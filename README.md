# AEGIS-GEMMA: Air-gapped Edge Gemma Intelligence System

> **First-responder tactical AI that runs 100% offline — powered by Google Gemma 4 E2B on local hardware via llama.cpp. Zero cloud. Zero latency. Zero excuses.**

---

## The Problem We Solve

When disaster strikes, **internet is the first casualty**. Cell towers collapse, fiber lines sever, cloud APIs become unreachable. Yet this is precisely when AI-powered decision support is most critical — when an incident commander must triage dozens of simultaneous emergencies with incomplete information and zero connectivity.

Every existing crisis AI tool fails at this exact moment because they depend on cloud inference.

**AEGIS-GEMMA doesn't.**

## Three Gemma-Powered Intelligence Features

AEGIS-GEMMA leverages Gemma 4 E2B in three distinct ways, each demonstrating a different dimension of on-device AI capability:

### Feature 1: Real-Time Report Analysis
Individual crisis reports are analyzed by Gemma 4 with token-by-token streaming. Each report receives structured JSON output: severity classification, priority score (1-10), required resources, evacuation assessment, risk factors, and recommended immediate action.

### Feature 2: Situation Briefing Synthesis
With one click, Gemma 4 reads ALL active crisis reports and streams a unified commander's briefing covering situation overview, critical priorities, resource allocation, and cascading risk assessment. This is cross-incident analytical reasoning — not a simple summary.

### Feature 3: Proximity Intelligence
Gemma 4 analyzes spatial relationships between nearby incidents using haversine distance calculations. For every pair of incidents within 5km, the AI identifies cascade risks, resource-sharing opportunities, and evacuation route conflicts. Results render as risk-colored connector lines on the tactical map with per-pair insight cards.

## How It Works

```
Operator → Drops pin on offline map → Describes incident (text or voice)
                                          ↓
                                   [< 300ms] Instant keyword triage
                                          ↓
                              [Background] Gemma 4 E2B inference
                                          ↓
                              [WebSocket] Token-by-token streaming
                                          ↓
                              Structured JSON analysis delivered:
                              • Severity classification
                              • Priority score (1-10)
                              • Required resources
                              • Evacuation assessment
                              • Risk factor analysis
                              • Recommended immediate action
```

### Two-Phase Analysis Pipeline

**Phase 1 — Instant Triage (< 300ms):**
The report is persisted to SQLite and classified using keyword analysis. The HTTP response returns immediately. The operator sees the report on the map within milliseconds.

**Phase 2 — Deep AI Analysis (background):**
Gemma 4 E2B runs in a `ThreadPoolExecutor` to avoid blocking FastAPI's event loop. Each token is streamed via WebSocket to the operator's browser in real-time. The dashboard remains fully responsive during inference — polling, map interaction, and new report submission all continue uninterrupted.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                    AEGIS-GEMMA                             │
│              100% Air-Gapped Architecture                  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────┐  WebSocket   ┌────────────────────────┐  │
│  │   Browser    │◄─streaming─► │   FastAPI (async)      │ │
│  │              │   tokens     │   uvicorn              │  │
│  │  • Leaflet   │              │   • Non-blocking loop  │  │
│  │  • Voice API │              │   • ThreadPoolExecutor │  │
│  │  • Streaming │              │   • WebSocket broadcast│  │
│  └──────────────┘              └──────────┬─────────────┘  │
│         │                                 │                │
│  ┌──────┴───────┐              ┌──────────▼─────────────┐  │
│  │  Local Tile  │              │   Gemma 4 E2B          │  │
│  │  Cache (PNG) │              │   Q4_K_M GGUF (3.3 GB) │  │
│  │  Positron    │              │   via llama-cpp-python │  │
│  └──────────────┘              └──────────┬─────────────┘  │
│                                           │                │
│                    ┌──────────────────────┘                │
│                    ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  SQLite (aiosqlite)                 │   │
│  │  reports │ resources │ events │ ai_analysis (JSON)  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

## Key Technical Innovations

### 1. Non-Blocking Streaming Inference
The core engineering challenge: run a 3.3 GB language model without freezing the web server. We solve this by executing inference in a `ThreadPoolExecutor` and bridging to the async event loop via `asyncio.Queue`. Each generated token is broadcast to all connected WebSocket clients in real-time. The result: **the dashboard never stalls** — operators can submit new reports, pan the map, and check stats while Gemma is mid-inference.

### 2. Grammar-Guided JSON Output
Gemma 4 is prompted to produce structured JSON with specific fields (`severity`, `priority`, `resource_needs`, `risk_factors`, `evacuation_needed`, etc.). A robust bracket-matching parser extracts valid JSON even from partial or malformed model output, with keyword-based fallback for edge cases. This guarantees every report gets actionable, machine-readable classification.

### 3. Real-Time Token Visualization
Every token Gemma generates appears in a terminal-style display with JSON syntax highlighting (blue keys, green strings, yellow numbers). This serves two purposes: (1) it shows the AI's reasoning process transparently (addressing the Safety & Trust criterion), and (2) it provides immediate visual feedback that the system is working, even during long inference runs.

### 4. Spatial Proximity Analysis
The system calculates haversine distances between all incident pairs and sends nearby pairs (< 5km) to Gemma for cross-correlation analysis. The AI identifies cascade risks (e.g., fire near gas pipeline), resource-sharing opportunities (e.g., shared ambulance corridors), and evacuation conflicts (e.g., overlapping evacuation routes). Results render as risk-colored connector lines on the map with interactive tooltips.

### 5. Impact Zone Mapping
Each crisis marker on the map is surrounded by a severity-scaled impact radius circle (critical: 400m, high: 300m, medium: 200m, low: 120m). Markers are sized by severity (critical markers are 75% larger than low-severity ones). A professional severity legend provides instant visual decoding. This transforms the map from a pin collection into a tactical common operating picture.

### 6. Event Lifecycle Management
Every incident tracks its lifecycle state: **ACTIVE** (< 6 hours, green pulse indicator), **MONITORING** (6-24 hours, amber), or **RESOLVED** (> 24 hours, grey). Elapsed time is displayed on each report card and auto-refreshes every 30 seconds. This demonstrates production-grade event management maturity.

### 7. Complete Air-Gap Compliance
The system makes **zero external network calls**:
- All fonts bundled locally (Inter, JetBrains Mono)
- Leaflet.js served from local files
- Map tiles cached locally (CartoDB Positron, zoom 10-16)
- No CDN, no analytics, no telemetry
- No `fetch()` to any external domain

> **Note on Voice Input:** The Web Speech API is a browser-native feature that works offline on Chromium with OS-level language packs installed. On systems without offline speech packs, Chrome may route audio to Google's servers. For guaranteed air-gap compliance, install the `English (US)` offline speech pack in your OS settings, or disable voice input.

## Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **AI Model** | Gemma 4 E2B IT (Q4_K_M GGUF, 3.3 GB) | Best quality-per-byte for edge deployment |
| **Inference** | llama-cpp-python (CPU/AVX2 + flash attention) | Fastest CPU inference, no GPU required |
| **Backend** | Python 3.12, FastAPI, uvicorn | Async-native, WebSocket support |
| **Database** | SQLite via aiosqlite | Zero-config, single-file persistence |
| **Frontend** | Vanilla HTML/CSS/JS (zero frameworks) | No build step, instant deployment |
| **Maps** | Leaflet.js (locally bundled) + CartoDB Positron tiles | Lightweight, offline-capable |
| **Streaming** | Native WebSocket | Real-time bidirectional communication |
| **Voice** | Web Speech API (browser-native) | No external dependency |

## Quick Start

```bash
# 1. Clone and enter project
git clone https://github.com/mechimaher/aegis-gemma.git
cd aegis-gemma

# 2. Create virtual environment and install dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 3. Download the Gemma 4 model (3.3 GB, one-time)
pip install huggingface-hub
huggingface-cli download bartowski/google_gemma-4-E2B-it-GGUF \
  google_gemma-4-E2B-it-Q4_K_M.gguf --local-dir ./models/

# 4. Seed demo crisis scenarios (3 incidents, Gemma-analyzed)
python3 seed_demo.py

# 5. Launch
python3 -m uvicorn backend.server:app --host 0.0.0.0 --port 8080
```

Open **http://localhost:8080** in any modern browser.

## Demo Walkthrough

AEGIS-GEMMA includes a one-click automated demo (`▶ Demo` button or `Ctrl+Shift+D`) that showcases all three Gemma features in sequence:

1. **Tactical Map** — 3 pre-seeded Doha crisis scenarios appear with severity-colored markers, impact zones, and ACTIVE lifecycle indicators
2. **Drop a Pin** — Automated pin drop with typewriter-effect incident description
3. **AI Analysis** — Gemma 4 streams structured JSON analysis token-by-token in real-time
4. **Situation Briefing** — Gemma synthesizes ALL reports into a unified commander's overview
5. **Proximity Intelligence** — Gemma analyzes spatial correlations between nearby incidents
6. **Map Return** — Risk-colored connector lines with distance labels appear between correlated incidents

### Demo Scenarios (Pre-seeded)

| # | Scenario | Category | Severity |
|---|----------|----------|----------|
| 1 | Building collapse — Al Corniche, 25 trapped | Infrastructure | CRITICAL |
| 2 | Industrial chemical fire — toxic smoke plume | Fire/Evacuation | CRITICAL |
| 3 | Mass casualty — stadium crowd crush, 50 injured | Medical | CRITICAL |

All three incidents are within 5km of each other in the Doha metro area, enabling proximity analysis to identify cascade risks and resource-sharing opportunities.

## Performance Benchmarks

| Metric | Value |
|--------|-------|
| HTTP response (triage) | < 300ms |
| Model load time | 2–8s (hardware dependent) |
| Inference (Report JSON) | 40–80s on CPU |
| Inference (Briefing text) | 35–95s on CPU |
| Inference (Proximity analysis) | 40–90s on CPU |
| Token throughput | 2.0–4.5 tokens/sec (CPU) |
| Concurrent WebSocket clients | Tested up to 10 |
| Database (SQLite) | < 1ms per query |
| Total RAM usage | ~4.5 GB |
| Tile cache | 3,215 tiles (zoom 10-16, Doha region) |

## Project Structure

```
aegis-gemma/
├── backend/
│   ├── server.py          # FastAPI app, WebSocket, API routes, proximity analysis
│   ├── gemma_engine.py    # Gemma inference, streaming, JSON parsing
│   └── database.py        # SQLite schema, async CRUD operations
├── frontend/
│   ├── index.html         # Single-page application (3 tabs)
│   ├── css/aegis.css      # Design system, event lifecycle, proximity styles
│   └── js/aegis.js        # Map, streaming, briefing, proximity, demo automation
├── models/                # Gemma 4 GGUF model files
├── tiles/                 # Offline map tile cache (CartoDB Positron)
├── data/                  # SQLite database (auto-created)
├── cache_tiles.py         # Tile download utility for offline map setup
├── seed_demo.py           # Pre-populate demo scenarios with Gemma analysis
├── start.sh               # One-command launch script
├── requirements.txt       # Python dependencies
└── README.md              # This document
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/reports` | Submit crisis report → instant triage + streaming AI analysis |
| `GET` | `/api/reports` | List all reports (ordered by priority) |
| `GET` | `/api/reports/{id}` | Get single report with AI analysis |
| `POST` | `/api/briefing` | Generate streaming situation briefing |
| `POST` | `/api/proximity-analysis` | Run Gemma-powered spatial correlation analysis |
| `POST` | `/api/resources` | Register tactical resource |
| `GET` | `/api/dashboard` | System stats and model status |
| `WS` | `/ws` | Real-time token streaming and event updates |

## Hackathon Track Alignment

**Primary Track: Global Resilience**
- Disaster response AI for first responders
- Fully offline edge deployment
- Real-world crisis coordination utility
- Spatial intelligence for multi-incident response

**Secondary Track: Safety & Trust**
- Transparent AI reasoning (token streaming)
- Structured, deterministic outputs (JSON enforcement)
- Human-in-the-loop design (operator verifies before acting)
- Event lifecycle management (ACTIVE → MONITORING → RESOLVED)

## Why Gemma 4?

Gemma 4 E2B is uniquely suited for this application:
1. **Small enough for edge** — 3.3 GB quantized fits in laptop RAM alongside the web server
2. **Smart enough for triage** — Correctly classifies severity, identifies cascading risks, and recommends specific resource deployments
3. **Smart enough for spatial reasoning** — Analyzes cross-incident correlations and cascade risks between nearby emergencies
4. **Apache 2.0 licensed** — Can be deployed in government/military crisis centers without licensing concerns
5. **Structured output capable** — Reliably generates the JSON schema needed for machine-readable crisis reports

## License

Apache 2.0
