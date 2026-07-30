import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function offerFunctions() {
  const helperStart = clientSource.indexOf('const COMPANY_OFFER_SEED_CAP');
  const helperEnd = clientSource.indexOf('function readStoredReport');
  const renderStart = clientSource.indexOf('function renderCompanyOffer');
  const renderEnd = clientSource.indexOf('function renderFindings');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'offer URL helpers should remain in client.js');
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'offer renderer should remain in client.js');

  const elements = {
    'company-offer': { hidden: true },
    'company-offer-link': { href: '#' },
  };
  const context = {
    URL,
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    byId: (id) => elements[id] ?? null,
    encodeURIComponent,
    unescape,
  };
  vm.runInNewContext(
    `${clientSource.slice(helperStart, helperEnd)}\n${clientSource.slice(renderStart, renderEnd)}\n`
      + 'globalThis.__offer = { COMPANY_OFFER_SEED_CAP, companyOfferHref, companyOfferPayload, renderCompanyOffer };',
    context,
  );
  return { ...context.__offer, elements };
}

function recommendation(index = 0, overrides = {}) {
  return {
    id: `metadata-${index}`,
    lane: 'Metadata',
    title: `Publish a descriptive title ${index}`,
    severity: index === 0 ? 'high' : 'medium',
    observed: 'The public title is generic.',
    action: 'Publish a unique title that names the service and intended audience.',
    ...overrides,
  };
}

function reportData(recommendations, overrides = {}) {
  return {
    host: 'example.com',
    url: 'https://example.com/pricing',
    auditedAt: '2026-07-29T18:00:00.000Z',
    recommendations,
    ...overrides,
  };
}

function decodeHandoff(href) {
  const url = new URL(href);
  const encoded = url.hash.slice('#scan='.length);
  return {
    encoded,
    url,
    payload: JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
  };
}

test('renders only for valid findings and carries bounded site-integrity evidence', () => {
  const { renderCompanyOffer, elements } = offerFunctions();
  const recommendations = [
    recommendation(0),
    recommendation(1, {
      id: 'entity',
      lane: 'Entity',
      title: 'Add a public entity definition',
      observed: 'No Organization JSON-LD was found.',
      action: 'Publish one Organization object with the canonical name, URL, and logo.',
    }),
  ];

  renderCompanyOffer(reportData([]));
  assert.equal(elements['company-offer'].hidden, true);

  renderCompanyOffer(reportData(recommendations));
  assert.equal(elements['company-offer'].hidden, false);
  const { payload, url } = decodeHandoff(elements['company-offer-link'].href);
  assert.equal(url.origin, 'https://agents.suedeai.ai');
  assert.equal(url.pathname, '/company/operations/prospect');
  assert.deepEqual(payload, {
    kind: 'suede.audit.prospect',
    version: 1,
    source: 'suede-audit',
    domain: 'example.com',
    auditedUrl: 'https://example.com/pricing',
    observedAt: '2026-07-29T18:00:00.000Z',
    totalFindings: 2,
    omittedCount: 0,
    findings: [
      {
        id: 'metadata-0-1',
        kind: 'site-integrity',
        lane: 'Metadata',
        title: 'Publish a descriptive title 0',
        priority: 'high',
        observed: 'The public title is generic.',
        action: 'Publish a unique title that names the service and intended audience.',
      },
      {
        id: 'entity-2',
        kind: 'site-integrity',
        lane: 'Entity',
        title: 'Add a public entity definition',
        priority: 'medium',
        observed: 'No Organization JSON-LD was found.',
        action: 'Publish one Organization object with the canonical name, URL, and logo.',
      },
    ],
  });
});

test('caps the encoded handoff and reports every omitted finding', () => {
  const { COMPANY_OFFER_SEED_CAP, companyOfferHref } = offerFunctions();
  const recommendations = Array.from({ length: 30 }, (_, index) => recommendation(index, {
    title: `Finding ${String(index).padStart(3, '0')} ${'detail '.repeat(16)}`.trim(),
    observed: `Observed ${'signal '.repeat(24)}`.trim(),
    action: `Repair ${'instruction '.repeat(22)}`.trim(),
  }));
  const href = companyOfferHref(reportData(recommendations));
  assert.ok(href);
  const { encoded, payload } = decodeHandoff(href);

  assert.ok(encoded.length <= COMPANY_OFFER_SEED_CAP);
  assert.ok(payload.findings.length > 0);
  assert.ok(payload.findings.length <= 6);
  assert.equal(payload.totalFindings, recommendations.length);
  assert.equal(payload.omittedCount, recommendations.length - payload.findings.length);
  assert.deepEqual(
    payload.findings.map((finding) => finding.title),
    recommendations.slice(0, payload.findings.length).map((finding) => finding.title),
  );
});

test('rejects future, control-character, and oversized evidence', () => {
  const { companyOfferHref } = offerFunctions();
  assert.equal(companyOfferHref({
    ...reportData([recommendation()]),
    auditedAt: '2999-01-01T00:00:00.000Z',
  }), null);
  assert.equal(companyOfferHref(reportData([
    recommendation(0, { title: 'Visible\u202eHidden' }),
  ])), null);
  assert.equal(companyOfferHref(reportData([
    recommendation(0, { action: 'x'.repeat(301) }),
  ])), null);
  assert.equal(companyOfferHref(reportData(
    [recommendation()],
    { url: 'https://user:password@example.com/pricing?token=secret#private' },
  )), null);
  assert.equal(companyOfferHref(reportData(
    [recommendation()],
    { url: 'https://other.example/pricing' },
  )), null);
});

test('preserves the exact clean audited scheme and path for operator reproduction', () => {
  const { companyOfferHref } = offerFunctions();
  const href = companyOfferHref(reportData(
    [recommendation()],
    { url: 'http://example.com/public/pricing/' },
  ));
  assert.ok(href);
  const { payload } = decodeHandoff(href);

  assert.equal(payload.auditedUrl, 'http://example.com/public/pricing/');
});

test('places proof-first operator copy after repairs without persistence or sending', () => {
  const offerStart = indexSource.indexOf('<aside id="company-offer"');
  const offerEnd = indexSource.indexOf('</aside>', offerStart);
  const offerMarkup = indexSource.slice(offerStart, offerEnd);
  const renderStart = clientSource.indexOf('function renderCompanyOffer');
  const renderEnd = clientSource.indexOf('function renderFindings');
  const renderSource = clientSource.slice(renderStart, renderEnd);

  assert.ok(indexSource.indexOf('id="repair-list"') < offerStart);
  assert.match(offerMarkup, /Build the private diagnostic/);
  assert.match(offerMarkup, /one complete prepared repair/);
  assert.match(offerMarkup, /No email is sent/);
  assert.doesNotMatch(offerMarkup, /guarantee|improve your score/i);
  assert.doesNotMatch(renderSource, /fetch|localStorage|sessionStorage|mailto/i);
});
