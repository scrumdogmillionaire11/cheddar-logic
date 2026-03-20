import importlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
for module_name in list(sys.modules):
    if module_name == "backend" or module_name.startswith("backend."):
        del sys.modules[module_name]

import backend.services.result_transformer as result_transformer


def _raw_results(decision: dict) -> dict:
    return {
        "analysis": {"decision": decision},
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 0,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 29,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }


def test_transformer_exposes_strategy_and_transparency_fields_additively() -> None:
    decision = {
        "risk_posture": "AGGRESSIVE",
        "strategy_mode": "RECOVERY",
        "manager_state": {
            "overall_rank": 6_448_179,
            "risk_posture": "AGGRESSIVE",
            "strategy_mode": "RECOVERY",
            "rank_bucket": "recovery",
            "free_transfers": 1,
        },
        "primary_decision": "ROLL",
        "decision_status": "HOLD",
        "reasoning": "No transfer met the RECOVERY threshold (required gain 0.90 pts with 1 FT).",
        "no_transfer_reason": "No transfer met the RECOVERY threshold (required gain 0.90 pts with 1 FT).",
        "transfer_recommendations": [],
        "captaincy": {
            "captain": {"name": "Player A", "expected_pts": 6.0},
            "vice_captain": {"name": "Player B", "expected_pts": 6.0},
        },
        "near_threshold_moves": [
            {
                "out": "Semenyo",
                "in": "Palmer",
                "hit_cost": 4,
                "delta_pts_4gw": 6.2,
                "delta_pts_6gw": 9.1,
                "threshold_required": 8.0,
                "rejection_reason": "Projected gain below threshold.",
            }
        ],
        "strategy_paths": {
            "safe": {"out": "A", "in": "B"},
            "balanced": {"out": "A", "in": "C"},
            "aggressive": {"out": "A", "in": "D"},
        },
        "squad_issues": [
            {
                "category": "lineup",
                "severity": "MEDIUM",
                "title": "Forward line weak",
                "detail": "Low 6-GW projection in current FWD starters.",
            }
        ],
        "chip_timing_outlook": {
            "bench_boost_window": "GW34-36",
            "triple_captain_window": "GW36",
            "free_hit_window": "GW34",
            "rationale": "DGW upside in window.",
        },
        "risk_scenarios": [],
    }

    module = importlib.reload(result_transformer)
    assert "cheddar-logic/cheddar-fpl-sage" in module.__file__
    transformed = module.transform_analysis_results(_raw_results(decision))

    # Existing contract keys remain available.
    assert transformed["team_name"] == "FPL XI"
    assert transformed["primary_decision"] == "ROLL"
    assert "available_chips" in transformed

    # New additive contract keys.
    assert transformed["strategy_mode"] == "RECOVERY"
    assert transformed["manager_state"]["rank_bucket"] == "recovery"
    assert isinstance(transformed["near_threshold_moves"], list)
    assert isinstance(transformed["strategy_paths"], dict)
    assert isinstance(transformed["squad_issues"], list)
    assert isinstance(transformed["chip_timing_outlook"], dict)

    # Threshold context should be preserved for no-transfer messaging.
    assert "RECOVERY threshold" in transformed["transfer_plans"]["no_transfer_reason"]

    # Captain delta should retain numeric zero (not None/blank).
    assert transformed["captain_delta"]["delta_pts"] == 0.0


def test_transformer_backfills_manager_state_from_override_context() -> None:
    decision = {
        "risk_posture": "BALANCED",
        "primary_decision": "ROLL",
        "decision_status": "HOLD",
        "reasoning": "No transfer met threshold.",
        "transfer_recommendations": [],
        "captaincy": {
            "captain": {"name": "Player A", "expected_pts": 6.0},
            "vice_captain": {"name": "Player B", "expected_pts": 6.0},
        },
        "risk_scenarios": [],
    }

    module = importlib.reload(result_transformer)
    transformed = module.transform_analysis_results(
        _raw_results(decision),
        overrides={"risk_posture": "aggressive", "free_transfers": 2},
    )

    assert transformed["risk_posture"] == "AGGRESSIVE"
    assert transformed["free_transfers"] == 2
    assert transformed["strategy_mode"] == "RECOVERY"
    assert transformed["manager_state"]["risk_posture"] == "AGGRESSIVE"
    assert transformed["manager_state"]["free_transfers"] == 2
    assert transformed["manager_state"]["rank_bucket"] == "recovery"
    assert transformed["manager_state"]["strategy_mode"] == "RECOVERY"


def test_transformer_invalid_strategy_mode_falls_back_to_rank_derivation() -> None:
    decision = {
        "risk_posture": "AGGRESSIVE",
        "strategy_mode": "UNKNOWN_MODE",
        "manager_state": {"overall_rank": 6_448_179, "strategy_mode": "bad"},
        "primary_decision": "ROLL",
        "decision_status": "HOLD",
        "reasoning": "No transfer met threshold.",
        "transfer_recommendations": [],
        "captaincy": {
            "captain": {"name": "Player A", "expected_pts": 6.0},
            "vice_captain": {"name": "Player B", "expected_pts": 6.0},
        },
        "risk_scenarios": [],
    }

    module = importlib.reload(result_transformer)
    transformed = module.transform_analysis_results(_raw_results(decision))

    assert transformed["strategy_mode"] == "RECOVERY"
    assert transformed["manager_state"]["strategy_mode"] == "RECOVERY"
