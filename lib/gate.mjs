// Stateless email verification for the free audit.
//
// No database: the challenge travels as an HMAC-signed token held by the
// client, and the 6-digit code travels by email. The server can verify the
// pair without having stored either. Codes expire after 15 minutes.
//
// The gate arms itself only when both AUDIT_GATE_SECRET and RESEND_API_KEY
// are present; without them the audit runs ungated rather than bricking the
// product on missing config.

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_TTL_MS = 15 * 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function gateConfigured() {
  return Boolean(process.env.AUDIT_GATE_SECRET && process.env.RESEND_API_KEY);
}

export function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL.test(email);
}

function mac(value) {
  return createHmac('sha256', process.env.AUDIT_GATE_SECRET).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function issueChallenge(email) {
  const normalized = String(email).trim().toLowerCase();
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const payload = Buffer.from(JSON.stringify({
    email: normalized,
    codeMac: mac(`code:${normalized}:${code}`),
    exp: Date.now() + CODE_TTL_MS,
  })).toString('base64url');
  return { code, token: `${payload}.${mac(payload)}` };
}

export function verifyChallenge(token, email, code) {
  if (typeof token !== 'string' || token.length > 2048) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature || !safeEqual(signature, mac(payload))) return false;

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  if (!parsed || typeof parsed.email !== 'string' || typeof parsed.codeMac !== 'string') return false;
  if (!Number.isFinite(parsed.exp) || parsed.exp < Date.now()) return false;
  if (parsed.email !== String(email || '').trim().toLowerCase()) return false;
  return safeEqual(parsed.codeMac, mac(`code:${parsed.email}:${String(code || '').trim()}`));
}
