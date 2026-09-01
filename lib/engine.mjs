// Suede Audit engine. It inspects public site signals and crawler policy.
// It does not run prompts inside answer engines or predict citation outcomes.

import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

const USER_AGENT = 'SuedeAudit/2.0 (+https://optimize.suedeai.ai)';
const HTML_LIMIT_BYTES = 1_500_000;
const AUX_LIMIT_BYTES = 256_000;
const CRAWL_PAGE_LIMIT_BYTES = 512_000;
const MAX_REDIRECTS = 5;
const SEVERITY_WEIGHT = { high: 5, medium: 3, low: 1 };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };
const DEFAULT_CRAWL_LIMITS = Object.freeze({
  maxPages: 6,
  maxLinks: 30,
  maxRequests: 40,
  maxDepth: 1,
  maxFindings: 12,
  maxTotalMs: 20_000,
});
const HARD_CRAWL_LIMITS = Object.freeze({
  maxPages: 20,
  maxLinks: 120,
  maxRequests: 150,
  maxDepth: 2,
  maxFindings: 40,
  maxTotalMs: 45_000,
});

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

function nodeRequest(url, { addresses, timeoutMs, signal }) {
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
      signal?.removeEventListener('abort', abortRequest);
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
    const abortRequest = () => request.destroy(Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', abortRequest, { once: true });
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' })));
    request.on('error', (error) => {
      signal?.removeEventListener('abort', abortRequest);
      if (error.code === 'ETIMEDOUT') reject(new Error('The website took too long to respond.'));
      else if (error.code === 'ABORT_ERR') reject(new Error('The audit reached its response deadline.'));
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
    allowedOrigin,
    disallowQuery = false,
    requestBudget,
    deadline,
  } = options;
  let current = rawUrl instanceof URL ? validateUrlObject(new URL(rawUrl.href)) : normalizeUrl(rawUrl);
  const redirects = [];

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const absoluteDeadline = Math.min(
      Number.isFinite(deadline) ? deadline : Number.POSITIVE_INFINITY,
      Number.isFinite(requestBudget?.deadline) ? requestBudget.deadline : Number.POSITIVE_INFINITY,
    );
    if (Date.now() >= absoluteDeadline) throw new Error('The audit reached its response deadline.');
    if (allowedOrigin && current.origin !== allowedOrigin) throw new Error('The link redirected outside the audited site.');
    if (disallowQuery && current.search) throw new Error('Query-bearing links are not crawled.');
    if (requestBudget) {
      if (Date.now() >= requestBudget.deadline) throw new Error('The site crawl reached its time budget.');
      if (requestBudget.requests >= requestBudget.maxRequests) throw new Error('The site crawl reached its request budget.');
      requestBudget.requests += 1;
    }
    const addresses = await awaitBeforeDeadline(assertPublicUrl(current, { lookupImpl }), absoluteDeadline);
    if (Date.now() >= absoluteDeadline) throw new Error('The audit reached its response deadline.');
    const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, absoluteDeadline - Date.now()));
    let response;
    if (fetchImpl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
      try {
        response = await awaitBeforeDeadline(
          fetchImpl(current.href, {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              accept: 'text/html,application/xhtml+xml,text/plain,application/xml;q=0.8,*/*;q=0.5',
              'user-agent': USER_AGENT,
            },
          }),
          absoluteDeadline,
          () => controller.abort(),
        );
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error('The website took too long to respond.');
        throw new Error('The website could not be reached.');
      } finally {
        clearTimeout(timer);
      }
    } else {
      const controller = new AbortController();
      response = await awaitBeforeDeadline(
        requestImpl(current, { addresses, timeoutMs: effectiveTimeoutMs, signal: controller.signal }),
        absoluteDeadline,
        () => controller.abort(),
      );
    }

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      if (redirect === maxRedirects) throw new Error('The website redirected too many times.');
      const next = validateUrlObject(new URL(response.headers.get('location'), current));
      redirects.push({ status: response.status, from: current.href, to: next.href });
      current = next;
      response.body?.resume?.();
      if (typeof response.body?.cancel === 'function') void response.body.cancel().catch(() => {});
      continue;
    }

    return { response, finalUrl: current.href, redirects };
  }
  throw new Error('The website redirected too many times.');
}

async function awaitBeforeDeadline(promise, deadline, onTimeout) {
  if (!Number.isFinite(deadline)) return promise;
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error('The audit reached its response deadline.');
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('The audit reached its response deadline.'));
          try { onTimeout?.(); } catch { /* best-effort cleanup */ }
        }, remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readLimitedText(response, maxBytes, deadline) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('The page is too large to inspect safely.');

  if (!response.body?.getReader && typeof response.text === 'function') {
    const text = await awaitBeforeDeadline(
      response.text(),
      deadline,
      () => { if (typeof response.body?.cancel === 'function') void response.body.cancel().catch(() => {}); },
    );
    if (Buffer.byteLength(text) > maxBytes) throw new Error('The page is too large to inspect safely.');
    return text;
  }

  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await awaitBeforeDeadline(
        reader.read(),
        deadline,
        () => { void reader.cancel().catch(() => {}); },
      );
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
    const iterator = response.body[Symbol.asyncIterator]();
    while (true) {
      const { done, value: chunk } = await awaitBeforeDeadline(
        iterator.next(),
        deadline,
        () => response.body.destroy?.(),
      );
      if (done) break;
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
    const { response, finalUrl, redirects } = await requestPublicUrl(url, options);
    const bodyDeadline = Math.min(
      Number.isFinite(options.deadline) ? options.deadline : Number.POSITIVE_INFINITY,
      Number.isFinite(options.requestBudget?.deadline) ? options.requestBudget.deadline : Number.POSITIVE_INFINITY,
    );
    const text = await readLimitedText(response, limit, bodyDeadline);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      url: finalUrl,
      contentType: response.headers.get('content-type') || '',
      text,
      redirects,
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
      'The link redirected outside the audited site.',
      'Query-bearing links are not crawled.',
      'The site crawl reached its time budget.',
      'The site crawl reached its request budget.',
      'The audit reached its response deadline.',
    ]);
    const message = publicMessages.has(error?.message)
      ? error.message
      : 'The website response ended before it could be inspected.';
    if (required) throw new Error(message);
    return { ok: false, status: 0, url: url.href || String(url), contentType: '', text: null, redirects: [], error: message };
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

function cleanEvidenceUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function linksFromHtml(html, pageUrl, auditedOrigin) {
  const links = [];
  for (const tag of html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || []) {
    const href = attr(tag, 'href');
    if (!href || /^(?:mailto:|tel:|javascript:|data:|#)/i.test(href)) continue;
    try {
      const target = validateUrlObject(new URL(href, pageUrl));
      if (target.origin !== auditedOrigin || target.search) continue;
      const content = tag.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1] || '';
      const anchor = strip(content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Unlabelled link';
      links.push({ target, anchor });
    } catch { /* malformed and unsupported links are not fetched */ }
  }
  return links;
}

function semanticAnchorKey(anchor) {
  const key = String(anchor).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const tokens = key.split(' ').filter(Boolean);
  const ctaPrefixes = new Set(['click', 'continue', 'go', 'learn', 'open', 'read', 'see', 'unlabelled', 'view', 'visit']);
  const navigationWords = new Set(['click', 'continue', 'details', 'go', 'here', 'link', 'more', 'open', 'page', 'read', 'see', 'site', 'view', 'visit', 'website']);
  if (tokens.length < 2 || ctaPrefixes.has(tokens[0]) || tokens.every((token) => navigationWords.has(token))) return null;
  return key;
}

function preparedBrokenLinkRepair(finding, replacement) {
  const before = finding.evidence.targetUrl;
  if (!replacement || replacement === before) return null;
  return {
    kind: 'replace-link-target',
    ready: true,
    before,
    after: replacement,
    instruction: 'Replace the confirmed dead link target with the verified same-anchor destination.',
    verification: [
      'Confirm the replacement destination still returns a successful response.',
      'Confirm the source page no longer links to the dead target.',
      'Confirm the anchor text accurately describes the replacement destination before publishing.',
    ],
  };
}

function crawlFinding({ sourceUrl, targetUrl, resource, anchor }) {
  const source = cleanEvidenceUrl(sourceUrl);
  const target = cleanEvidenceUrl(targetUrl);
  const finalUrl = cleanEvidenceUrl(resource.url);
  const status = resource.status || 0;
  const redirectChain = (resource.redirects || []).map((item) => ({
    status: item.status,
    from: cleanEvidenceUrl(item.from),
    to: cleanEvidenceUrl(item.to),
  }));
  const permanent = redirectChain.length > 0
    && redirectChain.every((item) => item.status === 301 || item.status === 308)
    && target !== finalUrl;
  if (permanent && status >= 200 && status < 300) {
    const preparedRepair = {
      kind: 'replace-link-target',
      ready: true,
      before: target,
      after: finalUrl,
      instruction: 'Replace the redirected link target with its verified permanent destination.',
      verification: [
        'Confirm the replacement destination returns a successful response.',
        'Confirm the source page links directly to the replacement destination.',
      ],
    };
    return {
      id: `redirect-link-${Buffer.from(target).toString('base64url').slice(0, 20)}`,
      kind: 'redirect-link',
      lane: 'Site integrity',
      title: 'Replace a redirected internal link',
      severity: 'low',
      observed: `Internal link "${anchor}" resolves through a permanent redirect to a verified live destination.`,
      action: preparedRepair.instruction,
      evidence: { sourceUrl: source, targetUrl: target, finalUrl, status, anchorText: anchor, redirectChain },
      preparedRepair,
    };
  }
  if (status === 404 || status === 410) {
    return {
      id: `broken-link-${Buffer.from(target).toString('base64url').slice(0, 20)}`,
      kind: 'broken-link',
      lane: 'Site integrity',
      title: 'Repair a confirmed broken internal link',
      severity: 'high',
      observed: `Internal link "${anchor}" returned HTTP ${status} twice and is confirmed dead.`,
      action: 'Replace the target with a verified live page or remove the link if no replacement is intended.',
      evidence: { sourceUrl: source, targetUrl: target, finalUrl, status, anchorText: anchor, redirectChain },
      preparedRepair: null,
    };
  }
  if (status >= 500) {
    return {
      id: `unavailable-link-${Buffer.from(target).toString('base64url').slice(0, 20)}`,
      kind: 'unavailable-link',
      lane: 'Site integrity',
      title: 'Investigate an unavailable internal destination',
      severity: 'medium',
      observed: `Internal link "${anchor}" returned HTTP ${status} and is currently unavailable.`,
      action: 'Restore a successful response, then rerun the audit before treating the link as repaired.',
      evidence: { sourceUrl: source, targetUrl: target, finalUrl, status, anchorText: anchor, redirectChain },
      preparedRepair: null,
    };
  }
  return null;
}

export async function crawlSiteLinks(rootPage, options = {}) {
  const configured = { ...DEFAULT_CRAWL_LIMITS, ...(options.crawl || options) };
  const limits = Object.fromEntries(Object.entries(DEFAULT_CRAWL_LIMITS).map(([key, fallback]) => {
    const requested = Number(configured[key]);
    const value = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : fallback;
    return [key, Math.min(value, HARD_CRAWL_LIMITS[key])];
  }));
  const auditedOrigin = new URL(rootPage.finalUrl).origin;
  const requestBudget = {
    requests: 0,
    maxRequests: limits.maxRequests,
    deadline: Math.min(
      Date.now() + limits.maxTotalMs,
      Number.isFinite(options.deadline) ? options.deadline : Number.POSITIVE_INFINITY,
    ),
  };
  const seenTargets = new Set([cleanEvidenceUrl(rootPage.finalUrl)]);
  const queue = [{ url: rootPage.finalUrl, html: rootPage.html, depth: 0 }];
  const findings = [];
  const liveTargetsByAnchor = new Map();
  let pagesVisited = 0;
  let linksChecked = 0;
  let unknownLinks = 0;
  let discoveredLinks = 0;

  while (queue.length > 0 && pagesVisited < limits.maxPages && linksChecked < limits.maxLinks && Date.now() < requestBudget.deadline) {
    const page = queue.shift();
    pagesVisited += 1;
    const links = linksFromHtml(page.html, page.url, auditedOrigin);
    discoveredLinks += links.length;
    for (const link of links) {
      const key = cleanEvidenceUrl(link.target.href);
      if (!key || seenTargets.has(key)) continue;
      seenTargets.add(key);
      if (linksChecked >= limits.maxLinks || findings.length >= limits.maxFindings || requestBudget.requests >= limits.maxRequests || Date.now() >= requestBudget.deadline) break;
      linksChecked += 1;
      let resource = await fetchTextResource(link.target, {
        ...options,
        crawl: undefined,
        limit: CRAWL_PAGE_LIMIT_BYTES,
        timeoutMs: Math.min(8_000, Math.max(1, requestBudget.deadline - Date.now())),
        allowedOrigin: auditedOrigin,
        disallowQuery: true,
        requestBudget,
      });
      let unconfirmedDead = false;
      if (resource.status === 404 || resource.status === 410) {
        resource = await fetchTextResource(link.target, {
          ...options,
          crawl: undefined,
          limit: CRAWL_PAGE_LIMIT_BYTES,
          timeoutMs: Math.min(8_000, Math.max(1, requestBudget.deadline - Date.now())),
          allowedOrigin: auditedOrigin,
          disallowQuery: true,
          requestBudget,
        });
        unconfirmedDead = resource.status !== 404 && resource.status !== 410;
      }
      if (unconfirmedDead || resource.status === 0 || (resource.status >= 400 && resource.status < 500 && ![404, 410].includes(resource.status))) unknownLinks += 1;
      if (resource.ok && (resource.redirects || []).length === 0) {
        const anchorKey = semanticAnchorKey(link.anchor);
        if (anchorKey && !liveTargetsByAnchor.has(anchorKey)) liveTargetsByAnchor.set(anchorKey, cleanEvidenceUrl(resource.url));
      }
      const finding = unconfirmedDead ? null : crawlFinding({ sourceUrl: page.url, targetUrl: link.target.href, resource, anchor: link.anchor });
      if (finding) findings.push(finding);
      const isHtml = !resource.contentType || /html|xhtml/i.test(resource.contentType);
      if (resource.ok && isHtml && page.depth < limits.maxDepth && pagesVisited + queue.length < limits.maxPages) {
        queue.push({ url: resource.url, html: resource.text || '', depth: page.depth + 1 });
      }
    }
  }

  for (const finding of findings) {
    if (finding.kind !== 'broken-link') continue;
    const replacement = liveTargetsByAnchor.get(semanticAnchorKey(finding.evidence.anchorText));
    const preparedRepair = preparedBrokenLinkRepair(finding, replacement);
    if (preparedRepair) {
      finding.preparedRepair = preparedRepair;
      finding.action = preparedRepair.instruction;
    }
  }

  const brokenLinks = findings.filter((finding) => finding.kind === 'broken-link').length;
  const unavailableLinks = findings.filter((finding) => finding.kind === 'unavailable-link').length;
  const preparedRepairs = findings.filter((finding) => finding.preparedRepair?.ready).length;
  const truncated = queue.length > 0
    || linksChecked >= limits.maxLinks
    || findings.length >= limits.maxFindings
    || requestBudget.requests >= limits.maxRequests
    || Date.now() >= requestBudget.deadline;
  return {
    limits,
    pagesVisited,
    linksChecked,
    requestsMade: requestBudget.requests,
    discoveredLinks,
    brokenLinks,
    unavailableLinks,
    unknownLinks,
    preparedRepairs,
    truncated,
    findings,
  };
}

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

function policyForCrawler(page, crawler) {
  const robots = page.artifacts?.robots;
  return robots?.ok
    ? crawlerPolicy(robots.text, crawler)
    : robots?.status === 404
      ? { state: 'open', detail: 'No robots.txt file was published; no homepage block was detected.' }
      : { state: 'unknown', detail: 'robots.txt could not be inspected, so crawler access is not confirmed.' };
}

function platformCheck(page, id, name, crawler) {
  const policy = policyForCrawler(page, crawler);
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

export function modelUseControls(page) {
  return [
    {
      id: 'openai-training',
      name: 'OpenAI training control',
      crawler: 'GPTBot',
      ...policyForCrawler(page, 'GPTBot'),
    },
    {
      id: 'anthropic-training',
      name: 'Anthropic training control',
      crawler: 'ClaudeBot',
      ...policyForCrawler(page, 'ClaudeBot'),
    },
    {
      id: 'google-ai-use',
      name: 'Google AI-use control',
      crawler: 'Google-Extended',
      ...policyForCrawler(page, 'Google-Extended'),
    },
  ];
}

// --- Retrieval-chunk analysis -------------------------------------------------
//
// Google sells the infrastructure behind AI Overviews and AI Mode as Cloud
// Discovery Engine (Vertex AI Search), and its public configuration surface
// states the retrieval chunk size: at most 500 tokens per chunk, with the
// ancestor headings optionally travelling alongside. At roughly 0.75 words per
// token that is about 375 words.
//
// The consequence is mechanical, not stylistic: a claim that does not fit
// inside one chunk together with its own heading is not reliably retrievable as
// a unit. A page can have correct schema, clean metadata and open crawlers and
// still never be quoted, because every answer-shaped statement on it straddles
// a chunk boundary. Nothing else in this audit measures that.
const CHUNK_WORD_LIMIT = 375;

// Below this there is not enough server-rendered prose to judge chunking.
// Reported as a repair rather than a pass on purpose: a near-empty document
// most often means the text is rendered client-side, where a retrieval crawler
// never sees it. Scoring that as "every section fits" would be a false clean.
const MIN_ANALYZABLE_WORDS = 100;

// <nav> and <footer> are site chrome, not the prose a retrieval chunk competes
// for, and a long link list inside either one otherwise reads as a huge content
// block. <header> is deliberately kept: on article pages it usually holds the H1.
function stripNonContent(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}

function plainText(fragment) {
  return String(fragment || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function countWords(fragment) {
  const text = plainText(fragment);
  return text ? text.split(' ').length : 0;
}

function truncateHeading(text) {
  if (!text) return '';
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

// Splits the document at heading boundaries and measures the prose under each
// one. Blocks are what retrieval sees; headings are the only boundary it has.
export function analyzeChunks(html) {
  const cleaned = stripNonContent(html);
  const headingRe = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const marks = [];
  let match;
  while ((match = headingRe.exec(cleaned)) !== null) {
    marks.push({
      level: Number(match[1]),
      heading: truncateHeading(plainText(match[2])),
      start: match.index,
      end: headingRe.lastIndex,
    });
  }

  const blocks = [];
  if (marks.length === 0) {
    const words = countWords(cleaned);
    if (words > 0) blocks.push({ heading: null, level: null, words });
  } else {
    const preamble = countWords(cleaned.slice(0, marks[0].start));
    if (preamble > 0) blocks.push({ heading: null, level: null, words: preamble });
    for (let i = 0; i < marks.length; i += 1) {
      const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : cleaned.length;
      blocks.push({
        heading: marks[i].heading,
        level: marks[i].level,
        words: countWords(cleaned.slice(marks[i].end, bodyEnd)),
      });
    }
  }

  const totalWords = blocks.reduce((sum, block) => sum + block.words, 0);
  const oversized = blocks.filter((block) => block.words > CHUNK_WORD_LIMIT);
  const largest = blocks.reduce(
    (worst, block) => (worst === null || block.words > worst.words ? block : worst),
    null,
  );
  return { headingCount: marks.length, blocks, totalWords, oversized, largest };
}

function describeBlock(block) {
  if (!block) return 'none';
  return block.heading
    ? `${block.words} words under "${block.heading}"`
    : `${block.words} words before the first heading`;
}

const headingSections = (n) => `${n} heading section${n === 1 ? '' : 's'}`;

// Every check here is a binary pass or repair weighted by severity, so the
// source implementation's 25 / 12 / 0 three-way split has nowhere to land: a
// section count that would have been a warning there is a repair here, and the
// "at most two oversized sections" tier disappears with it. The distinction
// survives in the observed value, not in the score. That collapse is also why
// this check is weighted medium rather than high: one oversized section out of
// twenty-eight should not cost a site what a blocked Googlebot costs it.
export function summarizeChunking(html, { truncated = false } = {}) {
  const { headingCount, totalWords, oversized, largest } = analyzeChunks(html);
  const limitNote = `Retrieval chunks cap at ~${CHUNK_WORD_LIMIT} words (500 tokens).`;
  const splitAdvice = `Keep every heading section under ~${CHUNK_WORD_LIMIT} words so each claim travels with the heading that identifies it. ${limitNote}`;

  let pass;
  let value;
  let advice;

  if (totalWords < MIN_ANALYZABLE_WORDS) {
    pass = false;
    value = `${totalWords} words of server-rendered text, too little to evaluate`;
    advice = `Server-render the page copy. A retrieval crawler chunks the HTML it is served, so text that arrives client-side is not chunked at all. ${limitNote}`;
  } else if (headingCount === 0) {
    pass = false;
    value = `${totalWords} words, no headings anywhere on the page`;
    advice = `Break the page into headed sections. As one undifferentiated block it gives retrieval no boundary to extract a claim with. ${limitNote}`;
  } else if (oversized.length > 0) {
    pass = false;
    value = `${oversized.length} of ${headingSections(headingCount)} over ${CHUNK_WORD_LIMIT} words; largest ${describeBlock(largest)}`;
    advice = `Split the oversized sections under their own headings. Retrieval splits them mid-section instead, so a claim inside one can be extracted without the heading that identifies it. ${limitNote}`;
  } else {
    pass = true;
    value = `All ${headingSections(headingCount)} fit; largest ${describeBlock(largest)}`;
    advice = splitAdvice;
  }

  // A truncated body can invent a huge trailing block or hide a real one, so a
  // partial document can never be reported as a clean pass. Nothing sets this
  // flag today: fetchPage throws past HTML_LIMIT_BYTES rather than handing back
  // a cut body. The guard is here so this check cannot start reporting a false
  // clean if that limit is ever relaxed into a truncating read.
  if (truncated && pass) {
    pass = false;
    value = `${value}, measured on a partial document`;
    advice = `Only the first ${(HTML_LIMIT_BYTES / 1_000_000).toFixed(1)} MB of HTML was read, so the rest of the page went unmeasured. ${splitAdvice}`;
  }

  return { pass, value, advice };
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
  const chunking = summarizeChunking(html, { truncated: Boolean(page.truncated) });

  return [
    makeCheck('robots', 'Technical', 'robots.txt is available', artifacts.robots?.ok, artifacts.robots?.ok ? `HTTP ${artifacts.robots.status}` : `HTTP ${artifacts.robots?.status || 0}`, 'Publish a clear robots.txt at the site root.', 'low'),
    makeCheck('sitemap', 'Technical', 'XML sitemap is available', artifacts.sitemap?.ok, artifacts.sitemap?.ok ? `HTTP ${artifacts.sitemap.status}` : `HTTP ${artifacts.sitemap?.status || 0}`, 'Publish a sitemap.xml that lists canonical public pages.'),
    platformCheck(page, 'openai', 'OpenAI search', 'OAI-SearchBot'),
    platformCheck(page, 'anthropic', 'Claude search', 'Claude-SearchBot'),
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
    makeCheck('chunking', 'Content', 'Page sections fit one retrieval chunk', chunking.pass, chunking.value, chunking.advice),
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
  const responseDeadlineMs = Number(options.responseDeadlineMs);
  const deadline = Number.isFinite(responseDeadlineMs) && responseDeadlineMs > 0
    ? started + responseDeadlineMs
    : options.deadline;
  const boundedOptions = { ...options, deadline };
  const page = await fetchPage(url, { ...boundedOptions, includeArtifacts: tier === 'audit' });
  const crawl = tier === 'audit' && options.crawl ? await crawlSiteLinks(page, boundedOptions) : null;
  const checks = tier === 'audit' ? [...scanChecks(page), ...auditChecks(page)] : scanChecks(page);
  const publicArtifacts = Object.fromEntries(Object.entries(page.artifacts).map(([name, artifact]) => [name, {
    ok: artifact.ok,
    status: artifact.status,
    url: artifact.url,
  }]));

  const summary = summarize(checks);
  const crawlRecommendations = crawl?.findings.map((finding) => ({
    id: finding.id,
    kind: finding.kind,
    lane: finding.lane,
    title: finding.title,
    severity: finding.severity,
    observed: finding.observed,
    action: finding.action,
    evidence: finding.evidence,
    preparedRepair: finding.preparedRepair,
  })) || [];
  const result = {
    tier,
    url: page.finalUrl,
    requestedUrl: page.requestedUrl,
    host: new URL(page.finalUrl).hostname,
    auditedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    methodology: 'Automated inspection of public HTML, robots.txt, llms.txt, and sitemap.xml. Search access uses OAI-SearchBot, Claude-SearchBot, PerplexityBot, and Googlebot; GPTBot, ClaudeBot, and Google-Extended are shown separately as non-scoring model-use controls. This report does not run prompts inside AI answer engines or predict citations.',
    ...summary,
    recommendations: [...crawlRecommendations, ...summary.recommendations],
    controls: tier === 'audit' ? modelUseControls(page) : [],
    checks,
    artifacts: publicArtifacts,
  };
  if (crawl) result.crawl = crawl;
  return result;
}
