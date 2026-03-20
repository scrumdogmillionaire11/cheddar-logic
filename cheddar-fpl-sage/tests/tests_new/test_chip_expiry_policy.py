from cheddar_fpl_sage.analysis.enhanced_decision_framework import EnhancedDecisionFramework, DecisionOutput


def test_expiring_chip_forces_free_hit():
    framework = EnhancedDecisionFramework()
    chip_policy = {
        "chip_windows": [
            {"name": "first_half", "start_event": 1, "end_event": 19, "chips": ["Free Hit"]}
        ]
    }
    current_gw = 19
    assert framework.chip_expires_before_next_deadline("Free Hit", current_gw, chip_policy) is True


def test_stale_snapshot_hold_blocks_activation_but_warns():
    # Build a decision marked as stale and ensure status stays HOLD with reason retained
    decision = DecisionOutput(
        primary_decision="ACTIVATE_FREE_HIT",
        reasoning="Test",
        risk_scenarios=[],
        decision_status="HOLD",
        block_reason="STALE_SNAPSHOT",
    )
    summary = EnhancedDecisionFramework().generate_decision_summary(decision, team_data={"lineup_source": None})
    assert "HOLD" in summary
    assert "STALE_SNAPSHOT" in summary or "stale snapshot" in summary.lower()
