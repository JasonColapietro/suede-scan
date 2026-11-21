import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
    assert.match(read(file), /https:\/\/suedeai\.ai\/seo\/ai-citation-check/, `${file} names the next step`);
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

// The company is "Suede" (owner direction, 2026-11-21). "Suede AI" and
// "Suede Labs" survive only as schema alternateName values and one
// "formerly known as" alias line per discovery file. The verbatim Google
// search query quoted in the Manifest note is a third-party record.
const RETIRED_NAME = /\bsuede[\s\u00a0](?:ai|labs)\b/i;
const NAME_EXEMPT = [
  /"alternateName"\s*:\s*(?:\[[^\]]*\]|"[^"]*")/g,
  /^.*formerly known as Suede AI and Suede Labs\..*$/gm,
  /search for "Suede labs ai review,"/g,
];

test('public copy names the company Suede, never Suede AI or Suede Labs', () => {
  const dirs = ['', 'checks/', 'notes/'];
  const files = dirs.flatMap((dir) => readdirSync(new URL(dir || './', root))
    .filter((name) => /\.(?:html|txt|xml|json)$/.test(name) && name !== 'package.json' && name !== 'package-lock.json')
    .map((name) => dir + name));
  const hits = [];
  for (const file of files) {
    let text = read(file);
    for (const exempt of NAME_EXEMPT) text = text.replace(exempt, '');
    text.split('\n').forEach((line, i) => {
      if (RETIRED_NAME.test(line)) hits.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], `retired company name in public copy: ${hits.join(', ')}`);
});
