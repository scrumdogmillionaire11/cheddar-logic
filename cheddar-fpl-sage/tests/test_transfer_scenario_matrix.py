from __future__ import annotations

from dataclasses import dataclass
import os
import sys
from typing import Any

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]

@dataclass(frozen=True)
class Scenario:
    name: str
    risk_posture: str
    strategy_mode: str
    free_transfers: int
    team_data: dict[str, Any]
    projections: Any


def _projection(
    player_id: int,
    name: str,
    position: str,
    team: str,
    current_price: float,
    next_gw_pts: float,
    tags: list[str] | None = None,
    xmins_next: float = 90.0,
) -> Any:
    from cheddar_fpl_sage.models.canonical_projections import CanonicalPlayerProjection

    return CanonicalPlayerProjection(
        player_id=player_id,
        name=name,
        position=position,
        team=team,
        current_price=current_price,
        nextGW_pts=next_gw_pts,
        next6_pts=next_gw_pts * 4,
        xMins_next=xmins_next,
        volatility_score=0.35,
        ceiling=next_gw_pts * 1.25,
        floor=next_gw_pts * 0.75,
        tags=tags or [],
        confidence=0.8,
        ownership_pct=20.0,
        captaincy_rate=5.0,
        fixture_difficulty=3,
    )


def _projection_set(*projections: Any) -> Any:
    from cheddar_fpl_sage.models.canonical_projections import CanonicalProjectionSet

    return CanonicalProjectionSet(
        projections=list(projections),
        gameweek=30,
        created_timestamp="2026-03-19T00:00:00Z",
        confidence_level="high",
    )


def _squad_player(
    player_id: int,
    name: str,
    position: str,
    team: str,
    current_price: float,
    status_flag: str = "FIT",
    is_starter: bool = True,
    chance_of_playing_next_round: int = 100,
) -> dict[str, Any]:
    return {
        "player_id": player_id,
        "id": player_id,
        "name": name,
        "position": position,
        "team": team,
        "current_price": current_price,
        "status_flag": status_flag,
        "is_starter": is_starter,
        "chance_of_playing_next_round": chance_of_playing_next_round,
        "chance_of_playing_this_round": chance_of_playing_next_round,
        "news": "",
    }


def _team_data(
    squad: list[dict[str, Any]],
    strategy_mode: str,
    bank_value: float = 1.0,
) -> dict[str, Any]:
    return {
        "current_squad": squad,
        "teams": [
            {"id": 1, "short_name": "AAA", "name": "Alpha FC"},
            {"id": 2, "short_name": "BBB", "name": "Beta FC"},
            {"id": 3, "short_name": "CCC", "name": "Gamma FC"},
            {"id": 4, "short_name": "DDD", "name": "Delta FC"},
        ],
        "manager_state": {"strategy_mode": strategy_mode},
        "team_info": {"bank_value": bank_value},
    }


def _count_team(squad: list[dict[str, Any]], team_key: str) -> int:
    return sum(1 for player in squad if str(player.get("team", "")).upper() == team_key.upper())


def _incoming_ids(recommendations: list[dict[str, Any]]) -> list[int]:
    ids: list[int] = []
    for rec in recommendations:
        transfer_in = rec.get("transfer_in") or {}
        player_id = transfer_in.get("player_id")
        if isinstance(player_id, int):
            ids.append(player_id)
    return ids


def _assert_output_contract(
    recommendations: list[dict[str, Any]],
    scenario: Scenario,
) -> None:
    incoming = _incoming_ids(recommendations)
    assert len(incoming) == len(set(incoming)), f"{scenario.name}: duplicate incoming transfer targets"

    team_by_projection = {p.player_id: p.team for p in scenario.projections.projections}
    original_squad = scenario.team_data.get("current_squad", [])

    for rec in recommendations:
        assert isinstance(rec.get("action"), str) and rec["action"], f"{scenario.name}: missing action"

        plan = rec.get("plan")
        if plan:
            assert isinstance(plan.get("transfers_in", []), list), f"{scenario.name}: transfers_in must be list"
            assert isinstance(plan.get("transfers_out", []), list), f"{scenario.name}: transfers_out must be list"

        transfer_in = rec.get("transfer_in") or {}
        incoming_id = transfer_in.get("player_id")
        if not isinstance(incoming_id, int):
            continue

        incoming_team = team_by_projection.get(incoming_id)
        assert incoming_team is not None, f"{scenario.name}: incoming player missing from projections"

        outgoing_team = None
        transfer_out = rec.get("transfer_out") or {}
        if isinstance(transfer_out, dict):
            outgoing_team = transfer_out.get("team")

        projected_count = _count_team(original_squad, incoming_team)
        if outgoing_team and str(outgoing_team).upper() == str(incoming_team).upper():
            assert projected_count <= 3, f"{scenario.name}: same-team swap exceeded team cap"
        else:
            assert projected_count < 3, f"{scenario.name}: recommendation would create >3 players from same team"


@pytest.fixture
def scenarios() -> dict[str, Scenario]:
    urgent_out_squad = [
        _squad_player(101, "Injured DEF", "DEF", "BBB", 5.0, status_flag="OUT", is_starter=True, chance_of_playing_next_round=0),
        _squad_player(102, "AAA Core 1", "MID", "AAA", 8.0),
        _squad_player(103, "AAA Core 2", "MID", "AAA", 7.5),
        _squad_player(104, "AAA Core 3", "FWD", "AAA", 9.0),
    ]
    urgent_out_projections = _projection_set(
        _projection(101, "Injured DEF", "DEF", "BBB", 5.0, 0.1, tags=["injury_risk"], xmins_next=0),
        _projection(102, "AAA Core 1", "MID", "AAA", 8.0, 6.1),
        _projection(103, "AAA Core 2", "MID", "AAA", 7.5, 5.8),
        _projection(104, "AAA Core 3", "FWD", "AAA", 9.0, 6.4),
        _projection(201, "Safe DEF", "DEF", "CCC", 5.3, 5.7),
        _projection(202, "Risky DEF", "DEF", "DDD", 5.2, 5.5, tags=["injury_risk"], xmins_next=35),
    )

    doubtful_template_squad = [
        _squad_player(301, "Doubtful MID", "MID", "BBB", 7.0, status_flag="DOUBT", chance_of_playing_next_round=75),
        _squad_player(302, "Stable DEF", "DEF", "CCC", 5.0),
        _squad_player(303, "Stable MID", "MID", "DDD", 6.5),
    ]
    doubtful_template_projections = _projection_set(
        _projection(301, "Doubtful MID", "MID", "BBB", 7.0, 4.0),
        _projection(302, "Stable DEF", "DEF", "CCC", 5.0, 4.7),
        _projection(303, "Stable MID", "MID", "DDD", 6.5, 4.9),
        _projection(401, "Marginal Upgrade", "MID", "CCC", 7.2, 5.0),
    )

    duplicate_guard_squad = [
        _squad_player(501, "Out DEF 1", "DEF", "BBB", 4.7, status_flag="OUT", chance_of_playing_next_round=0),
        _squad_player(502, "Out DEF 2", "DEF", "DDD", 4.9, status_flag="OUT", chance_of_playing_next_round=0),
        _squad_player(503, "AAA Slot 1", "MID", "AAA", 8.0),
        _squad_player(504, "AAA Slot 2", "MID", "AAA", 7.5),
        _squad_player(505, "AAA Slot 3", "FWD", "AAA", 9.2),
    ]
    duplicate_guard_projections = _projection_set(
        _projection(501, "Out DEF 1", "DEF", "BBB", 4.7, 0.2, tags=["injury_risk"], xmins_next=0),
        _projection(502, "Out DEF 2", "DEF", "DDD", 4.9, 0.3, tags=["injury_risk"], xmins_next=0),
        _projection(503, "AAA Slot 1", "MID", "AAA", 8.0, 5.7),
        _projection(504, "AAA Slot 2", "MID", "AAA", 7.5, 5.3),
        _projection(505, "AAA Slot 3", "FWD", "AAA", 9.2, 6.2),
        _projection(601, "AAA DEF Blocked", "DEF", "AAA", 5.0, 6.0),
        _projection(602, "CCC DEF Top", "DEF", "CCC", 5.0, 5.8),
        _projection(603, "DDD DEF Next", "DEF", "DDD", 4.8, 5.6),
    )

    return {
        "urgent_out_replacement": Scenario(
            name="urgent_out_replacement",
            risk_posture="BALANCED",
            strategy_mode="BALANCED",
            free_transfers=1,
            team_data=_team_data(urgent_out_squad, strategy_mode="BALANCED"),
            projections=urgent_out_projections,
        ),
        "doubtful_balanced_blocks_marginal": Scenario(
            name="doubtful_balanced_blocks_marginal",
            risk_posture="BALANCED",
            strategy_mode="BALANCED",
            free_transfers=1,
            team_data=_team_data(doubtful_template_squad, strategy_mode="BALANCED"),
            projections=doubtful_template_projections,
        ),
        "doubtful_recovery_allows_marginal": Scenario(
            name="doubtful_recovery_allows_marginal",
            risk_posture="AGGRESSIVE",
            strategy_mode="RECOVERY",
            free_transfers=1,
            team_data=_team_data(doubtful_template_squad, strategy_mode="RECOVERY"),
            projections=doubtful_template_projections,
        ),
        "team_limit_and_duplicate_guard": Scenario(
            name="team_limit_and_duplicate_guard",
            risk_posture="BALANCED",
            strategy_mode="BALANCED",
            free_transfers=2,
            team_data=_team_data(duplicate_guard_squad, strategy_mode="BALANCED"),
            projections=duplicate_guard_projections,
        ),
    }


def _run_scenario(scenario: Scenario) -> list[dict[str, Any]]:
    from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import TransferAdvisor

    advisor = TransferAdvisor(risk_posture=scenario.risk_posture)
    recommendations = advisor.recommend_transfers(
        team_data=scenario.team_data,
        free_transfers=scenario.free_transfers,
        projections=scenario.projections,
    )
    _assert_output_contract(recommendations, scenario)
    return recommendations


def test_urgent_out_scenario_generates_urgent_replacement(scenarios: dict[str, Scenario]) -> None:
    recommendations = _run_scenario(scenarios["urgent_out_replacement"])

    urgent = [rec for rec in recommendations if rec.get("priority") == "URGENT"]
    assert urgent, "Expected urgent replacement recommendation for OUT player"
    assert any("Transfer out Injured DEF" in rec.get("action", "") for rec in urgent)


def test_balanced_mode_blocks_marginal_doubtful_move(scenarios: dict[str, Scenario]) -> None:
    recommendations = _run_scenario(scenarios["doubtful_balanced_blocks_marginal"])
    assert recommendations == [], "Balanced mode should skip marginal doubtful replacement"


def test_recovery_mode_allows_same_marginal_doubtful_move(scenarios: dict[str, Scenario]) -> None:
    recommendations = _run_scenario(scenarios["doubtful_recovery_allows_marginal"])

    assert recommendations, "Recovery mode should allow marginal gain move"
    assert any(rec.get("priority") == "MONITOR" for rec in recommendations)


def test_team_limit_and_duplicate_incoming_guards_hold_across_multi_transfer_run(
    scenarios: dict[str, Scenario],
) -> None:
    recommendations = _run_scenario(scenarios["team_limit_and_duplicate_guard"])

    incoming = _incoming_ids(recommendations)
    assert len(incoming) >= 2, "Expected multiple recommendations in multi-transfer scenario"
    assert len(set(incoming)) == len(incoming), "Incoming targets must be unique"

    projection_by_id = {
        projection.player_id: projection
        for projection in scenarios["team_limit_and_duplicate_guard"].projections.projections
    }
    incoming_teams = [projection_by_id[player_id].team for player_id in incoming]
    assert "AAA" not in incoming_teams, "Team-limit guard should block 4th AAA player"
