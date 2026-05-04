/**
 * AEGISGEMMA — Crisis Coordination Dashboard
 */

const state = {
  map: null, markers: {}, pinMode: false, pendingPin: null,
  ws: null, wsRetries: 0, reports: [], reportIds: new Set(),
  submittingId: null, heartbeatTimer: null,
  streamBuffers: {},
  crosshair: null,
  proximityLines: [],
  proximityLinesByPair: [],
  proximityBuffer: '',
  activePairPopups: new Map(),
};

document.addEventListener('DOMContentLoaded', () => {
  initMap(); initClock(); initWebSocket();
  loadReports(); loadDashboard();
  setInterval(loadDashboard, 15000);
  setInterval(refreshElapsedTimes, 30000);
});

// ─── Tab Switching ──────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const tabEl = document.getElementById('tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  const viewMap = { map: 'map-view', briefing: 'briefing-view', proximity: 'proximity-view' };
  const viewEl = document.getElementById(viewMap[tab]);
  if (viewEl) viewEl.classList.add('active');
  if (tab === 'map') setTimeout(() => state.map?.invalidateSize(), 100);
}

// ─── Map Setup ──────────────────────────────────────
function initMap() {
  state.map = L.map('map', {
    center: [25.2854, 51.5310], zoom: 13,
    zoomControl: true, attributionControl: false,
    maxZoom: 16, minZoom: 7,
    maxBounds: [[24.0, 50.0], [26.5, 53.0]],
    maxBoundsViscosity: 1.0,
  });
  // Tile layer with CSS class for professional filter treatment
  const tiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 16, minZoom: 7, maxNativeZoom: 16, className: 'map-tiles' });
  tiles.addTo(state.map);

  // Impact radius layer (rendered below markers)
  state.radiusLayer = L.layerGroup().addTo(state.map);

  state.map.on('click', e => { if (state.pinMode) placePin(e.latlng.lat, e.latlng.lng); });
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(state.map);

  // Severity legend
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = function() {
    const div = L.DomUtil.create('div', 'map-legend');
    div.innerHTML = `
      <div class="legend-title">Severity</div>
      <div class="legend-item"><span class="legend-dot" style="background:#d93025"></span>Critical</div>
      <div class="legend-item"><span class="legend-dot" style="background:#e8710a"></span>High</div>
      <div class="legend-item"><span class="legend-dot" style="background:#f9ab00"></span>Medium</div>
      <div class="legend-item"><span class="legend-dot" style="background:#1e8e3e"></span>Low</div>
      <div class="legend-divider"></div>
      <div class="legend-item"><span class="legend-ring"></span>Impact Zone</div>`;
    return div;
  };
  legend.addTo(state.map);
}

// ─── Pin Drop ───────────────────────────────────────
function togglePinMode() {
  state.pinMode = !state.pinMode;
  const btn = document.getElementById('btn-pin-drop');
  const overlay = document.getElementById('map-overlay');
  if (state.pinMode) {
    btn.classList.add('active');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg> Cancel Pin';
    overlay.classList.add('active');
    document.getElementById('map').style.cursor = 'crosshair';
    showCrosshair();
  } else {
    btn.classList.remove('active');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg> Drop Crisis Pin';
    overlay.classList.remove('active');
    document.getElementById('map').style.cursor = '';
    hideCrosshair();
    if (state.pendingPin) { state.map.removeLayer(state.pendingPin); state.pendingPin = null; }
  }
}

// ─── Map Crosshair (pin-mode target indicator) ──────
function showCrosshair() {
  if (state.crosshair) return;
  const mapEl = document.getElementById('map');
  const ch = document.createElement('div');
  ch.id = 'map-crosshair';
  ch.innerHTML = `
    <svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="22" stroke="#1a73e8" stroke-width="2" stroke-dasharray="4 3" opacity="0.5">
        <animateTransform attributeName="transform" type="rotate" from="0 32 32" to="360 32 32" dur="8s" repeatCount="indefinite"/>
      </circle>
      <circle cx="32" cy="32" r="12" stroke="#1a73e8" stroke-width="2" opacity="0.7"/>
      <line x1="32" y1="4" x2="32" y2="18" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
      <line x1="32" y1="46" x2="32" y2="60" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
      <line x1="4" y1="32" x2="18" y2="32" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
      <line x1="46" y1="32" x2="60" y2="32" stroke="#1a73e8" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
      <circle cx="32" cy="32" r="3" fill="#1a73e8" opacity="0.9"/>
    </svg>
  `;
  mapEl.appendChild(ch);
  state.crosshair = ch;
}

function hideCrosshair() {
  if (state.crosshair) { state.crosshair.remove(); state.crosshair = null; }
}

function placePin(lat, lng) {
  if (state.pendingPin) state.map.removeLayer(state.pendingPin);
  state.pendingPin = L.circleMarker([lat, lng], {
    radius: 12, color: '#1a73e8', fillColor: '#1a73e8', fillOpacity: 0.3, weight: 2,
  }).addTo(state.map);
  document.getElementById('input-lat').value = lat.toFixed(6);
  document.getElementById('input-lng').value = lng.toFixed(6);
  document.getElementById('input-report').focus();
  togglePinMode();
  showToast('Pin placed. Describe the incident below.', 'info');
}

// ─── Submit Report ──────────────────────────────────
async function submitReport(e) {
  e.preventDefault();
  const lat = parseFloat(document.getElementById('input-lat').value);
  const lng = parseFloat(document.getElementById('input-lng').value);
  const text = document.getElementById('input-report').value.trim();
  if (!text || isNaN(lat) || isNaN(lng)) { showToast('Place a pin and describe the incident.', 'warning'); return; }

  const btn = document.getElementById('btn-submit');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Analyzing...';

  try {
    const res = await fetch('/api/reports', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ latitude: lat, longitude: lng, report_text: text }),
    });
    const data = await res.json();
    if (data.status === 'success') {
      state.submittingId = data.report.id;
      addReportToMap(data.report); addReportToList(data.report); showAiAnalysis(data.report);
      if (data.ai_pending) {
        markReportAnalyzing(data.report.id);
        showToast(`Report #${data.report.id} submitted. Gemma is analyzing...`, 'info');
      } else {
        showToast(`Report #${data.report.id} — ${data.report.severity?.toUpperCase()}`, 'success');
      }
      document.getElementById('report-form').reset();
      if (state.pendingPin) { state.map.removeLayer(state.pendingPin); state.pendingPin = null; }
      loadDashboard();
      setTimeout(() => { state.submittingId = null; }, 2000);
    }
  } catch (err) { showToast('Network error.', 'error'); }
  finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Submit \u0026 Analyze';
  }
}

// ─── Streaming Token Display ────────────────────────
function showStreamingPanel(reportId) {
  const panel = document.getElementById('ai-panel');
  const empty = document.getElementById('ai-empty');
  if (empty) empty.remove();
  // Remove existing for this report
  const existing = panel.querySelector(`[data-report-id="${reportId}"]`);
  if (existing) existing.remove();

  state.streamBuffers[reportId] = '';
  const html = `
    <div class="ai-result ai-streaming" data-report-id="${reportId}">
      <div class="ai-result-header">
        <div class="ai-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4285f4" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg></div>
        <span>Gemma 4 E2B Streaming — Report #${reportId}</span>
        <span class="streaming-dot"></span>
      </div>
      <div class="stream-output" id="stream-${reportId}">
        <span class="cursor-blink">|</span>
      </div>
      <div class="inference-meta">
        <span class="spinner-sm"></span>
        <span id="stream-tokens-${reportId}">0 tokens</span>
      </div>
    </div>`;
  panel.insertAdjacentHTML('afterbegin', html);
}

function appendStreamToken(reportId, token) {
  state.streamBuffers[reportId] = (state.streamBuffers[reportId] || '') + token;
  const el = document.getElementById('stream-' + reportId);
  if (el) {
    el.innerHTML = formatStreamText(state.streamBuffers[reportId]) + '<span class="cursor-blink">|</span>';
    el.scrollTop = el.scrollHeight;
  }
  const tokenEl = document.getElementById('stream-tokens-' + reportId);
  if (tokenEl) tokenEl.textContent = (state.streamBuffers[reportId].length) + ' chars';
}

function formatStreamText(text) {
  // Syntax highlight JSON keys
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
    .replace(/: "((?:[^"\\]|\\.)*)"/g, ': <span class="json-str">"$1"</span>')
    .replace(/: (\d+)/g, ': <span class="json-num">$1</span>')
    .replace(/: (true|false)/g, ': <span class="json-bool">$1</span>');
}

// ─── Analyzing State ────────────────────────────────
function markReportAnalyzing(reportId) {
  const card = document.getElementById(`report-card-${reportId}`);
  if (card) {
    card.classList.add('analyzing');
    const header = card.querySelector('.report-header');
    if (header && !header.querySelector('.analyzing-indicator')) {
      const ind = document.createElement('span');
      ind.className = 'analyzing-indicator';
      ind.innerHTML = '<span class="spinner-sm"></span>';
      header.appendChild(ind);
    }
  }
  showStreamingPanel(reportId);
}

function updateReportWithAnalysis(reportId, report) {
  const card = document.getElementById(`report-card-${reportId}`);
  if (card) {
    card.classList.remove('analyzing');
    const ind = card.querySelector('.analyzing-indicator');
    if (ind) ind.remove();
    const severity = report.severity || report.ai_analysis?.severity || 'unknown';
    card.className = `report-card severity-${severity}`;
    card.id = `report-card-${reportId}`;
    const analysis = report.ai_analysis || {};
    const time = report.created_at ? new Date(report.created_at).toLocaleTimeString() : '';
    card.innerHTML = buildCardHTML(report, severity, analysis);
    card.onclick = () => { flyToReport(report); showAiAnalysis(report); };
  }
  addReportToMap(report);
  const idx = state.reports.findIndex(r => r.id === reportId);
  if (idx !== -1) state.reports[idx] = report;
  showAiAnalysis(report);
  delete state.streamBuffers[reportId];

  // Auto fly-to and open popup after analysis completes (critical for demo recording)
  flyToReport(report);
}

function flyToReport(report) {
  switchTab('map');
  state.map.flyTo([report.latitude, report.longitude], 15, { duration: 1.2 });
  setTimeout(() => {
    const marker = state.markers[`r-${report.id}`];
    if (marker) marker.openPopup();
  }, 1400);
}

// ─── Map Markers ────────────────────────────────────
function addReportToMap(report) {
  const sev = report.severity || report.ai_analysis?.severity || 'low';
  const a = report.ai_analysis || {};

  // Remove existing marker + radius
  if (state.markers[`r-${report.id}`]) state.map.removeLayer(state.markers[`r-${report.id}`]);
  if (state.markers[`rad-${report.id}`]) state.radiusLayer.removeLayer(state.markers[`rad-${report.id}`]);

  // Pending reports get neutral styling until Gemma decides
  const isPending = sev === 'pending' || sev === 'unknown';

  // Severity-based sizing (all large enough for ID label)
  const sizes = { critical: 30, high: 26, medium: 24, low: 22, pending: 26, unknown: 26 };
  const sz = sizes[sev] || 24;
  const markerClass = isPending ? 'crisis-marker pending' : `crisis-marker ${sev}`;
  const idLabel = report.id || '';
  const icon = L.divIcon({
    className: '',
    html: `<div class="${markerClass}" style="width:${sz}px;height:${sz}px"><span class="marker-id">${idLabel}</span></div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz/2, sz/2],
  });
  // Newer reports (higher IDs) get higher z-index so they always render on top
  const baseZ = sev === 'critical' ? 1000 : sev === 'high' ? 500 : 0;
  const idZ = (report.id || 0) * 10;
  const marker = L.marker([report.latitude, report.longitude], { icon, zIndexOffset: baseZ + idZ });
  marker.addTo(state.map);

  // Enterprise popup
  marker.bindPopup(buildPopupHTML(report, sev, a), { className: 'crisis-popup', maxWidth: 360, minWidth: 280, autoClose: false, closeOnClick: false });

  state.markers[`r-${report.id}`] = marker;

  // Impact radius — skip for pending reports (no severity data yet)
  if (!isPending) {
    const radiusMap = { critical: 400, high: 300, medium: 200, low: 120 };
    const radius = L.circle([report.latitude, report.longitude], {
      radius: radiusMap[sev] || 150,
      color: sevColor(sev),
      fillColor: sevColor(sev),
      fillOpacity: 0.06,
      weight: 1.5,
      opacity: 0.3,
      dashArray: sev === 'critical' ? '' : '6 4',
      className: `impact-zone ${sev}`,
    });
    radius.addTo(state.radiusLayer);
    state.markers[`rad-${report.id}`] = radius;
  }
}

function buildPopupHTML(report, sev, a) {
  const sevGrad = {
    critical:'linear-gradient(135deg, #d93025, #b71c1c)',
    high:'linear-gradient(135deg, #e8710a, #c25e00)',
    medium:'linear-gradient(135deg, #f9ab00, #e09500)',
    low:'linear-gradient(135deg, #1e8e3e, #137333)',
    pending:'linear-gradient(135deg, #5f6368, #3c4043)',
    unknown:'linear-gradient(135deg, #5f6368, #3c4043)',
  };
  const p = a.priority || 0;
  const time = report.created_at ? new Date(report.created_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '';
  const isLive = a.model_used && !a.model_used.includes('fallback');

  // Compact priority bar
  let pbar = '';
  for (let i = 1; i <= 10; i++) {
    const filled = i <= p;
    const c = filled ? (p >= 8 ? '#fff' : 'rgba(255,255,255,0.9)') : 'rgba(255,255,255,0.25)';
    pbar += `<div style="width:14px;height:3px;border-radius:2px;background:${c}"></div>`;
  }

  // Format category for display
  const formatTag = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const catDisplay = a.category ? formatTag(a.category) : '';

  // Truncated summary for popup (full version lives in right panel)
  const summaryText = a.summary
    ? (a.summary.length > 150 ? a.summary.substring(0, 150) + '…' : a.summary)
    : (report.report_text || '').substring(0, 120) + ((report.report_text || '').length > 120 ? '…' : '');

  return `
    <div class="popup-enterprise">
      <!-- Severity band -->
      <div class="pe-band" style="background:${sevGrad[sev]}">
        <div class="pe-band-top">
          <span class="pe-band-id">#${String(report.id).padStart(3,'0')}</span>
          <span class="pe-band-sev">${sev.toUpperCase()}</span>
        </div>
        ${catDisplay ? `<div class="pe-band-cat">${catDisplay}</div>` : ''}
        <div class="pe-band-bar">
          <div style="display:flex;gap:2px;align-items:center">${pbar}</div>
          <span class="pe-band-p">P${p}</span>
        </div>
      </div>

      <!-- Key stats -->
      <div class="pe-stats">
        ${a.affected_estimate > 0 ? `<div class="pe-stat"><span class="pe-stat-val pe-stat-num">${a.affected_estimate.toLocaleString()}</span><span class="pe-stat-lbl">Affected</span></div>` : ''}
        ${a.evacuation_needed ? `<div class="pe-stat"><span class="pe-stat-val pe-stat-evac">EVAC</span><span class="pe-stat-lbl">Required</span></div>` : ''}
        <div class="pe-stat"><span class="pe-stat-val">${time}</span><span class="pe-stat-lbl">Time</span></div>
      </div>

      <!-- Summary only -->
      <div class="pe-intel">
        <div class="pe-intel-text">${summaryText}</div>
      </div>

      <!-- Footer -->
      <div class="pe-footer">
        <span>${report.latitude.toFixed(4)}, ${report.longitude.toFixed(4)}</span>
        <span>${isLive ? '● Gemma 4' : '○ Fallback'}${a.inference_time_ms ? ' · ' + a.inference_time_ms + 'ms' : ''}</span>
      </div>
    </div>`;
}

function sevColor(s) {
  return { critical: '#d93025', high: '#e8710a', medium: '#f9ab00', low: '#1e8e3e' }[s] || '#5f6368';
}

// ─── Event Lifecycle Helpers ────────────────────────
function elapsedTime(isoDate) {
  if (!isoDate) return '';
  const diff = Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff/60)}m`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ${Math.floor((diff%3600)/60)}m`;
  return `${Math.floor(diff/86400)}d`;
}

function getEventStatus(isoDate) {
  if (!isoDate) return { label: 'ACTIVE', cls: 'status-active' };
  const hours = (Date.now() - new Date(isoDate).getTime()) / 3600000;
  if (hours < 6) return { label: 'ACTIVE', cls: 'status-active' };
  if (hours < 24) return { label: 'MONITORING', cls: 'status-monitoring' };
  return { label: 'RESOLVED', cls: 'status-resolved' };
}

function buildCardHTML(report, sev, a) {
  const elapsed = elapsedTime(report.created_at);
  const status = getEventStatus(report.created_at);
  const isPending = sev === 'pending' || sev === 'unknown';
  const sevDisplay = isPending
    ? '<span class="spinner-sm"></span> ANALYZING'
    : sev;
  const formatTag = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const catDisplay = isPending ? 'Gemma analyzing...' : formatTag(a.category || 'pending');
  return `<div class="report-header">
    <span class="report-id">#${String(report.id).padStart(3,'0')}</span>
    <span class="severity-badge ${sev}">${sevDisplay}</span>
  </div>
  <div class="report-text">${report.report_text || ''}</div>
  <div class="report-meta">
    <span>${catDisplay}</span>
    <span class="event-status ${status.cls}"><span class="status-pulse"></span>${status.label}</span>
    <span class="elapsed-time" data-created="${report.created_at || ''}">${elapsed}</span>
  </div>`;
}

function refreshElapsedTimes() {
  document.querySelectorAll('.elapsed-time[data-created]').forEach(el => {
    const created = el.getAttribute('data-created');
    if (created) el.textContent = elapsedTime(created);
  });
}

// ─── Reports List ───────────────────────────────────
function addReportToList(report) {
  if (state.reportIds.has(report.id)) return;
  state.reportIds.add(report.id);
  const list = document.getElementById('reports-list');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();
  const sev = report.severity || report.ai_analysis?.severity || 'unknown';
  const a = report.ai_analysis || {};
  const card = document.createElement('div');
  card.className = `report-card severity-${sev}`; card.id = `report-card-${report.id}`;
  card.onclick = () => { flyToReport(report); showAiAnalysis(report); };
  card.innerHTML = buildCardHTML(report, sev, a);
  list.insertBefore(card, list.firstChild);
  state.reports.unshift(report);
  document.getElementById('report-count').textContent = state.reports.length;
}

// ─── AI Analysis Display ────────────────────────────
function showAiAnalysis(report) {
  const panel = document.getElementById('ai-panel');
  const a = report.ai_analysis || {};
  const empty = document.getElementById('ai-empty'); if (empty) empty.remove();
  const p = a.priority || 0;
  const sevGradMap = {
    critical:'linear-gradient(135deg, #d93025, #b71c1c)',
    high:'linear-gradient(135deg, #e8710a, #c25e00)',
    medium:'linear-gradient(135deg, #f9ab00, #e09500)',
    low:'linear-gradient(135deg, #1e8e3e, #137333)',
    pending:'linear-gradient(135deg, #5f6368, #3c4043)',
    unknown:'linear-gradient(135deg, #5f6368, #3c4043)',
  };
  const sev = a.severity || 'unknown';
  const sevBg = sevGradMap[sev] || sevGradMap.unknown;

  // Priority bar with severity-aware colors
  let pbar = ''; for (let i=1;i<=10;i++) {
    const filled = i <= p;
    const c = filled ? (p >= 8 ? '#fff' : 'rgba(255,255,255,0.9)') : 'rgba(255,255,255,0.25)';
    pbar += `<div style="width:14px;height:3px;border-radius:2px;background:${c}"></div>`;
  }
  const formatTag = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const catDisplay = a.category ? formatTag(a.category) : '';
  const res = (a.resource_needs||[]).map(r=>`<span class="ai-tag">${formatTag(r)}</span>`).join('');
  const risks = (a.risk_factors||[]).map(r=>`<span class="ai-tag risk">${formatTag(r)}</span>`).join('');
  const isLive = a.model_used && a.model_used.includes('gemma');

  const html = `<div class="ai-result" data-report-id="${report.id}">
    <!-- Severity Header Band -->
    <div class="ai-band" style="background:${sevBg}">
      <div class="ai-band-top">
        <span class="ai-band-id">#${String(report.id).padStart(3,'0')}</span>
        <span class="ai-band-model">${isLive ? '● GEMMA 4' : '○ FALLBACK'}</span>
      </div>
      ${catDisplay ? `<div class="ai-band-cat">${catDisplay}</div>` : ''}
      <div class="ai-band-bar">
        <span class="ai-band-sev">${sev.toUpperCase()}</span>
        <div style="display:flex;gap:2px;align-items:center">${pbar}</div>
        <span class="ai-band-p">P${p}</span>
      </div>
    </div>

    ${a.evacuation_needed ? `<div class="ai-evac-alert">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      EVACUATION REQUIRED
    </div>` : ''}

    <!-- Tactical Summary -->
    <div class="ai-section">
      <div class="ai-section-label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--g-blue)" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> Tactical Summary</div>
      <div class="ai-section-text">${a.summary||'Analysis pending...'}</div>
    </div>

    <!-- Immediate Action -->
    ${a.recommended_action ? `<div class="ai-section ai-section-action">
      <div class="ai-section-label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--g-orange)" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Immediate Action</div>
      <div class="ai-section-text">${a.recommended_action}</div>
    </div>` : ''}

    <!-- Metrics Row -->
    ${a.affected_estimate > 0 ? `<div class="ai-metrics">
      <div class="ai-metric">
        <span class="ai-metric-val">${a.affected_estimate.toLocaleString()}</span>
        <span class="ai-metric-lbl">Est. Affected</span>
      </div>
    </div>` : ''}

    <!-- Resources & Risks -->
    ${res ? `<div class="ai-section">
      <div class="ai-section-label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--g-blue)" stroke-width="2"><path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></svg> Required Resources</div>
      <div class="ai-tags">${res}</div>
    </div>` : ''}
    ${risks ? `<div class="ai-section">
      <div class="ai-section-label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--g-red)" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> Risk Factors</div>
      <div class="ai-tags">${risks}</div>
    </div>` : ''}

    <!-- Inference Footer -->
    <div class="inference-meta">
      <span>${a.inference_time_ms?a.inference_time_ms+'ms':'—'}</span>
      <span>${isLive ? 'gemma-4-e2b-it' : ''}</span>
      <span>${a.tokens_used?a.tokens_used+' tokens':''}</span>
    </div>
  </div>`;
  // Clear all previous completed cards (keep streaming ones intact)
  panel.querySelectorAll('.ai-result:not(.ai-streaming)').forEach(el => {
    if (el.getAttribute('data-report-id') !== String(report.id)) el.remove();
  });
  const ex = panel.querySelector(`[data-report-id="${report.id}"]`);
  if (ex) ex.outerHTML = html; else panel.insertAdjacentHTML('afterbegin', html);
  panel.scrollTop = 0;

  // Highlight active card in left panel
  document.querySelectorAll('.report-card').forEach(c => c.classList.remove('active'));
  const activeCard = document.getElementById(`report-card-${report.id}`);
  if (activeCard) activeCard.classList.add('active');
}

// ─── Situation Briefing (STREAMING) ─────────────────
async function generateBriefing() {
  const btn = document.getElementById('btn-briefing');
  const content = document.getElementById('briefing-content');
  const briefingBtnDefault = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> Generate Briefing';
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Synthesizing...';

  // Show live streaming terminal
  content.innerHTML = `
    <div class="briefing-stream-container">
      <div class="briefing-stream-header">
        <span class="stream-dot"></span>
        <span>GEMMA 4 E2B — Synthesizing situation briefing...</span>
        <span class="briefing-token-count" id="briefing-token-count">0 tokens</span>
      </div>
      <div class="briefing-stream-terminal" id="briefing-stream-output"></div>
    </div>`;
  state.briefingBuffer = '';

  // Safety timeout: re-enable button after 120s if WS never completes
  if (state._briefingTimeout) clearTimeout(state._briefingTimeout);
  state._briefingTimeout = setTimeout(() => {
    if (btn.disabled) {
      btn.disabled = false; btn.innerHTML = briefingBtnDefault;
      showToast('Briefing timed out. Try again.', 'warning');
    }
  }, 120000);

  try {
    const res = await fetch('/api/briefing', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'success') {
      onBriefingComplete(data);
      clearTimeout(state._briefingTimeout);
    } else if (data.status === 'busy') {
      content.innerHTML = `<div class="briefing-empty"><p>${data.message}</p></div>`;
      btn.disabled = false; btn.innerHTML = briefingBtnDefault;
      clearTimeout(state._briefingTimeout);
      showToast(data.message, 'warning');
    }
    // If streaming, tokens will come via WebSocket — UI is already set up
  } catch(e) {
    content.innerHTML = '<p class="error">Failed to generate briefing.</p>';
    btn.disabled = false; btn.innerHTML = briefingBtnDefault;
    clearTimeout(state._briefingTimeout);
  }
}

function onBriefingToken(token) {
  state.briefingBuffer = (state.briefingBuffer || '') + token;
  const el = document.getElementById('briefing-stream-output');
  if (el) {
    el.textContent = state.briefingBuffer;
    el.scrollTop = el.scrollHeight;
  }
  const countEl = document.getElementById('briefing-token-count');
  if (countEl) countEl.textContent = `${state.briefingBuffer.split(/\s+/).length} tokens`;
}

function parseBriefingSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = { title: '', body: '' };
  // Monochrome SVG icons — single stroke color, Google enterprise style
  const svgI = (d) => `<svg class="brpt-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${d}</svg>`;
  const sectionIcons = {
    'overview':  svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    'summary':   svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    'situation':  svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    'executive': svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    'critical':  svgI('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    'immediate': svgI('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    'urgent':    svgI('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    'action':    svgI('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    'priority':  svgI('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
    'resource':  svgI('<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>'),
    'deploy':    svgI('<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>'),
    'personnel': svgI('<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>'),
    'logistics': svgI('<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>'),
    'equipment': svgI('<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>'),
    'risk':      svgI('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    'cascade':   svgI('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    'threat':    svgI('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    'hazard':    svgI('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    'warning':   svgI('<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
    'evacuation':svgI('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
    'shelter':   svgI('<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'),
    'safety':    svgI('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    'coordination': svgI('<path d="M8.12 8.12L15.88 15.88M15.88 8.12L8.12 15.88"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>'),
    'communication': svgI('<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>'),
    'inter-agency': svgI('<path d="M8.12 8.12L15.88 15.88"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/>'),
    'recommendation': svgI('<path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>'),
    'next':      svgI('<path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>'),
    'follow':    svgI('<path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>'),
    'outlook':   svgI('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    'forecast':  svgI('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
    'medical':   svgI('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    'health':    svgI('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    'hospital':  svgI('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    'casualt':   svgI('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
    'infrastructure': svgI('<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
    'damage':    svgI('<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
    'structural':svgI('<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>'),
    'transport': svgI('<rect x="1" y="3" width="15" height="13" rx="2" ry="2"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>'),
  };
  const defaultIcon = svgI('<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>');
  function matchIcon(title) {
    const t = title.toLowerCase();
    for (const [key, icon] of Object.entries(sectionIcons)) {
      if (t.includes(key)) return icon;
    }
    return defaultIcon;
  }
  for (const line of lines) {
    const headerMatch = line.match(/^\*\*(.+?)\*\*\s*:?\s*$/) || line.match(/^\*\*(.+?)\*\*/) ||
      line.match(/^#{1,3}\s+(.+)$/) || line.match(/^([A-Z][A-Z\s&/,-]{4,}):?\s*$/);
    if (headerMatch) {
      if (current.title || current.body.trim()) sections.push({ ...current });
      current = { title: headerMatch[1].replace(/\*\*/g, '').trim(), body: '' };
    } else {
      current.body += line + '\n';
    }
  }
  if (current.title || current.body.trim()) sections.push({ ...current });
  return sections.map(s => ({ ...s, icon: matchIcon(s.title || s.body) }));
}

function onBriefingComplete(data) {
  const content = document.getElementById('briefing-content');
  const btn = document.getElementById('btn-briefing');
  if (state._briefingTimeout) clearTimeout(state._briefingTimeout);
  const text = data.briefing || state.briefingBuffer || '';
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').split('.')[0] + ' UTC';
  const reportCount = data.report_count || state.reports.length || 0;
  const critCount = state.reports.filter(r => (r.severity || r.ai_analysis?.severity) === 'critical').length;
  const highCount = state.reports.filter(r => (r.severity || r.ai_analysis?.severity) === 'high').length;
  const infMs = data.inference_time_ms || 0;
  const tokens = data.tokens_used || 0;
  const tps = infMs > 0 ? (tokens / (infMs / 1000)).toFixed(1) : '—';

  // Parse sections
  const sections = parseBriefingSections(text);
  const hasSections = sections.some(s => s.title);

  let bodyHtml;
  if (hasSections) {
    bodyHtml = sections.map((s, i) => {
      if (!s.title && !s.body.trim()) return '';
      const bodyText = s.body.trim().replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
      if (!s.title) return `<div class="brpt-section brpt-section-intro" style="animation-delay:${i*80}ms"><div class="brpt-section-body">${bodyText}</div></div>`;
      return `<div class="brpt-section" style="animation-delay:${i*80}ms">
        <div class="brpt-section-header"><span class="brpt-section-icon">${s.icon}</span><span class="brpt-section-title">${s.title}</span></div>
        <div class="brpt-section-body">${bodyText}</div>
      </div>`;
    }).join('');
  } else {
    bodyHtml = `<div class="brpt-section brpt-section-intro"><div class="brpt-section-body">${text.replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</div></div>`;
  }

  const threatLevel = critCount >= 2 ? 'CRITICAL' : critCount >= 1 ? 'ELEVATED' : highCount >= 2 ? 'HIGH' : 'MODERATE';

  content.innerHTML = `
    <div class="brpt">
      <div class="brpt-classified">
        <div class="brpt-classified-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>AEGISGEMMA SITUATION BRIEFING</span>
        </div>
        <span class="brpt-classified-ts">${ts}</span>
      </div>

      <div class="brpt-threat-banner">
        <div class="brpt-threat-left">
          <span class="brpt-threat-label">THREAT ASSESSMENT</span>
          <span class="brpt-threat-level">${threatLevel}</span>
        </div>
        <div class="brpt-threat-right">
          <span class="brpt-threat-pill"><span class="brpt-dot"></span> GEMMA 4 E2B — LOCAL INFERENCE</span>
        </div>
      </div>

      <div class="brpt-metrics">
        <div class="brpt-metric">
          <span class="brpt-metric-val">${reportCount}</span>
          <span class="brpt-metric-lbl">REPORTS ANALYZED</span>
        </div>
        <div class="brpt-metric">
          <span class="brpt-metric-val">${critCount}</span>
          <span class="brpt-metric-lbl">CRITICAL</span>
        </div>
        <div class="brpt-metric">
          <span class="brpt-metric-val">${highCount}</span>
          <span class="brpt-metric-lbl">HIGH SEVERITY</span>
        </div>
        <div class="brpt-metric">
          <span class="brpt-metric-val">${(infMs/1000).toFixed(1)}s</span>
          <span class="brpt-metric-lbl">INFERENCE TIME</span>
        </div>
        <div class="brpt-metric">
          <span class="brpt-metric-val">${tokens}</span>
          <span class="brpt-metric-lbl">TOKENS</span>
        </div>
        <div class="brpt-metric">
          <span class="brpt-metric-val">${tps}</span>
          <span class="brpt-metric-lbl">TOKENS/SEC</span>
        </div>
      </div>

      <div class="brpt-body">${bodyHtml}</div>

      <div class="brpt-footer">
        <span>AEGISGEMMA · Air-Gapped Edge Intelligence</span>
        <span>gemma-4-e2b-it · ${tokens} tokens · ${(infMs/1000).toFixed(1)}s · ${reportCount} reports</span>
      </div>
    </div>`;

  btn.disabled = false;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> Generate Briefing';
  showToast(`Briefing complete — ${tokens} tokens in ${(infMs/1000).toFixed(1)}s · ${tps} tok/s`, 'success');
}

// ─── Load Data ──────────────────────────────────────
async function loadReports() {
  try {
    const res = await fetch('/api/reports'); const data = await res.json();
    if (data.reports) {
      state.reports = []; state.reportIds.clear();
      document.getElementById('reports-list').innerHTML = '';
      data.reports.forEach(r => { addReportToMap(r); addReportToList(r); });
    }
  } catch(e) {}
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/dashboard'); const data = await res.json();
    if (data.stats) {
      document.getElementById('stat-critical').textContent = data.stats.critical_count || 0;
      document.getElementById('stat-total').textContent = data.stats.total_reports || 0;
    }
    if (data.uptime_seconds) {
      const m = Math.floor(data.uptime_seconds/60), s = data.uptime_seconds%60;
      document.getElementById('stat-uptime').textContent = m>0?`${m}m ${s}s`:`${s}s`;
    }
    if (data.model_status) {
      const dot = document.getElementById('ai-status-dot');
      const txt = document.getElementById('ai-status-text');
      if (data.model_status.loaded) {
        dot.className = 'status-dot online'; txt.textContent = 'Gemma Ready';
        document.getElementById('model-name').textContent = 'Gemma 4 E2B';
        document.getElementById('inference-mode').textContent = data.model_status.mode || 'local';
      } else {
        dot.className = 'status-dot degraded'; txt.textContent = 'Fallback';
        document.getElementById('model-name').textContent = 'Keyword Engine';
        document.getElementById('inference-mode').textContent = 'rule-based';
      }
    }
  } catch(e) {}
}

// ─── WebSocket ──────────────────────────────────────
function initWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    state.ws = new WebSocket(`${proto}//${location.host}/ws`);
    state.ws.onopen = () => {
      state.wsRetries = 0;
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = setInterval(() => { if (state.ws?.readyState===1) state.ws.send('ping'); }, 30000);
    };
    state.ws.onmessage = e => { try { handleWS(JSON.parse(e.data)); } catch(x){} };
    state.ws.onclose = () => {
      if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
      if (state.wsRetries < 10) { state.wsRetries++; setTimeout(initWebSocket, Math.min(1000*Math.pow(2,state.wsRetries),30000)); }
    };
    state.ws.onerror = () => {};
  } catch(e) {}
}

function handleWS(msg) {
  switch(msg.type) {
    case 'new_report':
      if (msg.report.id === state.submittingId) return;
      if (!state.reportIds.has(msg.report.id)) {
        addReportToMap(msg.report); addReportToList(msg.report);
        showToast(`New report #${msg.report.id}`, 'info');
      } break;
    case 'analysis_started':
      markReportAnalyzing(msg.report_id); break;
    case 'analysis_token':
      appendStreamToken(msg.report_id, msg.token); break;
    case 'analysis_complete':
      if (msg.report) {
        updateReportWithAnalysis(msg.report_id, msg.report);
        const a = msg.report.ai_analysis || {};
        showToast(`AI: Report #${msg.report_id} — ${(a.severity||'?').toUpperCase()} P${a.priority||'?'} [${a.inference_time_ms||0}ms]`,
          a.severity==='critical'?'error':'success');
        loadDashboard();
      } break;
    case 'analysis_failed':
      const c = document.getElementById(`report-card-${msg.report_id}`);
      if (c) { c.classList.remove('analyzing'); const i=c.querySelector('.analyzing-indicator'); if(i)i.remove(); }
      showToast(`Analysis failed: #${msg.report_id}`, 'error'); break;
    // ─── Briefing Streaming ─────────────────────────
    case 'briefing_started':
      showToast(`Synthesizing ${msg.report_count} reports...`, 'info'); break;
    case 'briefing_token':
      onBriefingToken(msg.token); break;
    case 'briefing_complete':
      onBriefingComplete(msg); break;
    case 'briefing_failed':
      document.getElementById('briefing-content').innerHTML = '<p class="error">Briefing generation failed.</p>';
      document.getElementById('btn-briefing').disabled = false;
      showToast('Briefing failed: ' + (msg.error || 'unknown'), 'error'); break;
    // ─── Proximity Intelligence ─────────────────────
    case 'proximity_started':
      onProximityStarted(msg); break;
    case 'proximity_token':
      onProximityToken(msg.token); break;
    case 'proximity_complete':
      onProximityComplete(msg); break;
    case 'proximity_failed':
      document.getElementById('proximity-content').innerHTML = '<p class="error">Proximity analysis failed.</p>';
      document.getElementById('btn-proximity').disabled = false;
      showToast('Proximity analysis failed', 'error'); break;
  }
}

// ─── Clock ──────────────────────────────────────────
function initClock() {
  const update = () => {
    const n = new Date();
    document.getElementById('clock').textContent =
      n.toTimeString().split(' ')[0] + ' UTC' + (n.getTimezoneOffset()>0?'-':'+') +
      String(Math.abs(Math.floor(n.getTimezoneOffset()/60))).padStart(2,'0');
  };
  update(); setInterval(update, 1000);
}

// ─── Toast ──────────────────────────────────────────
function showToast(msg, type='info') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`; t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(40px)'; setTimeout(()=>t.remove(),300); }, 5000);
}


// ─── Proximity Intelligence (Gemma Feature #3) ─────

async function runProximityAnalysis() {
  const btn = document.getElementById('btn-proximity');
  const proxBtnDefault = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.12 8.12L15.88 15.88"/></svg> Analyze Proximity';
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing Proximity...';

  const content = document.getElementById('proximity-content');
  content.innerHTML = `
    <div class="proximity-streaming">
      <div class="prox-header-row">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--g-blue)" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.12 8.12L15.88 15.88"/></svg>
        <span>Gemma 4 analyzing spatial correlations...</span>
      </div>
      <div class="prox-stream" id="proximity-stream"><span class="cursor-blink">|</span></div>
    </div>`;

  state.proximityBuffer = '';

  // Safety timeout: re-enable button after 120s
  if (state._proximityTimeout) clearTimeout(state._proximityTimeout);
  state._proximityTimeout = setTimeout(() => {
    if (btn.disabled) {
      btn.disabled = false; btn.innerHTML = proxBtnDefault;
      showToast('Proximity analysis timed out. Try again.', 'warning');
    }
  }, 120000);

  try {
    const res = await fetch('/api/proximity-analysis', { method: 'POST' });
    const data = await res.json();
    if (data.status === 'error' || data.status === 'busy') {
      content.innerHTML = `<div class="briefing-empty"><p>${data.message}</p></div>`;
      btn.disabled = false;
      btn.innerHTML = proxBtnDefault;
      clearTimeout(state._proximityTimeout);
      if (data.status === 'busy') showToast(data.message, 'warning');
    }
  } catch (err) {
    content.innerHTML = '<p class="error">Failed to start proximity analysis.</p>';
    btn.disabled = false; btn.innerHTML = proxBtnDefault;
    clearTimeout(state._proximityTimeout);
  }
}

function onProximityStarted(msg) {
  showToast(`Analyzing ${msg.pair_count} incident pairs...`, 'info');
  // Draw initial distance lines on map (before AI insights)
  clearProximityLines();
  (msg.pairs || []).forEach(p => {
    const line = L.polyline(
      [[p.from_lat, p.from_lng], [p.to_lat, p.to_lng]],
      { color: '#5f6368', weight: 3, dashArray: '10 6', opacity: 0.8, className: 'proximity-line-pending' }
    ).addTo(state.map);
    // Distance label at midpoint
    const midLat = (p.from_lat + p.to_lat) / 2;
    const midLng = (p.from_lng + p.to_lng) / 2;
    const label = L.marker([midLat, midLng], {
      icon: L.divIcon({
        className: 'prox-dist-label',
        html: `<span>${p.distance_m >= 1000 ? (p.distance_m/1000).toFixed(1)+'km' : p.distance_m+'m'}</span>`,
        iconSize: [60, 20], iconAnchor: [30, 10],
      }),
      interactive: false,
    }).addTo(state.map);
    state.proximityLines.push(line, label);
  });
}

function onProximityToken(token) {
  state.proximityBuffer += token;
  const el = document.getElementById('proximity-stream');
  if (el) {
    el.innerHTML = formatStreamText(state.proximityBuffer) + '<span class="cursor-blink">|</span>';
    el.scrollTop = el.scrollHeight;
  }
}

function onProximityComplete(msg) {
  const btn = document.getElementById('btn-proximity');
  if (state._proximityTimeout) clearTimeout(state._proximityTimeout);
  btn.disabled = false;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M8.12 8.12L15.88 15.88"/></svg> Analyze Proximity';

  const pairs = msg.pairs || [];
  const content = document.getElementById('proximity-content');

  // Build results HTML
  const formatTag = t => t.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const riskColors = { critical: '#d93025', high: '#e8710a', medium: '#f9ab00', low: '#1e8e3e' };
  const riskGrads = {
    critical:'linear-gradient(135deg, #d93025, #b71c1c)',
    high:'linear-gradient(135deg, #e8710a, #c25e00)',
    medium:'linear-gradient(135deg, #f9ab00, #e09500)',
    low:'linear-gradient(135deg, #1e8e3e, #137333)',
  };

  let cardsHtml = pairs.map((p, i) => {
    const col = riskColors[p.risk_level] || '#5f6368';
    const grad = riskGrads[p.risk_level] || 'linear-gradient(135deg, #5f6368, #3c4043)';
    const distLabel = p.distance_m >= 1000 ? (p.distance_m/1000).toFixed(1)+' km' : p.distance_m+' m';
    const risk = (p.risk_level||'medium').toUpperCase();
    return `
      <div class="prox-card" data-pair-idx="${i}" title="Click to view on map">
        <div class="prox-band" style="background:${grad}">
          <div class="prox-band-top">
            <span class="prox-band-pair">PAIR ${i+1}</span>
            <span class="prox-band-risk">${risk}</span>
          </div>
          <div class="prox-band-ids">
            <span class="prox-band-id">#${String(p.from_id).padStart(3,'0')}</span>
            <svg width="20" height="10" viewBox="0 0 24 10" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="2"><path d="M2 5h20M18 1l4 4-4 4"/></svg>
            <span class="prox-band-id">#${String(p.to_id).padStart(3,'0')}</span>
            <span class="prox-band-dist">${distLabel}</span>
          </div>
        </div>
        <div class="prox-types-row">
          <div class="prox-type-pair">
            <span class="prox-type-id">#${String(p.from_id).padStart(3,'0')}</span>
            <span class="prox-type-cat">${formatTag(p.from_cat||'—')}</span>
          </div>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2" opacity="0.4"><path d="M8.12 8.12L15.88 15.88M15.88 8.12L8.12 15.88"/></svg>
          <div class="prox-type-pair" style="text-align:right">
            <span class="prox-type-id">#${String(p.to_id).padStart(3,'0')}</span>
            <span class="prox-type-cat">${formatTag(p.to_cat||'—')}</span>
          </div>
        </div>
        ${p.ai_insight ? `<div class="prox-section">
          <div class="prox-section-label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--g-blue)" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> AI Insight</div>
          <div class="prox-section-text">${p.ai_insight}</div>
        </div>` : ''}
        ${p.action ? `<div class="prox-section prox-section-action">
          <div class="prox-section-label"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--g-orange)" stroke-width="2.5"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Recommended Action</div>
          <div class="prox-section-text">${p.action}</div>
        </div>` : ''}
      </div>`;
  }).join('');

  content.innerHTML = `
    <div class="prox-results">
      <div class="prox-summary-bar">
        <span>${pairs.length} spatial correlations analyzed</span>
        <span>Gemma 4 · ${msg.inference_time_ms ? (msg.inference_time_ms/1000).toFixed(1)+'s' : '—'} · ${msg.tokens_used||0} tokens</span>
      </div>
      ${cardsHtml}
    </div>`;

  // Attach click-to-navigate handlers
  content.querySelectorAll('.prox-card[data-pair-idx]').forEach(card => {
    card.addEventListener('click', () => {
      const idx = parseInt(card.dataset.pairIdx, 10);
      navigateToPair(idx, pairs);
    });
  });

  // Update map lines with defense-grade tactical visualization
  clearProximityLines();
  pairs.forEach((p, pairIdx) => {
    const col = riskColors[p.risk_level] || '#5f6368';
    const riskLevel = (p.risk_level || 'medium').toUpperCase();
    const distLabel = p.distance_m >= 1000 ? (p.distance_m/1000).toFixed(1)+'km' : p.distance_m+'m';
    const threatPct = p.risk_level === 'critical' ? 95 : p.risk_level === 'high' ? 72 : p.risk_level === 'medium' ? 45 : 20;
    const cascadeScore = p.risk_level === 'critical' ? '9.2' : p.risk_level === 'high' ? '7.1' : p.risk_level === 'medium' ? '4.5' : '2.0';

    // Dashed connection line
    const line = L.polyline(
      [[p.from_lat, p.from_lng], [p.to_lat, p.to_lng]],
      {
        color: col, weight: 3.5,
        dashArray: p.risk_level === 'critical' ? '12 6' : '10 8',
        opacity: 1, lineCap: 'round',
        className: 'proximity-line-active'
      }
    ).addTo(state.map);

    // Build intel card HTML
    const popupHtml = `
      <div class="ptac">
        <div class="ptac-header" style="background: ${col};">
          <div class="ptac-header-top">
            <div class="ptac-link-badge">
              <span class="ptac-node">${String(p.from_id).padStart(3,'0')}</span>
              <span class="ptac-connector"><span class="ptac-connector-line"></span></span>
              <span class="ptac-node">${String(p.to_id).padStart(3,'0')}</span>
            </div>
            <span class="ptac-threat-level">${riskLevel}</span>
          </div>
          <div class="ptac-header-meta">
            <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg> ${distLabel}</span>
            <span>Proximity Intel</span>
          </div>
        </div>

        <div class="ptac-body">
          <div class="ptac-pair-strip">
            <div class="ptac-incident">
              <div class="ptac-incident-label">ORIGIN</div>
              <div class="ptac-incident-id">INC-${String(p.from_id).padStart(3,'0')}</div>
              <span class="ptac-incident-cat">${formatTag(p.from_cat || 'general')}</span>
            </div>
            <div class="ptac-vs">
              <div class="ptac-vs-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2" opacity="0.4"><path d="M8.12 8.12L15.88 15.88M15.88 8.12L8.12 15.88"/></svg>
              </div>
            </div>
            <div class="ptac-incident" style="text-align: right;">
              <div class="ptac-incident-label">TARGET</div>
              <div class="ptac-incident-id">INC-${String(p.to_id).padStart(3,'0')}</div>
              <span class="ptac-incident-cat">${formatTag(p.to_cat || 'general')}</span>
            </div>
          </div>

          <div class="ptac-metrics">
            <div class="ptac-metric">
              <span class="ptac-metric-val">${threatPct}%</span>
              <span class="ptac-metric-lbl">THREAT</span>
              <div class="ptac-gauge"><div class="ptac-gauge-fill" style="width:${threatPct}%;background:var(--g-blue)"></div></div>
            </div>
            <div class="ptac-metric">
              <span class="ptac-metric-val">${cascadeScore}</span>
              <span class="ptac-metric-lbl">CASCADE</span>
              <div class="ptac-gauge"><div class="ptac-gauge-fill" style="width:${parseFloat(cascadeScore)*10}%;background:var(--g-blue)"></div></div>
            </div>
            <div class="ptac-metric">
              <span class="ptac-metric-val">${distLabel}</span>
              <span class="ptac-metric-lbl">SEPARATION</span>
              <div class="ptac-gauge"><div class="ptac-gauge-fill" style="width:${Math.max(10,100 - p.distance_m/50)}%;background:var(--g-blue)"></div></div>
            </div>
          </div>

          ${p.ai_insight ? `
          <div class="ptac-intel">
            <div class="ptac-intel-header">
              <div class="ptac-intel-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z"/><line x1="9" y1="21" x2="15" y2="21"/></svg></div>
              <span class="ptac-intel-label">GEMMA AI ANALYSIS</span>
            </div>
            <div class="ptac-intel-text">${p.ai_insight}</div>
          </div>` : ''}

          ${p.action ? `
          <div class="ptac-action">
            <div class="ptac-action-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>
            <div>
              <div class="ptac-action-label">RECOMMENDED ACTION</div>
              <div class="ptac-action-text">${p.action}</div>
            </div>
          </div>` : ''}

          <div class="ptac-footer">
            <span>AEGISGEMMA PROXIMITY INTEL</span>
            <span class="ptac-footer-gemma">GEMMA 4 E2B</span>
          </div>
        </div>
      </div>`;

    // Click the connection line to open draggable intel card — use captured pairIdx
    line.on('click', () => openDraggableIntel(pairIdx));

    // Distance marker at midpoint
    const midLat = (p.from_lat + p.to_lat) / 2;
    const midLng = (p.from_lng + p.to_lng) / 2;
    const label = L.marker([midLat, midLng], {
      icon: L.divIcon({
        className: 'prox-dist-label',
        html: `<span style="background:${col};color:white">${distLabel}</span>`,
        iconSize: [70, 24], iconAnchor: [35, 12],
      }),
      interactive: true,
    }).addTo(state.map);

    // Click distance label to open intel card — use captured pairIdx
    label.on('click', () => openDraggableIntel(pairIdx));

    state.proximityLines.push(line, label);
    state.proximityLinesByPair.push({
      line, label, popupHtml,
      from: [p.from_lat, p.from_lng],
      to: [p.to_lat, p.to_lng],
      mid: [midLat, midLng],
    });
  });

  // Auto-open all pair intel cards with stagger for full tactical picture
  if (pairs.length > 0) {
    pairs.forEach((_, i) => {
      setTimeout(() => openDraggableIntel(i), 600 + i * 400);
    });
  }

  showToast(`Proximity: ${pairs.length} correlations · ${msg.inference_time_ms ? (msg.inference_time_ms/1000).toFixed(1)+'s' : '—'}`, 'success');
}

function clearProximityLines() {
  closeAllDraggableIntel();
  state.proximityLines.forEach(l => state.map.removeLayer(l));
  state.proximityLines = [];
  state.proximityLinesByPair = [];
}

// ─── Draggable Intel Cards (Multi-card C4ISR) ───────
function openDraggableIntel(idx) {
  // Toggle: if this pair's card is already open, close it
  if (state.activePairPopups.has(idx)) {
    closeSingleIntel(idx);
    return;
  }

  const pairRef = state.proximityLinesByPair[idx];
  if (!pairRef) return;

  const mid = pairRef.mid;
  // Calculate perpendicular offset so card doesn't cover the line
  const dlat = pairRef.to[0] - pairRef.from[0];
  const dlng = pairRef.to[1] - pairRef.from[1];
  const len = Math.sqrt(dlat*dlat + dlng*dlng) || 0.001;

  // Alternate offset direction: even indices go one side, odd the other
  // Plus slight extra offset per open card to prevent perfect overlap
  const side = (idx % 2 === 0) ? 1 : -1;
  const openCount = state.activePairPopups.size;
  const offsetScale = 0.006 + (openCount * 0.002);
  const offsetLat = mid[0] + side * (-dlng / len) * offsetScale;
  const offsetLng = mid[1] + side * (dlat / len) * offsetScale;

  // Tether line from midpoint to intel card
  const tether = L.polyline([mid, [offsetLat, offsetLng]], {
    color: '#1a73e8', weight: 2, opacity: 0.85,
    dashArray: '6 4', interactive: false,
    className: 'proximity-tether-line'
  }).addTo(state.map);

  // Small anchor dot at midpoint
  const anchor = L.circleMarker(mid, {
    radius: 5, fillColor: '#1a73e8', fillOpacity: 1,
    color: '#ffffff', weight: 2, stroke: true, interactive: false,
  }).addTo(state.map);

  // Draggable intel card marker
  const card = L.marker([offsetLat, offsetLng], {
    draggable: true,
    zIndexOffset: 5000 + idx,
    icon: L.divIcon({
      className: 'ptac-draggable',
      html: `<div class="ptac-drag-close" title="Close">×</div>${pairRef.popupHtml}`,
      iconSize: [340, null],
      iconAnchor: [170, 0],
    }),
  }).addTo(state.map);

  // Update tether on drag
  card.on('drag', (e) => {
    const pos = e.target.getLatLng();
    tether.setLatLngs([mid, [pos.lat, pos.lng]]);
  });

  // Close button — only close THIS specific card
  const capturedIdx = idx;
  card.getElement().querySelector('.ptac-drag-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeSingleIntel(capturedIdx);
  });

  // Prevent map click-through on the card
  L.DomEvent.disableClickPropagation(card.getElement());

  state.activePairPopups.set(idx, { card, tether, anchor });
}

function closeSingleIntel(idx) {
  const popup = state.activePairPopups.get(idx);
  if (popup) {
    state.map.removeLayer(popup.card);
    state.map.removeLayer(popup.tether);
    state.map.removeLayer(popup.anchor);
    state.activePairPopups.delete(idx);
  }
}

function closeAllDraggableIntel() {
  state.activePairPopups.forEach((popup) => {
    state.map.removeLayer(popup.card);
    state.map.removeLayer(popup.tether);
    state.map.removeLayer(popup.anchor);
  });
  state.activePairPopups.clear();
}

function navigateToPair(idx) {
  const pairRef = state.proximityLinesByPair[idx];
  if (!pairRef) return;

  switchTab('map');

  const bounds = L.latLngBounds([pairRef.from, pairRef.to]);
  state.map.flyToBounds(bounds, { padding: [80, 80], duration: 0.8, maxZoom: 15 });

  setTimeout(() => openDraggableIntel(idx), 900);
}

