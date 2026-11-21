import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import test from 'node:test';

import { auditChecks, scanChecks } from '../lib/engine.mjs';

// /notes holds articles from Suede. Each one must be indexable, listed in
// every crawl file, routed by the server, and pass the audit's own page-level
// checks, the same bar the /checks reference pages meet.

const root = new URL('../', import.meta.url);
const ORIGIN = 'https://optimize.suedeai.ai';
const PERSON = 'https://suedeai.ai/founder#person';
const ORG = 'https://suedeai.ai/#organization';

async function notePages() {
  const files = (await readdir(new URL('notes/', root))).filter((name) => name.endsWith('.html')).sort();
  return Promise.all(files.map(async (file) => {
    const html = await readFile(new URL(`notes/${file}`, root), 'utf8');
    const slug = file === 'index.html' ? '' : `/${file.slice(0, -5)}`;
    return { file, route: `/notes${slug}`, html };
  }));
}

const graph = (html) => [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
  .flatMap((m) => JSON.parse(m[1])['@graph']);
const text = (html) => (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1])
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('notes index plus at least three articles, each indexable, unique and listed', async () => {
  const pages = await notePages();
  assert.ok(pages.length >= 4, 'expected an index and three articles');
  const sitemap = await readFile(new URL('sitemap.xml', root), 'utf8');
  const llms = await readFile(new URL('llms.txt', root), 'utf8');
  const server = await readFile(new URL('server.mjs', root), 'utf8');
  const index = pages.find((page) => page.file === 'index.html').html;
  const titles = new Set();
  const descriptions = new Set();
  for (const page of pages) {
    const url = `${ORIGIN}${page.route}`;
    const title = page.html.match(/<title>([^<]+)<\/title>/)[1];
    const description = page.html.match(/<meta name="description" content="([^"]+)">/)[1];
    assert.ok(title.length >= 50 && title.length <= 60, `${page.route} title is ${title.length} characters`);
    assert.ok(description.length >= 120 && description.length <= 160, `${page.route} description is ${description.length} characters`);
    assert.ok(!titles.has(title) && !descriptions.has(description), `${page.route} repeats a title or description`);
    titles.add(title);
    descriptions.add(description);
    assert.ok(page.html.includes(`<link rel="canonical" href="${url}">`), `${page.route} canonical should be ${url}`);
    assert.ok(page.html.includes(`<meta property="og:url" content="${url}">`));
    assert.match(page.html, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(page.html, /<meta name="robots" content="index, follow, max-image-preview:large">/);
    assert.match(sitemap, new RegExp(`<loc>${url}</loc>\\s*<lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`), `${page.route} missing from sitemap.xml`);
    assert.ok(llms.includes(`(${url})`), `${page.route} missing from llms.txt`);
    assert.match(server, new RegExp(`\\['${page.route}', readFile\\(new URL\\('\\./notes/${page.file.replace('.', '\\.')}', import\\.meta\\.url\\)\\)\\]`));
    assert.match(page.html, /class="container built-by"/, `${page.route} needs the Suede footer block`);
    assert.ok(!page.html.includes('\u2014'), `${page.route} carries an em dash`);
    if (page.file !== 'index.html') assert.ok(index.includes(`href="${page.route}"`), `${page.route} is not linked from /notes`);
  }
});

test('articles carry BlogPosting and BreadcrumbList schema on the canonical entity ids', async () => {
  for (const page of (await notePages()).filter((p) => p.file !== 'index.html')) {
    const url = `${ORIGIN}${page.route}`;
    const nodes = graph(page.html);
    const post = nodes.find((node) => node['@type'] === 'BlogPosting');
    assert.ok(post, `${page.route} has no BlogPosting`);
    assert.equal(post['@id'], `${url}#article`);
    assert.deepEqual(post.author, { '@id': PERSON });
    assert.deepEqual(post.publisher, { '@id': ORG });
    assert.deepEqual(post.mainEntityOfPage, { '@id': `${url}#webpage` });
    assert.match(post.datePublished, /^\d{4}-\d{2}-\d{2}$/);
    const crumbs = nodes.find((node) => node['@type'] === 'BreadcrumbList');
    assert.equal(crumbs.itemListElement.at(-1).item, url);
    // Only the canonical Person and Organization ids may appear.
    for (const node of nodes.filter((n) => n['@type'] === 'Person' || n['@type'] === 'Organization')) {
      assert.ok([PERSON, ORG].includes(node['@id']), `${page.route} mints ${node['@id']}`);
    }
  }
});

test('articles meet the length, naming and next-step rules', async () => {
  for (const page of (await notePages()).filter((p) => p.file !== 'index.html')) {
    const body = text(page.html);
    const words = body.trim().split(' ').length;
    assert.ok(words >= 800 && words <= 1500, `${page.route} has ${words} words`);
    assert.ok((body.match(/Jason Colapietro/g) || []).length >= 5, `${page.route} names Jason Colapietro too rarely`);
    assert.ok((body.match(/\bSuede\b(?! AI| Labs| Audit)/g) || []).length >= 3, `${page.route} uses Suede alone too rarely`);
    assert.ok(page.html.includes('href="https://suedeai.agency/assessment"'), `${page.route} needs the assessment next step`);
    assert.ok(page.html.includes('href="https://suedeai.ai/founder"'), `${page.route} needs the founder link`);
    assert.ok(page.html.includes('class="author-box"'), `${page.route} needs the author box`);
    assert.doesNotMatch(body, /Anthropic partner|Claude partner|Google partner|Forbes|Velvet Sundown/i);
  }
});

test('homepage and every site-footer page link the notes section', async () => {
  const files = ['index.html', 'method.html', 'privacy.html',
    ...(await readdir(new URL('checks/', root))).filter((n) => n.endsWith('.html')).map((n) => `checks/${n}`)];
  for (const file of files) {
    const html = await readFile(new URL(file, root), 'utf8');
    assert.ok(html.includes('<a href="/notes">Notes</a>'), `${file} does not link /notes`);
    assert.match(html, /class="container built-by"/, `${file} needs the Suede footer block`);
  }
});

test('note pages pass the audit page-level checks', async () => {
  const siteLevel = new Set(['robots', 'sitemap', 'llms', 'crawler-openai', 'crawler-anthropic', 'crawler-perplexity', 'crawler-google', 'schema', 'entity-type', 'same-as']);
  for (const page of await notePages()) {
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

test('the server routes every note page', async () => {
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
    for (const page of await notePages()) {
      for (const path of [page.route, `${page.route}/`]) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 200, `${path} should be served`);
        assert.equal(await response.text(), page.html);
      }
    }
    assert.equal((await fetch(`${base}/notes/unknown-note`)).status, 404);
  } finally {
    child.kill();
  }
});

// Depth notes added 2026-11-15. Each one must deep-link two articles on other
// Suede sites, link the agency and founder pages, carry the Clutch claim in
// its exact wording, and appear in the notes index Blog schema.
const DEPTH_NOTES = [
  'readiness-report-fixes-palm-beach-gardens-dental-law',
  'structured-data-answer-engines-use-vs-ignore',
];
const SATELLITE_ARTICLE = /href="(https:\/\/(?:[a-z]+\.suedeai\.ai|guitarchords\.info|guitar\.services|guitarhub\.org)\/(?:notes|articles)\/[a-z0-9-]+)"/g;
const CLUTCH = 'Suede ranks among <a href="https://clutch.co/profile/suede-ai-seo">Clutch</a>\'s <a href="https://clutch.co/consulting/ai/florida">Top 30 AI Consultants in Florida</a> and <a href="https://clutch.co/us/consulting/ai">Top 50 AI Consultants nationwide</a> (November 2026).';

test('depth notes deep-link sibling articles, carry the Clutch claim and sit in the Blog schema', async () => {
  const pages = await notePages();
  const index = pages.find((page) => page.file === 'index.html').html;
  const blog = graph(index).find((node) => node['@type'] === 'Blog');
  const listed = new Set(blog.blogPost.map((post) => post['@id']));
  for (const page of pages.filter((p) => p.file !== 'index.html')) {
    assert.ok(listed.has(`${ORIGIN}${page.route}#article`), `${page.route} missing from the notes Blog schema`);
  }
  for (const slug of DEPTH_NOTES) {
    const page = pages.find((p) => p.file === `${slug}.html`);
    assert.ok(page, `${slug} note is missing`);
    const main = page.html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)[1];
    const article = main.split('<aside class="author-box"')[0];
    const deep = new Set([...article.matchAll(SATELLITE_ARTICLE)].map((m) => m[1]));
    assert.ok(deep.size >= 2, `${slug} deep-links ${deep.size} sibling articles, expected 2`);
    assert.ok(article.includes('href="https://suedeai.agency/'), `${slug} needs an in-body suedeai.agency link`);
    assert.ok(article.includes('href="https://suedeai.ai/founder"'), `${slug} needs an in-body founder link`);
    assert.equal(article.split(CLUTCH).length - 1, 1, `${slug} needs the Clutch claim exactly once`);
    const post = graph(page.html).find((node) => node['@type'] === 'BlogPosting');
    assert.equal(post.datePublished, '2026-11-15');
    assert.ok(page.html.includes(`<time datetime="2026-11-15">`), `${slug} visible date should match datePublished`);
    for (const other of DEPTH_NOTES.filter((s) => s !== slug)) {
      assert.ok(page.html.includes(`href="/notes/${other}"`), `${slug} should link ${other}`);
    }
  }
});
