// Suede Scan/Audit — zero-dependency Node server.
// GET  /            → UI
// POST /api/scan    → fast tier (~10 checks, <5s)
// POST /api/audit   → deep tier (scan checks + extra lanes, graded report)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3400;

// ---------- fetching ----------

async function fetchPage(rawUrl) {
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const parsed = new URL(url); // throws on garbage
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs are supported');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(parsed.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'SuedeScan/1.0 (+https://suedeai.ai)' },
    });
    const html = await res.text();
    return { finalUrl: res.url, status: res.status, https: res.url.startsWith('https://'), html };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- HTML helpers (regex-based, good enough for a scan) ----------

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
const first = (html, re) => { const m = html.match(re); return m ? m[1].trim() : null; };
const count = (html, re) => (html.match(re) || []).length;
const attr = (tag, name) => { const m = tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i')); return m ? m[1] : null; };

function metaContent(html, nameOrProp) {
  const re = new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${nameOrProp}["'][^>]*>`, 'i');
  const m = html.match(re);
  return m ? attr(m[0], 'content') : null;
}

// ---------- checks ----------
// Each check: { id, lane, label, pass, value, advice }

function scanChecks(page) {
  const { html, https, status } = page;
  const body = strip(html);
  const title = first(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const desc = metaContent(html, 'description');
  const h1s = count(html, /<h1[\s>]/gi);
  const canonical = /<link[^>]+rel\s*=\s*["']canonical["']/i.test(html);
  const viewport = !!metaContent(html, 'viewport');
  const robotsMeta = metaContent(html, 'robots');
  const ogTitle = metaContent(html, 'og:title');
  const ogImage = metaContent(html, 'og:image');
  const imgs = html.match(/<img[^>]*>/gi) || [];
  const imgsWithAlt = imgs.filter((t) => /alt\s*=\s*["'][^"']+["']/i.test(t)).length;
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const noindex = robotsMeta ? /noindex/i.test(robotsMeta) : false;

  return [
    { id: 'status', lane: 'Access', label: 'Page reachable (2xx)', pass: status >= 200 && status < 300, value: `HTTP ${status}`, advice: 'Fix the response status — search engines skip non-2xx pages.' },
    { id: 'https', lane: 'Access', label: 'Served over HTTPS', pass: https, value: https ? 'yes' : 'no', advice: 'Move to HTTPS; it is a ranking and trust signal.' },
    { id: 'noindex', lane: 'Access', label: 'Not blocked by noindex', pass: !noindex, value: robotsMeta || 'no robots meta', advice: 'Remove the noindex directive if this page should rank.' },
    { id: 'title', lane: 'Metadata', label: 'Title tag 15–60 chars', pass: !!title && title.length >= 15 && title.length <= 60, value: title ? `"${title.slice(0, 80)}" (${title.length} chars)` : 'missing', advice: 'Write a 15–60 character title with the primary keyword up front.' },
    { id: 'desc', lane: 'Metadata', label: 'Meta description 50–160 chars', pass: !!desc && desc.length >= 50 && desc.length <= 160, value: desc ? `${desc.length} chars` : 'missing', advice: 'Add a 50–160 character meta description that earns the click.' },
    { id: 'h1', lane: 'Structure', label: 'Exactly one H1', pass: h1s === 1, value: `${h1s} found`, advice: 'Use exactly one H1 that states what the page is.' },
    { id: 'canonical', lane: 'Metadata', label: 'Canonical link present', pass: canonical, value: canonical ? 'present' : 'missing', advice: 'Add a canonical link to prevent duplicate-content dilution.' },
    { id: 'viewport', lane: 'Mobile', label: 'Viewport meta present', pass: viewport, value: viewport ? 'present' : 'missing', advice: 'Add a responsive viewport meta tag for mobile rendering.' },
    { id: 'og', lane: 'Social', label: 'Open Graph title + image', pass: !!ogTitle && !!ogImage, value: [ogTitle ? 'title ✓' : 'title ✗', ogImage ? 'image ✓' : 'image ✗'].join(', '), advice: 'Add og:title and og:image so shares render a rich preview.' },
    { id: 'alt', lane: 'Content', label: 'Images have alt text', pass: imgs.length === 0 || imgsWithAlt / imgs.length >= 0.8, value: `${imgsWithAlt}/${imgs.length} with alt`, advice: 'Give at least 80% of images descriptive alt text.' },
    { id: 'words', lane: 'Content', label: 'Substantive content (300+ words)', pass: words >= 300, value: `${words} words`, advice: 'Thin pages struggle to rank — aim for 300+ words of real content.' },
  ];
}

function auditChecks(page) {
  const { html } = page;
  const jsonLd = count(html, /<script[^>]+application\/ld\+json/gi);
  const lang = first(html, /<html[^>]+lang\s*=\s*["']([^"']+)["']/i);
  const twitter = !!metaContent(html, 'twitter:card');
  const favicon = /<link[^>]+rel\s*=\s*["'](?:shortcut )?icon["']/i.test(html);
  const h2s = count(html, /<h2[\s>]/gi);
  const links = html.match(/<a[^>]+href\s*=\s*["']([^"']+)["']/gi) || [];
  const internal = links.filter((l) => !/href\s*=\s*["']https?:\/\//i.test(l) || l.includes(new URL(page.finalUrl).hostname)).length;
  const inlineStyles = count(html, /style\s*=\s*["']/gi);
  const scripts = count(html, /<script[\s>]/gi);
  const htmlKb = Math.round(html.length / 1024);

  return [
    { id: 'schema', lane: 'Schema', label: 'JSON-LD structured data', pass: jsonLd > 0, value: `${jsonLd} block(s)`, advice: 'Add JSON-LD (Organization, Article, Product…) — required for rich results and AI citation.' },
    { id: 'lang', lane: 'Access', label: 'html lang attribute', pass: !!lang, value: lang || 'missing', advice: 'Declare the page language on the <html> tag.' },
    { id: 'twitter', lane: 'Social', label: 'Twitter card meta', pass: twitter, value: twitter ? 'present' : 'missing', advice: 'Add twitter:card so X/Twitter shares render a preview.' },
    { id: 'favicon', lane: 'Brand', label: 'Favicon declared', pass: favicon, value: favicon ? 'present' : 'missing', advice: 'Declare a favicon — it shows in SERPs and tabs.' },
    { id: 'h2', lane: 'Structure', label: 'H2 subheadings present', pass: h2s >= 2, value: `${h2s} found`, advice: 'Break content into scannable H2 sections — helps readers and AI answer engines.' },
    { id: 'links', lane: 'Structure', label: 'Internal links (3+)', pass: internal >= 3, value: `${internal} internal of ${links.length} total`, advice: 'Link to related pages on your own site to distribute authority.' },
    { id: 'weight', lane: 'Performance', label: 'HTML under 300 KB', pass: htmlKb <= 300, value: `${htmlKb} KB, ${scripts} scripts, ${inlineStyles} inline styles`, advice: 'Trim page weight — heavy HTML delays first paint.' },
  ];
}

function grade(pct) {
  return pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 55 ? 'D' : 'F';
}

function summarize(checks) {
  const passed = checks.filter((c) => c.pass).length;
  const pct = Math.round((passed / checks.length) * 100);
  const lanes = {};
  for (const c of checks) {
    lanes[c.lane] ??= { passed: 0, total: 0 };
    lanes[c.lane].total++;
    if (c.pass) lanes[c.lane].passed++;
  }
  const laneGrades = Object.fromEntries(
    Object.entries(lanes).map(([k, v]) => [k, grade(Math.round((v.passed / v.total) * 100))])
  );
  return { passed, total: checks.length, score: pct, grade: grade(pct), laneGrades };
}

// ---------- server ----------

async function handleApi(tier, req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let url;
  try { url = JSON.parse(raw).url; } catch { /* fallthrough */ }
  if (!url) return json(res, 400, { error: 'Missing url' });

  try {
    const page = await fetchPage(url);
    const checks = tier === 'audit' ? [...scanChecks(page), ...auditChecks(page)] : scanChecks(page);
    json(res, 200, { tier, url: page.finalUrl, ...summarize(checks), checks });
  } catch (e) {
    json(res, 502, { error: `Could not fetch that URL: ${e.message}` });
  }
}

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/scan') return await handleApi('scan', req, res);
    if (req.method === 'POST' && req.url === '/api/audit') return await handleApi('audit', req, res);
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const page = await readFile(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log(`Suede Scan running on http://localhost:${PORT}`));
