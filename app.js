const fontStylesheet = document.createElement('link');
fontStylesheet.rel = 'stylesheet';
fontStylesheet.href = 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap';
document.head.append(fontStylesheet);

const byId = (id) => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const landingShell = byId('landing-shell');
const report = byId('report');
const form = byId('audit-form');
const urlInput = byId('audit-url');
const submitButton = byId('submit-button');
const formError = byId('form-error');
const loadingPanel = byId('loading-panel');
const loadingDetail = byId('loading-detail');
const navLinks = [...document.querySelectorAll('.primary-nav a')];

let currentReport = null;
let loadingTimer = null;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
}[character]));

const clampScore = (value) => Math.max(0, Math.min(100, Number(value) || 0));
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

function renderReport(data) {
  currentReport = data;
  const score = clampScore(data.score);
  const laneCount = Object.keys(data.laneScores || {}).length;
  const reportTitle = `${data.host} Public-Site Audit | Suede Audit`;

  document.title = reportTitle;
  byId('report-title').textContent = data.host;
  byId('report-subtitle').textContent = 'Public-site discovery and answer-readiness report';
  byId('stat-checks').textContent = data.total;
  byId('stat-lanes').textContent = laneCount;
  byId('stat-repairs').textContent = data.recommendations.length;
  byId('report-timestamp').textContent = formatTimestamp(data.auditedAt, data.elapsedMs);
  byId('score-value').textContent = score;
  byId('grade-value').textContent = data.grade;
  byId('score-gauge').style.setProperty('--score-angle', `${score * 3.6}deg`);
  byId('methodology-copy').textContent = data.methodology;
  byId('share-score').querySelector('strong').textContent = score;

  renderScorePlatforms(data.platforms || []);
  renderPillars(data.pillarScores || []);
  renderInsight(data);
  renderPlatforms(data.platforms || []);
  renderLanes(data.laneScores || {});
  renderRepairs(data.recommendations || []);
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

  setLoading(true);
  try {
    const response = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: value }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'The audit could not inspect that URL.');

    renderReport(payload);
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
  const url = new URL(reportPath(currentReport.host), window.location.origin).href;
  const original = button.textContent;
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

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAudit(urlInput.value);
});

document.querySelectorAll('[data-run-another]').forEach((button) => {
  button.addEventListener('click', () => {
    if (report.hidden) {
      urlInput.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
      window.setTimeout(() => urlInput.focus(), reduceMotion ? 0 : 250);
    } else {
      resetAudit();
    }
  });
});

[byId('copy-report'), byId('copy-report-bottom')].forEach((button) => {
  button.addEventListener('click', () => copyReport(button));
});

window.addEventListener('popstate', () => {
  const domain = domainFromLocation();
  if (domain) runAudit(domain, { updateHistory: false });
  else resetAudit({ updateHistory: false, focus: false });
});

const initialDomain = domainFromLocation();
if (initialDomain) {
  urlInput.value = initialDomain;
  runAudit(initialDomain, { updateHistory: false });
}
