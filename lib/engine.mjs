// Suede Audit engine. It inspects public site signals and crawler policy.
// It does not run prompts inside answer engines or predict citation outcomes.

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const USER_AGENT = 'SuedeAudit/2.0 (+https://audit.suedeai.ai)';
const HTML_LIMIT_BYTES = 1_500_000;
const AUX_LIMIT_BYTES = 256_000;
const MAX_REDIRECTS = 5;
const SEVERITY_WEIGHT = { high: 5, medium: 3, low: 1 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function validateUrlObject(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only public HTTP and HTTPS URLs are supported.');
  }
  if (url.username || url.password) {
    throw new Error('Credentials cannot be included in the URL.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('Only ports 80 and 443 can be inspected.');
  }
  url.hash = '';
  return url;
}

export function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0 || rawUrl.length > 2048) {
    throw new Error('Enter a public website URL.');
  }
  let value = rawUrl.trim();
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;
  try {
    return validateUrlObject(new URL(value));
  } catch (error) {
    if (error?.message?.startsWith('Only ') || error?.message?.startsWith('Credentials')) throw error;
    throw new Error('Enter a valid public website URL.');
  }
}

function privateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && [0, 168].includes(b)) ||
    (a === 198 && [18, 19, 51].includes(b)) ||
    (a === 203 && b === 0) ||
    a >= 224
  );
}

export function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split('%')[0];
  const family = isIP(normalized);
  if (family === 4) return privateIpv4(normalized);
  if (family !== 6) return true;

  if (normalized.includes('.')) {
    const mapped = normalized.slice(normalized.lastIndexOf(':') + 1);
    if (isIP(mapped) === 4) return privateIpv4(mapped);
  }

  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('::ffff:') ||
    /^(?:0:){5}ffff:/.test(normalized) ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:')
  );
}

export async function assertPublicUrl(url, { lookupImpl = dnsLookup } = {}) {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'metadata.google.internal'
  ) {
    throw new Error('Public internet domains only.');
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Public internet domains only.');
    return [{ address: hostname, family: isIP(hostname) }];
  }

  let records;
  try {
    records = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('That domain did not resolve to a public website.');
  }
  const list = Array.isArray(records) ? records : [records];
  if (list.length === 0 || list.some((record) => !record?.address || isPrivateAddress(record.address))) {
    throw new Error('Public internet domains only.');
  }
  return list;
}

function nodeRequest(url, { addresses, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const pinned = addresses.find((record) => record.family === 4) || addresses[0];
    const request = transport.request(url, {
      method: 'GET',
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.8,*/*;q=0.5',
        'accept-encoding': 'identity',
        'user-agent': USER_AGENT,
      },
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, addresses.map((record) => ({ address: record.address, family: record.family })));
        else callback(null, pinned.address, pinned.family);
      },
    }, (response) => {
      response.setTimeout(timeoutMs, () => response.destroy(Object.assign(new Error('Response timed out'), { code: 'ETIMEDOUT' })));
      resolve({
        status: response.statusCode || 0,
        headers: {
          get(name) {
            const value = response.headers[String(name).toLowerCase()];
            return Array.isArray(value) ? value.join(', ') : value == null ? null : String(value);
          },
        },
        body: response,
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => {
      if (error.code === 'ETIMEDOUT') reject(new Error('The website took too long to respond.'));
      else reject(new Error('The website could not be reached.'));
    });
    request.end();
  });
}

async function requestPublicUrl(rawUrl, options = {}) {
  const {
    fetchImpl,
    lookupImpl = dnsLookup,
    requestImpl = nodeRequest,
    timeoutMs = 15_000,
    maxRedirects = MAX_REDIRECTS,
  } = options;
  let current = rawUrl instanceof URL ? validateUrlObject(new URL(rawUrl.href)) : normalizeUrl(rawUrl);

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const addresses = await assertPublicUrl(current, { lookupImpl });
    let response;
    if (fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await fetchImpl(current.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.8,*/*;q=0.5',
            'user-agent': USER_AGENT,
          },
        });
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('The website took too long to respond.');
        throw new Error('The website could not be reached.');
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await requestImpl(current, { addresses, timeoutMs });
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirect === maxRedirects) throw new Error('The website redirected too many times.');
      current = validateUrlObject(new URL(response.headers.get('location'), current));
      response.body?.resume?.();
      if (typeof response.body?.cancel === 'function') await response.body.cancel().catch(() => {});
      continue;
    }

    return { response, finalUrl: current.href };
  }
  throw new Error('The website redirected too many times.');
}

async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('The page is too large to inspect safely.');

  if (!response.body?.getReader && typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error('The page is too large to inspect safely.');
    return text;
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error('The page is too large to inspect safely.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  if (response.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) {
      const value = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      total += value.byteLength;
      if (total > maxBytes) {
        response.body.destroy?.();
        throw new Error('The page is too large to inspect safely.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  }

  throw new Error('The website response could not be read.');
}

async function fetchTextResource(url, options = {}) {
  const { limit = AUX_LIMIT_BYTES, required = false } = options;
  try {
    const { response, finalUrl } = await requestPublicUrl(url, options);
    const text = await readLimitedText(response, limit);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      url: finalUrl,
      contentType: response.headers.get('content-type') || '',
      text,
    };
  } catch (error) {
    const publicMessages = new Set([
      'Only public HTTP and HTTPS URLs are supported.',
      'Credentials cannot be included in the URL.',
      'Only ports 80 and 443 can be inspected.',
      'Enter a valid public website URL.',
      'Public internet domains only.',
      'That domain did not resolve to a public website.',
      'The website took too long to respond.',
      'The website could not be reached.',
      'The website redirected too many times.',
      'The page is too large to inspect safely.',
      'The website response could not be read.',
    ]);
    const message = publicMessages.has(error?.message)
      ? error.message
      : 'The website response ended before it could be inspected.';
    if (required) throw new Error(message);
    return { ok: false, status: 0, url: url.href || String(url), contentType: '', text: null, error: message };
  }
}

export async function fetchPage(rawUrl, options = {}) {
  const target = normalizeUrl(rawUrl);
  const main = await fetchTextResource(target, { ...options, required: true, limit: HTML_LIMIT_BYTES });
  if (main.contentType && !/html|xhtml/i.test(main.contentType)) {
    throw new Error('That URL did not return an HTML page.');
  }

  const final = new URL(main.url);
  const artifacts = options.includeArtifacts === false
    ? {}
    : Object.fromEntries(await Promise.all(
      [
        ['robots', new URL('/robots.txt', final)],
        ['llms', new URL('/llms.txt', final)],
        ['sitemap', new URL('/sitemap.xml', final)],
      ].map(async ([key, url]) => [key, await fetchTextResource(url, options)]),
    ));

  return {
    requestedUrl: target.href,
    finalUrl: main.url,
    status: main.status,
    https: final.protocol === 'https:',
    html: main.text,
    artifacts,
  };
}

const strip = (value) => value
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<!--([\s\S]*?)-->/g, '');
const first = (html, pattern) => html.match(pattern)?.[1]?.trim() || null;
const count = (html, pattern) => (html.match(pattern) || []).length;
const attr = (tag, name) => tag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || null;

function metaContent(html, nameOrProperty) {
  const escaped = nameOrProperty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${escaped}["'][^>]*>`, 'i'))?.[0];
  return tag ? attr(tag, 'content') : null;
}

function linkRel(html, relPattern) {
  return (html.match(/<link[^>]*>/gi) || []).some((tag) => relPattern.test(attr(tag, 'rel') || ''));
}

function schemaData(html) {
  const blocks = [];
  const pattern = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      blocks.push(null);
    }
  }

  const types = new Set();
  let hasSameAs = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = node['@type'];
    if (Array.isArray(type)) type.forEach((item) => types.add(String(item)));
    else if (type) types.add(String(type));
    if (Array.isArray(node.sameAs) ? node.sameAs.length > 0 : Boolean(node.sameAs)) hasSameAs = true;
    Object.values(node).forEach(visit);
  };
  blocks.forEach(visit);
  return { count: blocks.length, validCount: blocks.filter(Boolean).length, types: [...types], hasSameAs };
}

function parseRobotsGroups(text) {
  if (!text) return [];
  const groups = [];
  let agents = [];
  let rules = [];
  const flush = () => {
    if (agents.length > 0) groups.push({ agents, rules });
    agents = [];
    rules = [];
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (rules.length > 0) flush();
      agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && agents.length > 0) {
      rules.push({ field, value });
    }
  }
  flush();
  return groups;
}

export function crawlerPolicy(robotsText, crawler, path = '/') {
  if (!robotsText) {
    return { state: 'open', detail: 'No robots.txt block detected.' };
  }
  const groups = parseRobotsGroups(robotsText);
  const name = crawler.toLowerCase();
  const exact = groups.filter((group) => group.agents.includes(name));
  const selected = exact.length > 0 ? exact : groups.filter((group) => group.agents.includes('*'));
  const matching = selected
    .flatMap((group) => group.rules)
    .filter((rule) => rule.value && path.startsWith(rule.value.replace(/[$*].*$/, '')))
    .sort((a, b) => b.value.length - a.value.length || (a.field === 'allow' ? -1 : 1));
  const rule = matching[0];
  if (rule?.field === 'disallow') {
    return { state: 'blocked', detail: `${crawler} is blocked from ${rule.value}.` };
  }
  if (exact.length > 0 || rule) {
    return { state: 'open', detail: `${crawler} is allowed to inspect the public page.` };
  }
  return { state: 'open', detail: `No ${crawler} block is declared.` };
}

function makeCheck(id, lane, label, pass, value, advice, severity = 'medium', extras = {}) {
  return { id, lane, label, pass: Boolean(pass), value, advice, severity, ...extras };
}

export function scanChecks(page) {
  const { html, https, status } = page;
  const body = strip(html);
  const title = first(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const description = metaContent(html, 'description');
  const h1s = count(html, /<h1[\s>]/gi);
  const canonical = (html.match(/<link[^>]*>/gi) || []).some((tag) => /(?:^|\s)canonical(?:\s|$)/i.test(attr(tag, 'rel') || ''));
  const viewport = Boolean(metaContent(html, 'viewport'));
  const robotsMeta = metaContent(html, 'robots');
  const images = html.match(/<img[^>]*>/gi) || [];
  const imagesWithAlt = images.filter((tag) => /alt\s*=\s*["'][^"']+["']/i.test(tag)).length;
  const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const noindex = robotsMeta ? /noindex/i.test(robotsMeta) : false;

  return [
    makeCheck('status', 'Access', 'Page returns a successful response', status >= 200 && status < 300, `HTTP ${status}`, 'Return a 2xx status for the public page.', 'high'),
    makeCheck('https', 'Access', 'Page is served over HTTPS', https, https ? 'HTTPS' : 'HTTP', 'Serve the page over HTTPS and redirect the HTTP version.', 'high'),
    makeCheck('noindex', 'Access', 'Page can be indexed', !noindex, robotsMeta || 'No robots meta block', 'Remove the noindex directive if the page should be discovered.', 'high'),
    makeCheck('title', 'Metadata', 'Title is specific and scannable', title && title.length >= 15 && title.length <= 60, title ? `${title.slice(0, 80)} (${title.length} characters)` : 'Missing', 'Write a 15 to 60 character title with the page topic near the front.'),
    makeCheck('description', 'Metadata', 'Meta description explains the page', description && description.length >= 50 && description.length <= 160, description ? `${description.length} characters` : 'Missing', 'Add a 50 to 160 character description that states the page outcome.'),
    makeCheck('h1', 'Content', 'Page has exactly one H1', h1s === 1, `${h1s} found`, 'Use one H1 that states the page subject.'),
    makeCheck('canonical', 'Technical', 'Canonical link is declared', canonical, canonical ? 'Present' : 'Missing', 'Add a canonical URL for the preferred page version.'),
    makeCheck('viewport', 'Technical', 'Mobile viewport is declared', viewport, viewport ? 'Present' : 'Missing', 'Add a responsive viewport meta tag.', 'high'),
    makeCheck('open-graph', 'Metadata', 'Open Graph title and image are present', Boolean(metaContent(html, 'og:title') && metaContent(html, 'og:image')), `${metaContent(html, 'og:title') ? 'title' : 'no title'}, ${metaContent(html, 'og:image') ? 'image' : 'no image'}`, 'Add Open Graph title and image metadata.', 'low'),
    makeCheck('image-alt', 'Content', 'Images carry descriptive alt text', images.length === 0 || imagesWithAlt / images.length >= 0.8, `${imagesWithAlt} of ${images.length} images`, 'Add meaningful alt text to at least 80 percent of content images.', 'low'),
    makeCheck('content-depth', 'Content', 'Page has substantive readable content', words >= 300, `${words} words`, 'Add direct, answer-ready copy that explains the subject in at least 300 useful words.'),
  ];
}

function platformCheck(page, id, name, crawler) {
  const robots = page.artifacts?.robots;
  const policy = robots?.ok
    ? crawlerPolicy(robots.text, crawler)
    : robots?.status === 404
      ? { state: 'open', detail: 'No robots.txt file was published; no homepage block was detected.' }
      : { state: 'unknown', detail: 'robots.txt could not be inspected, so crawler access is not confirmed.' };
  return makeCheck(
    `crawler-${id}`,
    'AI discovery',
    `${name} crawler can access the homepage`,
    policy.state === 'open',
    policy.state.charAt(0).toUpperCase() + policy.state.slice(1),
    `Update robots.txt so ${crawler} can access the public pages you want discovered.`,
    'high',
    { platform: { id, name, crawler, state: policy.state, detail: policy.detail } },
  );
}

export function auditChecks(page) {
  const { html, artifacts = {} } = page;
  const schemas = schemaData(html);
  const h2s = count(html, /<h2[\s>]/gi);
  const links = html.match(/<a[^>]+href\s*=\s*["']([^"']+)["']/gi) || [];
  const host = new URL(page.finalUrl).hostname;
  const internalLinks = links.filter((tag) => {
    const value = attr(tag, 'href');
    if (!value || /^(mailto:|tel:|javascript:|#)/i.test(value)) return false;
    try {
      return new URL(value, page.finalUrl).hostname === host;
    } catch {
      return false;
    }
  }).length;
  const inlineStyles = count(html, /style\s*=\s*["']/gi);
  const scripts = count(html, /<script[\s>]/gi);
  const htmlKb = Math.round(Buffer.byteLength(html) / 1024);
  const language = first(html, /<html[^>]+lang\s*=\s*["']([^"']+)["']/i);
  const organizationTypes = new Set(['Organization', 'Corporation', 'LocalBusiness', 'OnlineBusiness', 'Person']);
  const hasEntity = schemas.types.some((type) => organizationTypes.has(type));

  return [
    makeCheck('robots', 'Technical', 'robots.txt is available', artifacts.robots?.ok, artifacts.robots?.ok ? `HTTP ${artifacts.robots.status}` : `HTTP ${artifacts.robots?.status || 0}`, 'Publish a clear robots.txt at the site root.', 'low'),
    makeCheck('sitemap', 'Technical', 'XML sitemap is available', artifacts.sitemap?.ok, artifacts.sitemap?.ok ? `HTTP ${artifacts.sitemap.status}` : `HTTP ${artifacts.sitemap?.status || 0}`, 'Publish a sitemap.xml that lists canonical public pages.'),
    platformCheck(page, 'openai', 'OpenAI search', 'OAI-SearchBot'),
    platformCheck(page, 'perplexity', 'Perplexity', 'PerplexityBot'),
    platformCheck(page, 'google', 'Google discovery', 'Googlebot'),
    makeCheck('llms', 'AI discovery', 'llms.txt evidence index is available', artifacts.llms?.ok && Boolean(artifacts.llms.text?.trim()), artifacts.llms?.ok ? `HTTP ${artifacts.llms.status}` : 'Not found', 'Publish an accurate llms.txt as an optional plain-text evidence index.', 'low'),
    makeCheck('schema', 'Entity', 'Valid JSON-LD is present', schemas.validCount > 0, `${schemas.validCount} valid of ${schemas.count} blocks`, 'Add valid JSON-LD for the organization and the page subject.', 'high'),
    makeCheck('entity-type', 'Entity', 'A primary entity type is declared', hasEntity, schemas.types.length ? schemas.types.join(', ') : 'No types found', 'Declare the primary Organization, Person, or business entity in JSON-LD.', 'high'),
    makeCheck('same-as', 'Entity', 'Entity identity links are declared', schemas.hasSameAs, schemas.hasSameAs ? 'sameAs present' : 'Missing', 'Add verified public identity URLs through sameAs on the primary entity.'),
    makeCheck('language', 'Access', 'Document language is declared', Boolean(language), language || 'Missing', 'Set the html lang attribute.', 'low'),
    makeCheck('twitter-card', 'Metadata', 'X card metadata is present', Boolean(metaContent(html, 'twitter:card')), metaContent(html, 'twitter:card') || 'Missing', 'Add twitter:card metadata for reliable X previews.', 'low'),
    makeCheck('favicon', 'Metadata', 'A favicon is declared', linkRel(html, /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/i), linkRel(html, /(?:^|\s)(?:shortcut\s+)?icon(?:\s|$)/i) ? 'Present' : 'Missing', 'Declare a favicon for browser and result-page identity.', 'low'),
    makeCheck('h2', 'Content', 'Page uses explanatory H2 sections', h2s >= 2, `${h2s} found`, 'Break the page into at least two descriptive H2 sections.'),
    makeCheck('internal-links', 'Content', 'Page points to supporting internal evidence', internalLinks >= 3, `${internalLinks} internal of ${links.length} links`, 'Link to at least three relevant internal pages with descriptive anchor text.'),
    makeCheck('html-weight', 'Performance', 'HTML response stays under 300 KB', htmlKb <= 300, `${htmlKb} KB, ${scripts} scripts, ${inlineStyles} inline styles`, 'Reduce server-rendered HTML and inline payloads below 300 KB.'),
  ];
}

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 55) return 'D';
  return 'F';
}

export function summarize(checks) {
  const totalWeight = checks.reduce((sum, check) => sum + SEVERITY_WEIGHT[check.severity], 0);
  const passedWeight = checks.filter((check) => check.pass).reduce((sum, check) => sum + SEVERITY_WEIGHT[check.severity], 0);
  const score = totalWeight ? Math.round((passedWeight / totalWeight) * 100) : 0;
  const lanes = {};
  for (const check of checks) {
    lanes[check.lane] ??= { passed: 0, total: 0, passedWeight: 0, totalWeight: 0, highImpactOpen: 0 };
    const lane = lanes[check.lane];
    lane.total += 1;
    lane.totalWeight += SEVERITY_WEIGHT[check.severity];
    if (check.pass) {
      lane.passed += 1;
      lane.passedWeight += SEVERITY_WEIGHT[check.severity];
    } else if (check.severity === 'high') {
      lane.highImpactOpen += 1;
    }
  }

  const laneScores = Object.fromEntries(Object.entries(lanes).map(([name, lane]) => {
    const laneScore = Math.round((lane.passedWeight / lane.totalWeight) * 100);
    return [name, {
      score: laneScore,
      grade: grade(laneScore),
      passed: lane.passed,
      total: lane.total,
      highImpactOpen: lane.highImpactOpen,
    }];
  }));
  const recommendations = checks
    .filter((check) => !check.pass)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.lane.localeCompare(b.lane))
    .map((check) => ({
      id: check.id,
      lane: check.lane,
      title: check.label,
      severity: check.severity,
      observed: check.value,
      action: check.advice,
    }));

  const pillarDefinitions = [
    { id: 'discoverability', name: 'Discoverability', lanes: ['Access', 'Technical', 'AI discovery'], description: 'Reachability, crawl policy, canonical routing, and public discovery files.' },
    { id: 'entity', name: 'Entity evidence', lanes: ['Entity'], description: 'Structured identity, organization type, and verified identity links.' },
    { id: 'content', name: 'Content clarity', lanes: ['Metadata', 'Content', 'Performance'], description: 'Page meaning, supporting content, share metadata, and response weight.' },
  ];
  const pillarScores = pillarDefinitions.map((pillar) => {
    const selected = checks.filter((check) => pillar.lanes.includes(check.lane));
    const selectedWeight = selected.reduce((sum, check) => sum + SEVERITY_WEIGHT[check.severity], 0);
    const selectedPassed = selected.filter((check) => check.pass).reduce((sum, check) => sum + SEVERITY_WEIGHT[check.severity], 0);
    const pillarScore = selectedWeight ? Math.round((selectedPassed / selectedWeight) * 100) : 0;
    return {
      ...pillar,
      score: pillarScore,
      grade: grade(pillarScore),
      passed: selected.filter((check) => check.pass).length,
      total: selected.length,
    };
  });

  return {
    passed: checks.filter((check) => check.pass).length,
    total: checks.length,
    score,
    grade: grade(score),
    laneGrades: Object.fromEntries(Object.entries(laneScores).map(([name, lane]) => [name, lane.grade])),
    laneScores,
    pillarScores,
    recommendations,
    platforms: checks.filter((check) => check.platform).map((check) => check.platform),
  };
}

export async function runTier(tier, url, options = {}) {
  if (!['scan', 'audit'].includes(tier)) throw new Error('Unknown audit tier.');
  const started = Date.now();
  const page = await fetchPage(url, { ...options, includeArtifacts: tier === 'audit' });
  const checks = tier === 'audit' ? [...scanChecks(page), ...auditChecks(page)] : scanChecks(page);
  const publicArtifacts = Object.fromEntries(Object.entries(page.artifacts).map(([name, artifact]) => [name, {
    ok: artifact.ok,
    status: artifact.status,
    url: artifact.url,
  }]));

  return {
    tier,
    url: page.finalUrl,
    requestedUrl: page.requestedUrl,
    host: new URL(page.finalUrl).hostname,
    auditedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    methodology: 'Automated inspection of public HTML, robots.txt, llms.txt, and sitemap.xml. This report does not run prompts inside AI answer engines or predict citations.',
    ...summarize(checks),
    checks,
    artifacts: publicArtifacts,
  };
}
