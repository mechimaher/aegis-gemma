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
  activePairPopup: null,
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
    card.onclick = () => { flyToReport(report); };
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

  // Severity-based sizing (critical = large, pending = medium neutral)
  const sizes = { critical: 28, high: 24, medium: 20, low: 16, pending: 22, unknown: 22 };
  const sz = sizes[sev] || 18;
  const markerClass = isPending ? 'crisis-marker pending' : `crisis-marker ${sev}`;
  const icon = L.divIcon({
    className: '',
    html: `<div class="${markerClass}" style="width:${sz}px;height:${sz}px"></div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz/2, sz/2],
  });
  // Newer reports (higher IDs) get higher z-index so they always render on top
  const baseZ = sev === 'critical' ? 1000 : sev === 'high' ? 500 : 0;
  const idZ = (report.id || 0) * 10;
  const marker = L.marker([report.latitude, report.longitude], { icon, zIndexOffset: baseZ + idZ });
  marker.addTo(state.map);

  // Enterprise popup
  marker.bindPopup(buildPopupHTML(report, sev, a), { className: 'crisis-popup', maxWidth: 360, minWidth: 280 });

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
  const sevColors = { critical:'#d93025', high:'#e8710a', medium:'#f9ab00', low:'#1e8e3e', pending:'#5f6368', unknown:'#5f6368' };
  const sevGrad = {
    critical:'linear-gradient(135deg, #d93025, #b71c1c)',
    high:'linear-gradient(135deg, #3c4043, #202124)',
    medium:'linear-gradient(135deg, #3c4043, #202124)',
    low:'linear-gradient(135deg, #3c4043, #202124)',
    pending:'linear-gradient(135deg, #5f6368, #3c4043)',
    unknown:'linear-gradient(135deg, #5f6368, #3c4043)',
  };
  const col = sevColors[sev] || '#5f6368';
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

  // Top 3 resource tags only
  const topRes = (a.resource_needs || []).slice(0, 3).map(r =>
    `<span class="pe-chip">${r}</span>`
  ).join('');

  return `
    <div class="popup-enterprise">
      <!-- Color-coded severity band with key identifiers -->
      <div class="pe-band" style="background:${sevGrad[sev]}">
        <div class="pe-band-top">
          <span class="pe-band-id">#${String(report.id).padStart(3,'0')}</span>
          <span class="pe-band-sev">${sev.toUpperCase()}</span>
        </div>
        <div class="pe-band-bar">
          <div style="display:flex;gap:2px;align-items:center">${pbar}</div>
          <span class="pe-band-p">P${p}</span>
        </div>
      </div>

      <!-- Stats row -->
      <div class="pe-stats">
        ${a.category ? `<div class="pe-stat"><span class="pe-stat-val">${a.category}</span><span class="pe-stat-lbl">Type</span></div>` : ''}
        ${a.affected_estimate > 0 ? `<div class="pe-stat"><span class="pe-stat-val pe-stat-num">${a.affected_estimate.toLocaleString()}</span><span class="pe-stat-lbl">Affected</span></div>` : ''}
        ${a.evacuation_needed ? `<div class="pe-stat"><span class="pe-stat-val pe-stat-evac">EVAC</span><span class="pe-stat-lbl">Required</span></div>` : ''}
        <div class="pe-stat"><span class="pe-stat-val">${time}</span><span class="pe-stat-lbl">Time</span></div>
      </div>

      <!-- AI summary (one compact block) -->
      ${a.summary ? `<div class="pe-intel">
        <div class="pe-intel-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--g-blue)" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> AI Intel</div>
        <div class="pe-intel-text">${a.summary}</div>
      </div>` : `<div class="pe-intel">
        <div class="pe-intel-text" style="color:var(--on-surface-dim)">${(report.report_text || '').substring(0, 120)}${(report.report_text || '').length > 120 ? '…' : ''}</div>
      </div>`}

      ${a.recommended_action ? `
      <div class="pe-cmd">
        <span class="pe-cmd-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
        <span class="pe-cmd-text">${a.recommended_action}</span>
      </div>` : ''}

      ${topRes ? `<div class="pe-res">${topRes}</div>` : ''}

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
  const catDisplay = isPending ? 'Gemma analyzing...' : (a.category || 'pending');
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
  let pbar = ''; for (let i=1;i<=10;i++) { let c='priority-segment'; if(i<=p){c+=' filled';if(p>=8)c+=' critical';else if(p>=5)c+=' high';} pbar+=`<div class="${c}"></div>`; }
  const res = (a.resource_needs||[]).map(r=>`<span class="ai-tag">${r}</span>`).join('');
  const risks = (a.risk_factors||[]).map(r=>`<span class="ai-tag risk">${r}</span>`).join('');
  const isLive = a.model_used && !a.model_used.includes('fallback');
  const lbl = isLive ? 'Gemma 4 E2B Analysis' : 'Keyword Triage';
  const cls = isLive ? 'ai-result ai-live' : 'ai-result';
  const html = `<div class="${cls}" data-report-id="${report.id}">
    <div class="ai-result-header">
      <div class="ai-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#4285f4" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg></div>
      <span>${lbl} — Report #${report.id}</span>
    </div>
    <div class="ai-field"><div class="ai-field-label">Severity / Priority</div>
      <div style="display:flex;align-items:center;gap:12px">
        <span class="severity-badge ${a.severity||'low'}">${a.severity||'unknown'}</span>
        <div class="priority-bar">${pbar}</div>
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--on-surface-variant)">${p}/10</span>
      </div></div>
    <div class="ai-field"><div class="ai-field-label">Tactical Summary</div><div class="ai-field-value">${a.summary||'Analysis pending...'}</div></div>
    <div class="ai-field"><div class="ai-field-label">Immediate Action</div><div class="ai-field-value">${a.recommended_action||'—'}</div></div>
    <div class="ai-field"><div class="ai-field-label">Incident Type</div><div class="ai-field-value">${a.category||'general'} ${a.evacuation_needed?'<span style="color:var(--g-red);font-weight:700"> — EVACUATION REQUIRED</span>':''}</div></div>
    ${a.affected_estimate>0?`<div class="ai-field"><div class="ai-field-label">Estimated Affected</div><div class="ai-field-value" style="font-family:var(--font-mono);font-size:18px;font-weight:700">${a.affected_estimate}</div></div>`:''}
    ${res?`<div class="ai-field"><div class="ai-field-label">Required Resources</div><div class="ai-tags">${res}</div></div>`:''}
    ${risks?`<div class="ai-field"><div class="ai-field-label">Risk Factors</div><div class="ai-tags">${risks}</div></div>`:''}
    <div class="inference-meta">
      <span>${a.inference_time_ms?a.inference_time_ms+'ms':'—'}</span>
      <span>${a.model_used||'pending'}</span>
      <span>${a.tokens_used?a.tokens_used+' tokens':''}</span>
    </div></div>`;
  const ex = panel.querySelector(`[data-report-id="${report.id}"]`);
  if (ex) ex.outerHTML = html; else panel.insertAdjacentHTML('afterbegin', html);
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
      content.innerHTML = `<div class="briefing-text">${(data.briefing || '').replace(/\n/g,'<br>')}</div>`;
      btn.disabled = false; btn.innerHTML = briefingBtnDefault;
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

function onBriefingComplete(data) {
  const content = document.getElementById('briefing-content');
  const btn = document.getElementById('btn-briefing');
  if (state._briefingTimeout) clearTimeout(state._briefingTimeout);
  const text = data.briefing || state.briefingBuffer || '';
  const meta = `<div class="briefing-meta">${data.inference_time_ms || 0}ms · ${data.tokens_used || 0} tokens · ${data.report_count || 0} reports analyzed · gemma-4-e2b-it-local</div>`;
  content.innerHTML = `<div class="briefing-text">${text.replace(/\n/g,'<br>')}</div>${meta}`;
  btn.disabled = false;
  btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> Generate Briefing';
  showToast(`Briefing complete — ${data.tokens_used || 0} tokens in ${((data.inference_time_ms || 0)/1000).toFixed(1)}s`, 'success');
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

// ─── DEMO AUTO-PLAY ─────────────────────────────────
// Triggered by Ctrl+Shift+D or the floating demo button
const DEMO_SCENARIOS = [
  {
    lat: 25.2850, lng: 51.5150,
    text: "Chemical plant explosion in industrial zone. Massive fire with toxic black smoke spreading southeast. 15 workers critically injured, 3 unaccounted for. Residential area 500 meters downwind — immediate evacuation needed. Secondary explosion risk from adjacent fuel storage tanks.",
    label: "Chemical Plant Explosion"
  },
  {
    lat: 25.2700, lng: 51.5380,
    text: "Major earthquake struck residential district. Two 8-story apartment buildings have partially collapsed. Estimated 150 residents trapped under debris. Gas mains ruptured, strong smell of gas. Multiple fires breaking out. Aftershock activity continuing.",
    label: "Earthquake — Residential Collapse"
  },
  {
    lat: 25.3050, lng: 51.5500,
    text: "Flash flooding on coastal highway after storm surge. 60+ vehicles submerged. Bus with 35 passengers stranded in rising water. Water level at 2 meters and climbing. Power lines down in flood zone creating electrocution hazard.",
    label: "Flash Flood — Highway"
  }
];

let demoRunning = false;
let demoScenarioIndex = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function typeText(el, text, speed = 35) {
  el.value = '';
  el.focus();
  for (let i = 0; i < text.length; i++) {
    el.value += text[i];
    el.scrollTop = el.scrollHeight;
    // Variable speed for natural feel
    const delay = text[i] === '.' ? speed * 4 : text[i] === ',' ? speed * 2 : speed + Math.random() * 15;
    await sleep(delay);
  }
}

async function runDemo() {
  if (demoRunning) { showToast('Demo already running.', 'warning'); return; }
  demoRunning = true;

  // Cycle through scenarios sequentially (never repeat until all 3 used)
  const scenario = { ...DEMO_SCENARIOS[demoScenarioIndex % DEMO_SCENARIOS.length] };
  demoScenarioIndex++;
  // Add small coordinate jitter (~50-100m) to prevent exact overlaps on repeat cycles
  scenario.lat += (Math.random() - 0.5) * 0.002;
  scenario.lng += (Math.random() - 0.5) * 0.002;
  showToast(`Incoming field report: ${scenario.label}`, 'warning');
  await sleep(1500);

  // Step 1: Switch to map tab
  switchTab('map');
  await sleep(800);

  // Step 2: Activate pin mode
  if (!state.pinMode) togglePinMode();
  await sleep(1000);

  // Step 3: Drop pin with smooth map pan
  state.map.flyTo([scenario.lat, scenario.lng], 15, { duration: 1.5 });
  await sleep(2000);
  placePin(scenario.lat, scenario.lng);
  await sleep(1000);

  // Step 4: Typewriter effect on the incident description
  const textarea = document.getElementById('input-report');
  await typeText(textarea, scenario.text, 30);
  await sleep(800);

  // Step 5: Submit
  showToast('Submitting to Gemma 4 for analysis...', 'info');
  await sleep(500);
  document.getElementById('btn-submit').click();
  await sleep(2000);

  // Step 6: Scroll AI panel into view and wait for completion
  const aiPanel = document.getElementById('ai-panel');
  aiPanel.scrollTop = aiPanel.scrollHeight;

  // Wait for streaming to complete (check every 3 seconds, max 4 minutes)
  let waited = 0;
  const maxWait = 240000;
  while (waited < maxWait) {
    await sleep(3000);
    waited += 3000;
    aiPanel.scrollTop = aiPanel.scrollHeight;
    // Check if streaming is done (no more .ai-streaming elements)
    const streaming = document.querySelectorAll('.ai-streaming');
    if (streaming.length === 0 && waited > 5000) break;
  }

  showToast('Analysis complete. Generating situation briefing...', 'info');
  await sleep(3000);

  // Step 7: Switch to briefing tab
  switchTab('briefing');
  await sleep(1500);

  // Step 8: Generate briefing
  document.getElementById('btn-briefing').click();
  showToast('Gemma 4 synthesizing all field reports...', 'info');

  // Wait for briefing to complete
  waited = 0;
  while (waited < maxWait) {
    await sleep(3000);
    waited += 3000;
    if (!document.getElementById('btn-briefing').disabled) break;
  }

  await sleep(2000);
  showToast('Briefing complete. Running proximity intelligence...', 'info');
  await sleep(2000);

  // Step 9: Switch to proximity tab
  switchTab('proximity');
  await sleep(1500);

  // Step 10: Run proximity analysis
  document.getElementById('btn-proximity').click();
  showToast('Gemma 4 analyzing spatial correlations...', 'info');

  // Wait for proximity to complete
  waited = 0;
  while (waited < maxWait) {
    await sleep(3000);
    waited += 3000;
    if (!document.getElementById('btn-proximity').disabled) break;
  }

  await sleep(2000);
  showToast('Proximity analysis complete. Returning to tactical map...', 'info');
  await sleep(1500);

  // Step 11: Switch back to map to show proximity lines
  switchTab('map');
  await sleep(3000);

  demoRunning = false;
}

// Keyboard shortcut: Ctrl+Shift+D
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    runDemo();
  }
});

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
      { color: '#5f6368', weight: 2, dashArray: '8 6', opacity: 0.5, className: 'proximity-line-pending' }
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
  const riskColors = { critical: '#d93025', high: '#e8710a', medium: '#f9ab00', low: '#1e8e3e' };

  let cardsHtml = pairs.map((p, i) => {
    const col = riskColors[p.risk_level] || '#5f6368';
    const distLabel = p.distance_m >= 1000 ? (p.distance_m/1000).toFixed(1)+' km' : p.distance_m+' m';
    return `
      <div class="prox-card" data-pair-idx="${i}" style="border-left: 3px solid ${col}; cursor:pointer" title="Click to view on map">
        <div class="prox-card-header">
          <div class="prox-pair-ids">
            <span class="prox-id">#${String(p.from_id).padStart(3,'0')}</span>
            <svg width="16" height="12" viewBox="0 0 24 12" fill="none" stroke="${col}" stroke-width="2"><path d="M2 6h20M18 2l4 4-4 4"/></svg>
            <span class="prox-id">#${String(p.to_id).padStart(3,'0')}</span>
          </div>
          <div class="prox-meta">
            <span class="prox-dist">${distLabel}</span>
            <span class="prox-risk" style="color:${col}">${(p.risk_level||'medium').toUpperCase()}</span>
          </div>
        </div>
        <div class="prox-card-types">
          <span class="prox-type">${p.from_cat||'—'}</span>
          <span class="prox-type">${p.to_cat||'—'}</span>
        </div>
        ${p.ai_insight ? `<div class="prox-insight">${p.ai_insight}</div>` : ''}
        ${p.action ? `<div class="prox-action"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#5f6368" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> ${p.action}</div>` : ''}
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
  pairs.forEach(p => {
    const col = riskColors[p.risk_level] || '#5f6368';
    const riskLevel = (p.risk_level || 'medium').toUpperCase();
    const distLabel = p.distance_m >= 1000 ? (p.distance_m/1000).toFixed(1)+'km' : p.distance_m+'m';
    const threatPct = p.risk_level === 'critical' ? 95 : p.risk_level === 'high' ? 72 : p.risk_level === 'medium' ? 45 : 20;
    const cascadeScore = p.risk_level === 'critical' ? '9.2' : p.risk_level === 'high' ? '7.1' : p.risk_level === 'medium' ? '4.5' : '2.0';

    // Dashed connection line
    const line = L.polyline(
      [[p.from_lat, p.from_lng], [p.to_lat, p.to_lng]],
      {
        color: col, weight: 2,
        dashArray: p.risk_level === 'critical' ? '8 4' : '6 6',
        opacity: 0.7, lineCap: 'round',
        className: 'proximity-line-active'
      }
    ).addTo(state.map);

    // Build intel card HTML
    const popupHtml = `
      <div class="ptac">
        <div class="ptac-header" style="background: #3c4043;">
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
              <span class="ptac-incident-cat">${p.from_cat || 'general'}</span>
            </div>
            <div class="ptac-vs">
              <div class="ptac-vs-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2" opacity="0.4"><path d="M8.12 8.12L15.88 15.88M15.88 8.12L8.12 15.88"/></svg>
              </div>
            </div>
            <div class="ptac-incident" style="text-align: right;">
              <div class="ptac-incident-label">TARGET</div>
              <div class="ptac-incident-id">INC-${String(p.to_id).padStart(3,'0')}</div>
              <span class="ptac-incident-cat">${p.to_cat || 'general'}</span>
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

    // Click the connection line to open draggable intel card
    line.on('click', () => openDraggableIntel(state.proximityLinesByPair.length));

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

    // Click distance label to open intel card too
    label.on('click', () => openDraggableIntel(state.proximityLinesByPair.length));

    state.proximityLines.push(line, label);
    state.proximityLinesByPair.push({
      line, label, popupHtml,
      from: [p.from_lat, p.from_lng],
      to: [p.to_lat, p.to_lng],
      mid: [midLat, midLng],
    });
  });

  // Auto-open first pair intel card
  if (pairs.length > 0) {
    setTimeout(() => openDraggableIntel(0), 600);
  }

  showToast(`Proximity: ${pairs.length} correlations · ${msg.inference_time_ms ? (msg.inference_time_ms/1000).toFixed(1)+'s' : '—'}`, 'success');
}

function clearProximityLines() {
  closeDraggableIntel();
  state.proximityLines.forEach(l => state.map.removeLayer(l));
  state.proximityLines = [];
  state.proximityLinesByPair = [];
}

// ─── Draggable Intel Card (C4ISR-grade) ─────────────
function openDraggableIntel(idx) {
  closeDraggableIntel();

  const pairRef = state.proximityLinesByPair[idx];
  if (!pairRef) return;

  const mid = pairRef.mid;
  // Calculate perpendicular offset so card doesn't cover the line
  const dlat = pairRef.to[0] - pairRef.from[0];
  const dlng = pairRef.to[1] - pairRef.from[1];
  const len = Math.sqrt(dlat*dlat + dlng*dlng) || 0.001;
  // Perpendicular direction (rotate 90°), normalized, scaled
  const offsetScale = 0.006;
  const offsetLat = mid[0] + (-dlng / len) * offsetScale;
  const offsetLng = mid[1] + (dlat / len) * offsetScale;

  // Tether line from midpoint to intel card
  const tether = L.polyline([mid, [offsetLat, offsetLng]], {
    color: '#9aa0a6', weight: 1, opacity: 0.6,
    dashArray: '3 3', interactive: false,
  }).addTo(state.map);

  // Small anchor dot at midpoint
  const anchor = L.circleMarker(mid, {
    radius: 3, fillColor: '#9aa0a6', fillOpacity: 0.8,
    stroke: false, interactive: false,
  }).addTo(state.map);

  // Draggable intel card marker
  const card = L.marker([offsetLat, offsetLng], {
    draggable: true,
    zIndexOffset: 5000,
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

  // Close button handler (delegated)
  card.getElement().querySelector('.ptac-drag-close').addEventListener('click', (e) => {
    e.stopPropagation();
    closeDraggableIntel();
  });

  // Prevent map click-through on the card
  L.DomEvent.disableClickPropagation(card.getElement());

  state.activePairPopup = { card, tether, anchor };
}

function closeDraggableIntel() {
  if (state.activePairPopup) {
    state.map.removeLayer(state.activePairPopup.card);
    state.map.removeLayer(state.activePairPopup.tether);
    state.map.removeLayer(state.activePairPopup.anchor);
    state.activePairPopup = null;
  }
}

function navigateToPair(idx) {
  const pairRef = state.proximityLinesByPair[idx];
  if (!pairRef) return;

  switchTab('map');

  const bounds = L.latLngBounds([pairRef.from, pairRef.to]);
  state.map.flyToBounds(bounds, { padding: [80, 80], duration: 0.8, maxZoom: 15 });

  setTimeout(() => openDraggableIntel(idx), 900);
}

