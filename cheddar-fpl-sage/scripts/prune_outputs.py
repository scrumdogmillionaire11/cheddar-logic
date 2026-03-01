"""
Prune old output run bundles according to retention rules.

Usage:
    python scripts/prune_outputs.py --keep-days 14 --keep-latest 10
"""

import argparse
import json
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_KEEP_DAYS = 14
DEFAULT_KEEP_LATEST = 10


def load_summary(summary_path: Path):
    if not summary_path.exists():
        return []
    try:
        return json.loads(summary_path.read_text())
    except Exception:
        return []


def prune_outputs(base_dir: Path, keep_days: int, keep_latest: int, dry_run: bool = False):
    summary_path = base_dir / "DATA_SUMMARY.json"
    summary = load_summary(summary_path)
    if not summary:
        print("No DATA_SUMMARY.json or empty; nothing to prune.")
        return

    runs_dir = base_dir / "runs"
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=keep_days)

    # Normalize entries with parsed datetime
    normalized = []
    for entry in summary:
        try:
            generated = datetime.fromisoformat(entry.get("generated_at"))
        except Exception:
            generated = datetime.min.replace(tzinfo=timezone.utc)
        normalized.append((generated, entry))

    # Sort newest first
    normalized.sort(key=lambda x: x[0], reverse=True)

    # Always keep pinned
    keep = {entry["run_id"] for _, entry in normalized if entry.get("pinned")}

    # Keep latest N
    keep.update(entry["run_id"] for _, entry in normalized[:keep_latest])

    # Keep within cutoff
    for generated, entry in normalized:
        if generated >= cutoff:
            keep.add(entry["run_id"])

    # Determine deletions
    to_delete = []
    for _, entry in normalized:
        run_id = entry["run_id"]
        if run_id in keep:
            continue
        run_path = runs_dir / run_id
        to_delete.append(run_path)

    if not to_delete:
        print("Nothing to prune.")
        return

    for path in to_delete:
        if dry_run:
            print(f"[DRY RUN] Would delete {path}")
        else:
            if path.exists():
                shutil.rmtree(path, ignore_errors=True)
                print(f"Deleted {path}")

    if not dry_run:
        # Update summary to remove deleted runs
        remaining = [entry for _, entry in normalized if (runs_dir / entry["run_id"]).exists() or entry["run_id"] in keep]
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        summary_path.write_text(json.dumps(remaining, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Prune old output run bundles.")
    parser.add_argument("--keep-days", type=int, default=DEFAULT_KEEP_DAYS, help="Days to retain")
    parser.add_argument("--keep-latest", type=int, default=DEFAULT_KEEP_LATEST, help="Minimum number of latest runs to retain")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be deleted without deleting")
    args = parser.parse_args()

    base_dir = Path("outputs")
    prune_outputs(base_dir, args.keep_days, args.keep_latest, args.dry_run)


if __name__ == "__main__":
    main()
