import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeChunks,
  assertPublicUrl,
  auditChecks,
  crawlSiteLinks,
  crawlerPolicy,
  isPrivateAddress,
  modelUseControls,
  normalizeUrl,
  runTier,
  scanChecks,
  summarize,
  summarizeChunking,
} from '../lib/engine.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function healthyHtml() {
  const words = Array.from({ length: 330 }, (_, index) => `evidence${index}`).join(' ');
  return `<!doctype html>
    <html lang="en">
      <head>
        <title>Evidence-ready public website audit report</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="description" content="A detailed public page with enough precise description text for a useful automated audit result.">
        <meta property="og:title" content="Evidence-ready public website audit report">
        <meta property="og:image" content="https://example.com/og.png">
        <meta name="twitter:card" content="summary_large_image">
        <link rel="canonical" href="https://example.com/">
        <link rel="icon" href="/favicon.ico">
        <script type="application/ld+json">{
          "@context":"https://schema.org",
          "@type":"Organization",
          "name":"Example",
          "sameAs":["https://example.social/example"]
        }</script>
      </head>
      <body>
        <h1>Example evidence hub</h1>
        <h2>What the company does</h2>
        <h2>How to verify it</h2>
        <a href="/about">About</a><a href="/docs">Docs</a><a href="/contact">Contact</a>
        <img src="/proof.png" alt="Public proof artifact">
        <p>${words}</p>
      </body>
    </html>`;
}

function healthyPage(overrides = {}) {
  return {
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    https: true,
    html: healthyHtml(),
    artifacts: {
      robots: {
        ok: true,
        status: 200,
        url: 'https://example.com/robots.txt',
        text: 'User-agent: *\nAllow: /\n',
      },
      llms: {
        ok: true,
        status: 200,
        url: 'https://example.com/llms.txt',
        text: '# Example\nPublic evidence index.',
      },
      sitemap: {
        ok: true,
        status: 200,
        url: 'https://example.com/sitemap.xml',
        text: '<urlset></urlset>',
      },
    },
    ...overrides,
  };
}

test('normalizes public domains and rejects unsupported URL shapes', () => {
  assert.equal(normalizeUrl('example.com').href, 'https://example.com/');
  assert.equal(normalizeUrl('http://example.com/path').href, 'http://example.com/path');
  assert.throws(() => normalizeUrl('ftp://example.com'), /Only public HTTP and HTTPS/);
  assert.throws(() => normalizeUrl('https://user:pass@example.com'), /Credentials/);
  assert.throws(() => normalizeUrl('https://example.com:444'), /ports 80 and 443/);
  assert.throws(() => normalizeUrl('https://exa mple.com'), /valid public website URL/);
});

test('recognizes private and reserved IP ranges', () => {
  for (const address of ['0.0.0.0', '10.2.3.4', '127.0.0.1', '169.254.2.3', '172.20.0.1', '192.168.1.5', '::', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
    assert.equal(isPrivateAddress(address), true, `${address} should be private`);
  }
  assert.equal(isPrivateAddress('93.184.216.34'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('blocks local hostnames before a request is made', async () => {
  await assert.rejects(() => assertPublicUrl(new URL('http://localhost/'), { lookupImpl: publicLookup }), /Public internet domains only/);
  await assert.rejects(() => assertPublicUrl(new URL('http://127.0.0.1/'), { lookupImpl: publicLookup }), /Public internet domains only/);
  await assert.rejects(() => assertPublicUrl(new URL('http://[::ffff:7f00:1]/'), { lookupImpl: publicLookup }), /Public internet domains only/);
  await assert.doesNotReject(() => assertPublicUrl(new URL('https://example.com/'), { lookupImpl: publicLookup }));
});

test('crawls bounded same-origin links with broken-link and redirect repair evidence', async () => {
  const root = healthyPage({
    html: '<a href="/missing">Missing page</a><a href="/old">Old page</a><a href="/escape">Unsafe redirect</a><a href="/query-redirect">Query redirect</a><a href="https://outside.example/x">External</a><a href="/ignored?token=secret">Query</a>',
  });
  const requested = [];
  const responses = new Map([
    ['https://example.com/missing', new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/old', new Response('', { status: 308, headers: { location: '/new' } })],
    ['https://example.com/new', new Response('New page', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/escape', new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })],
    ['https://example.com/query-redirect', new Response('', { status: 302, headers: { location: '/new?token=secret' } })],
  ]);
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async (url) => {
      requested.push(url);
      return (responses.get(url) || new Response('Not found', { status: 404 })).clone();
    },
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 6, maxRequests: 8, maxDepth: 1, maxFindings: 4, maxTotalMs: 5_000 },
  });

  assert.equal(crawl.brokenLinks, 1);
  assert.equal(crawl.preparedRepairs, 2);
  assert.equal(requested.some((url) => url.includes('outside.example')), false);
  assert.equal(requested.some((url) => url.includes('127.0.0.1')), false);
  assert.equal(requested.some((url) => url.includes('token=secret')), false);
  assert.deepEqual(crawl.findings.find((finding) => finding.kind === 'broken-link').evidence, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/missing',
    finalUrl: 'https://example.com/missing',
    status: 404,
    anchorText: 'Missing page',
    redirectChain: [],
  });
  const broken = crawl.findings.find((finding) => finding.kind === 'broken-link');
  assert.equal(broken.preparedRepair.ready, true);
  assert.equal(broken.preparedRepair.before, 'https://example.com/missing');
  assert.equal(broken.preparedRepair.after, 'https://example.com/');
  assert.match(broken.preparedRepair.verification.join(' '), /no longer links/);
  const redirect = crawl.findings.find((finding) => finding.kind === 'redirect-link');
  assert.equal(redirect.preparedRepair.before, 'https://example.com/old');
  assert.equal(redirect.preparedRepair.after, 'https://example.com/new');
});

test('enforces the response deadline while DNS resolution is pending', async () => {
  const started = Date.now();
  const outcome = await Promise.race([
    runTier('audit', 'example.com', {
      lookupImpl: async () => new Promise(() => {}),
      responseDeadlineMs: 50,
    }).then(() => 'resolved', (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('test guard elapsed'), 180)),
  ]);
  assert.match(outcome, /response deadline/);
  assert.ok(Date.now() - started < 150);
});

test('aborts the production request while connection or headers are pending', async () => {
  let aborted = false;
  const started = Date.now();
  const outcome = await Promise.race([
    runTier('audit', 'example.com', {
      lookupImpl: publicLookup,
      requestImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      }),
      responseDeadlineMs: 50,
    }).then(() => 'resolved', (error) => error.message),
    new Promise((resolve) => setTimeout(() => resolve('test guard elapsed'), 180)),
  ]);
  assert.match(outcome, /response deadline/);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 150);
});

test('reads crawler policy using exact bot groups before wildcard rules', () => {
  const robots = `
User-agent: *
Allow: /

User-agent: OAI-SearchBot
Disallow: /

User-agent: PerplexityBot
Allow: /
`;
  assert.equal(crawlerPolicy(robots, 'OAI-SearchBot').state, 'blocked');
  assert.equal(crawlerPolicy(robots, 'PerplexityBot').state, 'open');
  assert.equal(crawlerPolicy(robots, 'Googlebot').state, 'open');
  assert.equal(crawlerPolicy(null, 'Googlebot').state, 'open');
});

test('builds weighted lane scores and prioritized recommendations', () => {
  const page = healthyPage();
  const checks = [...scanChecks(page), ...auditChecks(page)];
  const summary = summarize(checks);

  assert.equal(summary.score, 100);
  assert.equal(summary.grade, 'A');
  assert.equal(summary.recommendations.length, 0);
  assert.equal(summary.laneScores['AI discovery'].score, 100);
  assert.equal(summary.platforms.length, 4);
  assert.equal(summary.pillarScores.length, 3);

  const blocked = healthyPage({
    artifacts: {
      ...page.artifacts,
      robots: { ...page.artifacts.robots, text: 'User-agent: OAI-SearchBot\nDisallow: /\n' },
      llms: { ok: false, status: 404, url: 'https://example.com/llms.txt', text: null },
    },
  });
  const blockedSummary = summarize([...scanChecks(blocked), ...auditChecks(blocked)]);
  assert.ok(blockedSummary.score < 100);
  assert.equal(blockedSummary.platforms.find((platform) => platform.id === 'openai').state, 'blocked');
  assert.equal(blockedSummary.recommendations[0].severity, 'high');

  const unknown = healthyPage({
    artifacts: {
      ...page.artifacts,
      robots: { ok: false, status: 403, url: 'https://example.com/robots.txt', text: null },
    },
  });
  const unknownSummary = summarize([...scanChecks(unknown), ...auditChecks(unknown)]);
  assert.equal(unknownSummary.platforms.find((platform) => platform.id === 'openai').state, 'unknown');
  assert.equal(unknownSummary.platforms.find((platform) => platform.id === 'openai').detail, 'robots.txt could not be inspected, so crawler access is not confirmed.');
});

test('separates Reuters-style search access from model-use controls', () => {
  const page = healthyPage({
    artifacts: {
      ...healthyPage().artifacts,
      robots: {
        ok: true,
        status: 200,
        url: 'https://example.com/robots.txt',
        text: `
User-agent: Googlebot
User-agent: OAI-SearchBot
User-agent: Claude-SearchBot
User-agent: PerplexityBot
Disallow: /search

User-agent: *
Allow: /plus/
Disallow: /
`,
      },
    },
  });
  const summary = summarize([...scanChecks(page), ...auditChecks(page)]);
  const controls = modelUseControls(page);

  assert.equal(summary.platforms.find((platform) => platform.id === 'openai').state, 'open');
  assert.equal(summary.platforms.find((platform) => platform.id === 'anthropic').state, 'open');
  assert.equal(summary.platforms.find((platform) => platform.id === 'google').state, 'open');
  assert.deepEqual(controls.map((control) => [control.crawler, control.state]), [
    ['GPTBot', 'blocked'],
    ['ClaudeBot', 'blocked'],
    ['Google-Extended', 'blocked'],
  ]);
  assert.equal(summary.laneScores['AI discovery'].score, 100);
});

test('runs a full audit with deterministic public fetch fixtures', async () => {
  const responses = new Map([
    ['https://example.com/', new Response(healthyHtml(), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['https://example.com/robots.txt', new Response('User-agent: *\nAllow: /\n', { status: 200 })],
    ['https://example.com/llms.txt', new Response('# Example', { status: 200 })],
    ['https://example.com/sitemap.xml', new Response('<urlset></urlset>', { status: 200 })],
  ]);
  const fetchImpl = async (url) => {
    const response = responses.get(url);
    if (!response) return new Response('Not found', { status: 404 });
    return response.clone();
  };

  const result = await runTier('audit', 'example.com', { fetchImpl, lookupImpl: publicLookup });
  assert.equal(result.tier, 'audit');
  assert.equal(result.host, 'example.com');
  assert.equal(result.grade, 'A');
  assert.ok(result.total >= 20);
  assert.equal(result.platforms.length, 4);
  assert.equal(result.controls.length, 3);
  assert.match(result.methodology, /public HTML/i);
  assert.match(result.auditedAt, /^\d{4}-\d{2}-\d{2}T/);
});

// --- Retrieval-chunk analysis ------------------------------------------------
//
// Discovery Engine retrieves at most 500 tokens (~375 words) per chunk, so a
// heading section longer than that is split mid-section and a claim inside it
// can be extracted away from the heading that identifies it. These tests pin
// the boundary behaviour, not prose quality.

const filler = (n) => Array.from({ length: n }, (_, index) => `w${index}`).join(' ');

test('analyzeChunks splits the document at headings and counts each section body', () => {
  const analysis = analyzeChunks(`
    <p>${filler(5)}</p>
    <h1>Page title</h1>
    <p>${filler(10)}</p>
    <h2>Second section</h2>
    <p>${filler(20)}</p>
  `);

  assert.equal(analysis.headingCount, 2);
  assert.deepEqual(
    analysis.blocks.map((block) => [block.heading, block.words]),
    [[null, 5], ['Page title', 10], ['Second section', 20]],
  );
  assert.equal(analysis.totalWords, 35);
  assert.equal(analysis.largest.heading, 'Second section');
  assert.deepEqual(analysis.oversized, []);
});

test('analyzeChunks ignores script, style and comment content', () => {
  const analysis = analyzeChunks(`
    <h1>Real heading</h1>
    <script type="application/ld+json">{"name":"${filler(400)}"}</script>
    <style>.a{content:"${filler(400)}"}</style>
    <!-- ${filler(400)} -->
    <p>${filler(6)}</p>
  `);

  assert.equal(analysis.totalWords, 6);
  assert.deepEqual(analysis.oversized, []);
});

test('analyzeChunks excludes nav and footer chrome but keeps header content', () => {
  const analysis = analyzeChunks(`
    <nav><a href="/a">${filler(400)}</a></nav>
    <header><h1>Real title</h1></header>
    <p>${filler(12)}</p>
    <footer><a href="/b">${filler(400)}</a></footer>
  `);

  assert.equal(analysis.totalWords, 12);
  assert.equal(analysis.headingCount, 1);
  assert.equal(analysis.blocks[0].heading, 'Real title');
  assert.deepEqual(analysis.oversized, []);
});

test('summarizeChunking passes a page whose every section fits one chunk', () => {
  const result = summarizeChunking(`
    <h1>What this is</h1><p>${filler(120)}</p>
    <h2>How it works</h2><p>${filler(200)}</p>
    <h2>Pricing</h2><p>${filler(150)}</p>
  `);

  assert.equal(result.pass, true);
  assert.match(result.value, /All 3 heading sections fit/);
  assert.match(result.value, /200 words under "How it works"/);
});

test('summarizeChunking does not pass a page with one section past the chunk limit', () => {
  const result = summarizeChunking(`
    <h1>Fine</h1><p>${filler(100)}</p>
    <h2>Too long</h2><p>${filler(600)}</p>
  `);

  assert.equal(result.pass, false);
  assert.match(result.value, /1 of 2 heading sections over 375 words/);
  assert.match(result.value, /600 words under "Too long"/);
});

// The source implementation graded one or two oversized sections as a warning
// worth partial credit and three or more as an outright failure. This engine
// scores checks as a binary pass or repair, so both land identically; only the
// observed value tells them apart.
test('summarizeChunking scores many oversized sections the same way it scores one', () => {
  const many = summarizeChunking(`
    <h2>A</h2><p>${filler(500)}</p>
    <h2>B</h2><p>${filler(500)}</p>
    <h2>C</h2><p>${filler(500)}</p>
  `);
  const one = summarizeChunking(`
    <h2>A</h2><p>${filler(500)}</p>
    <h2>B</h2><p>${filler(10)}</p>
    <h2>C</h2><p>${filler(10)}</p>
  `);

  assert.equal(many.pass, false);
  assert.equal(one.pass, false);
  assert.match(many.value, /3 of 3 heading sections over 375 words/);
  assert.match(one.value, /1 of 3 heading sections over 375 words/);
});

test('summarizeChunking does not pass a long page that has no headings at all', () => {
  const result = summarizeChunking(`<div><p>${filler(900)}</p></div>`);

  assert.equal(result.pass, false);
  assert.match(result.value, /900 words, no headings anywhere/);
  assert.match(result.advice, /undifferentiated block/);
});

// A JS-rendered shell has no prose for a retrieval crawler to chunk. Scoring it
// as "every section fits" would be a false clean, so it reports a repair.
test('summarizeChunking does not pass when there is too little server-rendered text', () => {
  const result = summarizeChunking('<h1>App</h1><div id="root"></div>');

  assert.equal(result.pass, false);
  assert.match(result.value, /too little to evaluate/);
  assert.match(result.advice, /client-side/);
});

test('summarizeChunking never reports a clean pass on a truncated body', () => {
  const html = `
    <h1>What this is</h1><p>${filler(120)}</p>
    <h2>How it works</h2><p>${filler(200)}</p>
  `;
  const whole = summarizeChunking(html);
  const cut = summarizeChunking(html, { truncated: true });

  assert.equal(whole.pass, true);
  assert.equal(cut.pass, false);
  assert.match(cut.value, /partial document/);
});

test('auditChecks scores retrieval chunking alongside the existing content checks', () => {
  const healthy = auditChecks(healthyPage()).find((check) => check.id === 'chunking');
  assert.equal(healthy.pass, true);
  assert.equal(healthy.lane, 'Content');
  assert.equal(healthy.severity, 'medium');

  const bloated = healthyPage({
    html: healthyHtml().replace('<h2>How to verify it</h2>', `<h2>How to verify it</h2><p>${filler(600)}</p>`),
  });
  const checks = [...scanChecks(bloated), ...auditChecks(bloated)];
  const summary = summarize(checks);

  assert.equal(checks.find((check) => check.id === 'chunking').pass, false);
  assert.ok(summary.score < 100);
  assert.ok(summary.recommendations.some((repair) => repair.id === 'chunking'));
});
