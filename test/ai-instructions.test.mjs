import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const html = read('ai-instructions.html');

test('ai-instructions schema, footer and sitemap agree on the update date', () => {
  const block = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
  const page = JSON.parse(block)['@graph'].find((node) => node['@type'] === 'WebPage');
  assert.equal(page.url, 'https://optimize.suedeai.ai/ai-instructions');
  const updated = html.match(/Updated (\w+ \d{1,2}, \d{4})\./)?.[1];
  assert.ok(updated, 'footer states the update date');
  assert.equal(new Date(`${updated} UTC`).toISOString().slice(0, 10), page.dateModified);
  assert.match(read('sitemap.xml'), new RegExp(`ai-instructions</loc>\\s*<lastmod>${page.dateModified}</lastmod>`));
});

test('ai-instructions copy states facts without hedging', () => {
  assert.doesNotMatch(html, /not guaranteed|do not establish|does not guarantee|is not proof/i);
});

test('duplicate URL forms 308 to the canonical one', () => {
  const config = JSON.parse(read('vercel.json'));
  assert.equal(config.trailingSlash, false);
  assert.ok(config.redirects.some((r) => r.source === '/ai-instructions.html' && r.destination === '/ai-instructions' && r.permanent));
});
