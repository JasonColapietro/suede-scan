import assert from 'node:assert/strict';
import test from 'node:test';

import { gateConfigured, validEmail, issueChallenge, verifyChallenge } from '../lib/gate.mjs';

process.env.AUDIT_GATE_SECRET = 'test-secret';
process.env.RESEND_API_KEY = 're_test_key';

test('gate arms only when both env vars are present', () => {
  assert.equal(gateConfigured(), true);
  const key = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  assert.equal(gateConfigured(), false);
  process.env.RESEND_API_KEY = key;
});

test('validates email shapes permissively but not absurdly', () => {
  assert.equal(validEmail('founder@company.com'), true);
  assert.equal(validEmail('a@b.co'), true);
  assert.equal(validEmail('nope'), false);
  assert.equal(validEmail('has space@x.com'), false);
  assert.equal(validEmail(`${'a'.repeat(250)}@b.co`), false);
});

test('issued challenge verifies with the right email and code', () => {
  const { code, token } = issueChallenge('Founder@Company.com');
  assert.match(code, /^\d{6}$/);
  assert.equal(verifyChallenge(token, 'founder@company.com', code), true);
  assert.equal(verifyChallenge(token, ' Founder@Company.com ', code), true);
});

test('rejects wrong codes, wrong emails, and tampered tokens', () => {
  const { code, token } = issueChallenge('a@b.co');
  const wrongCode = code === '000000' ? '000001' : '000000';
  assert.equal(verifyChallenge(token, 'a@b.co', wrongCode), false);
  assert.equal(verifyChallenge(token, 'other@b.co', code), false);
  assert.equal(verifyChallenge(`${token}x`, 'a@b.co', code), false);
  const [payload] = token.split('.');
  assert.equal(verifyChallenge(`${payload}.forged`, 'a@b.co', code), false);
  assert.equal(verifyChallenge(undefined, 'a@b.co', code), false);
});

test('rejects expired challenges', () => {
  const { code, token } = issueChallenge('a@b.co');
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60_000;
  try {
    assert.equal(verifyChallenge(token, 'a@b.co', code), false);
  } finally {
    Date.now = realNow;
  }
});
