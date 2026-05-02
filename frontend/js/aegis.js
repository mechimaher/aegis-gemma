/**
 * AEGIS-GEMMA — Crisis Coordination Dashboard
 */

const state = {
  map: null, markers: {}, pinMode: false, pendingPin: null,
  ws: null, wsRetries: 0, reports: [], reportIds: new Set(),
  submittingId: null, heartbeatTimer: null,
  streamBuffers: {}, // per-report token buffers
  recognition: null, isListening: false,
  crosshair: null, // pin-mode crosshair overlay
};

document.addEventListener('DOMContentLoaded', () => {
  initMap(); initClock(); initWebSocket(); initVoice();
  loadReports(); loadDashboard();
  setInterval(loadDashboard, 15000);
});

// ─── Tab Switching ──────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById(tab === 'map' ? 'map-view' : 'briefing-view').classList.add('active');
  if (tab === 'map') setTimeout(() => state.map?.invalidateSize(), 100);
}

// ─── Map Setup ──────────────────────────────────────
function initMap() {
  state.map = L.map('map', {
    center: [25.2854, 51.5310], zoom: 13,
    zoomControl: true, attributionControl: false,
    maxZoom: 16, minZoom: 12,
    maxBounds: [[25.12, 51.32], [25.52, 51.72]],
    maxBoundsViscosity: 1.0,
  });
  // Tile layer with CSS class for professional filter treatment
  const tiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', { maxZoom: 16, maxNativeZoom: 16, className: 'map-tiles' });
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
    radius: 12, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.4, weight: 2,
  }).addTo(state.map);
  document.getElementById('input-lat').value = lat.toFixed(6);
  document.getElementById('input-lng').value = lng.toFixed(6);
  document.getElementById('input-report').focus();
  togglePinMode();
  showToast('Pin placed. Describe the incident below.', 'info');
}

// ─── Voice Input (graceful degradation for air-gapped environments) ─
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    // Browser doesn't support Speech API at all
    document.getElementById('btn-voice').title = 'Voice input unavailable in this browser';
    document.getElementById('btn-voice').style.opacity = '0.3';
    document.getElementById('btn-voice').style.cursor = 'not-allowed';
    state.voiceUnavailable = true;
    return;
  }
  state.recognition = new SR();
  state.recognition.continuous = true;
  state.recognition.interimResults = true;
  state.recognition.lang = 'en-US';
  state.voiceGotResult = false;

  state.recognition.onresult = (e) => {
    state.voiceGotResult = true;
    if (state.voiceTimeout) { clearTimeout(state.voiceTimeout); state.voiceTimeout = null; }
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
    document.getElementById('input-report').value = text;
  };

  state.recognition.onerror = (e) => {
    if (e.error === 'network') {
      // Cloud transcription failed — air-gapped environment
      showToast('Voice requires internet or OS offline speech packs. Type your report instead.', 'warning');
    } else if (e.error === 'not-allowed') {
      showToast('Microphone access denied. Check browser permissions.', 'warning');
    } else if (e.error !== 'aborted') {
      showToast('Voice input error: ' + e.error, 'warning');
    }
    stopVoice();
  };

  state.recognition.onend = () => { if (state.isListening) stopVoice(); };
}

function toggleVoice() {
  if (state.voiceUnavailable) {
    showToast('Voice input not supported in this browser.', 'warning');
    return;
  }
  if (state.isListening) stopVoice(); else startVoice();
}

function startVoice() {
  if (!state.recognition) {
    showToast('Voice input not available.', 'warning');
    return;
  }
  state.isListening = true;
  state.voiceGotResult = false;
  try {
    state.recognition.start();
  } catch (e) {
    showToast('Voice input failed to start.', 'warning');
    state.isListening = false;
    return;
  }
  const btn = document.getElementById('btn-voice');
  btn.classList.add('active');
  showToast('Listening. Describe the incident...', 'info');

  // Safety timeout: if no result within 4 seconds, warn user
  state.voiceTimeout = setTimeout(() => {
    if (state.isListening && !state.voiceGotResult) {
      showToast('No speech detected. Ensure microphone is connected, or type your report.', 'warning');
      stopVoice();
    }
  }, 4000);
}

function stopVoice() {
  state.isListening = false;
  if (state.voiceTimeout) { clearTimeout(state.voiceTimeout); state.voiceTimeout = null; }
  if (state.recognition) try { state.recognition.stop(); } catch(e) {}
  document.getElementById('btn-voice').classList.remove('active');
}

// ─── Submit Report ──────────────────────────────────
async function submitReport(e) {
  e.preventDefault();
  if (state.isListening) stopVoice();
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
    card.innerHTML = `
      <div class="report-header">
        <span class="report-id">#${String(report.id).padStart(3,'0')}</span>
        <span class="severity-badge ${severity}">${severity}</span>
      </div>
      <div class="report-text">${report.report_text || ''}</div>
      <div class="report-meta"><span>${analysis.category||'pending'}</span><span>${time}</span></div>`;
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

  // Severity-based sizing (critical = large, low = small)
  const sizes = { critical: 28, high: 24, medium: 20, low: 16 };
  const sz = sizes[sev] || 18;
  const icon = L.divIcon({
    className: '',
    html: `<div class="crisis-marker ${sev}" style="width:${sz}px;height:${sz}px"></div>`,
    iconSize: [sz, sz],
    iconAnchor: [sz/2, sz/2],
  });
  const marker = L.marker([report.latitude, report.longitude], { icon, zIndexOffset: sev === 'critical' ? 1000 : sev === 'high' ? 500 : 0 });
  marker.addTo(state.map);

  // Enterprise popup
  marker.bindPopup(buildPopupHTML(report, sev, a), { className: 'crisis-popup', maxWidth: 360, minWidth: 280 });

  state.markers[`r-${report.id}`] = marker;

  // Impact radius circle (severity determines radius)
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

function buildPopupHTML(report, sev, a) {
  const sevColors = { critical:'#d93025', high:'#e8710a', medium:'#f9ab00', low:'#1e8e3e' };
  const sevGrad = {
    critical:'linear-gradient(135deg, #d93025, #b71c1c)',
    high:'linear-gradient(135deg, #e8710a, #bf5600)',
    medium:'linear-gradient(135deg, #f9ab00, #e09100)',
    low:'linear-gradient(135deg, #1e8e3e, #0d652d)'
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
        <div class="pe-intel-label"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="${col}" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> AI Intel</div>
        <div class="pe-intel-text">${a.summary}</div>
      </div>` : `<div class="pe-intel">
        <div class="pe-intel-text" style="color:var(--on-surface-dim)">${(report.report_text || '').substring(0, 120)}${(report.report_text || '').length > 120 ? '…' : ''}</div>
      </div>`}

      ${a.recommended_action ? `
      <div class="pe-cmd">
        <span class="pe-cmd-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00897b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
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

// ─── Reports List ───────────────────────────────────
function addReportToList(report) {
  if (state.reportIds.has(report.id)) return;
  state.reportIds.add(report.id);
  const list = document.getElementById('reports-list');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();
  const sev = report.severity || report.ai_analysis?.severity || 'unknown';
  const a = report.ai_analysis || {};
  const t = report.created_at ? new Date(report.created_at).toLocaleTimeString() : '';
  const card = document.createElement('div');
  card.className = `report-card severity-${sev}`; card.id = `report-card-${report.id}`;
  card.onclick = () => { flyToReport(report); showAiAnalysis(report); };
  card.innerHTML = `<div class="report-header"><span class="report-id">#${String(report.id).padStart(3,'0')}</span><span class="severity-badge ${sev}">${sev}</span></div>
    <div class="report-text">${report.report_text||''}</div>
    <div class="report-meta"><span>${a.category||'pending'}</span><span>${t}</span></div>`;
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
    <div class="ai-field"><div class="ai-field-label">Immediate Action</div><div class="ai-field-value" style="color:var(--g-teal)">${a.recommended_action||'—'}</div></div>
    <div class="ai-field"><div class="ai-field-label">Incident Type</div><div class="ai-field-value">${a.category||'general'} ${a.evacuation_needed?'<span style="color:var(--g-red);font-weight:700"> — EVACUATION REQUIRED</span>':''}</div></div>
    ${a.affected_estimate>0?`<div class="ai-field"><div class="ai-field-label">Estimated Affected</div><div class="ai-field-value" style="font-family:var(--font-mono);font-size:18px;color:var(--g-yellow)">${a.affected_estimate}</div></div>`:''}
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

  try {
    const res = await fetch('/api/briefing', { method: 'POST' });
    const data = await res.json();
    // If the model isn't loaded, we get instant fallback
    if (data.status === 'success') {
      content.innerHTML = `<div class="briefing-text">${(data.briefing || '').replace(/\n/g,'<br>')}</div>`;
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/></svg> Generate Briefing';
    }
    // If streaming, tokens will come via WebSocket — UI is already set up
  } catch(e) {
    content.innerHTML = '<p class="error">Failed to generate briefing.</p>';
    btn.disabled = false;
    btn.innerHTML = 'Generate Briefing';
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
        dot.className = 'status-dot online'; txt.textContent = 'AI Online';
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
      document.getElementById('ws-status-dot').className = 'status-dot online';
      state.wsRetries = 0;
      if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = setInterval(() => { if (state.ws?.readyState===1) state.ws.send('ping'); }, 30000);
    };
    state.ws.onmessage = e => { try { handleWS(JSON.parse(e.data)); } catch(x){} };
    state.ws.onclose = () => {
      document.getElementById('ws-status-dot').className = 'status-dot offline';
      if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
      if (state.wsRetries < 10) { state.wsRetries++; setTimeout(initWebSocket, Math.min(1000*Math.pow(2,state.wsRetries),30000)); }
    };
    state.ws.onerror = () => { document.getElementById('ws-status-dot').className = 'status-dot offline'; };
  } catch(e) { document.getElementById('ws-status-dot').className = 'status-dot offline'; }
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
    lat: 25.2930, lng: 51.5350,
    text: "Chemical plant explosion in industrial zone. Massive fire with toxic black smoke spreading southeast. 15 workers critically injured, 3 unaccounted for. Residential area 500 meters downwind — immediate evacuation needed. Secondary explosion risk from adjacent fuel storage tanks.",
    label: "Chemical Plant Explosion"
  },
  {
    lat: 25.2780, lng: 51.5200,
    text: "Major earthquake struck residential district. Two 8-story apartment buildings have partially collapsed. Estimated 150 residents trapped under debris. Gas mains ruptured, strong smell of gas. Multiple fires breaking out. Aftershock activity continuing.",
    label: "Earthquake — Residential Collapse"
  },
  {
    lat: 25.2650, lng: 51.5440,
    text: "Flash flooding on coastal highway after storm surge. 60+ vehicles submerged. Bus with 35 passengers stranded in rising water. Water level at 2 meters and climbing. Power lines down in flood zone creating electrocution hazard.",
    label: "Flash Flood — Highway"
  }
];

let demoRunning = false;

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

  const scenario = DEMO_SCENARIOS[Math.floor(Math.random() * DEMO_SCENARIOS.length)];
  showToast(`▶ Demo: ${scenario.label}`, 'info');
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
  showToast('▶ Submitting report for Gemma 4 analysis...', 'info');
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

  showToast('▶ AI analysis complete. Switching to Situation Briefing...', 'info');
  await sleep(3000);

  // Step 7: Switch to briefing tab
  switchTab('briefing');
  await sleep(1500);

  // Step 8: Generate briefing
  document.getElementById('btn-briefing').click();
  showToast('▶ Gemma 4 synthesizing all reports...', 'info');

  // Wait for briefing to complete
  waited = 0;
  while (waited < maxWait) {
    await sleep(3000);
    waited += 3000;
    if (!document.getElementById('btn-briefing').disabled) break;
  }

  await sleep(2000);
  showToast('▶ Demo complete. AEGIS-GEMMA ready for deployment.', 'success');
  demoRunning = false;
}

// Keyboard shortcut: Ctrl+Shift+D
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.shiftKey && e.key === 'D') {
    e.preventDefault();
    runDemo();
  }
});
