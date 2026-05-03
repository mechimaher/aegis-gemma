"""
Aegis-Gemma: FastAPI Crisis Coordination Server
Air-gapped, zero-trust offline intelligence server.

Architecture:
  - Non-blocking async inference via thread pool
  - Token-by-token streaming via WebSocket
  - Instant keyword triage + background AI upgrade
  - Situation briefing synthesis across all reports
  - Optimized tile serving with aggressive caching

Usage: uvicorn backend.server:app --host 0.0.0.0 --port 8080
"""

import os
import time
import json
import logging
import asyncio
from datetime import datetime, timezone
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, Response
from pydantic import BaseModel, Field
from typing import Optional

from backend.database import (
    init_db, create_report, update_report_analysis,
    get_report, get_all_reports, create_resource,
    get_all_resources, log_event, get_dashboard_stats,
)
import backend.gemma_engine as gemma_engine
from backend.gemma_engine import (
    load_model, analyze_crisis_report_streaming,
    get_model_status, is_model_loaded, _fallback_analysis,
)

# ─── Logging ───────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [AEGIS] %(levelname)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("aegis")

# ─── WebSocket Connection Manager ─────────────────────────
class ConnectionManager:
    """Manages WebSocket connections for real-time crisis updates."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"WebSocket connected. Active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"WebSocket disconnected. Active: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        """Broadcast a message to all connected clients."""
        data = json.dumps(message)
        disconnected = []
        for connection in self.active_connections:
            try:
                await connection.send_text(data)
            except Exception:
                disconnected.append(connection)
        for conn in disconnected:
            if conn in self.active_connections:
                self.active_connections.remove(conn)


manager = ConnectionManager()

# ─── App Lifecycle ─────────────────────────────────────────
_start_time = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database and attempt model loading on startup."""
    logger.info("=" * 50)
    logger.info("  AEGIS-GEMMA Crisis Coordinator v3")
    logger.info("  Air-Gapped Cognitive Intelligence Server")
    logger.info("=" * 50)

    await init_db()
    logger.info("Database initialized")
    await log_event("system", "Aegis-Gemma server started")

    logger.info("Loading Gemma model...")
    model_loaded = load_model()
    if model_loaded:
        logger.info("Gemma model loaded — AI inference ONLINE")
        await log_event("model", "Gemma model loaded successfully")
    else:
        logger.warning("Gemma model not found — running in FALLBACK mode")
        await log_event("model", "Running in fallback mode (no model found)")

    logger.info("=" * 50)
    logger.info("  Server ready on http://0.0.0.0:8080")
    logger.info("=" * 50)

    yield

    logger.info("Aegis-Gemma shutting down.")


# ─── FastAPI App ───────────────────────────────────────────
app = FastAPI(
    title="Aegis-Gemma",
    description="Air-Gapped Cognitive Crisis Coordinator — Powered by Gemma 4",
    version="3.0.0",
    lifespan=lifespan,
)

# Serve static frontend files
FRONTEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")

# ─── Pydantic Models ──────────────────────────────────────

class CrisisReportRequest(BaseModel):
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    report_text: str = Field(..., min_length=5, max_length=2000)
    reporter_id: Optional[str] = None


class ResourceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    type: str = Field(..., min_length=1)
    latitude: float = Field(..., ge=-90, le=90)
    longitude: float = Field(..., ge=-180, le=180)
    quantity: int = Field(1, ge=1)


# ─── Routes: Frontend ─────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    """Serve the main tactical map interface."""
    index_path = os.path.join(FRONTEND_DIR, "index.html")
    with open(index_path, "r") as f:
        return HTMLResponse(content=f.read())


# ─── Routes: Crisis Reports ───────────────────────────────

@app.post("/api/reports")
async def submit_crisis_report(req: CrisisReportRequest):
    """
    Submit a new crisis field report.
    Returns IMMEDIATELY after persistence (~300ms).
    AI analysis streams token-by-token via WebSocket.
    """
    logger.info(f"New report: ({req.latitude:.4f}, {req.longitude:.4f}) — {req.report_text[:80]}...")

    # Step 1: Persist the raw report IMMEDIATELY
    report = await create_report(
        latitude=req.latitude,
        longitude=req.longitude,
        report_text=req.report_text,
        reporter_id=req.reporter_id,
    )

    if is_model_loaded():
        # Model available: report stays as "pending" — Gemma is the sole authority
        # No keyword pre-judgment; the AI reveal is the product moment
        pending_stub = {
            "severity": "pending",
            "priority": 0,
            "category": "analyzing",
            "summary": "Gemma 4 analysis in progress...",
            "recommended_action": "Awaiting AI assessment",
            "resource_needs": [],
            "risk_factors": [],
            "evacuation_needed": False,
            "inference_time_ms": 0,
            "model_used": "pending",
            "tokens_used": 0,
        }
        pending_report = await update_report_analysis(report["id"], pending_stub)

        # Broadcast pending report to all clients
        await manager.broadcast({
            "type": "new_report",
            "report": pending_report,
        })

        # Launch STREAMING AI analysis in background (non-blocking)
        asyncio.create_task(
            _background_streaming_analysis(report["id"], req.report_text, req.latitude, req.longitude)
        )

        return {
            "status": "success",
            "report": pending_report,
            "ai_pending": True,
        }

    else:
        # Model unavailable: keyword fallback is the best we can offer
        instant_triage = _fallback_analysis(req.report_text, note="AI model unavailable — keyword triage only")
        instant_report = await update_report_analysis(report["id"], instant_triage)

        await manager.broadcast({
            "type": "new_report",
            "report": instant_report,
        })

        return {
            "status": "success",
            "report": instant_report,
            "ai_pending": False,
        }


async def _background_streaming_analysis(report_id: int, report_text: str,
                                          latitude: float, longitude: float):
    """
    Background task: streams Gemma tokens via WebSocket for live UI updates.
    The HTTP response has already been sent — this is fire-and-forget.
    """
    try:
        logger.info(f"Streaming AI analysis started for report #{report_id}")

        # Broadcast "analyzing" status
        await manager.broadcast({
            "type": "analysis_started",
            "report_id": report_id,
        })

        # Set up a thread-safe queue for token streaming
        token_queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        def on_token(token: str):
            """Called from the inference thread — safely enqueue for async broadcast."""
            asyncio.run_coroutine_threadsafe(token_queue.put(token), loop)

        # Start streaming inference in background thread
        analysis_future = asyncio.ensure_future(
            analyze_crisis_report_streaming(
                report_text=report_text,
                latitude=latitude,
                longitude=longitude,
                on_token=on_token,
            )
        )

        # Drain the token queue and broadcast each token
        token_count = 0
        while not analysis_future.done() or not token_queue.empty():
            try:
                token = await asyncio.wait_for(token_queue.get(), timeout=0.5)
                token_count += 1
                await manager.broadcast({
                    "type": "analysis_token",
                    "report_id": report_id,
                    "token": token,
                    "n": token_count,
                })
            except asyncio.TimeoutError:
                continue

        # Get the final analysis result
        analysis = await analysis_future

        # Update database with AI results
        updated_report = await update_report_analysis(report_id, analysis)

        await log_event("report", f"Report #{report_id} analyzed by Gemma",
                        {"severity": analysis.get("severity"), "priority": analysis.get("priority")})

        # Broadcast completed analysis to all clients
        await manager.broadcast({
            "type": "analysis_complete",
            "report_id": report_id,
            "report": updated_report,
        })

        severity = analysis.get("severity", "?")
        priority = analysis.get("priority", "?")
        time_ms = analysis.get("inference_time_ms", 0)
        logger.info(f"Report #{report_id} — {severity.upper()} P{priority} [{time_ms}ms] [{token_count} tokens streamed]")

    except Exception as e:
        logger.error(f"Streaming analysis failed for report #{report_id}: {e}", exc_info=True)
        await manager.broadcast({
            "type": "analysis_failed",
            "report_id": report_id,
            "error": str(e),
        })


@app.get("/api/reports")
async def list_reports():
    """Get all crisis reports, ordered by priority."""
    reports = await get_all_reports()
    return {"status": "success", "reports": reports, "count": len(reports)}


@app.get("/api/reports/{report_id}")
async def get_single_report(report_id: int):
    """Get a specific crisis report."""
    report = await get_report(report_id)
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    return {"status": "success", "report": report}


# ─── Routes: Situation Briefing (STREAMING) ──────────────

@app.post("/api/briefing")
async def generate_situation_briefing():
    """
    Generate a streaming situation briefing.
    Returns immediately — tokens stream via WebSocket for live UI display.
    """
    reports = await get_all_reports()
    if not reports:
        return {"status": "success", "briefing": "No active reports to brief."}

    # Build CONDENSED report summaries
    report_summaries = []
    for r in reports:
        analysis = r.get("ai_analysis", {}) if isinstance(r.get("ai_analysis"), dict) else {}
        sev = (analysis.get("severity") or r.get("severity", "?"))[:4].upper()
        text = (analysis.get("summary") or r.get("report_text", ""))[:60]
        report_summaries.append(f"#{r['id']}[{sev}]: {text}")

    reports_block = "\n".join(report_summaries)
    report_count = len(reports)

    if not is_model_loaded():
        critical = sum(1 for r in reports if (r.get("ai_analysis", {}) or {}).get("severity") == "critical" or r.get("severity") == "critical")
        high = sum(1 for r in reports if (r.get("ai_analysis", {}) or {}).get("severity") == "high" or r.get("severity") == "high")
        return {
            "status": "success",
            "briefing": (
                f"SITUATION BRIEFING — {report_count} active reports.\n\n"
                f"Critical: {critical} | High: {high} | Total: {report_count}\n\n"
                f"Recommend prioritizing critical incidents.\n\n"
                f"Active Reports:\n{reports_block}"
            ),
            "model_used": "fallback",
        }

    # Launch streaming briefing as background task
    briefing_prompt = (
        f"You are AEGIS crisis command AI. Write a concise SITUATION BRIEFING.\n\n"
        f"{report_count} active incidents:\n{reports_block}\n\n"
        f"Sections: 1.SITUATION OVERVIEW 2.CRITICAL PRIORITIES 3.RESOURCE ALLOCATION 4.RISK ASSESSMENT\n"
        f"Be direct. No JSON."
    )

    asyncio.create_task(_stream_briefing(briefing_prompt, report_count))

    return {
        "status": "streaming",
        "message": "Briefing generation started. Tokens streaming via WebSocket.",
        "report_count": report_count,
    }


async def _stream_briefing(prompt: str, report_count: int):
    """Background task: stream briefing tokens via WebSocket."""
    import time as _time

    try:
        await manager.broadcast({
            "type": "briefing_started",
            "report_count": report_count,
        })

        token_queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        def on_token(token: str):
            asyncio.run_coroutine_threadsafe(token_queue.put(token), loop)

        def _run_streaming():
            with gemma_engine._inference_lock:
                start = _time.time()
                stream = gemma_engine._llm.create_chat_completion(
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=384,
                    temperature=0.2,
                    top_p=0.85,
                    repeat_penalty=1.15,
                    stream=True,
                )
                chunks = []
                for chunk in stream:
                    delta = chunk["choices"][0].get("delta", {})
                    token = delta.get("content", "")
                    if token:
                        chunks.append(token)
                        on_token(token)
                elapsed = _time.time() - start
            return "".join(chunks).strip(), int(elapsed * 1000), len(chunks)

        _pool = ThreadPoolExecutor(max_workers=1)
        inference_future = loop.run_in_executor(_pool, _run_streaming)

        # Drain token queue and broadcast each token
        token_count = 0
        while not inference_future.done() or not token_queue.empty():
            try:
                token = await asyncio.wait_for(token_queue.get(), timeout=0.5)
                token_count += 1
                await manager.broadcast({
                    "type": "briefing_token",
                    "token": token,
                    "n": token_count,
                })
            except asyncio.TimeoutError:
                continue

        text, time_ms, chunks = await inference_future
        _pool.shutdown(wait=False)

        await manager.broadcast({
            "type": "briefing_complete",
            "briefing": text,
            "inference_time_ms": time_ms,
            "tokens_used": chunks,
            "report_count": report_count,
        })

        logger.info(f"Briefing streamed: {time_ms}ms | {chunks} tokens | {report_count} reports")

    except Exception as e:
        logger.error(f"Briefing streaming failed: {e}", exc_info=True)
        await manager.broadcast({
            "type": "briefing_failed",
            "error": str(e),
        })


# ─── Routes: Resources ────────────────────────────────────

@app.post("/api/resources")
async def register_resource(req: ResourceRequest):
    """Register a resource (medical team, supply depot, etc.) on the tactical map."""
    resource = await create_resource(
        name=req.name,
        res_type=req.type,
        latitude=req.latitude,
        longitude=req.longitude,
        quantity=req.quantity,
    )
    await manager.broadcast({"type": "new_resource", "resource": resource})
    return {"status": "success", "resource": resource}


@app.get("/api/resources")
async def list_resources():
    """Get all registered resources."""
    resources = await get_all_resources()
    return {"status": "success", "resources": resources, "count": len(resources)}


# ─── Routes: Proximity Intelligence (Gemma Feature #3) ────

import math

def _haversine_m(lat1, lon1, lat2, lon2):
    """Calculate distance in meters between two coordinates."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


@app.post("/api/proximity-analysis")
async def run_proximity_analysis():
    """
    Gemma Feature #3: Cross-incident proximity intelligence.
    Identifies nearby incident pairs and uses Gemma to analyze
    cascade risks, resource sharing, and evacuation conflicts.
    """
    reports = await get_all_reports()
    if len(reports) < 2:
        return {"status": "error", "message": "Need at least 2 reports for proximity analysis"}

    # Calculate all pairwise distances
    pairs = []
    for i, r1 in enumerate(reports):
        for r2 in reports[i + 1:]:
            dist = _haversine_m(r1["latitude"], r1["longitude"],
                                r2["latitude"], r2["longitude"])
            if dist < 5000:  # Within 5km
                a1 = r1.get("ai_analysis", {}) or {}
                a2 = r2.get("ai_analysis", {}) or {}
                pairs.append({
                    "from_id": r1["id"], "to_id": r2["id"],
                    "distance_m": round(dist),
                    "from_lat": r1["latitude"], "from_lng": r1["longitude"],
                    "to_lat": r2["latitude"], "to_lng": r2["longitude"],
                    "from_sev": a1.get("severity", "unknown"),
                    "to_sev": a2.get("severity", "unknown"),
                    "from_cat": a1.get("category", "unknown"),
                    "to_cat": a2.get("category", "unknown"),
                    "from_text": (r1.get("report_text", ""))[:80],
                    "to_text": (r2.get("report_text", ""))[:80],
                })

    pairs.sort(key=lambda p: p["distance_m"])
    top_pairs = pairs[:6]  # Limit to 6 closest pairs

    if not top_pairs:
        return {"status": "success", "pairs": [], "message": "No nearby incident pairs found"}

    if not is_model_loaded():
        # Fallback: return pairs with basic distance info
        for p in top_pairs:
            p["ai_insight"] = f"Incidents {p['distance_m']}m apart. Manual assessment recommended."
            p["risk_level"] = "medium"
        return {"status": "success", "pairs": top_pairs, "model_used": "fallback"}

    # Build compact prompt for Gemma
    pair_descs = []
    for i, p in enumerate(top_pairs):
        pair_descs.append(
            f"P{i+1}: #{p['from_id']}({p['from_sev']},{p['from_cat']}) <-> "
            f"#{p['to_id']}({p['to_sev']},{p['to_cat']}) = {p['distance_m']}m"
        )

    prompt = (
        "You are AEGIS crisis AI. Analyze spatial relationships between nearby incidents.\n\n"
        f"Incident pairs within 5km:\n" + "\n".join(pair_descs) + "\n\n"
        "Reply ONLY with a JSON array. For each pair:\n"
        '[{"pair":"P1","risk_level":"critical/high/medium/low",'
        '"insight":"1 sentence: cascade risk, resource sharing, or evacuation conflict",'
        '"action":"1 sentence recommended coordination action"}]\n'
        "Be specific about WHY proximity matters for each pair."
    )

    # Launch streaming in background
    asyncio.create_task(_stream_proximity(prompt, top_pairs))

    return {
        "status": "streaming",
        "message": "Proximity analysis started. Results streaming via WebSocket.",
        "pair_count": len(top_pairs),
    }


async def _stream_proximity(prompt: str, pairs: list):
    """Background task: stream proximity analysis via WebSocket."""
    import time as _time

    try:
        await manager.broadcast({
            "type": "proximity_started",
            "pair_count": len(pairs),
            "pairs": pairs,
        })

        token_queue = asyncio.Queue()
        loop = asyncio.get_event_loop()

        def on_token(token: str):
            asyncio.run_coroutine_threadsafe(token_queue.put(token), loop)

        def _run_streaming():
            with gemma_engine._inference_lock:
                start = _time.time()
                stream = gemma_engine._llm.create_chat_completion(
                    messages=[{"role": "user", "content": prompt}],
                    max_tokens=512,
                    temperature=0.15,
                    top_p=0.85,
                    repeat_penalty=1.15,
                    stream=True,
                )
                chunks = []
                for chunk in stream:
                    delta = chunk["choices"][0].get("delta", {})
                    token = delta.get("content", "")
                    if token:
                        chunks.append(token)
                        on_token(token)
                elapsed = _time.time() - start
            return "".join(chunks).strip(), int(elapsed * 1000), len(chunks)

        _pool = ThreadPoolExecutor(max_workers=1)
        inference_future = loop.run_in_executor(_pool, _run_streaming)

        token_count = 0
        while not inference_future.done() or not token_queue.empty():
            try:
                token = await asyncio.wait_for(token_queue.get(), timeout=0.5)
                token_count += 1
                await manager.broadcast({
                    "type": "proximity_token",
                    "token": token,
                    "n": token_count,
                })
            except asyncio.TimeoutError:
                continue

        raw_text, time_ms, chunks = await inference_future
        _pool.shutdown(wait=False)

        # Parse the AI response into per-pair insights
        insights = _parse_proximity_response(raw_text, pairs)

        await manager.broadcast({
            "type": "proximity_complete",
            "pairs": insights,
            "inference_time_ms": time_ms,
            "tokens_used": chunks,
        })

        logger.info(f"Proximity analysis: {time_ms}ms | {chunks} tokens | {len(pairs)} pairs")

    except Exception as e:
        logger.error(f"Proximity analysis failed: {e}", exc_info=True)
        await manager.broadcast({
            "type": "proximity_failed",
            "error": str(e),
        })


def _parse_proximity_response(raw_text: str, pairs: list) -> list:
    """Parse Gemma's proximity analysis response and merge with pair data."""
    from backend.gemma_engine import _parse_crisis_json

    text = raw_text.strip()
    # Strip markdown fences
    if text.startswith("```json"):
        text = text[7:]
    elif text.startswith("```"):
        text = text[3:]
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()

    try:
        insights_list = json.loads(text)
        if isinstance(insights_list, list):
            for i, pair in enumerate(pairs):
                if i < len(insights_list):
                    ins = insights_list[i]
                    pair["risk_level"] = ins.get("risk_level", "medium")
                    pair["ai_insight"] = ins.get("insight", "")
                    pair["action"] = ins.get("action", "")
                else:
                    pair["risk_level"] = "medium"
                    pair["ai_insight"] = "Analysis pending."
                    pair["action"] = ""
            return pairs
    except (json.JSONDecodeError, TypeError):
        pass

    # Fallback: assign generic insights
    for pair in pairs:
        pair["risk_level"] = "high" if pair["distance_m"] < 1500 else "medium"
        pair["ai_insight"] = f"Incidents {pair['distance_m']}m apart — coordinate response."
        pair["action"] = "Deploy shared resources between locations."
    return pairs


# ─── Routes: Dashboard & System ───────────────────────────

@app.get("/api/dashboard")
async def get_dashboard():
    """Get dashboard statistics."""
    stats = await get_dashboard_stats()
    return {
        "status": "success",
        "stats": stats,
        "model_status": get_model_status(),
        "uptime_seconds": int(time.time() - _start_time),
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/system/status")
async def system_status():
    """Full system health check."""
    return {
        "status": "operational",
        "service": "Aegis-Gemma Crisis Coordinator",
        "version": "3.0.0",
        "air_gapped": True,
        "model": get_model_status(),
        "uptime_seconds": int(time.time() - _start_time),
        "server_time": datetime.now(timezone.utc).isoformat(),
        "network_mode": "local-only",
    }


# ─── Routes: Offline Map Tiles ────────────────────────────

TILES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "tiles")

_grid_tile_cache: bytes = b""


@app.get("/tiles/{z}/{x}/{y}.png")
async def serve_tile(z: int, x: int, y: int):
    """
    Serve offline map tiles.
    Priority: individual PNGs -> MBTiles database -> cached grid placeholder.
    """
    tile_path = os.path.join(TILES_DIR, str(z), str(x), f"{y}.png")
    if os.path.exists(tile_path):
        return FileResponse(
            tile_path,
            media_type="image/png",
            headers={"Cache-Control": "public, max-age=86400"},
        )

    mbtiles_path = os.path.join(TILES_DIR, "map.mbtiles")
    if os.path.exists(mbtiles_path):
        import aiosqlite
        async with aiosqlite.connect(mbtiles_path) as db:
            tms_y = (1 << z) - 1 - y
            cursor = await db.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                (z, x, tms_y)
            )
            row = await cursor.fetchone()
            if row:
                return Response(
                    content=row[0],
                    media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"},
                )

    global _grid_tile_cache
    if not _grid_tile_cache:
        _grid_tile_cache = _generate_grid_tile()
    return Response(
        content=_grid_tile_cache,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


def _generate_grid_tile() -> bytes:
    """Generate a simple dark grid tile as placeholder."""
    import struct
    import zlib

    width, height = 256, 256
    rows = []
    for y_px in range(height):
        row = []
        for x_px in range(width):
            if x_px % 32 == 0 or y_px % 32 == 0:
                row.extend([40, 50, 60, 255])
            else:
                row.extend([20, 25, 35, 255])
        rows.append(bytes([0] + row))

    raw_data = b"".join(rows)
    compressed = zlib.compress(raw_data)

    def png_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBB B", width, height, 8, 6, 0, 0, 0))
    png += png_chunk(b"IDAT", compressed)
    png += png_chunk(b"IEND", b"")
    return png


# ─── WebSocket: Real-time Updates ─────────────────────────

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time crisis updates and token streaming."""
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text('{"type":"pong"}')
    except WebSocketDisconnect:
        manager.disconnect(websocket)
