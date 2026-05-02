#!/usr/bin/env python3
"""
Aegis-Gemma: Demo Scenario Seeder
Pre-populates the database with realistic crisis scenarios for demo presentations.
"""

import asyncio
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from backend.database import init_db, create_report, update_report_analysis
from backend.gemma_engine import (
    load_model, is_model_loaded, _run_inference_sync, _fallback_analysis
)

# Demo Scenarios
DEMO_SCENARIOS = [
    {
        "latitude": 25.2867,
        "longitude": 51.5340,
        "report_text": "Building collapse at Al Corniche intersection. Structural failure in 6-story residential building. Estimated 25 residents trapped. Dust cloud reducing visibility. Adjacent buildings showing stress fractures.",
    },
    {
        "latitude": 25.2920,
        "longitude": 51.5200,
        "report_text": "Flash flooding on Salwa Road. Water level at 1.2 meters and rising. 40+ vehicles stranded including a school bus with 30 children. Storm drain system overwhelmed. Power lines down in water.",
    },
    {
        "latitude": 25.2750,
        "longitude": 51.5450,
        "report_text": "Industrial fire at warehouse complex in Industrial Area. Chemical storage facility involved. Toxic smoke plume drifting northeast toward residential zone. 3 workers injured, 2 unaccounted for.",
    },
    {
        "latitude": 25.3000,
        "longitude": 51.5100,
        "report_text": "Mass casualty incident at sports stadium. Crowd crush during evacuation. Approximately 50 people injured, 12 in critical condition. Medical facilities overwhelmed. Need additional ambulances and field hospitals.",
    },
    {
        "latitude": 25.2800,
        "longitude": 51.5500,
        "report_text": "Road blocked by debris at Pearl Island access bridge. Earthquake aftershock caused partial bridge deck separation. 200+ residents isolated on island. No vehicular access. Need marine or air evacuation assessment.",
    },
    {
        "latitude": 25.2650,
        "longitude": 51.5250,
        "report_text": "Power grid failure across Musheireb district. Complete blackout affecting hospital, school, and 500 residential units. Backup generators at hospital running on 4 hours of fuel. Diabetic patients need refrigerated insulin supply.",
    },
    {
        "latitude": 25.3100,
        "longitude": 51.5380,
        "report_text": "Gas pipeline rupture near Lusail construction site. Active gas leak with ignition risk. 200-meter exclusion zone established. 3 construction crews (45 workers) being evacuated. Wind carrying gas toward metro station.",
    },
]


async def seed_demo_data(use_model: bool = True):
    """Seed the database with demo scenarios."""
    print("=" * 50)
    print("  AEGIS-GEMMA Demo Data Seeder")
    print("=" * 50)

    await init_db()

    if use_model:
        print("\nLoading Gemma model for AI analysis...")
        model_ok = load_model()
        if model_ok:
            print("[OK] Model loaded — will use real AI analysis")
        else:
            print("[WARN] Model not available — using keyword fallback")
    else:
        print("[SKIP] Model skipped (using keyword fallback)")

    print(f"\nSeeding {len(DEMO_SCENARIOS)} crisis scenarios...\n")

    for i, scenario in enumerate(DEMO_SCENARIOS, 1):
        print(f"  [{i}/{len(DEMO_SCENARIOS)}] {scenario['report_text'][:70]}...")

        # Create the report
        report = await create_report(
            latitude=scenario["latitude"],
            longitude=scenario["longitude"],
            report_text=scenario["report_text"],
        )

        # Analyze — call the sync function directly (not the async wrapper)
        if is_model_loaded():
            analysis = _run_inference_sync(
                report_text=scenario["report_text"],
                latitude=scenario["latitude"],
                longitude=scenario["longitude"],
            )
        else:
            analysis = _fallback_analysis(scenario["report_text"])

        # Update with analysis
        await update_report_analysis(report["id"], analysis)

        severity = analysis.get("severity", "unknown")
        priority = analysis.get("priority", 0)
        time_ms = analysis.get("inference_time_ms", 0)
        print(f"         -> {severity.upper()} (P{priority}) [{time_ms}ms]")

    print(f"\n[DONE] Seeded {len(DEMO_SCENARIOS)} scenarios successfully.")
    print("   Open http://localhost:8080 to view the tactical map.\n")


if __name__ == "__main__":
    use_ai = "--no-model" not in sys.argv
    asyncio.run(seed_demo_data(use_model=use_ai))
