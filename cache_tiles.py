#!/usr/bin/env python3
"""
Aegis-Gemma: Offline Map Tile Cacher
Downloads CartoDB Dark Matter tiles for a target region and stores them
as individual PNGs in the tiles/ directory for fully offline use.

Usage:
    python3 cache_tiles.py                # Cache Doha (default)
    python3 cache_tiles.py --help         # See options
"""

import os
import sys
import time
import struct
import zlib
import sqlite3
import urllib.request
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from math import floor, log, tan, pi, cos

# ─── Configuration ───────────────────────────────────
TILE_URL = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
SUBDOMAINS = ["a", "b", "c", "d"]
USER_AGENT = "Aegis-Gemma/1.0 Offline Tile Cacher"

# Predefined regions
REGIONS = {
    "doha": {
        "name": "Doha, Qatar",
        "bounds": [25.20, 51.40, 25.45, 51.65],  # [lat_min, lon_min, lat_max, lon_max]
        "zoom_range": [10, 16],
    },
    "doha_wide": {
        "name": "Greater Doha Region",
        "bounds": [25.10, 51.30, 25.55, 51.70],
        "zoom_range": [8, 14],
    },
    "istanbul": {
        "name": "Istanbul, Turkey",
        "bounds": [40.95, 28.85, 41.15, 29.15],
        "zoom_range": [10, 15],
    },
    "tokyo": {
        "name": "Tokyo, Japan",
        "bounds": [35.60, 139.65, 35.78, 139.85],
        "zoom_range": [10, 15],
    },
}


def lat_lon_to_tile(lat, lon, zoom):
    """Convert latitude/longitude to tile coordinates at a given zoom level."""
    n = 2 ** zoom
    x = int(floor((lon + 180.0) / 360.0 * n))
    lat_rad = lat * pi / 180.0
    y = int(floor((1.0 - log(tan(lat_rad) + 1.0 / cos(lat_rad)) / pi) / 2.0 * n))
    return x, y


def get_tile_range(bounds, zoom):
    """Get the range of tile coordinates for a bounding box at a given zoom level."""
    lat_min, lon_min, lat_max, lon_max = bounds
    x_min, y_max = lat_lon_to_tile(lat_min, lon_min, zoom)
    x_max, y_min = lat_lon_to_tile(lat_max, lon_max, zoom)
    return x_min, x_max, y_min, y_max


def count_tiles(bounds, zoom_min, zoom_max):
    """Count total tiles needed for a region across zoom levels."""
    total = 0
    for z in range(zoom_min, zoom_max + 1):
        x_min, x_max, y_min, y_max = get_tile_range(bounds, z)
        total += (x_max - x_min + 1) * (y_max - y_min + 1)
    return total


def download_tile(z, x, y, output_dir):
    """Download a single tile and save it to disk."""
    subdomain = SUBDOMAINS[(x + y) % len(SUBDOMAINS)]
    url = TILE_URL.replace("{s}", subdomain).replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y))

    tile_dir = os.path.join(output_dir, str(z), str(x))
    tile_path = os.path.join(tile_dir, f"{y}.png")

    # Skip if already cached
    if os.path.exists(tile_path) and os.path.getsize(tile_path) > 100:
        return "skipped"

    try:
        os.makedirs(tile_dir, exist_ok=True)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
            with open(tile_path, "wb") as f:
                f.write(data)
        return "downloaded"
    except Exception as e:
        return f"failed: {e}"


def create_mbtiles(tiles_dir, output_path, region_name):
    """Package downloaded tiles into an MBTiles SQLite database."""
    print(f"\n📦 Packaging into MBTiles: {output_path}")

    if os.path.exists(output_path):
        os.remove(output_path)

    db = sqlite3.connect(output_path)
    db.execute("""CREATE TABLE metadata (name TEXT, value TEXT)""")
    db.execute("""CREATE TABLE tiles (
        zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB
    )""")
    db.execute("""CREATE UNIQUE INDEX idx_tiles ON tiles (zoom_level, tile_column, tile_row)""")

    # Metadata
    db.execute("INSERT INTO metadata VALUES ('name', ?)", (f"Aegis-Gemma: {region_name}",))
    db.execute("INSERT INTO metadata VALUES ('format', 'png')")
    db.execute("INSERT INTO metadata VALUES ('type', 'baselayer')")
    db.execute("INSERT INTO metadata VALUES ('version', '1.0')")
    db.execute("INSERT INTO metadata VALUES ('description', 'Offline tactical map tiles for crisis coordination')")

    tile_count = 0
    for z_dir in sorted(os.listdir(tiles_dir)):
        z_path = os.path.join(tiles_dir, z_dir)
        if not os.path.isdir(z_path) or not z_dir.isdigit():
            continue
        z = int(z_dir)
        for x_dir in sorted(os.listdir(z_path)):
            x_path = os.path.join(z_path, x_dir)
            if not os.path.isdir(x_path) or not x_dir.isdigit():
                continue
            x = int(x_dir)
            for y_file in sorted(os.listdir(x_path)):
                if not y_file.endswith(".png"):
                    continue
                y = int(y_file.replace(".png", ""))
                tile_file = os.path.join(x_path, y_file)
                with open(tile_file, "rb") as f:
                    tile_data = f.read()
                # MBTiles uses TMS y-axis (flipped)
                tms_y = (1 << z) - 1 - y
                db.execute("INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?)",
                           (z, x, tms_y, tile_data))
                tile_count += 1

    db.commit()
    db.close()

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"✅ MBTiles created: {tile_count} tiles, {size_mb:.1f} MB")
    return tile_count


def main():
    parser = argparse.ArgumentParser(description="Aegis-Gemma Offline Tile Cacher")
    parser.add_argument("--region", choices=list(REGIONS.keys()), default="doha",
                        help="Predefined region to cache (default: doha)")
    parser.add_argument("--zoom-min", type=int, help="Minimum zoom level (overrides region default)")
    parser.add_argument("--zoom-max", type=int, help="Maximum zoom level (overrides region default)")
    parser.add_argument("--threads", type=int, default=4, help="Download threads (default: 4)")
    parser.add_argument("--mbtiles", action="store_true", help="Also create MBTiles database")
    parser.add_argument("--output", default=None, help="Output directory (default: tiles/)")
    args = parser.parse_args()

    region = REGIONS[args.region]
    bounds = region["bounds"]
    zoom_min = args.zoom_min or region["zoom_range"][0]
    zoom_max = args.zoom_max or region["zoom_range"][1]
    output_dir = args.output or os.path.join(os.path.dirname(__file__), "tiles")

    total_tiles = count_tiles(bounds, zoom_min, zoom_max)

    print("═══════════════════════════════════════════")
    print("  🛡️  AEGIS-GEMMA Tile Cacher")
    print("═══════════════════════════════════════════")
    print(f"  Region:  {region['name']}")
    print(f"  Bounds:  {bounds}")
    print(f"  Zoom:    {zoom_min} → {zoom_max}")
    print(f"  Tiles:   {total_tiles}")
    print(f"  Output:  {output_dir}")
    print(f"  Threads: {args.threads}")
    print("═══════════════════════════════════════════")
    print()

    # Collect all tile coordinates
    tiles = []
    for z in range(zoom_min, zoom_max + 1):
        x_min, x_max, y_min, y_max = get_tile_range(bounds, z)
        for x in range(x_min, x_max + 1):
            for y in range(y_min, y_max + 1):
                tiles.append((z, x, y))

    # Download tiles
    downloaded = 0
    skipped = 0
    failed = 0
    start_time = time.time()

    with ThreadPoolExecutor(max_workers=args.threads) as executor:
        futures = {executor.submit(download_tile, z, x, y, output_dir): (z, x, y) for z, x, y in tiles}
        for i, future in enumerate(as_completed(futures)):
            result = future.result()
            if result == "downloaded":
                downloaded += 1
            elif result == "skipped":
                skipped += 1
            else:
                failed += 1

            # Progress
            done = i + 1
            pct = done / total_tiles * 100
            elapsed = time.time() - start_time
            rate = done / elapsed if elapsed > 0 else 0
            eta = (total_tiles - done) / rate if rate > 0 else 0
            sys.stdout.write(f"\r  [{done}/{total_tiles}] {pct:.0f}% | ↓ {downloaded} ⏭ {skipped} ✗ {failed} | {rate:.0f} tiles/s | ETA: {eta:.0f}s  ")
            sys.stdout.flush()

    elapsed_total = time.time() - start_time
    print(f"\n\n✅ Complete in {elapsed_total:.1f}s")
    print(f"   Downloaded: {downloaded}")
    print(f"   Skipped:    {skipped} (already cached)")
    print(f"   Failed:     {failed}")

    # Create MBTiles if requested
    if args.mbtiles:
        mbtiles_path = os.path.join(output_dir, "map.mbtiles")
        create_mbtiles(output_dir, mbtiles_path, region["name"])

    print(f"\n🗺️  Tiles ready for offline use at: {output_dir}")


if __name__ == "__main__":
    main()
