import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]

from cheddar_fpl_sage.analysis.decision_framework.captain_selector import CaptainSelector


def test_recommend_captaincy_filters_out_out_and_doubt_starters() -> None:
    selector = CaptainSelector(risk_posture="BALANCED")
    team_data = {
        "current_squad": [
            {"name": "Healthy MID", "team": "ARS", "position": "MID", "is_starter": True, "status_flag": "AVL", "total_points": 120, "current_price": 8.0, "ownership": 30},
            {"name": "Out FWD", "team": "CHE", "position": "FWD", "is_starter": True, "status_flag": "OUT", "total_points": 160, "current_price": 9.0, "ownership": 20},
            {"name": "Doubt DEF", "team": "LIV", "position": "DEF", "is_starter": True, "status_flag": "DOUBT", "total_points": 140, "current_price": 6.0, "ownership": 15},
            {"name": "Healthy FWD", "team": "MCI", "position": "FWD", "is_starter": True, "status_flag": "AVL", "total_points": 110, "current_price": 7.5, "ownership": 12},
        ]
    }

    result = selector.recommend_captaincy(team_data, fixture_data={})

    assert result["captain"]["name"] == "Healthy MID"
    assert result["vice_captain"]["name"] == "Healthy FWD"


def test_recommend_captaincy_falls_back_to_all_starters_when_none_available() -> None:
    selector = CaptainSelector(risk_posture="BALANCED")
    team_data = {
        "current_squad": [
            {"name": "Out MID", "team": "ARS", "position": "MID", "is_starter": True, "status_flag": "OUT", "total_points": 120, "current_price": 8.0, "ownership": 30},
            {"name": "Doubt FWD", "team": "CHE", "position": "FWD", "is_starter": True, "status_flag": "DOUBT", "total_points": 115, "current_price": 7.8, "ownership": 25},
        ]
    }

    result = selector.recommend_captaincy(team_data, fixture_data={})

    assert result["captain"]["name"] == "Out MID"
    assert result["vice_captain"]["name"] == "Doubt FWD"


def test_recommend_captaincy_returns_empty_when_no_starters_exist() -> None:
    selector = CaptainSelector(risk_posture="BALANCED")
    team_data = {
        "current_squad": [
            {"name": "Bench MID", "team": "ARS", "position": "MID", "is_starter": False, "status_flag": "AVL", "total_points": 120, "current_price": 8.0, "ownership": 30},
            {"name": "Bench FWD", "team": "CHE", "position": "FWD", "is_starter": False, "status_flag": "AVL", "total_points": 115, "current_price": 7.8, "ownership": 25},
        ]
    }

    result = selector.recommend_captaincy(team_data, fixture_data={})

    assert result == {}
