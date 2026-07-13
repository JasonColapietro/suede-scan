// Shared request handler for the scan/audit endpoints.
// Works both as a Vercel Node function and under the local dev server.

export async function handleTier(tier, req, res, runTier) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ error: 'POST only' }));
  }

  let url;
  try {
    // Vercel parses JSON bodies into req.body; the local server does not.
    if (req.body && typeof req.body === 'object') {
      url = req.body.url;
    } else {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      url = JSON.parse(raw).url;
    }
  } catch { /* fallthrough to missing-url error */ }

  res.setHeader('content-type', 'application/json');
  if (!url) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing url' }));
  }

  try {
    const result = await runTier(tier, url);
    res.statusCode = 200;
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: `Could not fetch that URL: ${e.message}` }));
  }
}
