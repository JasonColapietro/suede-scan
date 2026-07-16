import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTier } from '../lib/handler.mjs';

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

test('returns the audit envelope with no-store headers', async () => {
  const req = {
    method: 'POST',
    body: { url: 'example.com' },
    headers: { 'x-forwarded-for': '203.0.113.10' },
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
  await handleTier('audit', { method: 'POST', body: {}, headers: { 'x-forwarded-for': '203.0.113.11' }, socket: {} }, missing, async () => ({}));
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
  const crossSite = responseRecorder();
  await handleTier('audit', {
    method: 'POST', body: { url: 'example.com' }, headers: { 'sec-fetch-site': 'cross-site' }, socket: {},
  }, crossSite, async () => ({}));
  assert.equal(crossSite.statusCode, 403);

  const trapped = responseRecorder();
  await handleTier('audit', {
    method: 'POST', body: { url: 'example.com', companyFax: '555-0100' }, headers: { 'x-forwarded-for': '203.0.113.14' }, socket: {},
  }, trapped, async () => ({}));
  assert.equal(trapped.statusCode, 400);
  assert.equal(JSON.parse(trapped.body).error, 'Request rejected.');
});

test('caps repeated requests per process window', async () => {
  const runTier = async () => ({ host: 'example.com', score: 80, elapsedMs: 1 });
  let last;
  for (let index = 0; index < 13; index += 1) {
    const req = { method: 'POST', body: { url: 'example.com' }, headers: { 'x-forwarded-for': '203.0.113.12' }, socket: {} };
    last = responseRecorder();
    await handleTier('audit', req, last, runTier);
  }
  assert.equal(last.statusCode, 429);
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
});
