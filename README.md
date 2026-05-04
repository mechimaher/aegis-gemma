# AEGISGEMMA

### Air-Gapped Edge Gemma Intelligence System

> First-responder tactical AI that runs **100% offline** — powered by Google Gemma 4 E2B with GPU-accelerated inference via llama.cpp. Zero cloud. Zero latency. Zero excuses.

---

## The Problem

When disaster strikes, **internet is the first casualty**. Cell towers collapse, fiber lines sever, cloud APIs become unreachable. Yet this is precisely when AI-powered decision support is most critical — when an incident commander must triage dozens of simultaneous emergencies with incomplete information and zero connectivity.

Every existing crisis AI tool fails at this exact moment because they depend on cloud inference.

**AEGISGEMMA runs entirely on a single laptop.** No internet. No cloud. No API keys. Just a local Gemma 4 model, a local database, and a local map — everything an incident commander needs to coordinate a multi-incident crisis response from a field operations tent with no connectivity.

## Three Gemma-Powered Intelligence Features

AEGISGEMMA leverages Gemma 4 E2B in **three distinct ways**, each demonstrating a different dimension of on-device AI capability:

### Feature 1: Real-Time Report Triage (Streaming)

Individual crisis reports are analyzed by Gemma 4 with **token-by-token streaming**. The operator drops a pin on the offline tactical map, describes the incident in natural language, and submits. The report starts as `PENDING` — Gemma is the sole authority for classification.

Within seconds, Gemma streams structured JSON output visible in real-time:
- **Severity classification** (critical / high / medium / low)
- **Priority score** (1–10)
- **Incident category** (medical, fire, flood, infrastructure, evacuation)
- **Required resources** (ambulances, hazmat teams, search-and-rescue)
- **Evacuation assessment** (needed or not)
- **Risk factors** (aftershocks, secondary explosions, toxic plumes)
- **Recommended immediate action** (specific, actionable command)

**Why this matters:** Every report gets a consistent, structured assessment regardless of operator fatigue or experience level. The AI augments human judgment — it doesn't replace it.

### Feature 2: Situation Briefing Synthesis

With one click, Gemma 4 reads **ALL** active crisis reports and streams a unified commander's briefing covering:
1. **Situation Overview** — Current operational picture
2. **Critical Priorities** — What needs attention first
3. **Resource Allocation** — Where to deploy limited assets
4. **Risk Assessment** — Cascading threats and escalation potential

This is **cross-incident analytical reasoning** — not a simple summary. Gemma synthesizes patterns across multiple emergencies to identify systemic risks that individual report analysis would miss.

### Feature 3: Proximity Intelligence

Gemma 4 analyzes **spatial relationships** between nearby incidents. The system calculates haversine distances between all incident pairs and sends those within 5 km to Gemma for cross-correlation analysis:

- **Cascade risks** — Fire near gas pipeline, chemical plume heading toward hospital
- **Resource-sharing opportunities** — Shared ambulance corridors, overlapping response zones
- **Evacuation conflicts** — Routes blocked by multiple incidents simultaneously

Results render as dashed connector lines on the tactical map with **draggable C4ISR-grade intel cards** — tethered to the midpoint by a thin line, repositionable 360° so they never obscure incident markers. Clicking a pair card in the analysis panel automatically flies the map to that connection and opens the intel overlay.

---

## How It Works

```
Operator → Drops pin on offline map → Describes incident in natural language
                                          ↓
                                   Report saved to SQLite (severity: PENDING)
                                          ↓
                              [Background] Gemma 4 E2B inference
                              ThreadPoolExecutor → non-blocking
                                          ↓
                              [WebSocket] Token-by-token streaming
                              Each token broadcast to all clients
                                          ↓
                              Severity REVEALED by Gemma:
                              Marker changes color, card updates,
                              impact zone appears on map
```

**AI-First Pipeline:** When Gemma is loaded, new reports start as `PENDING` with neutral pulsing markers. Gemma runs in a `ThreadPoolExecutor` and streams tokens via WebSocket. When analysis completes, severity is **revealed** — Gemma is the sole authority. When Gemma is unavailable, a keyword-based triage engine provides instant fallback classification, ensuring the system degrades gracefully.

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│                       AEGISGEMMA                           │
│              100% Air-Gapped · GPU-Accelerated             │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────┐  WebSocket   ┌────────────────────────┐  │
│  │   Browser    │◄─streaming──►│   FastAPI (async)      │  │
│  │              │   tokens     │   uvicorn on :8080     │  │
│  │  • Leaflet   │              │   • Non-blocking loop  │  │
│  │  • Offline   │              │   • ThreadPoolExecutor │  │
│  │  • Streaming │              │   • WebSocket broadcast│  │
│  └──────────────┘              └──────────┬─────────────┘  │
│         │                                 │                │
│  ┌──────┴───────┐              ┌──────────▼─────────────┐  │
│  │  Local Tile  │              │   Gemma 4 E2B          │  │
│  │  Cache (PNG) │              │   Q4_K_M GGUF (3.3 GB) │  │
│  │  CartoDB     │              │   llama-cpp-python     │  │
│  │  Positron    │              │   CUDA + CPU hybrid    │  │
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

---

## Technical Depth

### 1. Adaptive GPU/CPU Hybrid Inference
The inference engine auto-detects CUDA capability by inspecting the compiled `llama-cpp-python` binary for CUDA shared objects. When a GPU is present, the system uses **progressive VRAM probing** — attempting full layer offload (99 layers), then stepping down (24 → 16 → 10 → 0) until the model fits. On a GTX 1650 (4 GB VRAM), this achieves 3–5× throughput over CPU-only. The entire detection and fallback process is automatic.

### 2. Non-Blocking Streaming Architecture
The core engineering challenge: run a 3.3 GB language model without freezing the web server. Inference executes in a `ThreadPoolExecutor`, bridged to the async event loop via `asyncio.Queue`. Each token is broadcast to all connected WebSocket clients in real-time. The dashboard **never stalls** — operators can submit new reports, pan the map, and check stats while Gemma is mid-inference.

### 3. Robust JSON Parsing Pipeline
Gemma produces structured JSON with specific crisis-response fields. A **three-stage parser** handles LLM output quirks:
1. Direct `json.loads()` parse
2. Regex extraction of JSON objects from surrounding text
3. Bracket-depth matching for truncated output
4. Keyword-based fallback for complete parse failures

This guarantees every report gets machine-readable classification — even from partial or malformed model output.

### 4. Token-by-Token Transparency
Every token Gemma generates appears in a terminal-style display with syntax highlighting. This serves two purposes: (1) **transparent AI reasoning** — operators see exactly what the model produces, and (2) **immediate feedback** — the system visibly works during long inference runs, building trust.

### 5. Spatial Correlation Engine
Haversine distance calculations between all incident pairs, with a coverage-first selection algorithm that ensures every incident node has at least one connection before filling remaining slots. Pairs within 5 km are sent to Gemma for cross-correlation analysis, with results rendered as interactive overlays on the tactical map.

### 6. Complete Air-Gap Compliance
The system makes **zero external network calls**:
- All fonts bundled locally (Inter, JetBrains Mono)
- Leaflet.js served from local files
- Map tiles cached locally (CartoDB Positron, zoom 10–16)
- No CDN, no analytics, no telemetry
- SQLite database — no network database dependency

---

## Technology Stack

| Component | Technology | Why |
|-----------|-----------|-----|
| **AI Model** | Gemma 4 E2B IT (Q4_K_M GGUF, 3.3 GB) | Best quality-per-byte for edge deployment |
| **Inference** | llama-cpp-python + CUDA | Auto-detects GPU, progressive VRAM management |
| **Backend** | Python 3.12, FastAPI, uvicorn | Async-native, WebSocket-first |
| **Database** | SQLite via aiosqlite | Zero-config, single-file, offline persistence |
| **Frontend** | Vanilla HTML/CSS/JS (zero frameworks) | No build step, instant deployment |
| **Maps** | Leaflet.js + CartoDB Positron tiles (local) | Lightweight, fully offline |
| **Streaming** | Native WebSocket | Real-time token broadcast |

---

## Quick Start

```bash
# 1. Clone
git clone https://github.com/mechimaher/aegis-gemma.git
cd aegis-gemma

# 2. Environment
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 3. Download Gemma 4 model (3.3 GB, one-time)
pip install huggingface-hub
huggingface-cli download bartowski/google_gemma-4-E2B-it-GGUF \
  google_gemma-4-E2B-it-Q4_K_M.gguf --local-dir ./models/

# 4. (Optional) GPU acceleration — NVIDIA only
sudo apt install nvidia-cuda-toolkit
CMAKE_ARGS="-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=native" \
  pip install llama-cpp-python --force-reinstall --no-cache-dir
pip install nvidia-cuda-runtime-cu12 nvidia-cublas-cu12

# 5. Seed demo scenarios
python3 seed_demo.py

# 6. Launch
python3 -m uvicorn backend.server:app --host 0.0.0.0 --port 8080
```

Open **http://localhost:8080** — the status bar shows `● Gemma Ready` when the model is loaded.

> **GPU auto-detection:** The engine probes for CUDA support at startup. If found, it progressively offloads transformer layers to the GPU until the model fits in available VRAM. No manual configuration needed.

---

## Demo

AEGISGEMMA includes a one-click demo (`Demo` button or `Ctrl+Shift+D`) that showcases all three Gemma features in sequence:

1. **Tactical Map** — Pre-seeded Doha crisis scenarios with severity markers and impact zones
2. **Pin Drop** — New incident with typewriter-effect description
3. **AI Triage** — Report starts `PENDING` → Gemma streams JSON → severity **revealed**
4. **Situation Briefing** — Gemma synthesizes all reports into commander's overview
5. **Proximity Intel** — Gemma analyzes spatial correlations between nearby incidents
6. **Map Return** — Risk connector lines with draggable intel cards

### Pre-Seeded Scenarios

| # | Scenario | Category |
|---|----------|----------|
| 1 | Building collapse — 25 trapped, aftershock risk | Infrastructure |
| 2 | Industrial chemical fire — toxic smoke plume | Fire / Hazmat |
| 3 | Stadium crowd crush — 50 injured, mass casualty | Medical |

All incidents are within 5 km (Doha metro area), enabling proximity analysis to identify cascade risks and resource-sharing opportunities.

---

## Performance

| Metric | CPU-Only | GPU (GTX 1650, 4 GB) |
|--------|----------|------|
| Model load | 2–8s | 3–5s |
| Report analysis | 40–80s | 12–25s |
| Situation briefing | 35–95s | 10–30s |
| Proximity analysis | 40–90s | 12–28s |
| Token throughput | 2–4.5 tok/s | 8–15 tok/s |
| HTTP response | < 300ms | < 300ms |
| Database ops | < 1ms | < 1ms |
| RAM usage | ~4.5 GB | ~4.5 GB (+267 MB VRAM) |

---

## Project Structure

```
aegis-gemma/
├── backend/
│   ├── server.py          # FastAPI, WebSocket, API routes, proximity engine
│   ├── gemma_engine.py    # Gemma inference, streaming, JSON parsing
│   └── database.py        # SQLite schema, async CRUD
├── frontend/
│   ├── index.html         # Single-page application
│   ├── css/aegis.css      # Design system
│   └── js/aegis.js        # Map, streaming, briefing, proximity, demo
├── models/                # Gemma 4 GGUF model (not tracked in git)
├── tiles/                 # Offline map tile cache
├── data/                  # SQLite database (auto-created)
├── seed_demo.py           # Demo scenario seeder
├── cache_tiles.py         # Tile download utility
├── start.sh               # Launch script
├── requirements.txt       # Python dependencies
└── README.md
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/reports` | Submit crisis report → streaming AI analysis |
| `GET` | `/api/reports` | List all reports (priority-ordered) |
| `GET` | `/api/reports/{id}` | Single report with AI analysis |
| `POST` | `/api/briefing` | Streaming situation briefing |
| `POST` | `/api/proximity-analysis` | Spatial correlation analysis |
| `POST` | `/api/resources` | Register tactical resource |
| `GET` | `/api/dashboard` | System stats + model status |
| `WS` | `/ws` | Real-time token streaming |

---

## Hackathon Track Alignment

**Primary Track: Global Resilience**
- Disaster response AI for first responders operating without connectivity
- Fully offline edge deployment on consumer hardware
- Real-world crisis coordination utility with spatial intelligence
- Designed for the moment when cloud AI is unavailable

**Secondary Track: Safety & Trust**
- Transparent AI reasoning (live token streaming — operator sees every token)
- Structured, deterministic outputs (JSON schema enforcement)
- Human-in-the-loop design (AI recommends, operator decides)
- Graceful degradation (keyword fallback when model unavailable)

## Why Gemma 4?

Gemma 4 E2B is uniquely suited for edge crisis response:

1. **Small enough for edge** — 3.3 GB quantized fits in laptop RAM alongside the web server
2. **GPU-acceleratable** — Partial layer offloading to entry-level GPUs (4 GB VRAM) delivers 3–5× throughput
3. **Accurate for triage** — Correctly classifies severity, identifies cascading risks, recommends resource deployments
4. **Spatial reasoning** — Analyzes cross-incident correlations and cascade risks
5. **Apache 2.0** — Deployable in government and military crisis centers without licensing concerns
6. **Structured output** — Reliably generates the JSON schema needed for machine-readable crisis classification

---

## License

Apache 2.0
