import assert from 'node:assert/strict';
import test from 'node:test';

import {
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

test('evaluates crawler policy for the submitted page path', () => {
  const page = healthyPage({
    finalUrl: 'https://example.com/private/pricing',
    artifacts: {
      ...healthyPage().artifacts,
      robots: { ...healthyPage().artifacts.robots, text: 'User-agent: OAI-SearchBot\nDisallow: /private\n' },
    },
  });
  const platform = auditChecks(page).find((check) => check.id === 'crawler-openai');
  assert.equal(platform.pass, false);
  assert.match(platform.platform.detail, /\/private/);
});

test('crawls bounded same-origin links and returns structured broken and prepared redirect evidence', async () => {
  const root = healthyPage({
    html: '<a href="/ok">Working page</a><a href="/missing">Missing page</a><a href="/old">Old page</a><a href="/escape">Unsafe redirect</a><a href="/query-redirect">Query redirect</a><a href="https://outside.example/x">External</a><a href="/ignored?token=secret">Query</a>',
  });
  const requested = [];
  const responses = new Map([
    ['https://example.com/ok', new Response('<a href="/nested">Nested</a>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/nested', new Response('Nested page', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/missing', new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/old', new Response('', { status: 308, headers: { location: '/new' } })],
    ['https://example.com/new', new Response('New page', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/escape', new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } })],
    ['https://example.com/query-redirect', new Response('', { status: 302, headers: { location: '/new?token=secret' } })],
  ]);
  const fetchImpl = async (url) => {
    requested.push(url);
    return (responses.get(url) || new Response('Not found', { status: 404 })).clone();
  };

  const crawl = await crawlSiteLinks(root, {
    fetchImpl,
    lookupImpl: publicLookup,
    crawl: { maxPages: 3, maxLinks: 10, maxRequests: 12, maxDepth: 1, maxFindings: 10, maxTotalMs: 5_000 },
  });

  assert.equal(crawl.brokenLinks, 1);
  assert.equal(crawl.preparedRepairs, 1);
  assert.equal(crawl.unknownLinks, 2);
  assert.ok(crawl.pagesVisited <= 3);
  assert.ok(crawl.requestsMade <= 12);
  assert.equal(requested.some((url) => url.includes('outside.example')), false);
  assert.equal(requested.some((url) => url.includes('token=secret')), false);
  assert.equal(requested.some((url) => url.includes('127.0.0.1')), false);

  const broken = crawl.findings.find((finding) => finding.kind === 'broken-link');
  assert.deepEqual(broken.evidence, {
    sourceUrl: 'https://example.com/',
    targetUrl: 'https://example.com/missing',
    finalUrl: 'https://example.com/missing',
    status: 404,
    anchorText: 'Missing page',
    redirectChain: [],
  });
  assert.equal(broken.preparedRepair, null);

  const redirect = crawl.findings.find((finding) => finding.kind === 'redirect-link');
  assert.equal(redirect.preparedRepair.ready, true);
  assert.equal(redirect.preparedRepair.before, 'https://example.com/old');
  assert.equal(redirect.preparedRepair.after, 'https://example.com/new');
  assert.match(redirect.preparedRepair.verification.join(' '), /returns a successful response/);
});

test('requires two dead responses before calling an internal link confirmed broken', async () => {
  const root = healthyPage({ html: '<a href="/sometimes-missing">Sometimes missing</a>' });
  let attempts = 0;
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } })
        : new Response('Recovered', { status: 200, headers: { 'content-type': 'text/html' } });
    },
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 2, maxRequests: 4, maxDepth: 1, maxFindings: 2, maxTotalMs: 5_000 },
  });
  assert.equal(attempts, 2);
  assert.equal(crawl.brokenLinks, 0);
  assert.equal(crawl.unknownLinks, 1);
});

test('counts an unconfirmed dead-link observation as one unknown link', async () => {
  const root = healthyPage({ html: '<a href="/blocked-after-miss">Blocked after miss</a>' });
  let attempts = 0;
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async () => new Response(attempts++ === 0 ? 'Not found' : 'Forbidden', {
      status: attempts === 1 ? 404 : 403,
      headers: { 'content-type': 'text/html' },
    }),
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 2, maxRequests: 4, maxDepth: 1, maxFindings: 2, maxTotalMs: 5_000 },
  });
  assert.equal(attempts, 2);
  assert.equal(crawl.brokenLinks, 0);
  assert.equal(crawl.unknownLinks, 1);
});

test('does not turn an unstable 404-then-redirect sequence into a prepared repair', async () => {
  const root = healthyPage({ html: '<a href="/unstable">Unstable</a>' });
  let first = true;
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async (url) => {
      if (url === 'https://example.com/unstable' && first) {
        first = false;
        return new Response('Not found', { status: 404 });
      }
      if (url === 'https://example.com/unstable') return new Response('', { status: 301, headers: { location: '/live' } });
      return new Response('Live', { status: 200, headers: { 'content-type': 'text/html' } });
    },
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 2, maxRequests: 4, maxDepth: 1, maxFindings: 2, maxTotalMs: 5_000 },
  });
  assert.equal(crawl.unknownLinks, 1);
  assert.equal(crawl.preparedRepairs, 0);
  assert.equal(crawl.findings.length, 0);
});

test('does not call a mixed permanent and temporary redirect chain a deterministic repair', async () => {
  const root = healthyPage({ html: '<a href="/old">Old</a>' });
  const responses = new Map([
    ['https://example.com/old', new Response('', { status: 301, headers: { location: '/middle' } })],
    ['https://example.com/middle', new Response('', { status: 302, headers: { location: '/current' } })],
    ['https://example.com/current', new Response('Current', { status: 200, headers: { 'content-type': 'text/html' } })],
  ]);
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async (url) => responses.get(url).clone(),
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 2, maxRequests: 4, maxDepth: 1, maxFindings: 2, maxTotalMs: 5_000 },
  });
  assert.equal(crawl.preparedRepairs, 0);
  assert.equal(crawl.findings.some((finding) => finding.kind === 'redirect-link'), false);
});

test('enforces the absolute crawl deadline while a response body is still streaming', async () => {
  const root = healthyPage({ html: '<a href="/slow">Slow</a>' });
  const slowBody = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      controller.enqueue(new TextEncoder().encode('late'));
      controller.close();
    },
  });
  const started = Date.now();
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async () => new Response(slowBody, { status: 200, headers: { 'content-type': 'text/html' } }),
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 2, maxRequests: 4, maxDepth: 1, maxFindings: 2, maxTotalMs: 50 },
  });
  assert.ok(Date.now() - started < 150);
  assert.equal(crawl.unknownLinks, 1);
  assert.equal(crawl.truncated, true);
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

test('does not award the integrity pass when link evidence is zero, unknown, or truncated', async () => {
  const responses = new Map([
    ['https://example.com/', new Response(healthyHtml().replace(/<a[\s\S]*?<\/a>/g, '<a href="/blocked">Blocked</a>'), { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/robots.txt', new Response('User-agent: *\nAllow: /\n', { status: 200 })],
    ['https://example.com/llms.txt', new Response('# Example', { status: 200 })],
    ['https://example.com/sitemap.xml', new Response('<urlset></urlset>', { status: 200 })],
    ['https://example.com/blocked', new Response('Forbidden', { status: 403, headers: { 'content-type': 'text/html' } })],
  ]);
  const result = await runTier('audit', 'example.com', {
    fetchImpl: async (url) => responses.get(url).clone(),
    lookupImpl: publicLookup,
  });
  const integrity = result.checks.find((check) => check.id === 'site-links');
  assert.equal(integrity.pass, false);
  assert.match(integrity.value, /1 unknown/);
});

test('crawl budgets stop additional requests without labeling unknown links as broken', async () => {
  const root = healthyPage({ html: '<a href="/one">One</a><a href="/two">Two</a><a href="/three">Three</a>' });
  let requests = 0;
  const crawl = await crawlSiteLinks(root, {
    fetchImpl: async () => { requests += 1; return new Response('ok', { status: 200, headers: { 'content-type': 'text/html' } }); },
    lookupImpl: publicLookup,
    crawl: { maxPages: 2, maxLinks: 10, maxRequests: 1, maxDepth: 1, maxFindings: 10, maxTotalMs: 5_000 },
  });
  assert.equal(requests, 1);
  assert.equal(crawl.requestsMade, 1);
  assert.equal(crawl.brokenLinks, 0);
  assert.equal(crawl.truncated, true);
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
    ['https://example.com/about', new Response('<p>About</p>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/docs', new Response('<p>Docs</p>', { status: 200, headers: { 'content-type': 'text/html' } })],
    ['https://example.com/contact', new Response('<p>Contact</p>', { status: 200, headers: { 'content-type': 'text/html' } })],
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
  assert.equal(result.crawl.linksChecked, 3);
  assert.equal(result.crawl.brokenLinks, 0);
  assert.match(result.methodology, /public HTML/i);
  assert.match(result.auditedAt, /^\d{4}-\d{2}-\d{2}T/);
});
