from backend.services.risk_aware_filter import (
    filter_transfers_by_risk,
    get_risk_multipliers,
)


def test_get_risk_multipliers_profiles() -> None:
    conservative = get_risk_multipliers("CONSERVATIVE")
    balanced = get_risk_multipliers("BALANCED")
    aggressive = get_risk_multipliers("AGGRESSIVE")

    assert conservative["min_gain_multiplier"] > balanced["min_gain_multiplier"]
    assert aggressive["min_gain_multiplier"] < balanced["min_gain_multiplier"]
    assert conservative["max_recommendations"] < aggressive["max_recommendations"]


def test_filter_transfers_by_risk_applies_threshold_and_limits() -> None:
    recommendations = [
        {"action": "Transfer 1", "reason": "Gain of 3.5pts projected", "suggested": "Player A"},
        {"action": "Transfer 2", "reason": "Expected improvement: 1.2pts", "suggested": "Player B"},
        {"action": "Transfer 3", "reason": "Upgrade worth 2.8pts next GW", "suggested": "Player C"},
        {"action": "Transfer 4", "reason": "Small gain of 0.8pts", "suggested": "Player D"},
        {"action": "Transfer 5", "reason": "Projected 4.0pts vs current", "suggested": "Player E"},
    ]

    conservative = filter_transfers_by_risk(recommendations, "CONSERVATIVE", base_min_gain=1.5)
    balanced = filter_transfers_by_risk(recommendations, "BALANCED", base_min_gain=1.5)
    aggressive = filter_transfers_by_risk(recommendations, "AGGRESSIVE", base_min_gain=1.5)

    assert len(conservative) <= 2
    assert len(balanced) <= 3
    assert len(aggressive) <= 5
    assert len(conservative) <= len(balanced) <= len(aggressive)
