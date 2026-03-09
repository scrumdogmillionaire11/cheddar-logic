"""
DGW/BGW fixture horizon planner contracts and deterministic builders.
"""

from __future__ import annotations

from dataclasses import dataclass
import unicodedata
from typing import Any, Dict, List, Optional, Tuple

TIME_DECAY_WEIGHTS: List[float] = [1.00, 0.92, 0.85, 0.78, 0.72, 0.66, 0.61, 0.56]


def _to_int(value: Any, default: Optional[int] = None) -> Optional[int]:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def _to_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalize_name(value: str) -> str:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    return " ".join(text.lower().split())


def _fixture_unique_key(fixture: Dict[str, Any]) -> Tuple[Any, ...]:
    fixture_id = fixture.get("id")
    if fixture_id is not None:
        return ("id", fixture_id)
    event = fixture.get("event") or fixture.get("gw")
    return (
        "fallback",
        event,
        fixture.get("team_h"),
        fixture.get("team_a"),
        fixture.get("kickoff_time"),
    )


@dataclass
class TeamGwWindow:
    team_id: int
    gw: int
    fixture_count: int
    is_blank: bool
    is_double: bool
    opponents_team_ids: List[int]
    avg_difficulty: float


@dataclass
class PlayerFixtureWindow:
    player_id: Optional[int]
    name: str
    team_id: Optional[int]
    team: str
    upcoming: List[Dict[str, Any]]
    summary: Dict[str, Any]


def _weighted_fixture_score(upcoming: List[Dict[str, Any]]) -> float:
    weighted_sum = 0.0
    weight_sum = 0.0
    for idx, row in enumerate(upcoming):
        weight = TIME_DECAY_WEIGHTS[idx] if idx < len(TIME_DECAY_WEIGHTS) else TIME_DECAY_WEIGHTS[-1]
        fixture_count = int(row.get("fixture_count") or 0)
        avg_diff = _to_float(row.get("avg_difficulty"), 3.0)
        if row.get("is_blank"):
            gw_raw = -4.0
        else:
            gw_raw = fixture_count * (3.0 - avg_diff)
            if row.get("is_double"):
                gw_raw += 1.0
        weighted_sum += gw_raw * weight
        weight_sum += weight
    if weight_sum <= 0:
        return 0.0
    return round(weighted_sum / weight_sum, 3)


def _build_player_window(
    player: Dict[str, Any],
    team_rows_by_id: Dict[int, Dict[int, Dict[str, Any]]],
    team_short_names: Dict[int, str],
    start_gw: int,
    horizon_gws: int,
) -> PlayerFixtureWindow:
    team_id = _to_int(player.get("team_id"), None)
    player_name = str(player.get("name") or "Unknown")
    team_name = str(player.get("team") or team_short_names.get(team_id or -1, "UNK"))

    upcoming: List[Dict[str, Any]] = []
    dgw_count = 0
    bgw_count = 0
    next_dgw_gw: Optional[int] = None
    next_bgw_gw: Optional[int] = None
    near_dgw = 0
    far_dgw = 0
    near_bgw = 0
    far_bgw = 0

    for offset in range(horizon_gws):
        gw = start_gw + offset
        row = (
            team_rows_by_id.get(team_id, {}).get(gw)
            if team_id is not None
            else None
        )
        if not row:
            row = {
                "gw": gw,
                "fixture_count": 0,
                "is_blank": True,
                "is_double": False,
                "opponents_team_ids": [],
                "avg_difficulty": 3.0,
            }
        is_blank = bool(row.get("is_blank"))
        is_double = bool(row.get("is_double"))
        if is_blank:
            bgw_count += 1
            if next_bgw_gw is None:
                next_bgw_gw = gw
            if offset <= 2:
                near_bgw += 1
            else:
                far_bgw += 1
        if is_double:
            dgw_count += 1
            if next_dgw_gw is None:
                next_dgw_gw = gw
            if offset <= 2:
                near_dgw += 1
            else:
                far_dgw += 1
        upcoming.append(
            {
                "gw": gw,
                "fixture_count": int(row.get("fixture_count") or 0),
                "is_blank": is_blank,
                "is_double": is_double,
                "opponents_team_ids": list(row.get("opponents_team_ids") or []),
                "avg_difficulty": float(row.get("avg_difficulty") or 3.0),
            }
        )

    summary = {
        "dgw_count": dgw_count,
        "bgw_count": bgw_count,
        "next_dgw_gw": next_dgw_gw,
        "next_bgw_gw": next_bgw_gw,
        "weighted_fixture_score": _weighted_fixture_score(upcoming),
        "near_dgw": near_dgw,
        "far_dgw": far_dgw,
        "near_bgw": near_bgw,
        "far_bgw": far_bgw,
    }

    return PlayerFixtureWindow(
        player_id=_to_int(player.get("player_id"), None),
        name=player_name,
        team_id=team_id,
        team=team_name,
        upcoming=upcoming,
        summary=summary,
    )


def _build_gw_timeline(
    start_gw: int,
    horizon_gws: int,
    team_rows_by_id: Dict[int, Dict[int, Dict[str, Any]]],
    team_short_names: Dict[int, str],
    fixture_count_by_gw: Dict[int, int],
) -> List[Dict[str, Any]]:
    timeline: List[Dict[str, Any]] = []
    for offset in range(horizon_gws):
        gw = start_gw + offset
        dgw_team_ids: List[int] = []
        bgw_team_ids: List[int] = []
        for team_id, rows in team_rows_by_id.items():
            row = rows.get(gw) or {}
            if row.get("is_double"):
                dgw_team_ids.append(team_id)
            if row.get("is_blank"):
                bgw_team_ids.append(team_id)
        dgw_team_ids.sort()
        bgw_team_ids.sort()
        timeline.append(
            {
                "gw": gw,
                "dgw_teams": [team_short_names.get(tid, str(tid)) for tid in dgw_team_ids],
                "bgw_teams": [team_short_names.get(tid, str(tid)) for tid in bgw_team_ids],
                "dgw_team_ids": dgw_team_ids,
                "bgw_team_ids": bgw_team_ids,
                "fixture_count_total": int(fixture_count_by_gw.get(gw, 0)),
            }
        )
    return timeline


def _resolve_player_ref(
    ref: Dict[str, Any],
    players_by_id: Dict[int, Dict[str, Any]],
    players_by_name_team: Dict[str, Dict[str, Any]],
    team_short_to_id: Dict[str, int],
) -> Dict[str, Any]:
    player_id = _to_int(ref.get("player_id"), None)
    if player_id is not None and player_id in players_by_id:
        return players_by_id[player_id]

    ref_name = _normalize_name(ref.get("name") or "")
    ref_team = _normalize_name(ref.get("team") or "")
    if ref_name and ref_team:
        key = f"{ref_name}|{ref_team}"
        if key in players_by_name_team:
            return players_by_name_team[key]

    if ref_name:
        candidates = [p for key, p in players_by_name_team.items() if key.startswith(f"{ref_name}|")]
        if len(candidates) == 1:
            return candidates[0]

    inferred_team_id = team_short_to_id.get(ref_team)
    return {
        "player_id": None,
        "name": str(ref.get("name") or "Unknown"),
        "team_id": inferred_team_id,
        "team": str(ref.get("team") or ""),
    }


def _dedupe_player_refs(
    refs: List[Dict[str, Any]],
    max_items: Optional[int] = None,
) -> List[Dict[str, Any]]:
    seen: set[str] = set()
    deduped: List[Dict[str, Any]] = []
    for ref in refs:
        player_id = _to_int(ref.get("player_id"), None)
        if player_id is not None:
            key = f"id:{player_id}"
        else:
            key = f"name:{_normalize_name(ref.get('name'))}|team:{_normalize_name(ref.get('team'))}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(ref)
        if max_items is not None and len(deduped) >= max_items:
            break
    return deduped


def _window_has_double_then_blank(window: Dict[str, Any]) -> Optional[int]:
    rows = window.get("upcoming") or []
    for idx in range(0, len(rows) - 1):
        if rows[idx].get("is_double") and rows[idx + 1].get("is_blank"):
            return _to_int(rows[idx].get("gw"), None)
    return None


def _generate_key_planning_notes(
    start_gw: int,
    squad_windows: List[Dict[str, Any]],
    candidate_windows: List[Dict[str, Any]],
    gw_timeline: List[Dict[str, Any]],
    captain_candidate_windows: List[Dict[str, Any]],
) -> List[str]:
    notes: List[str] = []

    # 1) Blank exposure in squad
    for timeline_row in gw_timeline:
        gw = timeline_row["gw"]
        blank_count = sum(
            1
            for window in squad_windows
            for row in (window.get("upcoming") or [])
            if row.get("gw") == gw and row.get("is_blank")
        )
        if blank_count >= 3:
            notes.append(f"Blank exposure building in GW{gw}: {blank_count} squad players blank.")
            break

    # 2) DGW cluster across tracked targets in next 2 GWs
    for gw in [start_gw, start_gw + 1]:
        dgw_targets = sum(
            1
            for window in candidate_windows
            for row in (window.get("upcoming") or [])
            if row.get("gw") == gw and row.get("is_double")
        )
        if dgw_targets >= 3:
            notes.append(f"Hold FT into GW{gw} DGW cluster: {dgw_targets} high-value targets double.")
            break

    # 3) Captaincy spike if top candidates include DGW in next 3 GWs
    spike_gw: Optional[int] = None
    for window in captain_candidate_windows[:3]:
        for row in (window.get("upcoming") or []):
            if row.get("gw", 10**9) > (start_gw + 2):
                continue
            if row.get("is_double"):
                if spike_gw is None or row.get("gw") < spike_gw:
                    spike_gw = int(row["gw"])
    if spike_gw is not None:
        notes.append(f"Captaincy upside spike around GW{spike_gw} (DGW attacker candidate).")

    # 4) Free hit pressure from league blank concentration + squad blank exposure
    for timeline_row in gw_timeline:
        gw = timeline_row["gw"]
        league_blanks = len(timeline_row.get("bgw_team_ids") or [])
        squad_blanks = sum(
            1
            for window in squad_windows
            for row in (window.get("upcoming") or [])
            if row.get("gw") == gw and row.get("is_blank")
        )
        if league_blanks >= 8 and squad_blanks >= 3:
            notes.append(f"Free Hit pressure flagged for GW{gw} due to blank concentration.")
            break

    # 5) DGW -> BGW adjacency caution
    adjacency_gw: Optional[int] = None
    for window in squad_windows + candidate_windows:
        first_gw = _window_has_double_then_blank(window)
        if first_gw is None:
            continue
        if adjacency_gw is None or first_gw < adjacency_gw:
            adjacency_gw = first_gw
    if adjacency_gw is not None:
        notes.append(
            f"DGW/BGW adjacency caution: GW{adjacency_gw} double followed by GW{adjacency_gw + 1} blank risk."
        )

    return notes


def build_fixture_horizon_context(
    fixtures: List[Dict[str, Any]],
    teams: List[Dict[str, Any]],
    players: List[Dict[str, Any]],
    start_gw: int,
    horizon_gws: int = 8,
    squad_player_refs: Optional[List[Dict[str, Any]]] = None,
    candidate_player_refs: Optional[List[Dict[str, Any]]] = None,
    captain_candidate_refs: Optional[List[Dict[str, Any]]] = None,
) -> Dict[str, Any]:
    """
    Build deterministic fixture planner context for solver/API/UI consumption.
    """
    horizon_gws = int(horizon_gws or 8)
    if horizon_gws <= 0:
        horizon_gws = 8

    team_short_names: Dict[int, str] = {}
    team_short_to_id: Dict[str, int] = {}
    team_ids: List[int] = []
    for team in teams or []:
        team_id = _to_int(team.get("id"), None)
        if team_id is None:
            continue
        short_name = str(team.get("short_name") or team.get("name") or team_id)
        team_short_names[team_id] = short_name
        team_short_to_id[_normalize_name(short_name)] = team_id
        team_ids.append(team_id)

    # Prepare player lookup tables
    players_by_id: Dict[int, Dict[str, Any]] = {}
    players_by_name_team: Dict[str, Dict[str, Any]] = {}
    for player in players or []:
        player_id = _to_int(player.get("id") or player.get("player_id"), None)
        team_id = _to_int(player.get("team"), None)
        if team_id is not None and team_id not in team_short_names:
            team_short_names[team_id] = f"Team {team_id}"
        team_name = team_short_names.get(team_id or -1, f"Team {team_id}" if team_id is not None else "UNK")
        normalized = {
            "player_id": player_id,
            "name": str(player.get("web_name") or player.get("name") or "Unknown"),
            "team_id": team_id,
            "team": team_name,
        }
        if player_id is not None:
            players_by_id[player_id] = normalized
        name_key = f"{_normalize_name(normalized['name'])}|{_normalize_name(team_name)}"
        players_by_name_team[name_key] = normalized

    # Build horizon windows per team/gw with fixture dedupe
    fixture_count_by_gw: Dict[int, int] = {start_gw + i: 0 for i in range(horizon_gws)}
    team_rows_by_id: Dict[int, Dict[int, Dict[str, Any]]] = {
        team_id: {
            (start_gw + i): {
                "team_id": team_id,
                "gw": start_gw + i,
                "fixture_count": 0,
                "is_blank": True,
                "is_double": False,
                "opponents_team_ids": [],
                "avg_difficulty": 3.0,
                "_difficulty_values": [],
            }
            for i in range(horizon_gws)
        }
        for team_id in team_ids
    }

    seen_fixture_keys: set[Tuple[Any, ...]] = set()
    for fixture in fixtures or []:
        if not isinstance(fixture, dict):
            continue
        event = _to_int(fixture.get("event") or fixture.get("gw"), None)
        if event is None or event < start_gw or event > (start_gw + horizon_gws - 1):
            continue
        uniq = _fixture_unique_key(fixture)
        if uniq in seen_fixture_keys:
            continue
        seen_fixture_keys.add(uniq)
        fixture_count_by_gw[event] = fixture_count_by_gw.get(event, 0) + 1

        home_team = _to_int(fixture.get("team_h"), None)
        away_team = _to_int(fixture.get("team_a"), None)
        home_diff = _to_float(fixture.get("team_h_difficulty"), 3.0)
        away_diff = _to_float(fixture.get("team_a_difficulty"), 3.0)

        if home_team is not None and home_team in team_rows_by_id:
            row = team_rows_by_id[home_team][event]
            row["fixture_count"] += 1
            if away_team is not None:
                row["opponents_team_ids"].append(away_team)
            row["_difficulty_values"].append(home_diff)

        if away_team is not None and away_team in team_rows_by_id:
            row = team_rows_by_id[away_team][event]
            row["fixture_count"] += 1
            if home_team is not None:
                row["opponents_team_ids"].append(home_team)
            row["_difficulty_values"].append(away_diff)

    # Finalize row fields
    for rows in team_rows_by_id.values():
        for row in rows.values():
            fixture_count = int(row["fixture_count"])
            row["is_blank"] = fixture_count == 0
            row["is_double"] = fixture_count >= 2
            diffs = row.pop("_difficulty_values", [])
            row["avg_difficulty"] = round(sum(diffs) / len(diffs), 2) if diffs else 3.0
            row["opponents_team_ids"] = sorted(set(row["opponents_team_ids"]))

    gw_timeline = _build_gw_timeline(
        start_gw=start_gw,
        horizon_gws=horizon_gws,
        team_rows_by_id=team_rows_by_id,
        team_short_names=team_short_names,
        fixture_count_by_gw=fixture_count_by_gw,
    )

    squad_player_refs = squad_player_refs or []
    candidate_player_refs = candidate_player_refs or []
    captain_candidate_refs = captain_candidate_refs or []

    # Resolve and build player windows
    resolved_squad_refs = _dedupe_player_refs(squad_player_refs)
    resolved_candidate_refs = _dedupe_player_refs(candidate_player_refs, max_items=12)
    resolved_captain_refs = _dedupe_player_refs(captain_candidate_refs)

    squad_windows: List[Dict[str, Any]] = []
    candidate_windows: List[Dict[str, Any]] = []
    captain_windows: List[Dict[str, Any]] = []
    player_summary_by_id: Dict[int, Dict[str, Any]] = {}

    def _build_windows_for_refs(refs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        windows: List[Dict[str, Any]] = []
        for ref in refs:
            resolved = _resolve_player_ref(ref, players_by_id, players_by_name_team, team_short_to_id)
            player_window = _build_player_window(
                player=resolved,
                team_rows_by_id=team_rows_by_id,
                team_short_names=team_short_names,
                start_gw=start_gw,
                horizon_gws=horizon_gws,
            )
            window_dict = {
                "player_id": player_window.player_id,
                "name": player_window.name,
                "team": player_window.team,
                "summary": {
                    "dgw_count": player_window.summary["dgw_count"],
                    "bgw_count": player_window.summary["bgw_count"],
                    "next_dgw_gw": player_window.summary["next_dgw_gw"],
                    "next_bgw_gw": player_window.summary["next_bgw_gw"],
                    "weighted_fixture_score": player_window.summary["weighted_fixture_score"],
                },
                "upcoming": [
                    {
                        "gw": row["gw"],
                        "fixture_count": row["fixture_count"],
                        "is_blank": row["is_blank"],
                        "is_double": row["is_double"],
                        "opponents_team_ids": row["opponents_team_ids"],
                        "avg_difficulty": row["avg_difficulty"],
                    }
                    for row in player_window.upcoming
                ],
            }
            windows.append(window_dict)
            if player_window.player_id is not None:
                player_summary_by_id[player_window.player_id] = {
                    **player_window.summary,
                    "team_id": player_window.team_id,
                    "team": player_window.team,
                }
        return windows

    squad_windows = _build_windows_for_refs(resolved_squad_refs)
    candidate_windows = _build_windows_for_refs(resolved_candidate_refs)
    captain_windows = _build_windows_for_refs(resolved_captain_refs)

    # Deterministic target sort
    candidate_windows.sort(
        key=lambda w: (
            w["summary"].get("next_dgw_gw") is None,
            w["summary"].get("next_dgw_gw") or 10**6,
            w["summary"].get("bgw_count", 99),
            -(w["summary"].get("weighted_fixture_score", -999.0)),
            -_to_float((w.get("summary") or {}).get("next6_pts"), 0.0),
        )
    )

    key_notes = _generate_key_planning_notes(
        start_gw=start_gw,
        squad_windows=squad_windows,
        candidate_windows=candidate_windows,
        gw_timeline=gw_timeline,
        captain_candidate_windows=captain_windows,
    )

    # Convert opponent ids to short names for API/UI surface
    def _decorate_opponents(window: Dict[str, Any]) -> Dict[str, Any]:
        for row in window.get("upcoming") or []:
            row["opponents"] = [team_short_names.get(tid, str(tid)) for tid in row.pop("opponents_team_ids", [])]
        return window

    squad_windows = [_decorate_opponents(w) for w in squad_windows]
    candidate_windows = [_decorate_opponents(w) for w in candidate_windows]

    team_gw_map = {
        str(team_id): [
            TeamGwWindow(
                team_id=team_id,
                gw=row["gw"],
                fixture_count=row["fixture_count"],
                is_blank=row["is_blank"],
                is_double=row["is_double"],
                opponents_team_ids=row["opponents_team_ids"],
                avg_difficulty=row["avg_difficulty"],
            ).__dict__
            for _, row in sorted(rows.items(), key=lambda item: item[0])
        ]
        for team_id, rows in team_rows_by_id.items()
    }

    return {
        "start_gw": start_gw,
        "horizon_gws": horizon_gws,
        "team_gw_map": team_gw_map,
        "player_summary_by_id": player_summary_by_id,
        "gw_timeline": [
            {
                "gw": row["gw"],
                "dgw_teams": row["dgw_teams"],
                "bgw_teams": row["bgw_teams"],
                "fixture_count_total": row["fixture_count_total"],
            }
            for row in gw_timeline
        ],
        "squad_player_windows": squad_windows,
        "candidate_player_windows": candidate_windows[:12],
        "captain_candidate_windows": captain_windows,
        "key_planning_notes": key_notes,
    }
