"""
Weekly bundle collector for deterministic run artifacts.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Dict, Any

import aiohttp

from cheddar_fpl_sage.utils.output_manager import OutputBundleManager, write_json_atomic, generate_run_id
from cheddar_fpl_sage.transformers.slate_builder import build_slate
from cheddar_fpl_sage.injury.processing import (
    build_fpl_injury_reports,
    build_injury_artifact_payload,
    load_secondary_injury_payload,
)

logger = logging.getLogger(__name__)


@dataclass
class BundlePaths:
    team_id: Optional[int]
    run_id: str
    run_dir: Path
    bootstrap_static: Path
    fixtures: Path
    events: Path
    team_picks: Optional[Path]
    slate: Path
    collection_meta: Path
    entry_info: Path
    injury_fpl: Path
    injury_secondary: Path
    injury_manual: Path
    injury_resolved: Path


async def _fetch_json(session: aiohttp.ClientSession, url: str) -> Dict[str, Any]:
    async with session.get(url) as resp:
        status = resp.status
        payload = await resp.json()
    return {"status": status, "payload": payload}


def _write_with_metadata(path: Path, payload: Dict[str, Any], run_id: str, season: str, target_gw: int, source_meta: Dict) -> None:
    # Handle both dict and list payloads
    if isinstance(payload, dict):
        enriched = dict(payload)
        enriched.update({
            "schema_version": "1.0.0",
            "season": season,
            "target_gw": target_gw,
            "run_id": run_id,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": source_meta,
        })
    else:
        # For list payloads (fixtures, events, etc.), wrap in a dict
        enriched = {
            "data": payload,
            "schema_version": "1.0.0",
            "season": season,
            "target_gw": target_gw,
            "run_id": run_id,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": source_meta,
        }
    write_json_atomic(path, enriched)


async def collect_weekly_bundle(team_id: Optional[int], target_gw: Optional[int], force_refresh: bool = False, run_id: Optional[str] = None) -> BundlePaths:
    """
    Collect weekly data and write into a run bundle.
    Returns BundlePaths pointing to saved artifacts.
    """
    manager = OutputBundleManager()
    resolved_run_id = run_id or generate_run_id(target_gw)
    run_dir = manager.team_runs_dir(team_id) / resolved_run_id
    data_dir = run_dir / "data_collections"

    paths = BundlePaths(
        team_id=team_id,
        run_id=resolved_run_id,
        run_dir=run_dir,
        bootstrap_static=data_dir / "bootstrap_static.json",
        fixtures=data_dir / "fixtures.json",
        events=data_dir / "events.json",
        team_picks=(data_dir / "team_picks.json") if team_id else None,
        slate=data_dir / f"slate_gw{target_gw or 'unknown'}.json",
        collection_meta=data_dir / "collection_meta.json",
        entry_info=data_dir / "entry_info.json",
        injury_fpl=data_dir / "injury_fpl.json",
        injury_secondary=data_dir / "injury_secondary.json",
        injury_manual=data_dir / "injury_manual.json",
        injury_resolved=data_dir / "injury_resolved.json",
    )

    async def _collect():
        base_url = "https://fantasy.premierleague.com/api"
        async with aiohttp.ClientSession() as session:
            bootstrap_resp, fixtures_resp, events_resp = await asyncio.gather(
                _fetch_json(session, f"{base_url}/bootstrap-static/"),
                _fetch_json(session, f"{base_url}/fixtures/"),
                _fetch_json(session, f"{base_url}/events/"),
            )
            picks_resp = None
            team_picks_provenance = None
            team_picks_confidence = None
            entry_resp = None
            if team_id:
                gw_for_picks = target_gw
                if gw_for_picks is None:
                    # derive next GW from events
                    next_events = [e for e in events_resp["payload"] if isinstance(e, dict) and e.get("is_next")]
                    if next_events:
                        gw_for_picks = next_events[0].get("id")
                gw_for_picks = gw_for_picks or target_gw or 1
                # Try to fetch picks for the target gameweek
                picks_resp = await _fetch_json(session, f"{base_url}/entry/{team_id}/event/{gw_for_picks}/picks/")
                if picks_resp["status"] == 200:
                    team_picks_provenance = "AVAILABLE"
                    team_picks_confidence = "HIGH"
                elif picks_resp["status"] == 404 and gw_for_picks > 1:
                    current_events = [e for e in events_resp["payload"] if isinstance(e, dict) and e.get("is_current")]
                    if current_events:
                        fallback_gw = current_events[0].get("id", gw_for_picks - 1)
                        print(f"⚠️  No picks available for GW{gw_for_picks}, trying GW{fallback_gw}...")
                        fallback_resp = await _fetch_json(session, f"{base_url}/entry/{team_id}/event/{fallback_gw}/picks/")
                        if fallback_resp["status"] == 200:
                            picks_resp = fallback_resp
                            team_picks_provenance = "FALLBACK_CURRENT_GW"
                            team_picks_confidence = "MED"
                            print(f"✅ Using picks from GW{fallback_gw}")
                        else:
                            team_picks_provenance = "UNAVAILABLE_404"
                            team_picks_confidence = "LOW"
                    else:
                        team_picks_provenance = "UNAVAILABLE_404"
                        team_picks_confidence = "LOW"
                elif picks_resp["status"] >= 500 or picks_resp["status"] < 0:
                    team_picks_provenance = "FAILED"
                    team_picks_confidence = "LOW"
                else:
                    team_picks_provenance = "UNAVAILABLE_404"
                    team_picks_confidence = "LOW"
                entry_resp = await _fetch_json(session, f"{base_url}/entry/{team_id}/")
            return (
                bootstrap_resp,
                fixtures_resp,
                events_resp,
                picks_resp,
                team_picks_provenance,
                team_picks_confidence,
                entry_resp,
            )

    bootstrap_resp, fixtures_resp, events_resp, picks_resp, team_picks_provenance, team_picks_confidence, entry_resp = await _collect()

    season = ""
    events_payload = events_resp["payload"] or []
    for ev in events_payload:
        if isinstance(ev, dict) and ev.get("is_current"):
            # Try deadline_time_formatted first (legacy format)
            formatted_deadline = ev.get("deadline_time_formatted", "")
            if formatted_deadline:
                season = formatted_deadline.split(" ")[-1] or ""
            # Fallback to deadline_time ISO format if formatted not available
            elif ev.get("deadline_time"):
                # Extract season from ISO format: "2026-01-24T11:00:00Z"
                # FPL seasons run Aug-May, so:
                # - Jan-Jul deadline -> season started previous year
                # - Aug-Dec deadline -> season started current year
                try:
                    from datetime import datetime
                    deadline_iso = ev.get("deadline_time", "")
                    dt = datetime.fromisoformat(deadline_iso.replace('Z', '+00:00'))
                    year = dt.year
                    # If month < 8 (Jan-Jul), season started last year
                    if dt.month < 8:
                        season = f"{year-1}-{str(year)[-2:]}"
                    else:  # Aug-Dec, season starts this year
                        season = f"{year}-{str(year+1)[-2:]}"
                except (ValueError, AttributeError):
                    pass
            break
    if not season:
        # CRITICAL A2: Do not default to "unknown" - leave as None for validation upstream
        logger.warning("Season could not be extracted from events data")
        season = None  # Will trigger validation error upstream

    derived_target = target_gw
    if derived_target is None:
        current = next((e for e in events_payload if isinstance(e, dict) and e.get("is_current")), None)
        next_ev = next((e for e in events_payload if isinstance(e, dict) and e.get("is_next")), None)
        derived_target = (next_ev or current or {}).get("id") or 1

    # Build slate deterministically
    teams_map = {t["id"]: t for t in bootstrap_resp["payload"].get("teams", [])} if isinstance(bootstrap_resp["payload"], dict) else {}
    slate_payload = build_slate(fixtures_resp["payload"], teams_map, derived_target)
    # Ensure slate path reflects derived target
    paths.slate = data_dir / f"slate_gw{derived_target}.json"

    source_meta = {
        "endpoints": {
            "bootstrap_static": bootstrap_resp["status"],
            "fixtures": fixtures_resp["status"],
            "events": events_resp["status"],
            "team_picks": picks_resp["status"] if picks_resp else None,
            "entry": entry_resp["status"] if entry_resp else None,
        }
    }

    _write_with_metadata(paths.bootstrap_static, bootstrap_resp["payload"], resolved_run_id, season, derived_target, source_meta)
    _write_with_metadata(paths.fixtures, fixtures_resp["payload"], resolved_run_id, season, derived_target, source_meta)
    _write_with_metadata(paths.events, events_payload, resolved_run_id, season, derived_target, source_meta)
    
    # Write team picks only if we have a successful response (200 status)
    if team_id and picks_resp and picks_resp["status"] == 200:
        _write_with_metadata(paths.team_picks, picks_resp["payload"], resolved_run_id, season, derived_target, source_meta)
        print(f"✅ Team picks saved for team {team_id}")
    elif team_id and picks_resp:
        print(f"⚠️  Team picks unavailable (HTTP {picks_resp['status']}) - continuing with general analysis")
        
    _write_with_metadata(paths.slate, slate_payload, resolved_run_id, season, derived_target, source_meta)
    if entry_resp:
        _write_with_metadata(paths.entry_info, entry_resp["payload"], resolved_run_id, season, derived_target, source_meta)

    # Persist injury catalog artifacts for reproducibility
    fpl_elements = bootstrap_resp["payload"].get("elements", [])
    fpl_reports = build_fpl_injury_reports(fpl_elements)
    injury_fpl_payload = build_injury_artifact_payload(
        fpl_reports,
        run_id=resolved_run_id,
        label="primary_fpl",
    )
    write_json_atomic(paths.injury_fpl, injury_fpl_payload)

    secondary_payload = load_secondary_injury_payload(
        fallback_path=Path("config") / "secondary_injury_feed.json",
    )
    secondary_payload.update({
        "run_id": resolved_run_id,
        "label": "secondary_feed",
    })
    write_json_atomic(paths.injury_secondary, secondary_payload)

    collection_meta = {
        "schema_version": "1.0.0",
        "run_id": resolved_run_id,
        "target_gw": derived_target,
        "season": season,
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "force_refresh": force_refresh,
        "endpoints": source_meta["endpoints"],
        "team_picks_provenance": team_picks_provenance,
        "team_picks_confidence": team_picks_confidence,
    }
    write_json_atomic(paths.collection_meta, collection_meta)

    return paths
