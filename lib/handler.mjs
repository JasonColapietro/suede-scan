// Shared request handler for the scan/audit endpoints.
// Works both as a Vercel Node function and under the local dev server.

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 12;
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

  const rate = rateLimit(req);
  res.setHeader('x-ratelimit-limit', String(RATE_LIMIT));
  if (!rate.allowed) {
    res.statusCode = 429;
    res.setHeader('retry-after', String(rate.retryAfter));
    return res.end(JSON.stringify({ error: 'Too many audits from this address. Wait a minute and try again.' }));
  }

  let url;
  try {
    // Vercel parses JSON bodies into req.body; the local server does not.
    if (req.body && typeof req.body === 'object') {
      url = req.body.url;
    } else {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) throw new Error('Request body is too large');
      }
      url = JSON.parse(raw).url;
    }
  } catch { /* fallthrough to missing-url error */ }

  if (typeof url !== 'string' || !url.trim() || url.length > 2048) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Enter a public website URL.' }));
  }

  try {
    const result = await runTier(tier, url);
    res.statusCode = 200;
    console.info(JSON.stringify({ event: 'audit_complete', tier, host: result.host, elapsedMs: result.elapsedMs, score: result.score }));
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 502;
    console.error(JSON.stringify({ event: 'audit_failed', tier, error: e.message }));
    res.end(JSON.stringify({ error: `We could not inspect that public URL. ${e.message}` }));
  }
}
