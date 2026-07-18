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
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    byId: (id) => elements[id] ?? null,
    encodeURIComponent,
    unescape,
  };
  vm.runInNewContext(
    `${clientSource.slice(helperStart, helperEnd)}\n${clientSource.slice(renderStart, renderEnd)}\n`
      + 'globalThis.__offer = { COMPANY_OFFER_SEED_CAP, companyOfferHref, renderCompanyOffer };',
    context,
  );
  return { ...context.__offer, elements };
}

function decodeSeed(href) {
  const encoded = href.split('#seed=')[1];
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  return {
    encoded,
    payload: JSON.parse(Buffer.from(base64, 'base64').toString('utf8')),
  };
}

test('renders the offer only for findings and seeds ordered repair titles', () => {
  const { renderCompanyOffer, elements } = offerFunctions();
  const recommendations = [
    { title: 'Add a public entity definition', action: 'Publish an About page.' },
    { title: 'Expose an llms.txt file', action: 'Add the discovery file.' },
  ];

  renderCompanyOffer('example.com', []);
  assert.equal(elements['company-offer'].hidden, true);

  renderCompanyOffer('example.com', recommendations);
  assert.equal(elements['company-offer'].hidden, false);
  assert.deepEqual(decodeSeed(elements['company-offer-link'].href).payload, {
    domain: 'example.com',
    findings: recommendations.map((repair) => repair.title),
  });
});

test('caps the encoded seed by dropping findings from the end', () => {
  const { COMPANY_OFFER_SEED_CAP, companyOfferHref } = offerFunctions();
  const findings = Array.from(
    { length: 200 },
    (_, index) => `Finding ${String(index).padStart(3, '0')} ${'detail '.repeat(12)}`,
  );
  const { encoded, payload } = decodeSeed(companyOfferHref('example.com', findings));

  assert.ok(encoded.length <= COMPANY_OFFER_SEED_CAP);
  assert.ok(payload.findings.length > 0);
  assert.ok(payload.findings.length < findings.length);
  assert.deepEqual(payload.findings, findings.slice(0, payload.findings.length));
});

test('places claim-safe company copy after the repairs list without persistence', () => {
  const offerStart = indexSource.indexOf('<aside id="company-offer"');
  const offerEnd = indexSource.indexOf('</aside>', offerStart);
  const offerMarkup = indexSource.slice(offerStart, offerEnd);
  const renderStart = clientSource.indexOf('function renderCompanyOffer');
  const renderEnd = clientSource.indexOf('function renderFindings');
  const renderSource = clientSource.slice(renderStart, renderEnd);

  assert.ok(indexSource.indexOf('id="repair-list"') < offerStart);
  assert.match(offerMarkup, /Put a company on this/);
  assert.match(offerMarkup, /work on these findings/);
  assert.doesNotMatch(offerMarkup, /\bfix(?:es|ed|ing)?\b|improve your score|guarantee/i);
  assert.doesNotMatch(renderSource, /fetch|localStorage|sessionStorage/);
});
