import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const HEDGES = /not proof|does not prove|does not guarantee|not guaranteed|no citation or ranking guarantee|still unmeasured/i;

test('homepage, method and llms files state what the score measures without hedging', () => {
  for (const file of ['index.html', 'method.html', 'llms.txt']) {
    assert.doesNotMatch(read(file), HEDGES, `${file} hedges`);
  }
  // llms-full.txt also carries the check reference, which quotes Google's own
  // "not guaranteed" indexing wording; check only the homepage and method sections.
  const full = read('llms-full.txt').split('\n## Audit Checks Reference')[0];
  assert.doesNotMatch(full, HEDGES, 'llms-full.txt homepage or method section hedges');
});

test('the citation question points buyers at the AI citation check', () => {
  for (const file of ['index.html', 'method.html', 'llms.txt']) {
    assert.match(read(file), /https:\/\/seo\.suedeai\.ai\/ai-citation-check/, `${file} names the next step`);
  }
});

test('FAQ JSON-LD answers match the visible FAQ word for word', () => {
  const html = read('index.html');
  const faq = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)]
    .map((m) => JSON.parse(m[1]))
    .flatMap((doc) => doc['@graph'] || [doc])
    .find((node) => node['@type'] === 'FAQPage');
  assert.ok(faq, 'FAQPage schema present');
  const text = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const visible = [...html.matchAll(/<details>\s*<summary>(.*?)<\/summary>\s*<p>(.*?)<\/p>\s*<\/details>/gs)]
    .map((m) => ({ q: text(m[1]), a: text(m[2]) }));
  assert.deepEqual(
    faq.mainEntity.map((q) => ({ q: q.name, a: q.acceptedAnswer.text })),
    visible,
  );
});
