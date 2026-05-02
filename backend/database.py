"""
Aegis-Gemma: SQLite Database Layer
Zero-dependency offline persistence for crisis reports and resource tracking.
"""

import aiosqlite
import os
import json
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "aegis.db")
_db_initialized = False

_SCHEMA = """
CREATE TABLE IF NOT EXISTS crisis_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    report_text TEXT NOT NULL,
    severity TEXT DEFAULT 'unknown',
    category TEXT DEFAULT 'general',
    ai_analysis TEXT,
    ai_priority INTEGER DEFAULT 0,
    ai_recommended_action TEXT,
    status TEXT DEFAULT 'new',
    reporter_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    quantity INTEGER DEFAULT 0,
    status TEXT DEFAULT 'available',
    assigned_to_report_id INTEGER,
    created_at TEXT NOT NULL,
    FOREIGN KEY (assigned_to_report_id) REFERENCES crisis_reports(id)
);
CREATE TABLE IF NOT EXISTS system_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_severity ON crisis_reports(severity);
CREATE INDEX IF NOT EXISTS idx_reports_status ON crisis_reports(status);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
"""

from contextlib import asynccontextmanager


@asynccontextmanager
async def _get_db():
    """Get a DB connection, auto-initializing tables if needed."""
    global _db_initialized
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    async with aiosqlite.connect(DB_PATH) as db:
        if not _db_initialized:
            await db.executescript(_SCHEMA)
            await db.commit()
            _db_initialized = True
        yield db



async def init_db():
    """Initialize the SQLite database with crisis coordination schema."""
    async with _get_db() as db:
        pass  # _get_db handles schema creation automatically


async def create_report(latitude: float, longitude: float, report_text: str,
                        reporter_id: str = None) -> dict:
    """Insert a new crisis report and return it."""
    now = datetime.now(timezone.utc).isoformat()
    async with _get_db() as db:
        cursor = await db.execute(
            """INSERT INTO crisis_reports 
               (latitude, longitude, report_text, reporter_id, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (latitude, longitude, report_text, reporter_id, now)
        )
        await db.commit()
        report_id = cursor.lastrowid
        return {
            "id": report_id,
            "latitude": latitude,
            "longitude": longitude,
            "report_text": report_text,
            "severity": "unknown",
            "category": "general",
            "status": "new",
            "reporter_id": reporter_id,
            "created_at": now,
        }


async def update_report_analysis(report_id: int, analysis: dict) -> dict:
    """Update a crisis report with AI analysis results."""
    now = datetime.now(timezone.utc).isoformat()
    async with _get_db() as db:
        await db.execute(
            """UPDATE crisis_reports SET
               ai_analysis = ?,
               ai_priority = ?,
               ai_recommended_action = ?,
               severity = ?,
               category = ?,
               status = 'analyzed',
               updated_at = ?
               WHERE id = ?""",
            (
                json.dumps(analysis),
                analysis.get("priority", 0),
                analysis.get("recommended_action", ""),
                analysis.get("severity", "unknown"),
                analysis.get("category", "general"),
                now,
                report_id,
            )
        )
        await db.commit()
    return await get_report(report_id)


async def get_report(report_id: int) -> dict | None:
    """Get a single crisis report by ID."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM crisis_reports WHERE id = ?", (report_id,)
        )
        row = await cursor.fetchone()
        if row:
            d = dict(row)
            if d.get("ai_analysis"):
                d["ai_analysis"] = json.loads(d["ai_analysis"])
            return d
        return None


async def get_all_reports() -> list[dict]:
    """Get all crisis reports, ordered by priority descending."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM crisis_reports ORDER BY ai_priority DESC, created_at DESC"
        )
        rows = await cursor.fetchall()
        results = []
        for row in rows:
            d = dict(row)
            if d.get("ai_analysis"):
                d["ai_analysis"] = json.loads(d["ai_analysis"])
            results.append(d)
        return results


async def create_resource(name: str, res_type: str, latitude: float,
                          longitude: float, quantity: int = 1) -> dict:
    """Register a resource on the tactical map."""
    now = datetime.now(timezone.utc).isoformat()
    async with _get_db() as db:
        cursor = await db.execute(
            """INSERT INTO resources (name, type, latitude, longitude, quantity, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (name, res_type, latitude, longitude, quantity, now)
        )
        await db.commit()
        return {
            "id": cursor.lastrowid,
            "name": name,
            "type": res_type,
            "latitude": latitude,
            "longitude": longitude,
            "quantity": quantity,
            "status": "available",
            "created_at": now,
        }


async def get_all_resources() -> list[dict]:
    """Get all registered resources."""
    async with _get_db() as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM resources ORDER BY created_at DESC")
        rows = await cursor.fetchall()
        return [dict(row) for row in rows]


async def log_event(event_type: str, message: str, metadata: dict = None):
    """Log a system event."""
    now = datetime.now(timezone.utc).isoformat()
    async with _get_db() as db:
        await db.execute(
            "INSERT INTO system_log (event_type, message, metadata, created_at) VALUES (?, ?, ?, ?)",
            (event_type, message, json.dumps(metadata) if metadata else None, now)
        )
        await db.commit()


async def get_dashboard_stats() -> dict:
    """Get aggregate statistics for the crisis dashboard."""
    async with _get_db() as db:
        # Total reports
        cursor = await db.execute("SELECT COUNT(*) FROM crisis_reports")
        total_reports = (await cursor.fetchone())[0]

        # Reports by severity
        cursor = await db.execute(
            "SELECT severity, COUNT(*) FROM crisis_reports GROUP BY severity"
        )
        severity_counts = {row[0]: row[1] for row in await cursor.fetchall()}

        # Reports by status
        cursor = await db.execute(
            "SELECT status, COUNT(*) FROM crisis_reports GROUP BY status"
        )
        status_counts = {row[0]: row[1] for row in await cursor.fetchall()}

        # Total resources
        cursor = await db.execute("SELECT COUNT(*) FROM resources")
        total_resources = (await cursor.fetchone())[0]

        # Critical reports (priority >= 8)
        cursor = await db.execute(
            "SELECT COUNT(*) FROM crisis_reports WHERE ai_priority >= 8"
        )
        critical_count = (await cursor.fetchone())[0]

        return {
            "total_reports": total_reports,
            "severity_counts": severity_counts,
            "status_counts": status_counts,
            "total_resources": total_resources,
            "critical_count": critical_count,
        }
