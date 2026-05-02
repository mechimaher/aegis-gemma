# AEGIS-GEMMA: Air-gapped Edge Gemma Intelligence System

> **First-responder tactical AI that runs 100% offline — powered by Google Gemma 4 E2B on local hardware via llama.cpp. Zero cloud. Zero latency. Zero excuses.**

---

## The Problem We Solve

When disaster strikes, **internet is the first casualty**. Cell towers collapse, fiber lines sever, cloud APIs become unreachable. Yet this is precisely when AI-powered decision support is most critical — when an incident commander must triage dozens of simultaneous emergencies with incomplete information and zero connectivity.

Every existing crisis AI tool fails at this exact moment because they depend on cloud inference.

**AEGIS-GEMMA doesn't.**

## How It Works

AEGIS-GEMMA is a self-contained tactical intelligence system that runs entirely on a single laptop:

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

### Situation Briefing — Multi-Report Synthesis

With one click, Gemma 4 reads ALL active crisis reports and streams a unified commander's briefing token-by-token in real-time:
- **Situation Overview** — Overall threat assessment
- **Critical Priorities** — Numbered immediate actions
- **Resource Allocation** — Where to deploy first
- **Cascading Risk Assessment** — How incidents interact

This is not a simple summary — it's cross-incident analytical reasoning. Streaming the output live means commanders can begin reading intelligence immediately, and the AI's reasoning process is fully transparent.

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
│  │              │              │   via llama-cpp-python │  │
│  └──────────────┘              └──────────┬─────────────┘  │
│                                           │                │
│                    ┌──────────────────────┘                │
│                    ▼                                       │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  SQLite (aiosqlite)                 │   │
│  │  reports │ resources │ events │ ai_analysis (JSON)  │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                            │
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

### 4. Impact Zone Mapping
Each crisis marker on the map is surrounded by a severity-scaled impact radius circle (critical: 400m, high: 300m, medium: 200m, low: 120m). Markers are sized by severity (critical markers are 75% larger than low-severity ones). A professional severity legend provides instant visual decoding. This transforms the map from a pin collection into a tactical common operating picture.

### 5. Complete Air-Gap Compliance
The system makes **zero external network calls**:
- All fonts bundled locally (Inter, JetBrains Mono)
- Leaflet.js served from local files
- Map tiles cached locally
- No CDN, no analytics, no telemetry
- No `fetch()` to any external domain

> **Note on Voice Input:** The Web Speech API is a browser-native feature that works offline on Chromium with OS-level language packs installed. On systems without offline speech packs, Chrome may route audio to Google's servers. For guaranteed air-gap compliance, install the `English (US)` offline speech pack in your OS settings, or disable voice input. A future enhancement would integrate `whisper.cpp` for fully local transcription.

## Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **AI Model** | Gemma 4 E2B IT (Q4_K_M GGUF, 3.3 GB) | Best quality-per-byte for edge deployment |
| **Inference** | llama-cpp-python (CPU/AVX2 + flash attention) | Fastest CPU inference, no GPU required |
| **Backend** | Python 3.12, FastAPI, uvicorn | Async-native, WebSocket support |
| **Database** | SQLite via aiosqlite | Zero-config, single-file persistence |
| **Frontend** | Vanilla HTML/CSS/JS (zero frameworks) | No build step, instant deployment |
| **Maps** | Leaflet.js (locally bundled) | Lightweight, offline-capable |
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

# 4. Seed demo crisis scenarios
python3 seed_demo.py

# 5. Launch
python3 -m uvicorn backend.server:app --host 0.0.0.0 --port 8080
```

Open **http://localhost:8080** in any modern browser.

## Demo Walkthrough

1. **Dashboard loads** — 7 pre-seeded Doha crisis scenarios appear on the tactical map with severity-colored markers and impact zones
2. **Drop a pin** — Click "Drop Crisis Pin", click the map, describe the incident
3. **Submit & Analyze** — Instant triage classifies the report; Gemma 4 begins streaming analysis tokens in real-time
4. **AI Analysis** — Structured results appear: severity, priority bar, tactical summary, immediate action, required resources, risk factors
5. **Situation Briefing** — Switch to the briefing tab, click "Generate Briefing" — Gemma synthesizes ALL reports into a commander's overview

### Demo Scenarios (Pre-seeded)

| # | Scenario | Severity |
|---|----------|----------|
| 1 | Building collapse — 6-story residential | CRITICAL |
| 2 | Flash flooding — 40+ vehicles stranded | HIGH |
| 3 | Industrial chemical fire — toxic plume | CRITICAL |
| 4 | Mass casualty — stadium crowd crush | CRITICAL |
| 5 | Bridge damage — Pearl Island isolated | HIGH |
| 6 | Power grid failure — hospital blackout | HIGH |
| 7 | Gas pipeline rupture — metro construction | CRITICAL |

## Performance Benchmarks

| Metric | Value |
|--------|-------|
| HTTP response (triage) | < 300ms |
| Model load time | 2–8s (hardware dependent) |
| Inference (Report JSON) | 40–80s on CPU |
| Inference (Briefing text) | 35–95s on CPU |
| Token throughput | 2.0–3.0 tokens/sec (CPU) |
| Concurrent WebSocket clients | Tested up to 10 |
| Database (SQLite) | < 1ms per query |
| Total RAM usage | ~4.5 GB |

## Project Structure

```
gemma/
├── backend/
│   ├── server.py          # FastAPI app, WebSocket, API routes
│   ├── gemma_engine.py    # Gemma inference, streaming, JSON parsing
│   └── database.py        # SQLite schema, async CRUD operations
├── frontend/
│   ├── index.html         # Single-page application
│   ├── css/aegis.css      # Design system
│   └── js/aegis.js        # Map, streaming, briefing logic
├── models/                # Gemma 4 GGUF model files
├── tiles/                 # Offline map tile cache
├── static/                # Fonts, Leaflet.js, served assets
├── seed_demo.py           # Pre-populate demo scenarios
└── README.md              # This document
```

## Hackathon Track Alignment

**Primary Track: Global Resilience**
- Disaster response AI for first responders
- Fully offline edge deployment
- Real-world crisis coordination utility

**Secondary Track: Safety & Trust**
- Transparent AI reasoning (token streaming)
- Structured, deterministic outputs (JSON enforcement)
- Human-in-the-loop design (operator verifies before acting)

## Why Gemma 4?

Gemma 4 E2B is uniquely suited for this application:
1. **Small enough for edge** — 3.3 GB quantized fits in laptop RAM alongside the web server
2. **Smart enough for triage** — Correctly classifies severity, identifies cascading risks, and recommends specific resource deployments
3. **Apache 2.0 licensed** — Can be deployed in government/military crisis centers without licensing concerns
4. **Structured output capable** — Reliably generates the JSON schema needed for machine-readable crisis reports

## License

Apache 2.0
