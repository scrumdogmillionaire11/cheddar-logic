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

from cheddar_fpl_sage.analysis.decision_framework.chip_analyzer import ChipAnalyzer
from cheddar_fpl_sage.models.canonical_projections import (
    CanonicalPlayerProjection,
    CanonicalProjectionSet,
)


@dataclass(frozen=True)
class ChipScenario:
    name: str
    current_gw: int
    chip_status: dict[str, Any]
    chip_policy: dict[str, Any]
    squad_data: dict[str, Any]
    fixture_data: dict[str, Any]
    projections: CanonicalProjectionSet


def _projection(player_id: int, name: str, next_gw_pts: float) -> CanonicalPlayerProjection:
    return CanonicalPlayerProjection(
        player_id=player_id,
        name=name,
        position="MID",
        team="AAA",
        current_price=8.0,
        nextGW_pts=next_gw_pts,
        next6_pts=next_gw_pts * 4,
        xMins_next=90,
        volatility_score=0.25,
        ceiling=next_gw_pts * 1.2,
        floor=next_gw_pts * 0.8,
        tags=[],
        confidence=0.85,
        ownership_pct=30.0,
        captaincy_rate=10.0,
        fixture_difficulty=2,
    )


def _projection_set(*items: CanonicalPlayerProjection) -> CanonicalProjectionSet:
    return CanonicalProjectionSet(
        projections=list(items),
        gameweek=30,
        created_timestamp="2026-03-19T00:00:00Z",
        confidence_level="high",
    )


def _squad(
    status_flag: str = "FIT",
    is_starter: bool = True,
    expected_pts: float = 12.0,
    is_double: bool = False,
) -> list[dict[str, Any]]:
    return [
        {
            "player_id": idx,
            "id": idx,
            "name": f"Player {idx}",
            "is_starter": is_starter,
            "status_flag": status_flag,
            "expected_pts": expected_pts,
            "is_double": is_double,
        }
        for idx in range(1, 12)
    ]


def _base_chip_status() -> dict[str, Any]:
    return {
        "Bench Boost": {"available": False},
        "Triple Captain": {"available": False},
        "Free Hit": {"available": False},
        "Wildcard": {"available": False},
    }


def _analyze(scenario: ChipScenario) -> Any:
    analyzer = ChipAnalyzer(risk_posture="BALANCED")
    decision = analyzer.analyze_chip_guidance(
        squad_data=scenario.squad_data,
        fixture_data=scenario.fixture_data,
        projections=scenario.projections,
        chip_status=scenario.chip_status,
        current_gw=scenario.current_gw,
        chip_policy=scenario.chip_policy,
    )

    assert decision.status in {"FIRE", "WATCH", "PASS"}, f"{scenario.name}: invalid status"
    assert isinstance(decision.reason_codes, list) and decision.reason_codes, f"{scenario.name}: missing reason_codes"
    assert isinstance(decision.narrative, str) and decision.narrative, f"{scenario.name}: missing narrative"
    return decision


@pytest.fixture
def scenarios() -> dict[str, ChipScenario]:
    wildcard_status = _base_chip_status()
    wildcard_status["Wildcard"] = {"available": True}

    tc_status = _base_chip_status()
    tc_status["Triple Captain"] = {"available": True}

    no_chip_status = _base_chip_status()

    high_projection_set = _projection_set(*[_projection(idx, f"Player {idx}", 16.0) for idx in range(1, 12)])
    low_projection_set = _projection_set(*[_projection(idx, f"Player {idx}", 2.0) for idx in range(1, 12)])

    return {
        "wildcard_watch_future_window": ChipScenario(
            name="wildcard_watch_future_window",
            current_gw=30,
            chip_status=wildcard_status,
            chip_policy={
                "total_gws": 38,
                "chip_windows": [
                    {"start_gw": 30, "score": 64},
                    {"start_gw": 33, "score": 82},
                ],
            },
            squad_data={"current_squad": _squad(status_flag="FIT", expected_pts=16.0)},
            fixture_data={"fixtures": [{"event": 30, "difficulty": 1}]},
            projections=high_projection_set,
        ),
        "wildcard_forced_fire_late_season": ChipScenario(
            name="wildcard_forced_fire_late_season",
            current_gw=37,
            chip_status=wildcard_status,
            chip_policy={"total_gws": 38, "chip_windows": [{"start_gw": 37, "score": 20}]},
            squad_data={"current_squad": _squad(status_flag="FIT", expected_pts=2.0)},
            fixture_data={"fixtures": [{"event": 37, "difficulty": 5}]},
            projections=low_projection_set,
        ),
        "triple_captain_pass_blank_captain": ChipScenario(
            name="triple_captain_pass_blank_captain",
            current_gw=31,
            chip_status=tc_status,
            chip_policy={"total_gws": 38, "chip_windows": [{"start_gw": 31, "score": 65}]},
            squad_data={"current_squad": _squad(status_flag="OUT", expected_pts=8.0, is_double=True)},
            fixture_data={"fixtures": [{"event": 31, "difficulty": 2}]},
            projections=high_projection_set,
        ),
        "pass_when_no_chips_available": ChipScenario(
            name="pass_when_no_chips_available",
            current_gw=32,
            chip_status=no_chip_status,
            chip_policy={"total_gws": 38},
            squad_data={"current_squad": _squad(status_flag="FIT", expected_pts=9.0)},
            fixture_data={"fixtures": []},
            projections=high_projection_set,
        ),
    }


def test_wildcard_watch_when_future_window_is_materially_better(scenarios: dict[str, ChipScenario]) -> None:
    decision = _analyze(scenarios["wildcard_watch_future_window"])

    assert decision.status == "WATCH"
    assert decision.watch_until == 33
    assert "better_window_imminent" in decision.reason_codes


def test_wildcard_forced_fire_near_season_end(scenarios: dict[str, ChipScenario]) -> None:
    decision = _analyze(scenarios["wildcard_forced_fire_late_season"])

    assert decision.status == "FIRE"
    assert decision.forced_by == "season_horizon_last_window"


def test_triple_captain_pass_for_blank_captain(scenarios: dict[str, ChipScenario]) -> None:
    decision = _analyze(scenarios["triple_captain_pass_blank_captain"])

    assert decision.status == "PASS"
    assert "triple_captain:blank_captain" in decision.reason_codes


def test_pass_when_no_chips_available(scenarios: dict[str, ChipScenario]) -> None:
    decision = _analyze(scenarios["pass_when_no_chips_available"])

    assert decision.status == "PASS"
    assert decision.selected_chip.name == "NONE"
    assert "chip_unavailable" in decision.reason_codes
