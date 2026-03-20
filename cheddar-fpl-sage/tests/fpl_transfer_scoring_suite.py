from types import SimpleNamespace
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]

from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import TransferAdvisor


def _candidate(
    *,
    player_id: int,
    next_gw: float,
    ppm: float,
    floor: float,
    ceiling: float,
    volatility: float,
) -> SimpleNamespace:
    return SimpleNamespace(
        player_id=player_id,
        nextGW_pts=next_gw,
        points_per_million=ppm,
        floor=floor,
        ceiling=ceiling,
        volatility_score=volatility,
        ownership_pct=20.0,
        xMins_next=90,
        is_injury_risk=False,
    )


def test_required_gain_decreases_as_free_transfers_increase() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")

    threshold_ft1 = advisor._required_gain("BALANCED", free_transfers=1)
    threshold_ft2 = advisor._required_gain("BALANCED", free_transfers=2)
    threshold_ft3 = advisor._required_gain("BALANCED", free_transfers=3)
    threshold_ft5 = advisor._required_gain("BALANCED", free_transfers=5)

    assert threshold_ft1 > threshold_ft2 > threshold_ft3 > threshold_ft5


def test_balanced_scoring_prefers_higher_value_efficiency() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")

    high_value = _candidate(
        player_id=101,
        next_gw=6.0,
        ppm=1.45,
        floor=5.0,
        ceiling=7.4,
        volatility=0.35,
    )
    low_value = _candidate(
        player_id=102,
        next_gw=6.0,
        ppm=0.95,
        floor=5.0,
        ceiling=7.4,
        volatility=0.35,
    )

    high_value_score = advisor._score_candidate_for_strategy(high_value, "BALANCED")
    low_value_score = advisor._score_candidate_for_strategy(low_value, "BALANCED")

    assert high_value_score > low_value_score


def test_context_threshold_uses_free_transfer_adjustment() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")

    required_ft1 = advisor._required_gain("BALANCED", free_transfers=1)
    required_ft3 = advisor._required_gain("BALANCED", free_transfers=3)

    assert required_ft1 > required_ft3

    projected_gain = round((required_ft1 + required_ft3) / 2, 2)
    assert advisor.context_allows_transfer("BALANCED", projected_gain, free_transfers=3)
    assert not advisor.context_allows_transfer("BALANCED", projected_gain, free_transfers=1)
