import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { BRAND_KEYWORDS, PAGE_KEYWORDS, keywordsContent, keywordsFor } from '../lib/page-keywords.mjs';

const root = new URL('../', import.meta.url);

async function indexablePages() {
  const files = (await readdir(root)).filter((name) => name.endsWith('.html'));
  const pages = [];
  for (const name of files) {
    const html = await readFile(new URL(name, root), 'utf8');
    const robots = html.match(/<meta name="robots" content="([^"]*)"/i)?.[1] || '';
    if (!/noindex/i.test(robots)) pages.push([name, html]);
  }
  return pages;
}

test('every indexable HTML page has a keyword list in the central map', async () => {
  const pages = await indexablePages();
  assert.ok(pages.length >= 3, 'expected index, method, and privacy pages');
  for (const [name] of pages) {
    assert.ok(PAGE_KEYWORDS[name], `${name} is indexable but has no entry in lib/page-keywords.mjs`);
  }
});

test('every indexable HTML page emits meta keywords right after its description', async () => {
  for (const [name, html] of await indexablePages()) {
    const tags = html.match(/<meta name="keywords"[^>]*>/gi) || [];
    assert.equal(tags.length, 1, `${name} should have exactly one meta keywords tag`);
    assert.match(
      html,
      /<meta name="description" content="[^"]+">\s*<meta name="keywords" content="[^"]+">/,
      `${name} should place meta keywords directly after meta description`,
    );
    const content = html.match(/<meta name="keywords" content="([^"]+)">/)[1];
    assert.equal(content, keywordsContent(name), `${name} keywords drifted from lib/page-keywords.mjs`);
  }
});

test('keyword lists include brand terms, dedupe, and avoid the retired company name', () => {
  for (const page of Object.keys(PAGE_KEYWORDS)) {
    const terms = keywordsFor(page);
    const lower = terms.map((term) => term.toLowerCase());
    assert.equal(new Set(lower).size, lower.length, `${page} has duplicate keywords`);
    for (const brand of BRAND_KEYWORDS) assert.ok(terms.includes(brand), `${page} missing brand term ${brand}`);
    assert.ok(!lower.some((term) => term.includes('suede labs')), `${page} uses the retired company name`);
    assert.ok(terms.length >= 4 && terms.length <= 20, `${page} keyword count out of range`);
  }
});
