"""
Hard data gate to ensure collections are present and fresh.
"""

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

logger = logging.getLogger(__name__)


@dataclass
class GateResult:
    status: str  # "PASS" | "HOLD"
    block_reason: Optional[str] = None
    missing: Optional[List[str]] = None


def _load_json(path: Path):
    with path.open() as f:
        data = json.load(f)
        # Handle wrapped format - if data has "data" key with list/dict, extract it
        if isinstance(data, dict) and "data" in data:
            return data["data"]
        return data


def _age_minutes(timestamp_str: str) -> float:
    try:
        ts = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
    except (ValueError, TypeError) as exc:
        logger.debug("Timestamp parse failed for '%s': %s, treating as stale", timestamp_str, exc)
        return 1e9
    delta = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
    return delta.total_seconds() / 60.0


def validate_bundle(bundle_paths, team_id: Optional[int], target_gw: int, freshness_max_minutes: int) -> GateResult:
    """Validate required artifacts exist and are fresh."""
    missing = []

    bootstrap_path = Path(bundle_paths.bootstrap_static)
    fixtures_path = Path(bundle_paths.fixtures)
    events_path = Path(bundle_paths.events)
    slate_path = Path(bundle_paths.slate)
    team_picks_path = Path(bundle_paths.team_picks) if bundle_paths.team_picks else None
    meta_path = Path(bundle_paths.collection_meta)

    if not bootstrap_path.exists():
        return GateResult(status="HOLD", block_reason="MISSING_BOOTSTRAP_STATIC", missing=["bootstrap_static.json"])
    if not fixtures_path.exists():
        return GateResult(status="HOLD", block_reason="MISSING_FIXTURES", missing=["fixtures.json"])
    if not events_path.exists():
        return GateResult(status="HOLD", block_reason="MISSING_EVENTS", missing=["events.json"])
    if not slate_path.exists():
        return GateResult(status="HOLD", block_reason="MISSING_SLATE", missing=["slate"])
    # Team picks are optional - allow analysis to proceed without them
    team_picks_missing = team_id and (team_picks_path is None or not team_picks_path.exists())
    if team_picks_missing:
        logger.warning("Team picks not available - analysis will proceed with general data only")
        return GateResult(status="HOLD", block_reason="MISSING_TEAM_PICKS", missing=["team_picks.json"])

    # Freshness check
    if not meta_path.exists():
        return GateResult(status="HOLD", block_reason="STALE_COLLECTION", missing=["collection_meta.json"])
    meta = _load_json(meta_path)
    collected_at = meta.get("collected_at")
    if collected_at is None:
        return GateResult(status="HOLD", block_reason="STALE_COLLECTION", missing=["collection_meta.json - no timestamp"])
    
    age_minutes = _age_minutes(collected_at)
    if age_minutes > freshness_max_minutes:
        age_hours = age_minutes / 60.0
        age_days = age_hours / 24.0
        age_desc = f"{age_days:.1f} days" if age_days >= 1 else f"{age_hours:.1f} hours"
        max_age_desc = f"{freshness_max_minutes / 60.0 / 24.0:.0f} days"
        return GateResult(status="HOLD", block_reason="STALE_COLLECTION", 
                         missing=[f"Data is {age_desc} old (max: {max_age_desc}) - collected: {collected_at}"])

    fixtures = _load_json(fixtures_path)
    fixtures_for_gw = [fx for fx in fixtures if (fx.get("event") or fx.get("gw")) == target_gw]
    if not fixtures_for_gw:
        return GateResult(status="HOLD", block_reason="MISSING_FIXTURES_FOR_TARGET_GW", missing=["fixtures.json"])

    slate = _load_json(slate_path)
    if slate.get("fixture_count", 0) <= 0:
        return GateResult(status="HOLD", block_reason="EMPTY_SLATE", missing=["slate"])

    events = _load_json(events_path)
    has_deadline = False
    for event in events or []:
        if not isinstance(event, dict):
            continue
        eid = event.get("id") or event.get("event")
        if eid == target_gw:
            if event.get("deadline_time") or event.get("deadline"):
                has_deadline = True
                break
    if not has_deadline:
        return GateResult(status="HOLD", block_reason="MISSING_EVENTS", missing=["events.json"])

    if team_id and team_picks_path:
        team_picks = _load_json(team_picks_path)
        picks = team_picks.get("picks") or team_picks.get("team_picks") or []
        if len(picks) < 11:
            detail = team_picks.get("detail")
            status = None
            try:
                status = _load_json(meta_path).get("endpoints", {}).get("team_picks")
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                logger.debug("Failed to load team picks status from meta: %s", exc)
                status = None
            extra = []
            if status:
                extra.append(f"status={status}")
            if detail:
                extra.append(f"detail={detail}")
            missing_note = f"team_picks.json ({'; '.join(extra)})" if extra else "team_picks.json"
            return GateResult(
                status="HOLD",
                block_reason="TEAM_PICKS_UNAVAILABLE",
                missing=[missing_note],
            )

    return GateResult(status="PASS", block_reason=None, missing=missing)
