#!/usr/bin/env node
// Build llms-full.txt: the full readable text of every page in sitemap.xml.
//
//   node scripts/build-llms-full.mjs           write llms-full.txt
//   node scripts/build-llms-full.mjs --check   exit 1 when llms-full.txt is stale
//
// llms.txt is the short index. llms-full.txt is what an answer engine reads
// when it wants the pages themselves without running a browser, so it is
// generated from the same committed HTML the server sends. Edit a page, then
// re-run this; test/llms-full.test.mjs fails when the two drift.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://optimize.suedeai.ai';
export const MAX_BYTES = 500_000;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', hellip: '…', middot: '·', times: '×', ndash: '–',
  mdash: '–', rarr: '→', larr: '←',
};
const decode = (value) => value
  .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCodePoint(Number.parseInt(c, 16)))
  .replace(/&#(\d+);/g, (_, c) => String.fromCodePoint(Number(c)))
  .replace(/&([a-z0-9]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);

const absolute = (href) => {
  if (!href || href.startsWith('#') || /^(?:mailto|tel|javascript):/i.test(href)) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return href.startsWith('/') ? ORIGIN + href : null;
};

// Code spans are decoded on their own, once, and protected from the outer
// decode: the check pages write literal entity names such as &amp;mdash; and
// a second pass would turn them back into the characters they describe.
function inline(html) {
  const code = [];
  const protectedHtml = html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, body) => {
    code.push(decode(body.replace(/<[^>]+>/g, '')));
    return `\u0000${code.length - 1}\u0000`;
  });
  return inlineText(protectedHtml).replace(/\u0000(\d+)\u0000/g, (_, i) => `\`${code[Number(i)]}\``);
}

function inlineText(html) {
  return decode(html
    .replace(/<span\b[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<(?:svg|button|select|input|textarea)\b[\s\S]*?(?:<\/(?:svg|button|select|textarea)>|\/?>)/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, body) => {
      const label = inline(body);
      const url = absolute((attrs.match(/\bhref="([^"]*)"/) ?? [])[1]);
      if (!label) return '';
      if (!url || url.startsWith(`${ORIGIN}/`) || url === ORIGIN || label.includes(url)) return label;
      return `[${label}](${url})`;
    })
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\n ]+/g, ' ')
    .replace(/\s+([,.;:!?)])/g, '$1')
    .trim();
}

const BLOCK = /<(h[1-6]|p|li|summary|tr|pre|caption)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

// Remove every element carrying the boolean `hidden` attribute, with all of
// its descendants. A regex cannot match nested tags of the same name, so walk
// the tags and count depth.
function stripHidden(html) {
  const VOID = /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
  let out = html;
  for (;;) {
    const open = out.match(/<([a-z][a-z0-9]*)\b(?=[^>]*\shidden(?:[\s=>]|$))[^>]*>/i);
    if (!open) return out;
    const name = open[1].toLowerCase();
    const start = open.index;
    let end = start + open[0].length;
    if (!VOID.test(name)) {
      const tags = new RegExp(`<(/?)${name}\\b[^>]*>`, 'gi');
      tags.lastIndex = end;
      let depth = 1;
      for (let m = tags.exec(out); m; m = tags.exec(out)) {
        depth += m[1] ? -1 : 1;
        if (depth === 0) { end = m.index + m[0].length; break; }
      }
      if (depth !== 0) end = out.length;
    }
    out = out.slice(0, start) + out.slice(end);
  }
}

function mainText(html) {
  let body = (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) ?? [, html])[1];
  body = stripHidden(body.replace(/<!--[\s\S]*?-->/g, ''))
    .replace(/<(script|style|noscript|svg|template|form)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, '')
    .replace(/<a class="text-link"[^>]*>[\s\S]*?<\/a>/gi, '');
  const lines = [];
  let last = '';
  for (const m of body.matchAll(BLOCK)) {
    const tag = m[1].toLowerCase();
    if (tag === 'tr') {
      const cells = [...m[3].matchAll(/<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((c) => inline(c[2])).filter(Boolean);
      if (cells.length) lines.push(`- ${cells.join(' | ')}`);
      continue;
    }
    const inner = /^li$/.test(tag) ? m[3].replace(/<(p|ul|ol)\b[\s\S]*?<\/\1>/gi, ' ') : m[3];
    const t = inline(inner);
    if (!t || t === last) continue;
    last = t;
    if (/^h[1-6]$/.test(tag)) lines.push('', `${'#'.repeat(Math.min(6, Number(tag[1]) + 1))} ${t}`, '');
    else if (tag === 'li') lines.push(`- ${t}`);
    else if (tag === 'summary') lines.push('', `Q: ${t}`);
    else if (tag === 'pre') lines.push('```', t, '```');
    else lines.push(t);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const meta = (html, name) => decode((html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`)) ?? [])[1] ?? '');

function routeFile(route) {
  if (route === '/') return 'index.html';
  const direct = `${route.slice(1)}.html`;
  if (existsSync(path.join(ROOT, direct))) return direct;
  const index = `${route.slice(1)}/index.html`;
  return existsSync(path.join(ROOT, index)) ? index : null;
}

export function sitemapEntries() {
  return [...readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8').matchAll(/<url>([\s\S]*?)<\/url>/g)].map(([, block]) => ({
    route: block.match(/<loc>https:\/\/optimize\.suedeai\.ai([^<]*)<\/loc>/)[1] || '/',
    lastmod: (block.match(/<lastmod>([^<]+)<\/lastmod>/) ?? [])[1] ?? null,
  }));
}

export function renderLlmsFull() {
  const sections = sitemapEntries().map(({ route, lastmod }) => {
    const file = routeFile(route);
    if (!file) throw new Error(`sitemap route ${route} has no HTML file`);
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    const title = decode((html.match(/<title>([^<]*)<\/title>/) ?? [])[1] ?? '').trim();
    return [
      `## ${title}`,
      '',
      `URL: ${ORIGIN}${route}`,
      ...(lastmod ? [`Updated: ${lastmod}`] : []),
      `Summary: ${meta(html, 'description')}`,
      '',
      mainText(html),
    ].join('\n');
  });
  return [
    '# Suede Audit: full text',
    '',
    '> The complete readable text of every public page on optimize.suedeai.ai, the free',
    '> AI visibility and SEO readiness audit from Suede AI (https://suedeai.ai/), founded',
    '> by Jason Colapietro. Pages appear in sitemap order; each section gives the page URL,',
    '> its last update and its summary, then the page text.',
    '',
    'Index: https://optimize.suedeai.ai/llms.txt',
    'Sitemap: https://optimize.suedeai.ai/sitemap.xml',
    'Audit source code: https://github.com/JasonColapietro/suede-scan',
    'Implementation service: https://seo.suedeai.ai/',
    '',
    sections.join('\n\n---\n\n'),
    '',
  ].join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = path.join(ROOT, 'llms-full.txt');
  const rendered = renderLlmsFull();
  const bytes = Buffer.byteLength(rendered);
  if (bytes > MAX_BYTES) {
    console.error(`llms-full.txt would be ${bytes} bytes, over the ${MAX_BYTES}-byte budget`);
    process.exit(1);
  }
  const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
  if (process.argv.includes('--check')) {
    if (current !== rendered) {
      console.error('llms-full.txt is stale. Run: node scripts/build-llms-full.mjs');
      process.exit(1);
    }
    console.log(`llms-full.txt is current (${bytes} bytes).`);
  } else if (current !== rendered) {
    writeFileSync(target, rendered);
    console.log(`Wrote llms-full.txt (${bytes} bytes).`);
  } else {
    console.log(`llms-full.txt is current (${bytes} bytes).`);
  }
}
