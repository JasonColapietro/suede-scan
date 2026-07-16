// Shared request handler for the scan/audit endpoints.
// Works both as a Vercel Node function and under the local dev server.

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
const USED_COOKIE = 'suede_audit_used';
const requestBuckets = new Map();

function requestIdentity(req) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const candidate = (Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket?.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
  return candidate.slice(0, 80);
}

function rateLimit(req) {
  const now = Date.now();
  const key = requestIdentity(req);
  const previous = requestBuckets.get(key);
  const bucket = !previous || previous.resetAt <= now
    ? { count: 0, resetAt: now + RATE_WINDOW_MS }
    : previous;
  bucket.count += 1;
  requestBuckets.set(key, bucket);

  if (requestBuckets.size > 1000) {
    for (const [storedKey, stored] of requestBuckets) {
      if (stored.resetAt <= now) requestBuckets.delete(storedKey);
    }
  }
  return { allowed: bucket.count <= RATE_LIMIT, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
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
    // Vercel parses JSON bodies into req.body; the local server does not.
    if (req.body && typeof req.body === 'object') {
      url = req.body.url;
      companyFax = req.body.companyFax;
    } else {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) throw new Error('Request body is too large');
      }
      const parsed = JSON.parse(raw);
      url = parsed.url;
      companyFax = parsed.companyFax;
    }
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
