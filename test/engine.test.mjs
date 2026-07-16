import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPublicUrl,
  auditChecks,
  crawlerPolicy,
  isPrivateAddress,
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

test('builds weighted lane scores and prioritized recommendations', () => {
  const page = healthyPage();
  const checks = [...scanChecks(page), ...auditChecks(page)];
  const summary = summarize(checks);

  assert.equal(summary.score, 100);
  assert.equal(summary.grade, 'A');
  assert.equal(summary.recommendations.length, 0);
  assert.equal(summary.laneScores['AI discovery'].score, 100);
  assert.equal(summary.platforms.length, 3);
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
  assert.equal(result.platforms.length, 3);
  assert.match(result.methodology, /public HTML/i);
  assert.match(result.auditedAt, /^\d{4}-\d{2}-\d{2}T/);
});
