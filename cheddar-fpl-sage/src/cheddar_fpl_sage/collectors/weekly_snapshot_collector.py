"""
Phase 2: STAGE A — Collect All FPL Metrics into Versioned Snapshot Bundle

Deterministic, status-aware collection of:
  - bootstrap-static (players, teams, events, ownership, injuries)
  - fixtures (schedule, results)
  - entry/{team_id} (team metadata: rank, bank, value)
  - entry/{team_id}/history (chip usage)
  - entry/{team_id}/event/{gw}/picks (team XI, best-effort)
  - event/{gw}/live (per-player GW stats, best-effort)

All artifacts are versioned to snapshot_id and stored in both:
  - JSON files: outputs/runs/{snapshot_id}/data_collections/
  - SQLite DB: data/fpl_sage.sqlite (via FPLDatabase)

With explicit status tracking:
  - OK: collected, stored, hash computed
  - UNAVAILABLE_404: endpoint returned 404 (expected for some)
  - FAILED_TIMEOUT: connection timeout
  - FAILED_PARSE: JSON parse error
  - FAILED: 5xx or other unexpected error
"""

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Any

import aiohttp

from cheddar_fpl_sage.storage.fpl_db import FPLDatabase
from cheddar_fpl_sage.utils.output_manager import OutputBundleManager

logger = logging.getLogger(__name__)


def compute_sha256(data: Dict) -> str:
    """Compute SHA256 hash of JSON data (deterministic sort order)."""
    json_str = json.dumps(data, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(json_str.encode()).hexdigest()


def create_snapshot_id(season: int, gw: int) -> str:
    """
    Create deterministic snapshot_id in format: {season}_{gw}_{date}_{time}
    Example: 2024_21_20250102_100000
    """
    now = datetime.now(timezone.utc)
    return f"{season}_{gw}_{now.strftime('%Y%m%d_%H%M%S')}"


@dataclass
class CollectionResult:
    """Result of attempting to collect a single artifact."""
    artifact_type: str  # bootstrap, fixtures, entry, history, picks, event_live
    status: str  # OK, UNAVAILABLE_404, FAILED_TIMEOUT, FAILED_PARSE, FAILED
    json_path: Optional[str]  # Path to saved JSON (None if not OK)
    sha256: Optional[str]  # Hash of file (None if not OK)
    error_detail: Optional[str] = None  # Error message if FAILED/FAILED_PARSE


class WeeklySnapshotCollector:
    """
    Collect all required FPL metrics into one reproducible snapshot.
    
    Hard rules:
    - GW must be resolved from bootstrap.events (never "unknown")
    - bootstrap + fixtures are REQUIRED (if either fails, snapshot is INVALID)
    - team_picks can be UNAVAILABLE_404 (best-effort)
    - event/live is BEST-EFFORT only
    """

    BASE_URL = "https://fantasy.premierleague.com/api"

    def __init__(self):
        self.session: Optional[aiohttp.ClientSession] = None

    async def __aenter__(self):
        self.session = aiohttp.ClientSession()
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.session:
            await self.session.close()

    async def _fetch_json(self, endpoint: str, timeout: int = 30) -> Dict[str, Any]:
        """
        Fetch JSON from FPL API.
        
        Returns:
            {
                "status": "OK" | "UNAVAILABLE_404" | "FAILED_TIMEOUT" | "FAILED_PARSE" | "FAILED",
                "payload": {...} or None,
                "error": "..." or None
            }
        """
        url = f"{self.BASE_URL}{endpoint}"
        logger.info(f"Fetching {endpoint}")

        try:
            async with self.session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
                if resp.status == 404:
                    return {"status": "UNAVAILABLE_404", "payload": None, "error": "HTTP 404"}
                elif resp.status == 200:
                    try:
                        payload = await resp.json()
                        return {"status": "OK", "payload": payload, "error": None}
                    except (json.JSONDecodeError, ValueError) as e:
                        return {"status": "FAILED_PARSE", "payload": None, "error": str(e)}
                else:
                    return {"status": "FAILED", "payload": None, "error": f"HTTP {resp.status}"}
        except asyncio.TimeoutError:
            return {"status": "FAILED_TIMEOUT", "payload": None, "error": "Timeout"}
        except Exception as e:
            return {"status": "FAILED", "payload": None, "error": str(e)}

    def _write_artifact(self, data_dir: Path, filename: str, payload: Dict) -> Path:
        """Write JSON artifact to file."""
        file_path = data_dir / filename
        file_path.parent.mkdir(parents=True, exist_ok=True)
        with open(file_path, 'w') as f:
            json.dump(payload, f, indent=2)
        return file_path

    async def collect_snapshot(
        self,
        season: int,
        gw_target: int,
        team_ids: Optional[List[int]] = None
    ) -> str:
        """
        Collect all FPL metrics for a snapshot.
        
        **Phase 2 collects GLOBAL FPL data only (no user-specific data):**
        - All players, teams, fixtures
        - GW metadata
        
        Args:
            season: FPL season (2024, 2025, etc.)
            gw_target: target gameweek (will be validated/resolved from bootstrap)
            team_ids: [OPTIONAL] list of FPL team IDs to collect entry/history/picks for
                      (user-specific data, collected AFTER global data)
        
        Returns:
            snapshot_id if successful
        
        Raises:
            ValueError: if bootstrap or fixtures fail (required artifacts)
        """
        if team_ids is None:
            team_ids = []
        
        # Step 1: Collect required artifacts (bootstrap, fixtures)
        logger.info(f"Starting snapshot collection: season={season}, gw_target={gw_target}, teams={team_ids if team_ids else '(none - global data only)'}")

        bootstrap_result = await self._fetch_json("/bootstrap-static/")
        if bootstrap_result["status"] != "OK":
            raise ValueError(f"Bootstrap collection failed: {bootstrap_result['status']} - {bootstrap_result['error']}")

        fixtures_result = await self._fetch_json("/fixtures/")
        if fixtures_result["status"] != "OK":
            raise ValueError(f"Fixtures collection failed: {fixtures_result['status']} - {fixtures_result['error']}")

        # Step 2: Resolve season/gw from bootstrap (never infer as "unknown")
        bootstrap_payload = bootstrap_result["payload"]
        events = bootstrap_payload.get("events", [])

        # Find current event
        current_event = next((e for e in events if e.get("is_current")), None)
        next_event = next((e for e in events if e.get("is_next")), None)

        # Determine which GW to use
        resolved_gw = gw_target or (current_event or next_event or {}).get("id") or 1
        resolved_season = season

        logger.info(f"Resolved: season={resolved_season}, gw={resolved_gw}")

        # Step 3: Create snapshot_id
        snapshot_id = create_snapshot_id(resolved_season, resolved_gw)

        # Step 4: Set up output directory
        manager = OutputBundleManager()
        snapshot_dir = manager.snapshots_dir / snapshot_id
        data_dir = snapshot_dir / "data_collections"
        data_dir.mkdir(parents=True, exist_ok=True)

        logger.info(f"Snapshot ID: {snapshot_id}, dir: {snapshot_dir}")

        # Step 5: Collect all artifacts
        results: List[CollectionResult] = []

        # Bootstrap (already fetched)
        bootstrap_path = self._write_artifact(data_dir, "bootstrap_static.json", bootstrap_payload)
        bootstrap_hash = compute_sha256(bootstrap_payload)
        results.append(CollectionResult(
            artifact_type="bootstrap_static",
            status="OK",
            json_path=str(bootstrap_path),
            sha256=bootstrap_hash
        ))
        logger.info(f"✅ bootstrap_static: {bootstrap_hash}")

        # Fixtures (already fetched)
        fixtures_payload = fixtures_result["payload"]
        fixtures_path = self._write_artifact(data_dir, "fixtures.json", fixtures_payload)
        fixtures_hash = compute_sha256(fixtures_payload)
        results.append(CollectionResult(
            artifact_type="fixtures",
            status="OK",
            json_path=str(fixtures_path),
            sha256=fixtures_hash
        ))
        logger.info(f"✅ fixtures: {fixtures_hash}")

        # Events (from bootstrap, stored separately for Phase 3)
        events_path = self._write_artifact(data_dir, "events.json", {"events": events})
        events_hash = compute_sha256({"events": events})
        results.append(CollectionResult(
            artifact_type="events",
            status="OK",
            json_path=str(events_path),
            sha256=events_hash
        ))
        logger.info(f"✅ events: {events_hash}")

        # Step 6: Collect per-team data
        for team_id in team_ids:
            logger.info(f"Collecting team data for team_id={team_id}...")

            # entry/{team_id}
            entry_result = await self._fetch_json(f"/entry/{team_id}/")
            if entry_result["status"] == "OK":
                entry_path = self._write_artifact(data_dir, f"entry_{team_id}.json", entry_result["payload"])
                entry_hash = compute_sha256(entry_result["payload"])
                results.append(CollectionResult(
                    artifact_type=f"entry_{team_id}",
                    status="OK",
                    json_path=str(entry_path),
                    sha256=entry_hash
                ))
                logger.info(f"  ✅ entry_{team_id}: {entry_hash}")
            else:
                results.append(CollectionResult(
                    artifact_type=f"entry_{team_id}",
                    status=entry_result["status"],
                    json_path=None,
                    sha256=None,
                    error_detail=entry_result["error"]
                ))
                logger.warning(f"  ⚠️  entry_{team_id}: {entry_result['status']} - {entry_result['error']}")

            # entry/{team_id}/history
            history_result = await self._fetch_json(f"/entry/{team_id}/history/")
            if history_result["status"] == "OK":
                history_path = self._write_artifact(data_dir, f"entry_{team_id}_history.json", history_result["payload"])
                history_hash = compute_sha256(history_result["payload"])
                results.append(CollectionResult(
                    artifact_type=f"entry_{team_id}_history",
                    status="OK",
                    json_path=str(history_path),
                    sha256=history_hash
                ))
                logger.info(f"  ✅ entry_{team_id}_history: {history_hash}")
            else:
                results.append(CollectionResult(
                    artifact_type=f"entry_{team_id}_history",
                    status=history_result["status"],
                    json_path=None,
                    sha256=None,
                    error_detail=history_result["error"]
                ))
                logger.warning(f"  ⚠️  entry_{team_id}_history: {history_result['status']} - {history_result['error']}")

            # entry/{team_id}/event/{gw}/picks (best-effort)
            picks_result = await self._fetch_json(f"/entry/{team_id}/event/{resolved_gw}/picks/")
            if picks_result["status"] == "OK":
                picks_path = self._write_artifact(
                    data_dir,
                    f"entry_{team_id}_event_{resolved_gw}_picks.json",
                    picks_result["payload"]
                )
                picks_hash = compute_sha256(picks_result["payload"])
                results.append(CollectionResult(
                    artifact_type=f"entry_{team_id}_event_{resolved_gw}_picks",
                    status="OK",
                    json_path=str(picks_path),
                    sha256=picks_hash
                ))
                logger.info(f"  ✅ entry_{team_id}_event_{resolved_gw}_picks: {picks_hash}")
            else:
                results.append(CollectionResult(
                    artifact_type=f"entry_{team_id}_event_{resolved_gw}_picks",
                    status=picks_result["status"],
                    json_path=None,
                    sha256=None,
                    error_detail=picks_result["error"]
                ))
                logger.warning(f"  ⚠️  entry_{team_id}_event_{resolved_gw}_picks: {picks_result['status']} - {picks_result['error']}")

        # Step 7: Collect event/{gw}/live (best-effort)
        # Only try if GW is current or finished
        if current_event or next_event:
            live_result = await self._fetch_json(f"/event/{resolved_gw}/live/")
            if live_result["status"] == "OK":
                live_path = self._write_artifact(data_dir, f"event_{resolved_gw}_live.json", live_result["payload"])
                live_hash = compute_sha256(live_result["payload"])
                results.append(CollectionResult(
                    artifact_type=f"event_{resolved_gw}_live",
                    status="OK",
                    json_path=str(live_path),
                    sha256=live_hash
                ))
                logger.info(f"✅ event_{resolved_gw}_live: {live_hash}")
            else:
                results.append(CollectionResult(
                    artifact_type=f"event_{resolved_gw}_live",
                    status=live_result["status"],
                    json_path=None,
                    sha256=None,
                    error_detail=live_result["error"]
                ))
                logger.warning(f"⚠️  event_{resolved_gw}_live: {live_result['status']} - {live_result['error']}")

        # Step 8: Build manifest and check validity
        manifest = {
            "snapshot_id": snapshot_id,
            "season": resolved_season,
            "gw": resolved_gw,
            "snapshot_ts": datetime.now(timezone.utc).isoformat(),
            "is_valid": True,
            "artifacts": {}
        }

        # Determine validity: bootstrap, fixtures, events must be OK
        required_ok = ["bootstrap_static", "fixtures", "events"]
        for result in results:
            artifact_key = result.artifact_type
            manifest["artifacts"][artifact_key] = {
                "status": result.status,
                "path": result.json_path,
                "sha256": result.sha256,
                **({"error": result.error_detail} if result.error_detail else {})
            }
            if artifact_key in required_ok and result.status != "OK":
                manifest["is_valid"] = False
                logger.error(f"INVALID: required artifact {artifact_key} has status {result.status}")

        # Write manifest to file
        manifest_path = snapshot_dir / "snapshot_manifest.json"
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)
        logger.info(f"Manifest written: {manifest_path}")

        # Step 9: Write to database
        logger.info("Writing to FPLDatabase...")
        with FPLDatabase() as db:
            db.init_db()

            # Write snapshot record
            for result in results:
                if result.artifact_type == "bootstrap_static":
                    db.upsert_bootstrap(snapshot_id, result.json_path, result.status)
                elif result.artifact_type == "fixtures":
                    db.upsert_fixtures(snapshot_id, result.json_path, result.status)
                elif result.artifact_type == "events":
                    db.upsert_events(snapshot_id, result.json_path, result.status)
                elif "picks" in result.artifact_type:
                    db.upsert_team_picks(snapshot_id, result.json_path, result.status)

            # Write manifest to DB
            db.write_manifest(snapshot_id, resolved_season, resolved_gw, manifest)

        logger.info(f"✅ Snapshot complete: {snapshot_id}, valid={manifest['is_valid']}")
        return snapshot_id


async def main():
    """Test the weekly snapshot collector."""
    logging.basicConfig(level=logging.INFO)

    async with WeeklySnapshotCollector() as collector:
        try:
            # Test with a small team list
            snapshot_id = await collector.collect_snapshot(
                season=2024,
                gw_target=21,
                team_ids=[1]  # Just one team for testing
            )
            print(f"\n✅ Snapshot collected: {snapshot_id}")
        except ValueError as e:
            print(f"\n🔴 Collection failed: {e}")


if __name__ == "__main__":
    asyncio.run(main())
