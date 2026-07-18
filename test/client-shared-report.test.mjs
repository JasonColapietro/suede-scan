import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');

function reportFixture(overrides = {}) {
  return {
    tier: 'audit',
    url: 'https://example.com/',
    requestedUrl: 'https://example.com/',
    host: 'example.com',
    auditedAt: '2026-07-18T12:00:00.000Z',
    elapsedMs: 120,
    methodology: 'Automated inspection of public signals.',
    passed: 0,
    total: 1,
    score: 20,
    grade: 'F',
    laneGrades: { Access: 'F' },
    laneScores: {
      Access: { score: 20, grade: 'F', passed: 0, total: 1, highImpactOpen: 1 },
    },
    pillarScores: [{
      id: 'discoverability',
      name: 'Discoverability',
      description: 'Public discovery signals.',
      score: 20,
      grade: 'F',
      passed: 0,
      total: 1,
    }],
    recommendations: [{
      id: 'robots',
      lane: 'Access',
      title: 'Open crawler access',
      severity: 'high',
      observed: 'Blocked',
      action: 'Review the public crawler policy.',
    }],
    platforms: [{ name: 'OpenAI discovery', crawler: 'GPTBot', state: 'blocked', detail: 'Blocked' }],
    checks: [{
      id: 'robots',
      label: 'Open crawler access',
      lane: 'Access',
      pass: false,
      value: 'Blocked',
      severity: 'high',
    }],
    artifacts: { 'robots.txt': { ok: true, status: 200, url: 'https://example.com/robots.txt' } },
    ...overrides,
  };
}

function encodeSnapshot(report) {
  return Buffer.from(JSON.stringify({ version: 1, report }), 'utf8').toString('base64url');
}

function fakeElement() {
  const listeners = new Map();
  const strong = { textContent: '' };
  return {
    hidden: false,
    disabled: false,
    textContent: '',
    value: '',
    href: '',
    innerHTML: '',
    listeners,
    classList: { add() {}, remove() {} },
    style: { setProperty() {} },
    addEventListener(type, listener) { listeners.set(type, listener); },
    focus() {},
    removeAttribute() {},
    scrollIntoView() {},
    setAttribute() {},
    querySelector(selector) { return selector === 'strong' ? strong : null; },
  };
}

function runClient({ pathname = '/', hash = '', storedReport = null } = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement());
    return elements.get(id);
  };
  element('report').hidden = true;
  element('company-offer').hidden = true;
  const navLinks = [fakeElement(), fakeElement()];
  const auditEntry = fakeElement();
  const storage = { gets: 0, sets: 0, removes: 0 };
  const network = { fetches: 0 };
  const clipboard = [];
  const historyCalls = [];
  const location = { origin: 'https://audit.suedeai.ai', pathname, search: '', hash };
  const history = {
    state: null,
    pushState(state, _title, url) { historyCalls.push({ kind: 'push', state, url }); },
    replaceState(state, _title, url) { historyCalls.push({ kind: 'replace', state, url }); },
  };
  const document = {
    title: '',
    head: { append() {} },
    createElement: () => fakeElement(),
    getElementById: element,
    querySelector: (selector) => (selector === '[data-audit-entry]' ? auditEntry : null),
    querySelectorAll: (selector) => (selector === '.primary-nav a' ? navLinks : []),
  };
  const window = {
    location,
    history,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    prompt() {},
    scrollTo() {},
    setInterval: () => 1,
    setTimeout: () => 1,
  };
  const localStorage = {
    getItem() {
      storage.gets += 1;
      return storedReport ? JSON.stringify(storedReport) : null;
    },
    setItem() { storage.sets += 1; },
    removeItem() { storage.removes += 1; },
  };
  const context = {
    URL,
    URLSearchParams,
    TextDecoder,
    Uint8Array,
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    clearInterval() {},
    decodeURIComponent,
    document,
    encodeURIComponent,
    fetch: async () => {
      network.fetches += 1;
      throw new Error('shared report loads must not fetch');
    },
    history,
    localStorage,
    navigator: { clipboard: { async writeText(value) { clipboard.push(value); } } },
    unescape,
    window,
  };
  vm.runInNewContext(clientSource, context);
  return { auditEntry, clipboard, elements, historyCalls, network, storage };
}

test('shared snapshot renders the report and company offer without spending an audit', () => {
  const report = reportFixture();
  const encoded = encodeSnapshot(report);
  const run = runClient({ pathname: '/report/example.com', hash: `#report=${encoded}` });

  assert.equal(run.network.fetches, 0);
  assert.deepEqual(run.storage, { gets: 0, sets: 0, removes: 0 });
  assert.equal(run.elements.get('report').hidden, false);
  assert.equal(run.elements.get('landing-shell').hidden, true);
  assert.equal(run.elements.get('company-offer').hidden, false);
  assert.match(run.elements.get('company-offer-link').href, /^https:\/\/agents\.suedeai\.ai\/founding#seed=/);
  assert.deepEqual(run.historyCalls.at(-1), {
    kind: 'replace',
    state: null,
    url: '/report/example.com',
  });
});

test('host-mismatched and malformed snapshots fail closed without storage or network use', () => {
  const cases = [
    `#report=${encodeSnapshot(reportFixture({ host: 'other.example', url: 'https://other.example/' }))}`,
    '#report=not-valid-JSON',
  ];

  for (const hash of cases) {
    const run = runClient({ pathname: '/report/example.com', hash });
    assert.equal(run.network.fetches, 0);
    assert.deepEqual(run.storage, { gets: 0, sets: 0, removes: 0 });
    assert.equal(run.elements.get('report').hidden, true);
    assert.equal(run.elements.get('report-title')?.textContent || '', '');
    assert.match(run.elements.get('form-error').textContent, /invalid or does not match.*No audit was run/i);
  }
});

test('legacy fragmentless report links prompt instead of consuming the free audit', () => {
  const run = runClient({ pathname: '/report/example.com' });

  assert.equal(run.network.fetches, 0);
  assert.deepEqual(run.storage, { gets: 1, sets: 0, removes: 0 });
  assert.equal(run.elements.get('report').hidden, true);
  assert.equal(run.elements.get('audit-url').value, 'example.com');
  assert.match(run.elements.get('form-error').textContent, /older shared link.*No audit was run/i);
});

test('Copy report produces a host-bound snapshot a new visitor can open without an audit', async () => {
  const report = reportFixture();
  const owner = runClient({ pathname: '/report/example.com', storedReport: report });
  await owner.elements.get('copy-report').listeners.get('click')();

  assert.equal(owner.clipboard.length, 1);
  const copied = new URL(owner.clipboard[0]);
  assert.equal(copied.pathname, '/report/example.com');
  assert.match(copied.hash, /^#report=[A-Za-z0-9_-]+$/);

  const visitor = runClient({ pathname: copied.pathname, hash: copied.hash });
  assert.equal(visitor.network.fetches, 0);
  assert.deepEqual(visitor.storage, { gets: 0, sets: 0, removes: 0 });
  assert.equal(visitor.elements.get('company-offer').hidden, false);
});

test('Copy report clearly refuses an oversized snapshot without truncation or fallback', async () => {
  const oversized = reportFixture({ methodology: 'x'.repeat(60000) });
  const run = runClient({ pathname: '/report/example.com', storedReport: oversized });
  await run.elements.get('copy-report').listeners.get('click')();

  assert.equal(run.clipboard.length, 0);
  assert.equal(run.network.fetches, 0);
  assert.equal(run.elements.get('copy-report').textContent, 'Report too large to share');
});
