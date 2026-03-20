from types import SimpleNamespace
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]

from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import TransferAdvisor
from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration


def test_team_limit_aliases_cover_id_short_and_full_name() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor._team_aliases = advisor._build_team_aliases(
        [
            {"id": 1, "short_name": "ARS", "name": "Arsenal"},
            {"id": 2, "short_name": "CHE", "name": "Chelsea"},
        ]
    )

    squad = [
        {"player_id": 11, "team": "Arsenal"},
        {"player_id": 12, "team": "ARS"},
        {"player_id": 13, "team": 1},
    ]
    team_counts = advisor._build_team_counts(squad)

    is_legal = advisor._is_team_limit_legal(
        team_counts=team_counts,
        outgoing_team="CHE",
        incoming_team="Arsenal",
    )

    assert team_counts.get("ARS") == 3
    assert is_legal is False


def test_blank_detection_uses_start_window_fixture_count_zero() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor.fixture_horizon_context = {
        "start_gw": 31,
        "candidate_player_windows": [
            {
                "player_id": 7001,
                "upcoming": [{"gw": 31, "fixture_count": 0, "is_blank": False, "is_double": False}],
            }
        ],
    }
    candidate = SimpleNamespace(player_id=7001, tags=[])

    assert advisor._is_blank_next_gw(candidate)


def test_double_next_gw_false_when_blank_tag_present() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor.fixture_horizon_context = {
        "start_gw": 31,
        "candidate_player_windows": [
            {
                "player_id": 7002,
                "upcoming": [{"gw": 31, "fixture_count": 2, "is_blank": False, "is_double": True}],
            }
        ],
    }
    candidate = SimpleNamespace(player_id=7002, tags=["blank"])

    assert advisor._is_blank_next_gw(candidate)
    assert advisor._is_double_next_gw(candidate) is False


def test_candidate_availability_concern_for_doubtful_status() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    candidate = SimpleNamespace(
        player_id=7003,
        is_injury_risk=False,
        xMins_next=90,
        status_flag="DOUBT",
        chance_of_playing_next_round=75,
    )

    assert advisor._candidate_has_availability_concern(candidate)


def test_candidate_availability_concern_for_low_chance_even_without_doubt_flag() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    candidate = SimpleNamespace(
        player_id=7004,
        is_injury_risk=False,
        xMins_next=90,
        status_flag="a",
        chance_of_playing_next_round=75,
    )

    assert advisor._candidate_has_availability_concern(candidate)


def test_candidate_no_availability_concern_for_fit_high_chance_profile() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    candidate = SimpleNamespace(
        player_id=7005,
        is_injury_risk=False,
        xMins_next=90,
        status_flag="FIT",
        chance_of_playing_next_round=100,
    )

    assert advisor._candidate_has_availability_concern(candidate) is False


def test_basic_projections_tag_doubtful_player_as_injury_risk() -> None:
    integration = FPLSageIntegration(config_file="missing-test-config.json")

    projections = integration._build_basic_projections(
        raw_data={
            "players": [
                {
                    "id": 7006,
                    "web_name": "Ballard",
                    "team": 1,
                    "element_type": 2,
                    "now_cost": 45,
                    "form": "3.5",
                    "points_per_game": "3.2",
                    "chance_of_playing_next_round": 75,
                    "status": "d",
                }
            ],
            "teams": [{"id": 1, "short_name": "SUN"}],
            "fixtures": [],
        },
        current_gw=30,
    )

    projection = projections.get_by_id(7006)

    assert projection is not None
    assert projection.is_injury_risk is True
    assert "injury_risk" in projection.tags


def test_basic_projections_tag_sub_85_percent_player_as_injury_risk() -> None:
    integration = FPLSageIntegration(config_file="missing-test-config.json")

    projections = integration._build_basic_projections(
        raw_data={
            "players": [
                {
                    "id": 7007,
                    "web_name": "Risky",
                    "team": 1,
                    "element_type": 2,
                    "now_cost": 44,
                    "form": "2.1",
                    "points_per_game": "2.8",
                    "chance_of_playing_next_round": 75,
                    "status": "a",
                }
            ],
            "teams": [{"id": 1, "short_name": "SUN"}],
            "fixtures": [],
        },
        current_gw=30,
    )

    projection = projections.get_by_id(7007)

    assert projection is not None
    assert projection.is_injury_risk is True
    assert "injury_risk" in projection.tags
