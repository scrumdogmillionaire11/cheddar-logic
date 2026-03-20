from cheddar_fpl_sage.analysis.enhanced_decision_framework import (
    ChipDecisionContext,
    ChipType,
    DecisionOutput,
    EnhancedDecisionFramework
)


def test_window_scoring_guardrail():
    framework = EnhancedDecisionFramework()
    guidance = ChipDecisionContext(
        current_gw=1,
        chip_type=ChipType.NONE,
        available_chips=[],
        current_window_score=0.0,
        best_future_window_score=0.0,
        window_rank=1,
        current_window_name="season",
        best_future_window_name="season"
    )
    decision = DecisionOutput(
        primary_decision="NO_CHIP_ACTION",
        reasoning="Test reasoning",
        risk_scenarios=[],
        chip_guidance=guidance
    )
    summary = framework.generate_decision_summary(decision, team_data={"team_info": {"team_name": "Test", "manager_name": "Manager"}})
    assert "0.0 vs 0.0" not in summary
    assert "Window scoring:** UNAVAILABLE" in summary
