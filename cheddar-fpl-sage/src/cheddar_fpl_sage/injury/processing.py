"""
Injury data helpers for multi-source enrichment.
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from cheddar_fpl_sage.models.injury_report import (
    InjuryReport,
    InjurySource,
    InjuryStatus,
    resolve_injury_report,
)
from cheddar_fpl_sage.utils.output_manager import write_json_atomic

logger = logging.getLogger(__name__)


CACHE_DIR = Path("outputs") / "injury_cache"
SECONDARY_FEED_NAME = "secondary_feed.json"


def _ensure_cache_dir():
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _map_fpl_status(status_flag: Optional[str]) -> InjuryStatus:
    if not status_flag:
        return InjuryStatus.UNKNOWN
    code = status_flag.strip().lower()
    if code == "a":
        return InjuryStatus.FIT
    if code == "d":
        return InjuryStatus.DOUBT
    if code in {"i", "s", "n"}:
        return InjuryStatus.OUT
    return InjuryStatus.UNKNOWN


def _parse_manual_status(status_raw: Optional[str]) -> InjuryStatus:
    if not status_raw:
        return InjuryStatus.UNKNOWN
    normalized = str(status_raw).strip().upper()
    if normalized in InjuryStatus.__members__:
        return InjuryStatus[normalized]
    if normalized in {"OUT", "INJURED", "INJ"}:
        return InjuryStatus.OUT
    if normalized in {"DOUBT", "DOUBTFUL"}:
        return InjuryStatus.DOUBT
    if normalized in {"FIT", "AVAILABLE"}:
        return InjuryStatus.FIT
    return InjuryStatus.UNKNOWN


def build_fpl_injury_reports(elements: Iterable[Dict[str, Any]], timestamp: Optional[str] = None) -> List[InjuryReport]:
    now = timestamp or datetime.now(timezone.utc).isoformat()
    reports: List[InjuryReport] = []
    for element in elements:
        report = InjuryReport(
            player_id=element.get("id", -1),
            status=_map_fpl_status(element.get("status")),
            chance=element.get("chance_of_playing_next_round") or element.get("chance_of_playing_this_round"),
            reason=element.get("news") or element.get("news_added"),
            source=InjurySource.PRIMARY_FPL,
            asof_utc=element.get("news_added") or now,
        )
        reports.append(report)
    return reports


def _load_reports_from_payload(payload: Any) -> List[InjuryReport]:
    if payload is None:
        return []
    raw_reports = payload.get("reports") if isinstance(payload, dict) and "reports" in payload else payload
    reports: List[InjuryReport] = []
    if isinstance(raw_reports, dict):
        raw_reports = [raw_reports]
    if isinstance(raw_reports, list):
        for entry in raw_reports:
            if isinstance(entry, InjuryReport):
                reports.append(entry)
            elif isinstance(entry, dict):
                reports.append(InjuryReport.from_dict(entry))
    return reports


def _serialize_reports(payload: Any) -> List[Dict[str, Any]]:
    return [report.to_dict() for report in _load_reports_from_payload(payload)]


def load_secondary_injury_payload(cache_path: Optional[Path] = None, fallback_path: Optional[Path] = None) -> Dict[str, Any]:
    cache_file = cache_path or (CACHE_DIR / SECONDARY_FEED_NAME)
    payload: Dict[str, Any] = {"schema_version": "1.0.0", "reports": []}
    if cache_file.exists():
        try:
            payload = json.loads(cache_file.read_text())
        except Exception:
            logger.warning(f"Failed to parse secondary feed cache {cache_file}; falling back to fallback source.")
            payload = payload
    elif fallback_path and fallback_path.exists():
        try:
            payload = json.loads(fallback_path.read_text())
        except Exception:
            payload = payload
    return {
        "schema_version": payload.get("schema_version", "1.0.0"),
        "generated_at": payload.get("generated_at") or datetime.now(timezone.utc).isoformat(),
        "reports": _serialize_reports(payload),
        "source": payload.get("source", "secondary_cache"),
    }


def build_manual_injury_reports(
    overrides: Dict[str, Dict[str, Any]],
    squad: Iterable[Dict[str, Any]],
    asof: Optional[str],
) -> List[InjuryReport]:
    name_to_id = {
        player.get("name", "").lower(): player.get("player_id", -1)
        for player in squad
        if player.get("name")
    }
    timestamp = asof or datetime.now(timezone.utc).isoformat()
    reports: List[InjuryReport] = []
    for key, payload in overrides.items():
        status_flag = payload.get("status_flag") or payload.get("status")
        report = InjuryReport(
            player_id=payload.get("player_id", name_to_id.get(key.lower(), -1)),
            status=_parse_manual_status(status_flag),
            chance=payload.get("chance_of_playing_next_round") or payload.get("chance"),
            reason=payload.get("injury_note") or payload.get("reason"),
            source=InjurySource.MANUAL_CONFIRMED,
            asof_utc=payload.get("asof_utc") or timestamp,
        )
        reports.append(report)
    return reports


def resolve_injury_payloads(
    fpl_payload: Dict[str, Any],
    secondary_payload: Dict[str, Any],
    manual_reports: List[InjuryReport],
    expected_player_ids: Optional[Iterable[int]] = None,
) -> Tuple[List[Dict[str, Any]], Dict[int, List[str]]]:
    fpl_reports = _load_reports_from_payload(fpl_payload)
    secondary_reports = _load_reports_from_payload(secondary_payload)
    manual = manual_reports

    candidates: Dict[int, List[InjuryReport]] = {}
    for report in fpl_reports + secondary_reports + manual:
        candidates.setdefault(report.player_id, []).append(report)

    expected_ids = set(expected_player_ids or [])
    for player_id in expected_ids:
        if player_id not in candidates:
            candidates[player_id] = [
                InjuryReport(player_id=player_id, status=InjuryStatus.UNKNOWN, source=InjurySource.UNKNOWN)
            ]

    resolved: List[Dict[str, Any]] = []
    traces: Dict[int, List[str]] = {}
    for player_id, candidate_list in sorted(candidates.items()):
        report, trace = resolve_injury_report(candidate_list)
        resolved.append(report.to_dict())
        traces[player_id] = trace

    return resolved, traces


def build_injury_artifact_payload(
    reports: Iterable[InjuryReport],
    run_id: Optional[str] = None,
    label: str = "injury",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    payload = {
        "schema_version": "1.0.0",
        "run_id": run_id,
        "label": label,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reports": [report.to_dict() for report in reports],
    }
    if extra:
        payload.update(extra)
    return payload


def persist_secondary_feed(payload: Dict[str, Any], cache_path: Optional[Path] = None) -> None:
    _ensure_cache_dir()
    target = cache_path or (CACHE_DIR / SECONDARY_FEED_NAME)
    try:
        write_json_atomic(target, payload)
    except Exception as exc:
        logger.error("Failed to persist secondary injury feed: %s", exc)
