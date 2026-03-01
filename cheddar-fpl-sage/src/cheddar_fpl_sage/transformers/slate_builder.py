"""
Deterministic slate builder for a target gameweek.
"""

from dataclasses import dataclass
from typing import Dict, List, Any


@dataclass
class Slate:
    target_gw: int
    fixture_count: int
    fixtures: List[Dict[str, Any]]
    teams_in_gw: List[int]
    blank_teams: List[int]
    double_teams: List[int]


def build_slate(fixtures: List[Dict], teams_map: Dict[int, Dict], target_gw: int) -> Dict:
    """
    Build a canonical slate for the target gameweek.
    - Deterministic ordering: kickoff_time, then fixture_id.
    - Blank teams: no fixtures in the target GW.
    - Double teams: 2+ fixtures in the target GW.
    """
    target_fixtures = []
    for fx in fixtures or []:
        gw = fx.get("event") or fx.get("gw")
        if gw != target_gw:
            continue
        target_fixtures.append(
            {
                "fixture_id": fx.get("id") or fx.get("code"),
                "gw": gw,
                "home_team_id": fx.get("team_h") or fx.get("home_team_id"),
                "away_team_id": fx.get("team_a") or fx.get("away_team_id"),
                "kickoff_time": fx.get("kickoff_time") or fx.get("kickoff"),
            }
        )

    # Deterministic ordering
    target_fixtures = sorted(
        target_fixtures,
        key=lambda f: (f.get("kickoff_time") or "", f.get("fixture_id") or 0),
    )

    # Teams present in GW
    teams_in_gw = set()
    for fx in target_fixtures:
        if fx.get("home_team_id") is not None:
            teams_in_gw.add(fx["home_team_id"])
        if fx.get("away_team_id") is not None:
            teams_in_gw.add(fx["away_team_id"])

    all_team_ids = list(teams_map.keys())
    blank_teams = sorted([tid for tid in all_team_ids if tid not in teams_in_gw])

    # Count appearances for double GW detection
    team_counts: Dict[int, int] = {}
    for fx in target_fixtures:
        for tid in (fx.get("home_team_id"), fx.get("away_team_id")):
            if tid is None:
                continue
            team_counts[tid] = team_counts.get(tid, 0) + 1
    double_teams = sorted([tid for tid, count in team_counts.items() if count >= 2])

    slate = Slate(
        target_gw=target_gw,
        fixture_count=len(target_fixtures),
        fixtures=target_fixtures,
        teams_in_gw=sorted(teams_in_gw),
        blank_teams=blank_teams,
        double_teams=double_teams,
    )
    return slate.__dict__
