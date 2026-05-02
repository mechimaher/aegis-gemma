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

    # Step 2: Run keyword-based instant triage (sub-millisecond)
    instant_triage = _fallback_analysis(req.report_text, note="Instant triage — AI analysis pending")
    instant_report = await update_report_analysis(report["id"], instant_triage)

    # Broadcast instant triage to all clients
    await manager.broadcast({
        "type": "new_report",
        "report": instant_report,
    })

    # Step 3: Launch STREAMING AI analysis in background (non-blocking)
    if is_model_loaded():
        asyncio.create_task(
            _background_streaming_analysis(report["id"], req.report_text, req.latitude, req.longitude)
        )

    return {
        "status": "success",
        "report": instant_report,
        "ai_pending": is_model_loaded(),
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
