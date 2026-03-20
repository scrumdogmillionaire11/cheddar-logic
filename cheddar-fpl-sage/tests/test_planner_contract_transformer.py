import importlib
import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
for module_name in list(sys.modules):
    if module_name == "backend" or module_name.startswith("backend."):
        del sys.modules[module_name]

import backend.services.contract_transformer as contract_transformer  # noqa: E402
import backend.services.result_transformer as result_transformer  # noqa: E402


def _fixture_planner_payload():
    return {
        "horizon_gws": 8,
        "start_gw": 30,
        "gw_timeline": [
            {"gw": 30, "dgw_teams": ["AAA"], "bgw_teams": ["BBB"], "fixture_count_total": 8}
        ],
        "squad_windows": [
            {
                "player_id": 101,
                "name": "Alpha",
                "team": "AAA",
                "summary": {
                    "dgw_count": 1,
                    "bgw_count": 0,
                    "next_dgw_gw": 30,
                    "next_bgw_gw": None,
                    "weighted_fixture_score": 1.234,
                },
                "upcoming": [
                    {
                        "gw": 30,
                        "fixture_count": 2,
                        "is_blank": False,
                        "is_double": True,
                        "opponents": ["BBB", "CCC"],
                        "avg_difficulty": 2.5,
                    }
                ],
            }
        ],
        "target_windows": [],
        "key_planning_notes": ["Hold FT into GW30 DGW cluster: 3 high-value targets double."],
    }


def test_result_transformer_keeps_old_keys_and_adds_fixture_planner() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "AGGRESSIVE",
                "primary_decision": "ROLL",
                "decision_status": "HOLD",
                "reasoning": "No transfer met threshold.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.5},
                },
                "fixture_planner": _fixture_planner_payload(),
                "risk_scenarios": [],
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 1_000_000,
                    "total_points": 1234,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 30,
                "free_transfers": 1,
                "chip_status": {},
            }
        },
    }

    module = importlib.reload(result_transformer)
    transformed = module.transform_analysis_results(raw_results)

    assert transformed["team_name"] == "FPL XI"
    assert transformed["primary_decision"] == "ROLL"
    assert "available_chips" in transformed

    assert "fixture_planner" in transformed
    assert transformed["fixture_planner"]["horizon_gws"] == 8
    assert transformed["fixture_planner"]["start_gw"] == 30
    assert transformed["fixture_planner"]["gw_timeline"][0]["gw"] == 30


def test_contract_transformer_passes_fixture_planner_additively() -> None:
    results = {
        "current_gw": 30,
        "season": "2025-26",
        "transfer_recommendations": [],
        "squad_health": {"health_pct": 80},
        "fixture_planner": _fixture_planner_payload(),
    }
    job = SimpleNamespace(
        analysis_id="a1",
        team_id=123,
        status="completed",
        created_at=datetime.now(timezone.utc),
        completed_at=datetime.now(timezone.utc),
        results=results,
        error=None,
    )

    module = importlib.reload(contract_transformer)
    payload = module.build_detailed_analysis_contract(job)

    assert payload["analysis_id"] == "a1"
    assert payload["fixture_planner"]["horizon_gws"] == 8
    assert payload["fixture_planner"]["gw_timeline"][0]["dgw_teams"] == ["AAA"]
