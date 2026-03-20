from types import SimpleNamespace
from typing import Dict, Optional
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]

from cheddar_fpl_sage.analysis.decision_framework.captain_selector import CaptainSelector
from cheddar_fpl_sage.analysis.decision_framework.constants import (
    derive_strategy_mode,
    get_transfer_threshold_base,
)
from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import TransferAdvisor
from cheddar_fpl_sage.analysis.enhanced_decision_framework import EnhancedDecisionFramework
from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration


def test_rank_bucket_recovery_mode_for_6m_rank_aggressive() -> None:
    assert derive_strategy_mode(6_448_179, "AGGRESSIVE") == "RECOVERY"


def test_defend_mode_for_top_rank_conservative() -> None:
    assert derive_strategy_mode(25_000, "CONSERVATIVE") == "DEFEND"


def test_recovery_threshold_is_lower_than_balanced() -> None:
    assert get_transfer_threshold_base("RECOVERY") < get_transfer_threshold_base("BALANCED")



def test_transfer_threshold_behavior_changes_by_strategy_mode() -> None:
    advisor = TransferAdvisor(risk_posture="AGGRESSIVE")

    # 1.0 projected gain should clear RECOVERY but fail BALANCED.
    assert advisor.context_allows_transfer("RECOVERY", projected_gain=1.0, free_transfers=1)
    assert not advisor.context_allows_transfer(
        "BALANCED", projected_gain=1.0, free_transfers=1
    )



def test_captain_scoring_shifts_from_template_to_differential() -> None:
    selector = CaptainSelector(risk_posture="BALANCED")
    template = SimpleNamespace(
        nextGW_pts=8.0,
        ownership_pct=70.0,
        floor=7.0,
        ceiling=10.0,
    )
    differential = SimpleNamespace(
        nextGW_pts=7.5,
        ownership_pct=10.0,
        floor=6.0,
        ceiling=13.0,
    )

    recovery_template = selector._score_captain_candidate(template, "RECOVERY")
    recovery_diff = selector._score_captain_candidate(differential, "RECOVERY")
    defend_template = selector._score_captain_candidate(template, "DEFEND")
    defend_diff = selector._score_captain_candidate(differential, "DEFEND")

    assert recovery_diff > recovery_template
    assert defend_template > defend_diff


def test_captain_selection_excludes_blank_and_prefers_immediate_dgw() -> None:
    selector = CaptainSelector(risk_posture="BALANCED")
    selector.strategy_mode = "BALANCED"
    selector.fixture_horizon_context = {
        "start_gw": 30,
        "player_summary_by_id": {
            501: {"near_dgw": 0, "near_bgw": 1, "next_bgw_gw": 30, "next_dgw_gw": None},
            502: {"near_dgw": 1, "near_bgw": 0, "next_bgw_gw": None, "next_dgw_gw": 30},
            503: {"near_dgw": 0, "near_bgw": 0, "next_bgw_gw": None, "next_dgw_gw": None},
        },
        "captain_candidate_windows": [
            {
                "player_id": 501,
                "upcoming": [{"gw": 30, "is_blank": True, "is_double": False, "fixture_count": 0}],
            },
            {
                "player_id": 502,
                "upcoming": [{"gw": 30, "is_blank": False, "is_double": True, "fixture_count": 2}],
            },
            {
                "player_id": 503,
                "upcoming": [{"gw": 30, "is_blank": False, "is_double": False, "fixture_count": 1}],
            },
        ],
    }

    blank_star = SimpleNamespace(
        player_id=501,
        name="Blank Star",
        team="AAA",
        position="MID",
        nextGW_pts=9.5,
        ownership_pct=55.0,
        floor=7.5,
        ceiling=11.5,
        xMins_next=90,
        is_injury_risk=False,
    )
    dgw_option = SimpleNamespace(
        player_id=502,
        name="DGW Option",
        team="BBB",
        position="MID",
        nextGW_pts=8.8,
        ownership_pct=25.0,
        floor=7.2,
        ceiling=10.8,
        xMins_next=90,
        is_injury_risk=False,
    )
    single_option = SimpleNamespace(
        player_id=503,
        name="Single Option",
        team="CCC",
        position="MID",
        nextGW_pts=9.0,
        ownership_pct=30.0,
        floor=7.3,
        ceiling=10.6,
        xMins_next=90,
        is_injury_risk=False,
    )

    class _XI:
        def get_captain_options(self):
            return [blank_star, single_option, dgw_option]

    result = selector.recommend_captaincy_from_xi(_XI(), fixture_data={}, projections=None, injury_reports=None)

    assert result["captain"]["name"] == "DGW Option"
    assert result["vice_captain"]["name"] != "Blank Star"
    pool_names = [row["name"] for row in result.get("candidate_pool", [])]
    assert "Blank Star" not in pool_names



def test_framework_derives_manager_state_with_rank_bucket() -> None:
    framework = EnhancedDecisionFramework(risk_posture="aggressive")
    manager_state = framework._derive_manager_state(
        {"team_info": {"overall_rank": 6_448_179}},
        free_transfers=2,
    )

    assert manager_state["strategy_mode"] == "RECOVERY"
    assert manager_state["rank_bucket"] == "recovery"
    assert manager_state["free_transfers"] == 2


def _integration_stub(
    *,
    config: Optional[Dict] = None,
    framework_risk_posture: str = "BALANCED",
) -> FPLSageIntegration:
    integration = FPLSageIntegration.__new__(FPLSageIntegration)
    integration.config = config or {}
    integration.config_manager = SimpleNamespace(get_risk_posture=lambda: "BALANCED")
    integration.decision_framework = SimpleNamespace(
        risk_posture=framework_risk_posture,
        _transfer_advisor=SimpleNamespace(risk_posture=framework_risk_posture),
        _captain_selector=SimpleNamespace(risk_posture=framework_risk_posture),
        _chip_analyzer=SimpleNamespace(risk_posture=framework_risk_posture),
    )
    return integration


def test_effective_context_prefers_api_overrides() -> None:
    integration = _integration_stub(
        config={
            "risk_posture": "CONSERVATIVE",
            "manual_overrides": {"free_transfers": 1},
        }
    )
    team_data = {
        "team_info": {
            "overall_rank": 6_448_179,
            "free_transfers": 0,
        }
    }

    context = integration._resolve_effective_decision_context(
        team_data,
        overrides={"risk_posture": "aggressive", "free_transfers": 2},
    )

    assert context["risk_posture"] == "AGGRESSIVE"
    assert context["free_transfers"] == 2
    assert context["free_transfers_source"] == "api_override"
    assert context["strategy_mode_hint"] == "RECOVERY"
    assert team_data["team_info"]["risk_posture"] == "AGGRESSIVE"
    assert team_data["team_info"]["free_transfers"] == 2


def test_effective_context_uses_manual_override_without_api() -> None:
    integration = _integration_stub(
        config={
            "risk_posture": "CONSERVATIVE",
            "manual_free_transfers": 3,
            "manual_overrides": {"free_transfers": 1},
        },
        framework_risk_posture="BALANCED",
    )
    team_data = {"team_info": {"overall_rank": 2_000_000, "free_transfers": 0}}

    context = integration._resolve_effective_decision_context(team_data, overrides=None)

    assert context["risk_posture"] == "BALANCED"
    assert context["free_transfers"] == 1
    assert context["free_transfers_source"] == "manual"
    assert context["strategy_mode_hint"] == "BALANCED"
    assert team_data["team_info"]["free_transfers"] == 1
