// Shared request handler for the scan/audit endpoints.
// Works both as a Vercel Node function and under the local dev server.

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { gateConfigured, validEmail, issueChallenge, verifyChallenge } from './gate.mjs';
import { sendCode, sendLead } from './mailer.mjs';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const USED_COOKIE = 'suede_audit_used';
const requestBuckets = new Map();
const OPERATOR_MAX_FINDINGS = 6;
const OPERATOR_MAX_TOTAL_FINDINGS = 200;
const OPERATOR_AUTH_RATE_LIMIT = 12;
const OPERATOR_RATE_LIMIT = 6;
const MAX_RATE_BUCKETS = 1000;
const operatorAuthBuckets = new Map();
const operatorBuckets = new Map();

// Per-address cap on verification-code emails, so the gate cannot be used to
// bomb someone's inbox. In-memory with the same reset caveat as the IP bucket.
const CODE_WINDOW_MS = 15 * 60_000;
const CODE_LIMIT = 4;
const codeBuckets = new Map();

function codeRateLimited(email) {
  const now = Date.now();
  const previous = codeBuckets.get(email);
  const bucket = !previous || previous.resetAt <= now
    ? { count: 0, resetAt: now + CODE_WINDOW_MS }
    : previous;
  bucket.count += 1;
  codeBuckets.set(email, bucket);
  if (codeBuckets.size > 1000) {
    for (const [storedKey, stored] of codeBuckets) {
      if (stored.resetAt <= now) codeBuckets.delete(storedKey);
    }
  }
  return bucket.count > CODE_LIMIT;
}

function requestIdentity(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const forwardedCandidate = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '')
    .split(',')[0]
    .trim();
  if (isIP(forwardedCandidate)) return forwardedCandidate;
  const socketCandidate = String(req.socket?.remoteAddress || '').split('%')[0].trim();
  return isIP(socketCandidate) ? socketCandidate : 'unknown';
}

function rateLimit(req, { buckets = requestBuckets, limit = RATE_LIMIT, prefix = '' } = {}) {
  const now = Date.now();
  const key = `${prefix}${requestIdentity(req)}`;
  for (const [storedKey, stored] of buckets) {
    if (stored.resetAt <= now) buckets.delete(storedKey);
  }
  if (!buckets.has(key) && buckets.size >= MAX_RATE_BUCKETS) {
    return { allowed: false, retryAfter: Math.ceil(RATE_WINDOW_MS / 1000) };
  }
  const previous = buckets.get(key);
  const bucket = !previous || previous.resetAt <= now
    ? { count: 0, resetAt: now + RATE_WINDOW_MS }
    : previous;
  bucket.count += 1;
  buckets.set(key, bucket);
  return { allowed: bucket.count <= limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

async function readRequestBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error('Request body is too large');
  }
  return JSON.parse(raw);
}

function bearerToken(req) {
  const value = Array.isArray(req.headers?.authorization)
    ? req.headers.authorization[0]
    : req.headers?.authorization;
  const match = typeof value === 'string' ? value.match(/^Bearer ([^\s]+)$/) : null;
  return match?.[1] || '';
}

function tokenMatches(candidate, expected) {
  if (typeof expected !== 'string' || expected.length < 32 || typeof candidate !== 'string' || !candidate) return false;
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function cleanOperatorHandoff(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.recommendations)) return null;
  if (result.recommendations.length < 1 || result.recommendations.length > OPERATOR_MAX_TOTAL_FINDINGS) return null;
  const domain = cleanText(result.host, 253)?.toLowerCase().replace(/\.$/, '');
  const observedAt = cleanText(result.auditedAt, 64);
  const observedTime = observedAt ? Date.parse(observedAt) : NaN;
  let auditedUrl;
  try {
    const parsed = new URL(result.url);
    const cleanHost = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!domain || cleanHost !== domain || !['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    auditedUrl = parsed.href;
  } catch {
    return null;
  }
  if (!Number.isFinite(observedTime) || observedTime > Date.now() + 5_000 || Date.now() - observedTime > 30 * 60_000) return null;
  const findings = result.recommendations.slice(0, OPERATOR_MAX_FINDINGS).map((finding, index) => {
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) return null;
    const rawId = cleanText(finding.id, 48) || `finding-${index + 1}`;
    const id = `${rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'finding'}-${index + 1}`.slice(0, 64);
    const lane = cleanText(finding.lane, 80);
    const title = cleanText(finding.title, 160);
    const observed = cleanText(finding.observed, 300);
    const action = cleanText(finding.action, 300);
    const priority = ['high', 'medium', 'low'].includes(finding.severity) ? finding.severity : null;
    return lane && title && observed && action && priority
      ? { id, kind: 'site-integrity', lane, title, priority, observed, action }
      : null;
  }).filter(Boolean);
  if (findings.length === 0) return null;
  return {
    kind: 'suede.audit.prospect',
    version: 1,
    source: 'suede-audit',
    domain,
    auditedUrl,
    observedAt: new Date(observedTime).toISOString(),
    totalFindings: result.recommendations.length,
    omittedCount: result.recommendations.length - findings.length,
    findings,
  };
}

export async function handleTier(tier, req, res, runTier) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    return res.end(JSON.stringify({ error: 'POST only' }));
  }

  const fetchSite = req.headers?.['sec-fetch-site'];
  if (fetchSite !== 'same-origin') {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: 'Audit requests must come from the Suede Audit page.' }));
  }

  const cookie = Array.isArray(req.headers?.cookie) ? req.headers.cookie.join('; ') : String(req.headers?.cookie || '');
  if (new RegExp(`(?:^|;\\s*)${USED_COOKIE}=1(?:;|$)`).test(cookie)) {
    res.statusCode = 409;
    return res.end(JSON.stringify({ error: 'This browser has already used its free audit.' }));
  }

  const rate = rateLimit(req);
  res.setHeader('x-ratelimit-limit', String(RATE_LIMIT));
  if (!rate.allowed) {
    res.statusCode = 429;
    res.setHeader('retry-after', String(rate.retryAfter));
    return res.end(JSON.stringify({ error: 'Too many audits from this address. Wait a minute and try again.' }));
  }

  let url;
  let companyFax;
  let email;
  let code;
  let token;
  try {
    // Vercel parses JSON bodies into req.body; the local server does not.
    let parsed;
    if (req.body && typeof req.body === 'object') {
      parsed = req.body;
    } else {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 8192) throw new Error('Request body is too large');
      }
      parsed = JSON.parse(raw);
    }
    ({ url, companyFax, email, code, token } = parsed);
  } catch { /* fallthrough to missing-url error */ }

  if (typeof url !== 'string' || !url.trim() || url.length > 2048) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Enter a public website URL.' }));
  }

  if (typeof companyFax === 'string' && companyFax.trim()) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Request rejected.' }));
  }

  const gated = gateConfigured();
  if (gated) {
    email = typeof email === 'string' ? email.trim() : '';
    if (!validEmail(email)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'Enter the email address where we should send your verification code.' }));
    }

    if (typeof code !== 'string' || !code.trim() || typeof token !== 'string') {
      // Step one: no code yet — email one and hand back the signed challenge.
      // The audit does not run and the free-audit cookie is not consumed.
      if (codeRateLimited(email.toLowerCase())) {
        res.statusCode = 429;
        return res.end(JSON.stringify({ error: 'Too many codes were sent to that address. Wait a few minutes and try again.' }));
      }
      const challenge = issueChallenge(email);
      try {
        await sendCode(email, challenge.code, url.trim());
      } catch (e) {
        res.statusCode = 502;
        console.error(JSON.stringify({ event: 'gate_send_failed', tier, error: e.message }));
        return res.end(JSON.stringify({ error: 'We could not send a code to that address. Check it and try again.' }));
      }
      console.info(JSON.stringify({ event: 'gate_code_sent', tier }));
      res.statusCode = 200;
      return res.end(JSON.stringify({ pending: true, token: challenge.token }));
    }

    if (!verifyChallenge(token, email, code)) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: 'That code is not right or has expired. Check the digits or request a new one.', badCode: true }));
    }
  }

  try {
    const result = await runTier(tier, url);
    res.statusCode = 200;
    res.setHeader('set-cookie', `${USED_COOKIE}=1; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`);
    console.info(JSON.stringify({ event: 'audit_complete', tier, host: result.host, elapsedMs: result.elapsedMs, score: result.score }));
    if (gated) {
      // The lead notification must never block or fail the report, but in a
      // serverless runtime it must finish before the response ends.
      try {
        await sendLead({ email, host: result.host, url: result.url || url.trim(), score: result.score, grade: result.grade });
      } catch (e) {
        console.error(JSON.stringify({ event: 'gate_lead_failed', tier, error: e.message }));
      }
    }
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 502;
    console.error(JSON.stringify({ event: 'audit_failed', tier, error: e.message }));
    res.end(JSON.stringify({ error: `We could not inspect that public URL. ${e.message}` }));
  }
}

export async function handleOperatorAudit(req, res, runTier, { token = process.env.SUEDE_AUDIT_OPERATOR_TOKEN } = {}) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('allow', 'POST');
    return res.end(JSON.stringify({ error: 'POST only' }));
  }
  if (typeof token !== 'string' || token.length < 32) {
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'Operator audit is not configured.' }));
  }
  const authRate = rateLimit(req, {
    buckets: operatorAuthBuckets,
    limit: OPERATOR_AUTH_RATE_LIMIT,
    prefix: 'operator-auth:',
  });
  if (!authRate.allowed) {
    res.statusCode = 429;
    res.setHeader('retry-after', String(authRate.retryAfter));
    return res.end(JSON.stringify({ error: 'Too many operator authorization attempts.' }));
  }
  if (!tokenMatches(bearerToken(req), token)) {
    res.statusCode = 401;
    res.setHeader('www-authenticate', 'Bearer');
    return res.end(JSON.stringify({ error: 'Operator authorization required.' }));
  }
  const workRate = rateLimit(req, {
    buckets: operatorBuckets,
    limit: OPERATOR_RATE_LIMIT,
    prefix: 'operator:',
  });
  res.setHeader('x-ratelimit-limit', String(OPERATOR_RATE_LIMIT));
  if (!workRate.allowed) {
    res.statusCode = 429;
    res.setHeader('retry-after', String(workRate.retryAfter));
    return res.end(JSON.stringify({ error: 'Operator audit rate limit reached.' }));
  }

  let body;
  try {
    body = await readRequestBody(req);
  } catch {
    body = null;
  }
  if (
    !body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || typeof body.url !== 'string'
    || !body.url.trim() || body.url.length > 2048
  ) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Operator audit requires exactly one public website URL.' }));
  }

  try {
    const result = await runTier('audit', body.url);
    const handoff = cleanOperatorHandoff(result);
    if (!handoff) {
      res.statusCode = 422;
      return res.end(JSON.stringify({ error: 'The audit did not produce a fresh, bounded Prospect handoff.' }));
    }
    res.statusCode = 200;
    console.info(JSON.stringify({ event: 'operator_audit_complete', tier: 'audit', host: result.host, elapsedMs: result.elapsedMs, score: result.score }));
    return res.end(JSON.stringify({ handoff }));
  } catch (error) {
    res.statusCode = 502;
    console.error(JSON.stringify({ event: 'operator_audit_failed', tier: 'audit', error: error.message }));
    return res.end(JSON.stringify({ error: `We could not inspect that public URL. ${error.message}` }));
  }
}
