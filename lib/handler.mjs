// Shared request handler for the scan/audit endpoints.
// Works both as a Vercel Node function and under the local dev server.

import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const OPERATOR_RATE_LIMIT = 6;
const OPERATOR_AUTH_RATE_LIMIT = 12;
const MAX_RATE_BUCKETS = 1000;
const HANDOFF_MAX_ENCODED = 6144;
const HANDOFF_MAX_FINDINGS = 6;
const HANDOFF_MAX_TOTAL_FINDINGS = 200;
const HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const USED_COOKIE = 'suede_audit_used';
const requestBuckets = new Map();
const operatorBuckets = new Map();
const operatorAuthBuckets = new Map();

export const OPERATOR_RESPONSE_DEADLINE_MS = 18_000;

export const OPERATOR_CRAWL_LIMITS = Object.freeze({
  maxPages: 20,
  maxLinks: 120,
  maxRequests: 150,
  maxDepth: 2,
  maxFindings: 40,
  maxTotalMs: 16_000,
});

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

function cleanHost(value) {
  const host = cleanText(value, 253)?.toLowerCase().replace(/\.$/, '');
  return host && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host) ? host : null;
}

function cleanPublicResultUrl(value, domain) {
  const text = cleanText(value, 2048);
  if (!text || !domain) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || host !== domain) return null;
    return url.href;
  } catch {
    return null;
  }
}

function cleanOperatorFinding(repair, index, domain) {
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) return null;
  const lane = cleanText(repair.lane, 80);
  const title = cleanText(repair.title, 160);
  const observed = cleanText(repair.observed, 300);
  const action = cleanText(repair.action, 300);
  const priority = ['high', 'medium', 'low'].includes(repair.severity) ? repair.severity : null;
  if (!lane || !title || !observed || !action || !priority) return null;
  const rawId = cleanText(repair.id, 48) || `finding-${index + 1}`;
  const slug = rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const finding = {
    id: `${slug || 'finding'}-${index + 1}`.slice(0, 64),
    kind: 'site-integrity',
    lane,
    title,
    priority,
    observed,
    action,
  };

  const evidence = repair.evidence;
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    const sourceUrl = cleanPublicResultUrl(evidence.sourceUrl, domain);
    const targetUrl = cleanPublicResultUrl(evidence.targetUrl, domain);
    const finalUrl = cleanPublicResultUrl(evidence.finalUrl, domain);
    const status = Number(evidence.status);
    const anchor = cleanText(evidence.anchorText, 160) || 'Unlabelled link';
    if (sourceUrl && targetUrl && finalUrl && Number.isInteger(status) && status >= 0 && status <= 599) {
      const redirectChain = Array.isArray(evidence.redirectChain)
        ? evidence.redirectChain.map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
          const redirectStatus = Number(item.status);
          const from = cleanPublicResultUrl(item.from, domain);
          const to = cleanPublicResultUrl(item.to, domain);
          return Number.isInteger(redirectStatus) && redirectStatus >= 100 && redirectStatus <= 599 && from && to
            ? { status: redirectStatus, from, to }
            : null;
        }).filter(Boolean).slice(0, 5)
        : [];
      finding.evidence = { sourceUrl, targetUrl, finalUrl, status, anchorText: anchor, redirectChain };
    }
  }

  const prepared = repair.preparedRepair;
  if (prepared?.kind === 'replace-link-target' && prepared.ready === true && finding.evidence) {
    const before = cleanPublicResultUrl(prepared.before, domain);
    const after = cleanPublicResultUrl(prepared.after, domain);
    const instruction = cleanText(prepared.instruction, 300);
    const verification = Array.isArray(prepared.verification)
      ? prepared.verification.map((step) => cleanText(step, 240)).filter(Boolean).slice(0, 3)
      : [];
    if (before && after && before !== after && instruction && verification.length > 0) {
      finding.preparedRepair = { kind: 'replace-link-target', ready: true, before, after, instruction, verification };
    }
  }
  return finding;
}

export function buildOperatorHandoff(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.recommendations)) return null;
  if (result.recommendations.length < 1 || result.recommendations.length > HANDOFF_MAX_TOTAL_FINDINGS) return null;
  const domain = cleanHost(result.host);
  const auditedUrl = cleanPublicResultUrl(result.url, domain);
  const observedAt = cleanText(result.auditedAt, 64);
  const observedTime = observedAt ? Date.parse(observedAt) : NaN;
  const age = Date.now() - observedTime;
  if (!domain || !auditedUrl || !Number.isFinite(observedTime) || age < 0 || age > HANDOFF_MAX_AGE_MS) return null;
  const validFindings = result.recommendations.map((repair, index) => cleanOperatorFinding(repair, index, domain)).filter(Boolean);
  if (validFindings.length === 0) return null;

  const totalFindings = result.recommendations.length;
  let findings = validFindings.slice(0, HANDOFF_MAX_FINDINGS);
  let handoff;
  while (findings.length > 0) {
    handoff = {
      kind: 'suede.audit.prospect',
      version: 1,
      source: 'suede-audit',
      domain,
      auditedUrl,
      observedAt: new Date(observedTime).toISOString(),
      totalFindings,
      omittedCount: totalFindings - findings.length,
      findings,
    };
    const encodedLength = Buffer.from(JSON.stringify(handoff), 'utf8').toString('base64url').length;
    if (encodedLength <= HANDOFF_MAX_ENCODED) return handoff;
    findings = findings.slice(0, -1);
  }
  return null;
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
  try {
    const parsed = await readRequestBody(req);
    url = parsed.url;
    companyFax = parsed.companyFax;
  } catch { /* fallthrough to missing-url error */ }

  if (typeof url !== 'string' || !url.trim() || url.length > 2048) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Enter a public website URL.' }));
  }

  if (typeof companyFax === 'string' && companyFax.trim()) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Request rejected.' }));
  }

  try {
    const result = await runTier(tier, url);
    res.statusCode = 200;
    res.setHeader('set-cookie', `${USED_COOKIE}=1; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`);
    console.info(JSON.stringify({ event: 'audit_complete', tier, host: result.host, elapsedMs: result.elapsedMs, score: result.score }));
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

  const rate = rateLimit(req, { buckets: operatorBuckets, limit: OPERATOR_RATE_LIMIT, prefix: 'operator:' });
  res.setHeader('x-ratelimit-limit', String(OPERATOR_RATE_LIMIT));
  if (!rate.allowed) {
    res.statusCode = 429;
    res.setHeader('retry-after', String(rate.retryAfter));
    return res.end(JSON.stringify({ error: 'Operator audit rate limit reached.' }));
  }

  let url;
  let validBody = false;
  try {
    const parsed = await readRequestBody(req);
    validBody = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).length === 1
      && Object.hasOwn(parsed, 'url');
    if (validBody) url = parsed.url;
  } catch { /* fallthrough */ }
  if (!validBody || typeof url !== 'string' || !url.trim() || url.length > 2048) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Operator audit requires exactly one public website URL.' }));
  }

  try {
    const result = await runTier('audit', url, {
      crawl: OPERATOR_CRAWL_LIMITS,
      responseDeadlineMs: OPERATOR_RESPONSE_DEADLINE_MS,
    });
    const handoff = buildOperatorHandoff(result);
    if (!handoff) {
      res.statusCode = 422;
      return res.end(JSON.stringify({ error: 'The audit did not produce a fresh, bounded Prospect handoff.' }));
    }
    res.statusCode = 200;
    console.info(JSON.stringify({ event: 'operator_audit_complete', tier: 'audit', host: result.host, elapsedMs: result.elapsedMs, score: result.score }));
    res.end(JSON.stringify({ handoff }));
  } catch (e) {
    res.statusCode = 502;
    console.error(JSON.stringify({ event: 'operator_audit_failed', tier: 'audit', error: e.message }));
    res.end(JSON.stringify({ error: `We could not inspect that public URL. ${e.message}` }));
  }
}
