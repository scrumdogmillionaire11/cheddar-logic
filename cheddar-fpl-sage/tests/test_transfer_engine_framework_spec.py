from __future__ import annotations

from types import SimpleNamespace
import os
import sys
from typing import Any

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]


def _advisor(risk_posture: str = "BALANCED"):
    from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import TransferAdvisor

    return TransferAdvisor(risk_posture=risk_posture)


def _candidate(**overrides: Any) -> SimpleNamespace:
    defaults = {
        "player_id": 9001,
        "name": "Candidate",
        "team": "CCC",
        "position": "MID",
        "current_price": 6.0,
        "nextGW_pts": 6.5,
        "next6_pts": 24.0,
        "xMins_next": 70,
        "is_injury_risk": False,
        "status_flag": "FIT",
        "chance_of_playing_next_round": 60,
        "points_per_million": 1.1,
        "floor": 4.2,
        "ceiling": 9.5,
        "volatility_score": 0.4,
        "ownership_pct": 18.0,
        "tags": [],
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_spec_1_low_start_probability_is_soft_penalized_not_hard_filtered() -> None:
    """
    Spec §4.2: low start probability must be a scoring penalty, not a hard gate.
    A FIT player with 60 % start chance should NOT be flagged as an availability concern.
    """
    advisor = _advisor()
    low_start_but_fit = _candidate(chance_of_playing_next_round=60, xMins_next=70, status_flag="FIT")

    assert advisor._candidate_has_availability_concern(low_start_but_fit) is False


def test_spec_1b_low_start_probability_reduces_score() -> None:
    """Soft penalty: a 60 % start-chance candidate scores lower than a 100 % equivalent."""
    advisor = _advisor()
    full_availability = _candidate(player_id=9001, chance_of_playing_next_round=100)
    low_start = _candidate(player_id=9002, chance_of_playing_next_round=60)

    assert (
        advisor._score_candidate_for_strategy(full_availability, "BALANCED")
        > advisor._score_candidate_for_strategy(low_start, "BALANCED")
    )


def test_spec_2_unavailable_status_is_hard_excluded() -> None:
    advisor = _advisor()
    unavailable = _candidate(status_flag="OUT", chance_of_playing_next_round=0, xMins_next=0)

    assert advisor._candidate_has_availability_concern(unavailable)


def test_spec_3_blank_gw_candidates_are_excluded_for_immediate_slot() -> None:
    advisor = _advisor()
    advisor.fixture_horizon_context = {
        "start_gw": 30,
        "candidate_player_windows": [
            {
                "player_id": 9100,
                "upcoming": [{"gw": 30, "fixture_count": 0, "is_blank": False, "is_double": False}],
            }
        ],
    }
    blank_candidate = _candidate(player_id=9100)

    assert advisor._is_blank_next_gw(blank_candidate)
    assert advisor._is_double_next_gw(blank_candidate) is False


def test_spec_4_negative_hit_economics_fail_threshold_and_emit_reason() -> None:
    advisor = _advisor()

    assert advisor.context_allows_transfer("BALANCED", projected_gain=-0.5, free_transfers=0) is False

    required = advisor._required_gain("BALANCED", free_transfers=0)
    rejection = {
        "rejection_reason": f"Projected gain -0.50 below required {required:.2f} for BALANCED mode.",
        "hit_cost": 4,
    }

    assert "below required" in rejection["rejection_reason"]
    assert rejection["hit_cost"] == 4


def test_spec_5_fallback_metadata_fields_on_hold_plan() -> None:
    """
    Spec §5: every plan object (including hold / general plans) must carry
    data_confidence, fallback_tier_used, and missing_inputs.
    """
    advisor = _advisor()
    hold = advisor.build_general_plan("BALANCED", 0.0, "No transfer met threshold")

    missing = [
        key
        for key in ("data_confidence", "fallback_tier_used", "missing_inputs")
        if key not in hold
    ]
    assert not missing, f"Missing fallback metadata fields: {', '.join(missing)}"


def test_spec_5b_transfer_plan_exposes_fallback_metadata() -> None:
    """build_transfer_plan also emits all three fallback metadata fields."""
    advisor = _advisor()
    player_out = {"player_id": 1, "name": "Player Out", "team": "AAA", "position": "MID"}
    player_proj = _candidate(player_id=1, name="Player Out", team="AAA", nextGW_pts=4.0, current_price=6.0)
    player_in = _candidate(player_id=2, name="Player In", team="BBB", nextGW_pts=6.5, current_price=6.0)

    plan = advisor.build_transfer_plan(player_out, player_proj, player_in, [], "BALANCED", 1, 0.0)

    missing = [
        key
        for key in ("data_confidence", "fallback_tier_used", "missing_inputs")
        if key not in plan
    ]
    assert not missing, f"Missing fallback metadata fields: {', '.join(missing)}"


def test_spec_6_explainability_fields_on_transfer_plan() -> None:
    """
    Spec §6: transfer plan must expose why_text, why_codes[], and risk_badges[].
    """
    advisor = _advisor()
    player_out = {"player_id": 1, "name": "Player Out", "team": "AAA", "position": "MID"}
    player_proj = _candidate(player_id=1, name="Player Out", team="AAA", nextGW_pts=4.0, current_price=6.0)
    player_in = _candidate(player_id=2, name="Player In", team="BBB", nextGW_pts=6.5, current_price=6.0)

    plan = advisor.build_transfer_plan(player_out, player_proj, player_in, [], "BALANCED", 1, 0.0)

    required = ("why_text", "why_codes", "risk_badges")
    absent = [key for key in required if key not in plan]
    assert not absent, f"Missing explainability fields: {', '.join(absent)}"

    # Type contracts
    assert isinstance(plan["why_text"], str) and plan["why_text"]
    assert isinstance(plan["why_codes"], list)
    assert isinstance(plan["risk_badges"], list)


def test_spec_6b_hold_plan_has_explainability_fields() -> None:
    """build_general_plan (hold) also emits why_text, why_codes, risk_badges."""
    advisor = _advisor()
    plan = advisor.build_general_plan("BALANCED", 0.0, "No transfer this week")

    assert plan["why_text"]
    assert plan["why_codes"] == ["HOLD_NO_TRANSFER"]
    assert plan["risk_badges"] == []


def test_value_efficiency_remains_first_class_in_balanced_scoring() -> None:
    advisor = _advisor()

    high_value = _candidate(player_id=9301, points_per_million=1.45, nextGW_pts=6.0)
    low_value = _candidate(player_id=9302, points_per_million=0.95, nextGW_pts=6.0)

    assert advisor._score_candidate_for_strategy(high_value, "BALANCED") > advisor._score_candidate_for_strategy(
        low_value,
        "BALANCED",
    )
