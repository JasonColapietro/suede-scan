import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MAX_BYTES, renderLlmsFull, sitemapEntries } from '../scripts/build-llms-full.mjs';

const root = new URL('../', import.meta.url);
const committed = readFileSync(new URL('llms-full.txt', root), 'utf8');

test('llms-full.txt is exactly what the pages generate', () => {
  assert.equal(committed, renderLlmsFull(), 'llms-full.txt is stale. Run: node scripts/build-llms-full.mjs');
});

test('llms-full.txt covers every sitemap URL, stays Markdown and under budget', () => {
  assert.match(committed, /^# /);
  assert.ok(Buffer.byteLength(committed) <= MAX_BYTES);
  const listed = [...committed.matchAll(/^URL: (\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(listed, sitemapEntries().map(({ route }) => `https://optimize.suedeai.ai${route}`));
  assert.ok(!committed.includes('\u2014'), 'llms-full.txt carries an em dash');
});

test('llms.txt points readers at llms-full.txt', () => {
  assert.match(readFileSync(new URL('llms.txt', root), 'utf8'), /https:\/\/optimize\.suedeai\.ai\/llms-full\.txt/);
});
