#!/usr/bin/env python3
"""
Refresh the cached secondary injury feed.

Intended to be run on a schedule (e.g., every 6 hours and again within the
two hours before a deadline) so the pipeline always has a recent secondary
signal to merge with the primary FPL data.
"""

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cheddar_fpl_sage.injury.processing import persist_secondary_feed
from cheddar_fpl_sage.utils.output_manager import write_json_atomic


CACHE_DIR = Path("outputs") / "injury_cache"
SECONDARY_FEED_NAME = "secondary_feed.json"
SECONDARY_FEED_META = "secondary_feed.meta.json"


def load_stub(path: Path) -> list:
    if not path.exists():
        return []
    try:
        payload = json.loads(path.read_text())
        reports = payload.get("reports") if isinstance(payload, dict) else payload
        if isinstance(reports, dict):
            reports = [reports]
        return reports
    except Exception:
        return []


def ensure_cache_dir():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def main():
    parser = argparse.ArgumentParser(description="Refresh cached secondary injury feed.")
    parser.add_argument(
        "--source",
        type=str,
        default="config/secondary_injury_feed.json",
        help="Local stub feed to seed the secondary injury cache.",
    )
    parser.add_argument(
        "--interval-hours",
        type=int,
        default=6,
        help="Regular refresh cadence in hours.",
    )
    parser.add_argument(
        "--deadline-window-hours",
        type=int,
        default=2,
        help="Additional run window before deadline.",
    )
    args = parser.parse_args()

    ensure_cache_dir()
    source_path = Path(args.source)
    reports = load_stub(source_path)
    now = datetime.now(timezone.utc)
    payload = {
        "schema_version": "1.0.0",
        "generated_at": now.isoformat(),
        "source": "secondary_refresh",
        "reports": reports,
        "refresh_meta": {
            "interval_hours": args.interval_hours,
            "deadline_window_hours": args.deadline_window_hours,
            "triggered_at": now.isoformat(),
        },
    }

    persist_secondary_feed(payload, cache_path=CACHE_DIR / SECONDARY_FEED_NAME)
    next_run = now + timedelta(hours=args.interval_hours)
    meta = {
        "last_updated": now.isoformat(),
        "next_scheduled_run": next_run.isoformat(),
        "deadline_window_hours": args.deadline_window_hours,
        "interval_hours": args.interval_hours,
    }
    write_json_atomic(CACHE_DIR / SECONDARY_FEED_META, meta)

    print("Secondary injury feed refreshed:")
    print(f"  Reports loaded: {len(reports)}")
    print(f"  Cache path: {CACHE_DIR / SECONDARY_FEED_NAME}")
    print(f"  Meta path: {CACHE_DIR / SECONDARY_FEED_META}")
    print(f"  Next regular run: {next_run.isoformat()}")


if __name__ == "__main__":
    main()
