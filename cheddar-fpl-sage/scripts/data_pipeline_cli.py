#!/usr/bin/env python3
"""
FPL Sage Data Pipeline CLI

Simplifies Phase 1–3 operations:
  - Initialize database
  - Collect weekly snapshots
  - Normalize snapshots to model inputs
  - Validate snapshots

Usage:
  python scripts/data_pipeline_cli.py init-db
  python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21 --teams 123456,789012
  python scripts/data_pipeline_cli.py normalize --snapshot-id 2025_21_20250102_100000
  python scripts/data_pipeline_cli.py validate --snapshot-id 2025_21_20250102_100000
  python scripts/data_pipeline_cli.py list-snapshots --season 2025-26
"""

import argparse
import asyncio
import json
import sys

from cheddar_fpl_sage.storage.fpl_db import FPLDatabase
from cheddar_fpl_sage.collectors.weekly_snapshot_collector import WeeklySnapshotCollector
from cheddar_fpl_sage.pipelines.build_weekly_inputs import WeeklyInputsNormalizer


def init_db(args):
    """Initialize the FPL database."""
    db_path = args.db_path
    print(f"📦 Initializing database: {db_path}")
    
    try:
        with FPLDatabase(db_path) as db:
            db.init_db()
        print("✅ Database initialized successfully")
        print(f"📁 Path: {db_path}")
        return True
    except Exception as e:
        print(f"❌ Database initialization failed: {e}")
        return False


async def collect_snapshot(args):
    """Collect a weekly snapshot."""
    season = args.season
    gw = args.gw
    teams = [int(t.strip()) for t in args.teams.split(",")] if args.teams.strip() else []
    
    print("🔄 Collecting snapshot...")
    print(f"   Season: {season}")
    print(f"   GW: {gw}")
    if teams:
        print(f"   Teams: {teams} (user-specific data)")
    else:
        print("   Teams: (none - global data only)")
    
    try:
        async with WeeklySnapshotCollector() as collector:
            snapshot_id = await collector.collect_snapshot(
                season=season,
                gw_target=gw,
                team_ids=teams
            )
        
        print("✅ Snapshot collected successfully")
        print(f"📷 Snapshot ID: {snapshot_id}")
        print(f"💡 Next step: python scripts/data_pipeline_cli.py normalize --snapshot-id {snapshot_id}")
        return True
    except Exception as e:
        print(f"❌ Collection failed: {e}")
        import traceback
        traceback.print_exc()
        return False


def normalize_snapshot(args):
    """Normalize a snapshot to model inputs."""
    snapshot_id = args.snapshot_id
    db_path = args.db_path
    
    print("🔄 Normalizing snapshot...")
    print(f"   Snapshot ID: {snapshot_id}")
    
    try:
        # Load artifacts from collected snapshots
        from cheddar_fpl_sage.utils.output_manager import OutputBundleManager
        
        manager = OutputBundleManager()
        snapshot_dir = manager.snapshots_dir / snapshot_id
        data_dir = snapshot_dir / "data_collections"
        
        if not data_dir.exists():
            print(f"❌ Snapshot data directory not found: {data_dir}")
            return False
        
        # Load bootstrap, fixtures, events
        bootstrap_data = None
        fixtures_data = None
        events_data = None
        
        bootstrap_file = data_dir / "bootstrap_static.json"
        if bootstrap_file.exists():
            with open(bootstrap_file) as f:
                bootstrap_data = json.load(f)
        
        fixtures_file = data_dir / "fixtures.json"
        if fixtures_file.exists():
            with open(fixtures_file) as f:
                fixtures_data = json.load(f)
        
        events_file = data_dir / "events.json"
        if events_file.exists():
            with open(events_file) as f:
                events_data = json.load(f)
        
        if not bootstrap_data:
            print(f"❌ Missing bootstrap_static.json in {data_dir}")
            return False
        
        normalizer = WeeklyInputsNormalizer(db_path)
        success, msg, manifest = normalizer.normalize_snapshot(
            snapshot_id=snapshot_id,
            bootstrap_data=bootstrap_data,
            fixtures_data=fixtures_data or {},
            events_data=events_data or {}
        )
        
        if success:
            print("✅ Normalization successful")
            print("📊 Output tables:")
            for table_name, table_info in manifest["tables"].items():
                count = table_info.get("count", "N/A")
                status = table_info.get("status", "N/A")
                print(f"   - {table_name}: {count} records [{status}]")
            return True
        else:
            print(f"❌ Normalization failed: {msg}")
            return False
    except Exception as e:
        print(f"❌ Normalization error: {e}")
        import traceback
        traceback.print_exc()
        return False


def validate_snapshot(args):
    """Validate a snapshot."""
    snapshot_id = args.snapshot_id
    db_path = args.db_path
    
    print("🔍 Validating snapshot...")
    print(f"   Snapshot ID: {snapshot_id}")
    
    try:
        with FPLDatabase(db_path) as db:
            valid, msg = db.validate_snapshot(snapshot_id)
        
        if valid:
            print("✅ Snapshot is valid")
            print(f"   {msg}")
        else:
            print("❌ Snapshot is invalid")
            print(f"   {msg}")
        
        return valid
    except Exception as e:
        print(f"❌ Validation error: {e}")
        return False


def list_snapshots(args):
    """List all snapshots, optionally filtered by season."""
    db_path = args.db_path
    season = args.season
    
    print(f"📋 Snapshots in database: {db_path}")
    if season:
        print(f"   Filter: Season {season}")
    
    try:
        with FPLDatabase(db_path) as db:
            snapshots = db.list_snapshots(season=season)
        
        if not snapshots:
            print("   (No snapshots found)")
            return True
        
        for snap in snapshots:
            snap_id = snap["snapshot_id"]
            snap_season = snap["season"]
            snap_gw = snap["gw"]
            snap_status = snap.get("validation_status", "UNKNOWN")
            print(f"   ✓ {snap_id}")
            print(f"     Season: {snap_season}, GW: {snap_gw}, Status: {snap_status}")
        
        print(f"\n📊 Total: {len(snapshots)} snapshot(s)")
        return True
    except Exception as e:
        print(f"❌ Query failed: {e}")
        return False


async def run_full_pipeline(args):
    """Run the complete pipeline: init → collect → normalize → validate."""
    season = args.season
    gw = args.gw
    teams = [int(t.strip()) for t in args.teams.split(",")] if args.teams.strip() else []
    db_path = args.db_path
    
    print("🚀 FPL Sage Full Pipeline")
    print("=" * 60)
    if teams:
        print(f"Season: {season} | GW: {gw} | Teams: {teams} (user-specific data)")
    else:
        print(f"Season: {season} | GW: {gw} | Teams: (none - global data only)")
    print("=" * 60)
    
    # Step 1: Initialize DB
    print("\n📦 Step 1: Initialize Database...")
    try:
        with FPLDatabase(db_path) as db:
            db.init_db()
        print(f"✅ Database initialized: {db_path}")
    except Exception as e:
        print(f"❌ Database initialization failed: {e}")
        return False
    
    # Step 2: Collect snapshot
    print("\n🔄 Step 2: Collecting Snapshot...")
    print(f"   Season: {season}, GW: {gw}, Teams: {teams}")
    
    try:
        async with WeeklySnapshotCollector() as collector:
            snapshot_id = await collector.collect_snapshot(
                season=season,
                gw_target=gw,
                team_ids=teams
            )
        print(f"✅ Snapshot collected: {snapshot_id}")
    except Exception as e:
        print(f"❌ Collection failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    # Step 3: Normalize snapshot
    print(f"\n🔄 Step 3: Normalizing Snapshot ({snapshot_id})...")
    
    try:
        # Load artifacts from collected snapshots
        from cheddar_fpl_sage.utils.output_manager import OutputBundleManager
        
        manager = OutputBundleManager()
        snapshot_dir = manager.snapshots_dir / snapshot_id
        data_dir = snapshot_dir / "data_collections"
        
        if not data_dir.exists():
            print(f"❌ Snapshot data directory not found: {data_dir}")
            return False
        
        # Load bootstrap, fixtures, events
        bootstrap_data = None
        fixtures_data = None
        events_data = None
        
        bootstrap_file = data_dir / "bootstrap_static.json"
        if bootstrap_file.exists():
            with open(bootstrap_file) as f:
                bootstrap_data = json.load(f)
        
        fixtures_file = data_dir / "fixtures.json"
        if fixtures_file.exists():
            with open(fixtures_file) as f:
                fixtures_data = json.load(f)
        
        events_file = data_dir / "events.json"
        if events_file.exists():
            with open(events_file) as f:
                events_data = json.load(f)
        
        if not bootstrap_data:
            print(f"❌ Missing bootstrap_static.json in {data_dir}")
            return False
        
        normalizer = WeeklyInputsNormalizer(db_path)
        success, msg, manifest = normalizer.normalize_snapshot(
            snapshot_id=snapshot_id,
            bootstrap_data=bootstrap_data,
            fixtures_data=fixtures_data or {},
            events_data=events_data or {}
        )
        
        if not success:
            print(f"❌ Normalization failed: {msg}")
            return False
        
        print("✅ Normalization successful")
        print("📊 Output tables:")
        for table_name, table_info in manifest["tables"].items():
            count = table_info.get("count", "N/A")
            status = table_info.get("status", "N/A")
            print(f"   - {table_name}: {count} records [{status}]")
    except Exception as e:
        print(f"❌ Normalization error: {e}")
        import traceback
        traceback.print_exc()
        return False
    
    # Step 4: Validate snapshot
    print(f"\n🔍 Step 4: Validating Snapshot ({snapshot_id})...")
    
    try:
        with FPLDatabase(db_path) as db:
            valid, msg = db.validate_snapshot(snapshot_id)
        
        if valid:
            print("✅ Snapshot is valid")
            print(f"   {msg}")
        else:
            print("⚠️  Snapshot validation warning")
            print(f"   {msg}")
    except Exception as e:
        print(f"❌ Validation error: {e}")
        return False
    
    # Success!
    print("\n" + "=" * 60)
    print("✅ PIPELINE COMPLETE")
    print("=" * 60)
    print(f"📷 Snapshot ID: {snapshot_id}")
    print(f"📁 Database: {db_path}")
    print("\n💡 Next steps:")
    print(f"   - Use snapshot_id '{snapshot_id}' for Phase 4 (projections)")
    print("   - List snapshots: python scripts/data_pipeline_cli.py list-snapshots")
    print(f"   - Re-normalize: python scripts/data_pipeline_cli.py normalize --snapshot-id {snapshot_id}")
    
    return True


def main():
    parser = argparse.ArgumentParser(
        description="FPL Sage Data Pipeline CLI (Phase 1–3)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Collect global FPL data only (RECOMMENDED - fastest, gets all player/team/fixture data)
  python scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 21
  
  # Full pipeline with user team picks (optional - adds entry/{team_id} data if needed)
  python scripts/data_pipeline_cli.py run-full --season 2025-26 --gw 21 --teams 123456,789012
  
  # Individual commands (for advanced users)
  python scripts/data_pipeline_cli.py init-db
  python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21
  python scripts/data_pipeline_cli.py collect --season 2025-26 --gw 21 --teams 123456,789012
  python scripts/data_pipeline_cli.py normalize --snapshot-id 2025_21_20250102_100000
  python scripts/data_pipeline_cli.py validate --snapshot-id 2025_21_20250102_100000
  python scripts/data_pipeline_cli.py list-snapshots --season 2025-26
        """
    )
    
    # Global arguments
    parser.add_argument(
        "--db-path",
        type=str,
        default="db/fpl_snapshots.sqlite",
        help="Path to FPL snapshots database (default: db/fpl_snapshots.sqlite)"
    )
    
    subparsers = parser.add_subparsers(dest="command", required=True, help="Available commands")
    
    # run-full command (recommended)
    runfull_parser = subparsers.add_parser("run-full", help="[RECOMMENDED] Full workflow: init → collect → normalize → validate")
    runfull_parser.add_argument("--season", type=str, required=True, help="Season (e.g., 2025-26)")
    runfull_parser.add_argument("--gw", type=int, required=True, help="Gameweek number (e.g., 21)")
    runfull_parser.add_argument("--teams", type=str, required=False, default="", help="[Optional] Comma-separated team IDs to collect user-specific picks for (e.g., 123456,789012)")
    runfull_parser.set_defaults(func=lambda args: asyncio.run(run_full_pipeline(args)))
    
    # init-db command
    init_parser = subparsers.add_parser("init-db", help="Initialize the FPL database")
    init_parser.set_defaults(func=lambda args: init_db(args))
    
    # collect command
    collect_parser = subparsers.add_parser("collect", help="Collect global FPL snapshot (players, teams, fixtures, GW metadata)")
    collect_parser.add_argument("--season", type=str, required=True, help="Season (e.g., 2025-26)")
    collect_parser.add_argument("--gw", type=int, required=True, help="Gameweek number (e.g., 21)")
    collect_parser.add_argument("--teams", type=str, required=False, default="", help="[Optional] Comma-separated team IDs to collect user-specific picks for (e.g., 123456,789012)")
    collect_parser.set_defaults(func=lambda args: asyncio.run(collect_snapshot(args)))
    
    # normalize command
    normalize_parser = subparsers.add_parser("normalize", help="Normalize snapshot to model inputs")
    normalize_parser.add_argument("--snapshot-id", type=str, required=True, help="Snapshot ID to normalize")
    normalize_parser.set_defaults(func=lambda args: normalize_snapshot(args))
    
    # validate command
    validate_parser = subparsers.add_parser("validate", help="Validate a snapshot")
    validate_parser.add_argument("--snapshot-id", type=str, required=True, help="Snapshot ID to validate")
    validate_parser.add_argument("--verify-hashes", action="store_true", default=True, help="Verify file hashes")
    validate_parser.set_defaults(func=lambda args: validate_snapshot(args))
    
    # list command
    list_parser = subparsers.add_parser("list-snapshots", help="List all snapshots")
    list_parser.add_argument("--season", type=str, default=None, help="Filter by season (optional)")
    list_parser.set_defaults(func=lambda args: list_snapshots(args))
    
    # Parse and execute
    args = parser.parse_args()
    success = args.func(args)
    
    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
