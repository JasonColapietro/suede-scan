// Gated-handler flow. Runs in its own process (node --test isolation), so the
// env vars armed here never leak into the ungated handler.test.mjs run.
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.AUDIT_GATE_SECRET = 'handler-secret';
process.env.RESEND_API_KEY = 're_test_key';

const { handleTier } = await import('../lib/handler.mjs');

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 0,
    body: '',
    setHeader(name, value) { headers.set(name.toLowerCase(), String(value)); },
    end(value = '') { this.body = value; },
    headers,
  };
}

function gatedRequest(body, ip) {
  return {
    method: 'POST',
    body,
    headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': ip },
    socket: {},
  };
}

const sentEmails = [];
function stubResend(ok = true) {
  sentEmails.length = 0;
  global.fetch = async (url, options) => {
    sentEmails.push(JSON.parse(options.body));
    return { ok, status: ok ? 200 : 500, text: async () => (ok ? '' : 'boom') };
  };
}

const runTier = async () => ({ host: 'example.com', url: 'https://example.com/', score: 71, grade: 'B', elapsedMs: 5 });

test('requires an email when the gate is armed', async () => {
  const res = responseRecorder();
  await handleTier('audit', gatedRequest({ url: 'example.com' }, '203.0.113.50'), res, runTier);
  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(res.body).error, /verification code/);
});

test('emails a code first, then unlocks the report and notifies the lead inbox', async () => {
  stubResend();
  const first = responseRecorder();
  await handleTier('audit', gatedRequest({ url: 'example.com', email: 'buyer@corp.com' }, '203.0.113.51'), first, runTier);
  assert.equal(first.statusCode, 200);
  const challenge = JSON.parse(first.body);
  assert.equal(challenge.pending, true);
  assert.ok(challenge.token);
  assert.equal(first.headers.has('set-cookie'), false);
  assert.equal(sentEmails.length, 1);
  assert.deepEqual(sentEmails[0].to, ['buyer@corp.com']);
  const code = sentEmails[0].subject.match(/^(\d{6}) /)[1];

  const second = responseRecorder();
  await handleTier('audit', gatedRequest({
    url: 'example.com', email: 'buyer@corp.com', code, token: challenge.token,
  }, '203.0.113.51'), second, runTier);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).host, 'example.com');
  assert.match(second.headers.get('set-cookie'), /suede_audit_used=1/);
  assert.equal(sentEmails.length, 2);
  assert.deepEqual(sentEmails[1].to, ['info@suedeai.org']);
  assert.match(sentEmails[1].subject, /Audit lead: example\.com \(buyer@corp\.com\)/);
});

test('rejects a wrong code without running the audit', async () => {
  stubResend();
  const first = responseRecorder();
  await handleTier('audit', gatedRequest({ url: 'example.com', email: 'wrong@corp.com' }, '203.0.113.52'), first, runTier);
  const challenge = JSON.parse(first.body);
  const code = sentEmails[0].subject.match(/^(\d{6}) /)[1];
  const wrongCode = code === '000000' ? '000001' : '000000';

  const second = responseRecorder();
  await handleTier('audit', gatedRequest({
    url: 'example.com', email: 'wrong@corp.com', code: wrongCode, token: challenge.token,
  }, '203.0.113.52'), second, async () => { throw new Error('runTier must not run'); });
  assert.equal(second.statusCode, 400);
  assert.equal(JSON.parse(second.body).badCode, true);
});

test('surfaces a send failure instead of pretending a code went out', async () => {
  stubResend(false);
  const res = responseRecorder();
  await handleTier('audit', gatedRequest({ url: 'example.com', email: 'fail@corp.com' }, '203.0.113.53'), res, runTier);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /could not send a code/);
});

test('caps verification codes per address', async () => {
  stubResend();
  let last;
  for (let index = 0; index < 5; index += 1) {
    last = responseRecorder();
    await handleTier('audit', gatedRequest({ url: 'example.com', email: 'bomb@corp.com' }, `203.0.113.6${index}`), last, runTier);
  }
  assert.equal(last.statusCode, 429);
  assert.match(JSON.parse(last.body).error, /Too many codes/);
});

test('a lead-notification failure does not fail the report', async () => {
  stubResend();
  const first = responseRecorder();
  await handleTier('audit', gatedRequest({ url: 'example.com', email: 'lead@corp.com' }, '203.0.113.54'), first, runTier);
  const challenge = JSON.parse(first.body);
  const code = sentEmails[0].subject.match(/^(\d{6}) /)[1];

  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'down' });
  const second = responseRecorder();
  await handleTier('audit', gatedRequest({
    url: 'example.com', email: 'lead@corp.com', code, token: challenge.token,
  }, '203.0.113.54'), second, runTier);
  assert.equal(second.statusCode, 200);
  assert.equal(JSON.parse(second.body).host, 'example.com');
});
