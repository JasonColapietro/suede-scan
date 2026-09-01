import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleOperatorAudit,
  handleTier,
  OPERATOR_CRAWL_LIMITS,
  OPERATOR_RESPONSE_DEADLINE_MS,
} from '../lib/handler.mjs';

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

test('authenticated operator audit returns a private Prospect handoff without consuming the public audit', async () => {
  const token = 'operator-test-token-that-is-at-least-32-bytes';
  const res = responseRecorder();
  let invocation;
  await handleOperatorAudit({
    method: 'POST',
    body: { url: 'https://example.com/' },
    headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.41' },
    socket: {},
  }, res, async (...args) => {
    invocation = args;
    return ({
    host: 'example.com',
    url: 'https://example.com/',
    auditedAt: new Date().toISOString(),
    score: 88,
    elapsedMs: 12,
    recommendations: [{
      id: 'redirect-link',
      lane: 'Site integrity',
      title: 'Replace a redirected internal link',
      severity: 'low',
      observed: 'The old page permanently redirects.',
      action: 'Link directly to the permanent destination.',
      evidence: {
        sourceUrl: 'https://example.com/services',
        targetUrl: 'https://example.com/old',
        finalUrl: 'https://example.com/new',
        status: 200,
        anchorText: 'Pricing',
        redirectChain: [{ status: 301, from: 'https://example.com/old', to: 'https://example.com/new' }],
      },
      preparedRepair: {
        kind: 'replace-link-target',
        ready: true,
        before: 'https://example.com/old',
        after: 'https://example.com/new',
        instruction: 'Replace the old target with the permanent destination.',
        verification: ['Confirm the destination returns 200.'],
      },
    }],
  });
  }, { token });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.has('set-cookie'), false);
  assert.deepEqual(Object.keys(JSON.parse(res.body)), ['handoff']);
  assert.equal(JSON.parse(res.body).handoff.kind, 'suede.audit.prospect');
  assert.deepEqual(invocation, ['audit', 'https://example.com/', {
    crawl: OPERATOR_CRAWL_LIMITS,
    responseDeadlineMs: OPERATOR_RESPONSE_DEADLINE_MS,
  }]);
  assert.equal(JSON.parse(res.body).handoff.findings[0].evidence.sourceUrl, 'https://example.com/services');
  assert.equal(JSON.parse(res.body).handoff.findings[0].preparedRepair.after, 'https://example.com/new');
});

test('operator audit throttles invalid bearer attempts before any audit work', async () => {
  const token = 'failed-auth-test-token-that-is-at-least-32-bytes';
  let last;
  let runs = 0;
  for (let index = 0; index < 13; index += 1) {
    last = responseRecorder();
    await handleOperatorAudit({
      method: 'POST',
      body: { url: 'https://example.com/' },
      headers: { authorization: `Bearer invalid-${index}`, 'x-forwarded-for': '198.51.100.77' },
      socket: {},
    }, last, async () => { runs += 1; }, { token });
  }

  assert.equal(last.statusCode, 429);
  assert.equal(runs, 0);
});

test('operator audit limits authorized work separately from the public browser gate', async () => {
  const token = 'authorized-work-test-token-that-is-at-least-32-bytes';
  let last;
  let runs = 0;
  for (let index = 0; index < 7; index += 1) {
    last = responseRecorder();
    await handleOperatorAudit({
      method: 'POST',
      body: { url: 'https://example.com/' },
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.42' },
      socket: {},
    }, last, async () => {
      runs += 1;
      return {
        host: 'example.com', url: 'https://example.com/', auditedAt: new Date().toISOString(),
        score: 80, elapsedMs: 1,
        recommendations: [{ id: 'finding', lane: 'Entity', title: 'Finding', severity: 'medium', observed: 'Observed state.', action: 'Apply the repair.' }],
      };
    }, { token });
  }

  assert.equal(last.statusCode, 429);
  assert.equal(runs, 6);
});

test('operator audit fails closed without the configured token or an exact bearer match', async () => {
  const request = (authorization, address) => ({
    method: 'POST',
    body: { url: 'https://example.com/' },
    headers: { authorization, 'x-forwarded-for': address },
    socket: {},
  });
  const unconfigured = responseRecorder();
  await handleOperatorAudit(request('Bearer any', '203.0.113.60'), unconfigured, async () => ({}), { token: '' });
  assert.equal(unconfigured.statusCode, 503);

  const unauthorized = responseRecorder();
  await handleOperatorAudit(request(`Bearer ${'b'.repeat(48)}`, '203.0.113.61'), unauthorized, async () => ({}), { token: 'a'.repeat(48) });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer');
});

test('operator audit accepts only the exact url body contract', async () => {
  const token = 'strict-body-test-token-that-is-at-least-32-bytes';
  let runs = 0;
  for (const [index, body] of [
    { websiteUrl: 'https://example.com/' },
    { url: 'https://example.com/', extra: true },
    ['https://example.com/'],
  ].entries()) {
    const res = responseRecorder();
    await handleOperatorAudit({
      method: 'POST', body,
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': `203.0.113.${70 + index}` },
      socket: {},
    }, res, async () => { runs += 1; }, { token });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(runs, 0);
});

test('returns the audit envelope with no-store headers', async () => {
  const req = {
    method: 'POST',
    body: { url: 'example.com' },
    headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.10' },
    socket: {},
  };
  const res = responseRecorder();
  await handleTier('audit', req, res, async () => ({ host: 'example.com', score: 80, elapsedMs: 20 }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-ratelimit-limit'), '12');
  assert.match(res.headers.get('set-cookie'), /suede_audit_used=1/);
  assert.deepEqual(JSON.parse(res.body), { host: 'example.com', score: 80, elapsedMs: 20 });
});

test('rejects missing URLs and unsupported methods', async () => {
  const missing = responseRecorder();
  await handleTier('audit', { method: 'POST', body: {}, headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.11' }, socket: {} }, missing, async () => ({}));
  assert.equal(missing.statusCode, 400);

  const method = responseRecorder();
  await handleTier('audit', { method: 'GET', headers: {}, socket: {} }, method, async () => ({}));
  assert.equal(method.statusCode, 405);
  assert.equal(method.headers.get('allow'), 'POST');
});

test('blocks a browser after its first successful free audit', async () => {
  const res = responseRecorder();
  await handleTier('audit', {
    method: 'POST',
    body: { url: 'example.com' },
    headers: { cookie: 'suede_audit_used=1', 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.13' },
    socket: {},
  }, res, async () => { throw new Error('runTier should not be called'); });
  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /already used/);
});

test('rejects cross-site requests and filled bot traps', async () => {
  const missingHeader = responseRecorder();
  await handleTier('audit', {
    method: 'POST', body: { url: 'example.com' }, headers: {}, socket: {},
  }, missingHeader, async () => ({}));
  assert.equal(missingHeader.statusCode, 403);

  const crossSite = responseRecorder();
  await handleTier('audit', {
    method: 'POST', body: { url: 'example.com' }, headers: { 'sec-fetch-site': 'cross-site' }, socket: {},
  }, crossSite, async () => ({}));
  assert.equal(crossSite.statusCode, 403);

  const trapped = responseRecorder();
  await handleTier('audit', {
    method: 'POST', body: { url: 'example.com', companyFax: '555-0100' }, headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.14' }, socket: {},
  }, trapped, async () => ({}));
  assert.equal(trapped.statusCode, 400);
  assert.equal(JSON.parse(trapped.body).error, 'Request rejected.');
});

test('caps repeated requests per process window', async () => {
  const runTier = async () => ({ host: 'example.com', score: 80, elapsedMs: 1 });
  let last;
  for (let index = 0; index < 13; index += 1) {
    const req = { method: 'POST', body: { url: 'example.com' }, headers: { 'sec-fetch-site': 'same-origin', 'x-forwarded-for': '203.0.113.12' }, socket: {} };
    last = responseRecorder();
    await handleTier('audit', req, last, runTier);
  }
  assert.equal(last.statusCode, 429);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});
