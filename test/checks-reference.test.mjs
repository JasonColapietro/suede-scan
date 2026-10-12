import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import test from 'node:test';

import { auditChecks, scanChecks } from '../lib/engine.mjs';

// The /checks pages document every scored check. These tests keep them in
// step with lib/engine.mjs and with the site's crawl files, so a change to a
// check's lane or severity fails here until the reference is updated.

const root = new URL('../', import.meta.url);
const ORIGIN = 'https://optimize.suedeai.ai';
const WEIGHT = { high: 5, medium: 3, low: 1 };

const fixture = {
  html: '<html lang="en"><head><title>x</title></head><body><h1>a</h1></body></html>',
  https: true,
  status: 200,
  finalUrl: 'https://example.com/',
  artifacts: { robots: { ok: true, status: 200, text: '' }, llms: { ok: false, status: 404 }, sitemap: { ok: false, status: 404 } },
};
const ENGINE_CHECKS = [...scanChecks(fixture), ...auditChecks(fixture)];

async function checkPages() {
  const files = (await readdir(new URL('checks/', root))).filter((name) => name.endsWith('.html')).sort();
  return Promise.all(files.map(async (file) => {
    const html = await readFile(new URL(`checks/${file}`, root), 'utf8');
    const slug = file === 'index.html' ? '' : `/${file.slice(0, -5)}`;
    return { file, route: `/checks${slug}`, html };
  }));
}

const attrs = (tag) => Object.fromEntries([...tag.matchAll(/data-([a-z]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replaceAll('&amp;', '&')]));

test('every engine check is documented once, with its engine lane and severity', async () => {
  const pages = (await checkPages()).filter((page) => page.file !== 'index.html');
  const documented = new Map();
  for (const page of pages) {
    for (const [tag] of page.html.matchAll(/<p class="check-facts"[^>]*>/g)) {
      const { check, lane, severity } = attrs(tag);
      assert.ok(!documented.has(check), `${check} is documented on more than one page`);
      documented.set(check, { lane, severity, page: page.route });
      assert.match(page.html, new RegExp(`<h2 id="${check}">`), `${page.route} needs an anchor for ${check}`);
    }
  }
  for (const check of ENGINE_CHECKS) {
    const entry = documented.get(check.id);
    assert.ok(entry, `engine check ${check.id} has no reference section`);
    assert.equal(entry.lane, check.lane, `${check.id} lane drifted from lib/engine.mjs`);
    assert.equal(entry.severity, check.severity, `${check.id} severity drifted from lib/engine.mjs`);
  }
  assert.equal(documented.size, ENGINE_CHECKS.length, 'reference documents a check the engine does not run');
});

test('the checks index lists every check with its weight and links to its section', async () => {
  const pages = await checkPages();
  const index = pages.find((page) => page.file === 'index.html').html;
  const sectionPage = new Map();
  for (const page of pages) {
    for (const [tag] of page.html.matchAll(/<p class="check-facts"[^>]*>/g)) sectionPage.set(attrs(tag).check, page.route);
  }
  const rows = [...index.matchAll(/<tr data-check[^>]*>[\s\S]*?<\/tr>/g)].map(([row]) => row);
  assert.equal(rows.length, ENGINE_CHECKS.length);
  for (const check of ENGINE_CHECKS) {
    const row = rows.find((candidate) => candidate.includes(`data-check="${check.id}"`));
    assert.ok(row, `index is missing ${check.id}`);
    const { lane, severity } = attrs(row.match(/<tr[^>]*>/)[0]);
    assert.equal(lane, check.lane);
    assert.equal(severity, check.severity);
    assert.match(row, new RegExp(`, ${WEIGHT[check.severity]}</td>`), `${check.id} shows the wrong weight`);
    assert.ok(row.includes(`href="${sectionPage.get(check.id)}#${check.id}"`), `${check.id} row should link to its section`);
  }
  const total = ENGINE_CHECKS.reduce((sum, check) => sum + WEIGHT[check.severity], 0);
  assert.match(index, new RegExp(`add up to ${total} points`));
});

test('every check page is indexable, self-canonical, unique, linked and listed', async () => {
  const pages = await checkPages();
  const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
  const llms = await readFile(new URL('llms.txt', root), 'utf8');
  const server = await readFile(new URL('server.mjs', root), 'utf8');
  const home = await readFile(new URL('index.html', root), 'utf8');
  const method = await readFile(new URL('method.html', root), 'utf8');
  const index = pages.find((page) => page.file === 'index.html').html;
  const titles = new Set();
  const descriptions = new Set();

  assert.match(home, /<a class="text-link checks-more" href="\/checks">/, 'homepage should link the check reference');
  assert.match(method, /<a href="\/checks">check reference<\/a>/, 'method page should link the check reference');

  for (const page of pages) {
    const url = `${ORIGIN}${page.route}`;
    const title = page.html.match(/<title>([^<]+)<\/title>/)[1];
    const description = page.html.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(!titles.has(title), `${page.route} repeats a title`);
    assert.ok(!descriptions.has(description), `${page.route} repeats a description`);
    titles.add(title);
    descriptions.add(description);
    assert.ok(page.html.includes(`<link rel="canonical" href="${url}">`), `${page.route} canonical should be ${url}`);
    assert.ok(page.html.includes(`<meta property="og:url" content="${url}">`));
    assert.match(page.html, /<meta name="robots" content="index, follow, max-image-preview:large">/);
    for (const [tag] of page.html.matchAll(/<meta name="(?:robots|googlebot)[^"]*"[^>]*>/gi)) {
      assert.ok(!/noindex|none/i.test(tag.match(/content="([^"]*)"/)?.[1] || ''), `${page.route} must not be noindex`);
    }
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), `${page.route} missing from sitemap.xml`);
    assert.ok(llms.includes(`(${url})`), `${page.route} missing from llms.txt`);
    assert.match(server, new RegExp(`\\['${page.route}', readFile\\(new URL\\('\\./checks/${page.file.replace('.', '\\.')}', import\\.meta\\.url\\)\\)\\]`));
    if (page.file !== 'index.html') assert.ok(index.includes(`href="${page.route}"`), `${page.route} is not linked from /checks`);
  }
});

test('check pages pass the audit page-level checks they document', async () => {
  // Site-level checks read robots.txt, sitemap.xml, llms.txt or JSON-LD and are
  // covered by the homepage; everything else must pass on each reference page.
  const siteLevel = new Set(['robots', 'sitemap', 'llms', 'crawler-openai', 'crawler-anthropic', 'crawler-perplexity', 'crawler-google', 'schema', 'entity-type', 'same-as']);
  for (const page of await checkPages()) {
    const audited = { html: page.html, https: true, status: 200, finalUrl: `${ORIGIN}${page.route}`, artifacts: {} };
    const failures = [...scanChecks(audited), ...auditChecks(audited)]
      .filter((check) => !siteLevel.has(check.id) && !check.pass)
      .map((check) => `${check.id}: ${check.value}`);
    assert.deepEqual(failures, [], `${page.route} fails its own audit checks`);
  }
});

async function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('the server routes every check page and 404s unknown slugs', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: new URL('.', root), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await fetch(`${base}/robots.txt`);
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    for (const page of await checkPages()) {
      for (const path of [page.route, `${page.route}/`]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 200, `${path} should be served`);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(await response.text(), page.html);
      }
    }
    for (const path of ['/checks/unknown-check', '/checks/index', '/checks/metadata.html']) {
      assert.equal((await fetch(`${base}${path}`)).status, 404, `${path} should not resolve`);
    }
  } finally {
    child.kill();
  }
});
