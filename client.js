const fontStylesheet = document.createElement('link');
fontStylesheet.rel = 'stylesheet';
fontStylesheet.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap';
document.head.append(fontStylesheet);

const byId = (id) => document.getElementById(id);
const FREE_REPORT_KEY = 'suede_audit_free_report_v1';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const landingShell = byId('landing-shell');
const report = byId('report');
const form = byId('audit-form');
const urlInput = byId('audit-url');
const submitButton = byId('submit-button');
const honeypot = byId('company-fax');
const formError = byId('form-error');
const loadingPanel = byId('loading-panel');
const loadingDetail = byId('loading-detail');
const navLinks = [...document.querySelectorAll('.primary-nav a')];
const auditEntry = document.querySelector('[data-audit-entry]');

let currentReport = null;
let currentReportIsSharedSnapshot = false;
let loadingTimer = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
}[character]));

const clampScore = (value) => Math.max(0, Math.min(100, Number(value) || 0));

const COMPANY_OFFER_SEED_CAP = 6144;
const COMPANY_OFFER_FINDING_CAP = 6;
const COMPANY_OFFER_TOTAL_FINDING_CAP = 200;
const COMPANY_OFFER_PREFIX = '#scan=';
const SHARED_REPORT_PREFIX = '#report=';
const SHARED_REPORT_VERSION = 1;
const SHARED_REPORT_MAX_ENCODED = 49152;

function base64UrlEncode(value) {
  const base64 = btoa(unescape(encodeURIComponent(value)));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function cleanHandoffText(value, maxLength) {
  if (typeof value !== 'string') return null;
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  const text = value.trim();
  return text && text.length <= maxLength ? text : null;
}

function cleanHandoffHost(value) {
  const host = cleanHandoffText(value, 253);
  if (!host) return null;
  const normalized = host.toLowerCase().replace(/\.$/, '');
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized)
    ? normalized
    : null;
}

function cleanHandoffUrl(value, domain) {
  const text = cleanHandoffText(value, 2048);
  if (!text || !domain) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      host !== domain
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

function cleanHandoffFinding(repair, index) {
  if (typeof repair !== 'object' || repair === null || Array.isArray(repair)) return null;
  const lane = cleanHandoffText(repair.lane, 80);
  const title = cleanHandoffText(repair.title, 160);
  const observed = cleanHandoffText(repair.observed, 300);
  const action = cleanHandoffText(repair.action, 300);
  const priority = ['high', 'medium', 'low'].includes(repair.severity)
    ? repair.severity
    : null;
  if (!lane || !title || !observed || !action || !priority) return null;
  const rawId = cleanHandoffText(repair.id, 48) || `finding-${index + 1}`;
  const slug = rawId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return {
    id: `${slug || 'finding'}-${index + 1}`.slice(0, 64),
    kind: 'site-integrity',
    lane,
    title,
    priority,
    observed,
    action,
  };
}

function companyOfferPayload(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || !Array.isArray(data.recommendations)) return null;
  if (data.recommendations.length < 1 || data.recommendations.length > COMPANY_OFFER_TOTAL_FINDING_CAP) return null;
  const domain = cleanHandoffHost(data.host);
  const auditedUrl = cleanHandoffUrl(data.url, domain);
  const observedAt = cleanHandoffText(data.auditedAt, 64);
  const observedTime = observedAt ? Date.parse(observedAt) : NaN;
  if (!domain || !auditedUrl || !Number.isFinite(observedTime) || observedTime > Date.now()) return null;
  const validFindings = data.recommendations
    .map((repair, index) => cleanHandoffFinding(repair, index))
    .filter(Boolean);
  if (validFindings.length === 0) return null;
  const totalFindings = data.recommendations.length;
  let findings = validFindings.slice(0, COMPANY_OFFER_FINDING_CAP);
  let payload = {
    kind: 'suede.audit.prospect',
    version: 1,
    source: 'suede-audit',
    domain,
    auditedUrl,
    observedAt: new Date(observedTime).toISOString(),
    totalFindings,
    omittedCount: totalFindings - findings.length,
    findings,
  };
  let encoded = base64UrlEncode(JSON.stringify(payload));
  while (encoded.length > COMPANY_OFFER_SEED_CAP && findings.length > 1) {
    findings = findings.slice(0, -1);
    payload = {
      ...payload,
      omittedCount: totalFindings - findings.length,
      findings,
    };
    encoded = base64UrlEncode(JSON.stringify(payload));
  }
  return encoded.length <= COMPANY_OFFER_SEED_CAP ? payload : null;
}

function companyOfferHref(data) {
  const payload = companyOfferPayload(data);
  if (!payload) return null;
  const encoded = base64UrlEncode(JSON.stringify(payload));
  return `https://agents.suedeai.ai/company/operations/prospect${COMPANY_OFFER_PREFIX}${encoded}`;
}

function readStoredReport() {
  try {
    const raw = localStorage.getItem(FREE_REPORT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.host !== 'string' || !Array.isArray(saved.checks) || !Number.isFinite(saved.score)) {
      localStorage.removeItem(FREE_REPORT_KEY);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

function storeReport(data) {
  try { localStorage.setItem(FREE_REPORT_KEY, JSON.stringify(data)); } catch { /* server cookie remains the fallback */ }
}

function inputHost(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasStringFields(value, fields) {
  return isRecord(value) && fields.every((field) => typeof value[field] === 'string');
}

function validateSharedReport(value, expectedDomain) {
  if (!isRecord(value)) return null;
  if (typeof expectedDomain !== 'string' || typeof value.url !== 'string') return null;
  const expectedHost = inputHost(expectedDomain);
  const reportHost = typeof value.host === 'string' ? value.host.toLowerCase() : null;
  if (!expectedHost || reportHost !== expectedHost || inputHost(value.url) !== expectedHost) return null;
  if (!Number.isFinite(value.score) || !Number.isFinite(value.total)) return null;
  if (!hasStringFields(value, ['grade', 'auditedAt', 'methodology'])) return null;
  if (!Array.isArray(value.checks) || !value.checks.every((check) => (
    hasStringFields(check, ['label', 'lane', 'value', 'severity']) && typeof check.pass === 'boolean'
  ))) return null;
  if (!Array.isArray(value.recommendations) || !value.recommendations.every((repair) => (
    hasStringFields(repair, ['title', 'action', 'observed', 'lane', 'severity'])
  ))) return null;
  if (!Array.isArray(value.pillarScores) || !value.pillarScores.every((pillar) => (
    hasStringFields(pillar, ['name', 'description'])
    && Number.isFinite(pillar.score)
    && Number.isFinite(pillar.passed)
    && Number.isFinite(pillar.total)
  ))) return null;
  if (!Array.isArray(value.platforms) || !value.platforms.every((platform) => (
    hasStringFields(platform, ['name', 'crawler', 'state', 'detail'])
  ))) return null;
  if (value.controls !== undefined && (!Array.isArray(value.controls) || !value.controls.every((control) => (
    hasStringFields(control, ['name', 'crawler', 'state', 'detail'])
  )))) return null;
  if (!isRecord(value.laneScores) || !Object.values(value.laneScores).every((lane) => (
    isRecord(lane) && Number.isFinite(lane.score) && Number.isFinite(lane.highImpactOpen)
  ))) return null;
  if (!isRecord(value.artifacts) || !Object.values(value.artifacts).every((artifact) => (
    isRecord(artifact) && typeof artifact.ok === 'boolean' && Number.isFinite(artifact.status)
  ))) return null;
  return value;
}

function sharedReportHref(data) {
  const encoded = base64UrlEncode(JSON.stringify({ version: SHARED_REPORT_VERSION, report: data }));
  if (encoded.length > SHARED_REPORT_MAX_ENCODED) {
    throw new RangeError('The report snapshot is too large to share in a URL.');
  }
  return `${new URL(reportPath(data.host), window.location.origin).href}${SHARED_REPORT_PREFIX}${encoded}`;
}

function readSharedReportSnapshot(expectedDomain) {
  const hash = window.location.hash;
  if (!hash.startsWith(SHARED_REPORT_PREFIX)) return { present: false, report: null };
  const encoded = hash.slice(SHARED_REPORT_PREFIX.length);
  if (!encoded || encoded.length > SHARED_REPORT_MAX_ENCODED || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return { present: true, report: null };
  }
  try {
    const envelope = JSON.parse(base64UrlDecode(encoded));
    if (!isRecord(envelope) || envelope.version !== SHARED_REPORT_VERSION) {
      return { present: true, report: null };
    }
    return { present: true, report: validateSharedReport(envelope.report, expectedDomain) };
  } catch {
    return { present: true, report: null };
  }
}

function stripSharedReportFragment() {
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
}

function showNonConsumingReportPrompt(domain, invalidSnapshot = false) {
  currentReport = null;
  currentReportIsSharedSnapshot = false;
  report.hidden = true;
  landingShell.hidden = false;
  setReportNavigation(false);
  clearError();
  const host = inputHost(domain);
  urlInput.value = host || '';
  formError.textContent = invalidSnapshot
    ? 'This shared report snapshot is invalid or does not match the URL. No audit was run.'
    : 'This older shared link does not include a report snapshot. No audit was run. Review the domain, then choose Run the audit to use this browser\'s free audit.';
  formError.hidden = false;
}

function showUsedAudit(saved) {
  showError(`This browser's free audit has already been used for ${saved.host}. Open the saved audit above or use Suede Scan for another site.`);
}
function setLoading(active) {
  clearInterval(loadingTimer);
  loadingTimer = null;
  loadingPanel.hidden = !active;
  submitButton.disabled = active;
  submitButton.textContent = active ? 'Inspecting' : 'Run the audit';

  if (!active) return;
  const stages = [
    'Checking the homepage response and public HTML.',
    'Reading robots.txt, llms.txt, and sitemap.xml.',
    'Scoring entity, content, crawler, and technical signals.',
  ];
  let stage = 0;
  loadingDetail.textContent = stages[stage];
  loadingTimer = window.setInterval(() => {
    stage = Math.min(stage + 1, stages.length - 1);
    loadingDetail.textContent = stages[stage];
  }, 1400);
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
  urlInput.setAttribute('aria-invalid', 'true');
}

function clearError() {
  formError.hidden = true;
  formError.textContent = '';
  urlInput.removeAttribute('aria-invalid');
}

function setReportNavigation(active) {
  if (navLinks.length < 2) return;
  navLinks[0].href = active ? '#readiness-field' : '#checks';
  navLinks[0].textContent = active ? 'Signal field' : 'What it checks';
  navLinks[1].href = active ? '#findings' : '#method';
  navLinks[1].textContent = active ? 'Findings' : 'Method';
}

function formatTimestamp(value, elapsedMs) {
  const date = new Date(value);
  const stamp = Number.isNaN(date.getTime())
    ? 'Fresh audit'
    : new Intl.DateTimeFormat('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(date);
  const duration = Number.isFinite(elapsedMs) ? ` · ${Math.max(1, Math.round(elapsedMs / 100) / 10)}s run` : '';
  return `${stamp}${duration} · point-in-time public signals`;
}

function reportPath(host) {
  return `/report/${encodeURIComponent(host)}`;
}

function renderScorePlatforms(platforms) {
  byId('score-platforms').innerHTML = platforms.map((platform) => `
    <span class="${platform.state === 'blocked' ? 'blocked' : platform.state === 'unknown' ? 'unknown' : ''}">
      <i aria-hidden="true"></i>${escapeHtml(platform.name.replace(' discovery', ''))}
    </span>
  `).join('');
}

function renderPillars(pillars) {
  byId('pillar-grid').innerHTML = pillars.map((pillar) => {
    const score = clampScore(pillar.score);
    return `
      <article class="pillar-card">
        <header><h3>${escapeHtml(pillar.name)}</h3><div class="pillar-score">${score}<span>/100</span></div></header>
        <p>${escapeHtml(pillar.description)}</p>
        <div class="pillar-progress" role="progressbar" aria-label="${escapeHtml(pillar.name)} score" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><span style="width:${score}%"></span></div>
        <div class="pillar-foot"><span>${escapeHtml(pillar.passed)} of ${escapeHtml(pillar.total)} checks clear</span><span>Grade ${escapeHtml(pillar.grade)}</span></div>
      </article>`;
  }).join('');
}

function renderInsight(data) {
  const strongest = [...data.pillarScores].sort((a, b) => b.score - a.score)[0];
  const firstRepair = data.recommendations[0];
  const title = firstRepair ? firstRepair.title : 'No automated blockers found';
  const body = firstRepair
    ? firstRepair.action
    : 'The inspected signals passed. This does not prove that an answer engine will cite or recommend the site.';
  byId('report-insight').innerHTML = `
    <span class="insight-label">${firstRepair ? 'First repair' : 'Automated result'}</span>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div>
    <div class="insight-best">Strongest pillar<b>${escapeHtml(strongest?.name || 'Not scored')}</b></div>`;
}

function renderPlatforms(platforms) {
  byId('platform-grid').innerHTML = platforms.map((platform) => `
    <article class="platform-card">
      <header>
        <div><h3>${escapeHtml(platform.name)}</h3><span class="crawler-name">${escapeHtml(platform.crawler)}</span></div>
        <span class="access-state ${platform.state === 'blocked' ? 'blocked' : platform.state === 'unknown' ? 'unknown' : ''}">${platform.state === 'blocked' ? 'Blocked' : platform.state === 'unknown' ? 'Unknown' : 'Open'}</span>
      </header>
      <p>${escapeHtml(platform.detail)}</p>
      <footer><span>Source: robots.txt</span><span>Homepage policy</span></footer>
    </article>`).join('');
}

function renderControls(controls) {
  const wrapper = byId('control-policy');
  wrapper.hidden = controls.length === 0;
  byId('control-grid').innerHTML = controls.map((control) => `
    <article class="platform-card">
      <header>
        <div><h3>${escapeHtml(control.name)}</h3><span class="crawler-name">${escapeHtml(control.crawler)}</span></div>
        <span class="access-state ${control.state === 'blocked' ? 'blocked' : control.state === 'unknown' ? 'unknown' : ''}">${control.state === 'blocked' ? 'Blocked' : control.state === 'unknown' ? 'Unknown' : 'Allowed'}</span>
      </header>
      <p>${escapeHtml(control.detail)}</p>
      <footer><span>Source: robots.txt</span><span>Non-scoring policy</span></footer>
    </article>`).join('');
}

function renderLanes(lanes) {
  byId('lane-rows').innerHTML = Object.entries(lanes).map(([name, lane]) => {
    const score = clampScore(lane.score);
    const impact = lane.highImpactOpen > 0
      ? `${lane.highImpactOpen} high-impact ${lane.highImpactOpen === 1 ? 'blocker' : 'blockers'}`
      : 'No high-impact blockers';
    return `
      <div class="lane-row">
        <div class="lane-name">${escapeHtml(name)}</div>
        <div class="lane-track" role="progressbar" aria-label="${escapeHtml(name)} readiness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><span style="width:${score}%"></span></div>
        <div class="lane-score">${score}/100</div>
        <div class="lane-impact ${lane.highImpactOpen > 0 ? 'high' : ''}">${escapeHtml(impact)}</div>
      </div>`;
  }).join('');
}

function renderRepairs(recommendations) {
  if (recommendations.length === 0) {
    byId('repair-list').innerHTML = `
      <div class="repair-empty">
        <span class="pass-mark" aria-hidden="true">&#10003;</span>
        <div><h3>No automatic repairs are open.</h3><p>The public signals inspected by this report passed. Run separate buyer-prompt evidence before making any citation claim.</p></div>
      </div>`;
    byId('repair-list').classList.remove('repair-list');
    return;
  }

  byId('repair-list').classList.add('repair-list');
  byId('repair-list').innerHTML = recommendations.map((repair) => `
    <article class="repair-item">
      <div><h3>${escapeHtml(repair.title)}</h3><p>${escapeHtml(repair.action)}</p></div>
      <div class="repair-observed">Observed: ${escapeHtml(repair.observed)}<br>Lane: ${escapeHtml(repair.lane)}</div>
      <span class="severity severity-${escapeHtml(repair.severity)}">${escapeHtml(repair.severity)}</span>
    </article>`).join('');
}

function renderCompanyOffer(data) {
  const offer = byId('company-offer');
  if (!offer) return;
  const href = companyOfferHref(data);
  if (!href) {
    offer.hidden = true;
    return;
  }
  byId('company-offer-link').href = href;
  offer.hidden = false;
}

function renderFindings(checks) {
  byId('findings-body').innerHTML = checks.map((check) => `
    <tr>
      <td><span class="status-chip ${check.pass ? 'status-pass' : 'status-repair'}">${check.pass ? 'Pass' : 'Repair'}</span></td>
      <td><div class="finding-label">${escapeHtml(check.label)}<span>${escapeHtml(check.lane)}</span></div></td>
      <td><div class="finding-observed">${escapeHtml(check.value)}</div></td>
      <td><span class="severity ${check.pass ? 'severity-clear' : `severity-${escapeHtml(check.severity)}`}">${check.pass ? 'Clear' : escapeHtml(check.severity)}</span></td>
    </tr>`).join('');
}

function renderArtifacts(artifacts) {
  const entries = Object.entries(artifacts || {});
  byId('artifact-list').innerHTML = entries.map(([name, artifact]) => `
    <span class="artifact-chip ${artifact.ok ? 'ok' : ''}">${escapeHtml(name)} · HTTP ${escapeHtml(artifact.status || 0)}</span>
  `).join('');
}

function renderReport(data, { sharedSnapshot = false } = {}) {
  currentReport = data;
  currentReportIsSharedSnapshot = sharedSnapshot;
  const score = clampScore(data.score);
  const laneCount = Object.keys(data.laneScores || {}).length;
  const reportTitle = sharedSnapshot
    ? `${data.host} Unverified Shared Snapshot | Suede Audit`
    : `${data.host} Public-Site Audit | Suede Audit`;

  document.title = reportTitle;
  auditEntry.textContent = sharedSnapshot ? 'View shared snapshot' : 'View saved audit';
  report.classList[sharedSnapshot ? 'add' : 'remove']('report--shared-snapshot');
  byId('report-title').textContent = data.host;
  byId('shared-report-warning').hidden = !sharedSnapshot;
  byId('report-status-label').textContent = sharedSnapshot ? 'Shared snapshot' : 'Live report';
  byId('report-status-detail').textContent = sharedSnapshot
    ? 'Unverified user-provided copy'
    : 'Fresh automated audit';
  byId('report-subtitle').textContent = sharedSnapshot
    ? 'Unverified copy of user-provided public-site results'
    : 'Public-site discovery and answer-readiness report';
  byId('score-card-label').textContent = sharedSnapshot
    ? 'Shared score — unverified'
    : 'Overall readiness score';
  byId('score-card').setAttribute(
    'aria-label',
    sharedSnapshot ? 'Unverified shared score' : 'Overall readiness score',
  );
  byId('grade-label').textContent = sharedSnapshot ? 'Shared grade — unverified' : 'Weighted grade';
  byId('stat-checks').textContent = data.total;
  byId('stat-lanes').textContent = laneCount;
  byId('stat-repairs').textContent = data.recommendations.length;
  const timestamp = formatTimestamp(data.auditedAt, data.elapsedMs);
  byId('report-timestamp').textContent = sharedSnapshot
    ? `Snapshot claims: ${timestamp} · Unverified`
    : timestamp;
  byId('score-value').textContent = score;
  byId('grade-value').textContent = data.grade;
  byId('score-gauge').style.setProperty('--score-angle', `${score * 3.6}deg`);
  byId('methodology-copy').textContent = data.methodology;
  byId('share-score').querySelector('strong').textContent = score;
  byId('share-report-title').textContent = sharedSnapshot
    ? 'Share this unverified snapshot.'
    : 'Share the evidence trail.';
  byId('share-report-copy').textContent = sharedSnapshot
    ? 'This link carries user-controlled data and must not be treated as a Suede-verified audit.'
    : 'The link reopens this saved result without consuming a recipient audit.';

  renderScorePlatforms(data.platforms || []);
  renderPillars(data.pillarScores || []);
  renderInsight(data);
  renderPlatforms(data.platforms || []);
  renderControls(data.controls || []);
  renderLanes(data.laneScores || {});
  renderRepairs(data.recommendations || []);
  renderCompanyOffer(data);
  renderFindings(data.checks || []);
  renderArtifacts(data.artifacts || {});

  landingShell.hidden = true;
  report.hidden = false;
  setReportNavigation(true);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function runAudit(rawUrl, { updateHistory = true } = {}) {
  const value = String(rawUrl || '').trim();
  clearError();
  if (!value) {
    showError('Enter a public website URL.');
    urlInput.focus();
    return;
  }

  const saved = readStoredReport();
  if (saved) {
    if (inputHost(value) === saved.host.toLowerCase()) {
      renderReport(saved);
      const path = reportPath(saved.host);
      if (updateHistory && window.location.pathname !== path) history.pushState({ host: saved.host }, '', path);
      return;
    }
    showUsedAudit(saved);
    urlInput.focus();
    return;
  }

  setLoading(true);
  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: value, companyFax: honeypot.value }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const fallback = response.status === 429
        ? 'This network has already used its free audit. Open the saved report or use Suede Scan for another site.'
        : 'The audit could not inspect that URL.';
      throw new Error(payload.error || fallback);
    }

    renderReport(payload);
    storeReport(payload);
    urlInput.value = payload.host;
    const path = reportPath(payload.host);
    if (updateHistory) history.pushState({ host: payload.host }, '', path);
    else if (window.location.pathname !== path) history.replaceState({ host: payload.host }, '', path);
  } catch (error) {
    report.hidden = true;
    landingShell.hidden = false;
    setReportNavigation(false);
    showError(error.message || 'We could not inspect that public URL. Check the address and try again.');
    urlInput.focus();
  } finally {
    setLoading(false);
  }
}

function resetAudit({ updateHistory = true, focus = true } = {}) {
  currentReport = null;
  currentReportIsSharedSnapshot = false;
  report.hidden = true;
  landingShell.hidden = false;
  setReportNavigation(false);
  clearError();
  document.title = 'Suede Audit | AI Discovery and SEO Readiness';
  if (updateHistory) history.pushState({}, '', '/');
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  if (focus) window.setTimeout(() => urlInput.focus(), reduceMotion ? 0 : 250);
}

async function copyReport(button) {
  if (!currentReport) return;
  const original = button.textContent;
  let url;
  try {
    url = sharedReportHref(currentReport);
  } catch {
    button.textContent = 'Report too large to share';
    window.setTimeout(() => { button.textContent = original; }, 3000);
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = 'Link copied';
  } catch {
    window.prompt('Copy this report link:', url);
    button.textContent = 'Copy this URL';
  }
  window.setTimeout(() => { button.textContent = original; }, 2000);
}

function domainFromLocation() {
  const match = window.location.pathname.match(/^\/report\/([^/]+)\/?$/);
  if (match) {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  }
  return new URLSearchParams(window.location.search).get('url');
}

function renderSharedReportFromLocation() {
  const domain = domainFromLocation();
  const sharedSnapshot = readSharedReportSnapshot(domain);
  if (!sharedSnapshot.present) return false;
  stripSharedReportFragment();
  if (sharedSnapshot.report) renderReport(sharedSnapshot.report, { sharedSnapshot: true });
  else showNonConsumingReportPrompt(domain, true);
  return true;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAudit(urlInput.value);
});

auditEntry.addEventListener('click', () => {
  const saved = readStoredReport();
  if (saved) {
    renderReport(saved);
    const path = reportPath(saved.host);
    if (window.location.pathname !== path) history.pushState({ host: saved.host }, '', path);
    return;
  }
  urlInput.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  window.setTimeout(() => urlInput.focus(), reduceMotion ? 0 : 250);
});

[byId('copy-report'), byId('copy-report-bottom')].forEach((button) => {
  button.addEventListener('click', () => copyReport(button));
});

window.addEventListener('popstate', () => {
  const domain = domainFromLocation();
  if (!domain) {
    resetAudit({ updateHistory: false, focus: false });
    return;
  }
  if (currentReport && inputHost(domain) === currentReport.host.toLowerCase()) {
    renderReport(currentReport, { sharedSnapshot: currentReportIsSharedSnapshot });
    return;
  }
  const saved = readStoredReport();
  if (saved && inputHost(domain) === saved.host.toLowerCase()) renderReport(saved);
  else showNonConsumingReportPrompt(domain);
});

window.addEventListener('hashchange', () => {
  renderSharedReportFromLocation();
});

const initialDomain = domainFromLocation();
if (!renderSharedReportFromLocation()) {
  const storedReport = readStoredReport();
  if (storedReport && initialDomain && inputHost(initialDomain) === storedReport.host.toLowerCase()) {
    renderReport(storedReport);
  } else if (storedReport && initialDomain) {
    auditEntry.textContent = 'View saved audit';
    history.replaceState({}, '', '/');
    showUsedAudit(storedReport);
  } else if (initialDomain) {
    showNonConsumingReportPrompt(initialDomain);
  } else if (storedReport) {
    auditEntry.textContent = 'View saved audit';
    urlInput.value = storedReport.host;
  }
}
