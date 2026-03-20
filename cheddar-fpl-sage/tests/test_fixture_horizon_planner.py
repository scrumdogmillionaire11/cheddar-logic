import os
import sys
from types import SimpleNamespace
from typing import Optional

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]

from cheddar_fpl_sage.analysis.decision_framework.fixture_horizon import (  # noqa: E402
    build_fixture_horizon_context,
)
import cheddar_fpl_sage.analysis.fpl_sage_integration as integration_module  # noqa: E402
from cheddar_fpl_sage.analysis.decision_framework.transfer_advisor import (  # noqa: E402
    TransferAdvisor,
)
from cheddar_fpl_sage.analysis.decision_framework.contract_enforcement import (  # noqa: E402
    DecisionContractEnforcer,
)
from cheddar_fpl_sage.analysis.enhanced_decision_framework import (  # noqa: E402
    DecisionOutput,
)
from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration  # noqa: E402


def _teams():
    return [
        {"id": 1, "short_name": "AAA"},
        {"id": 2, "short_name": "BBB"},
        {"id": 3, "short_name": "CCC"},
        {"id": 4, "short_name": "DDD"},
    ]


def _players():
    return [
        {"id": 101, "web_name": "Alpha", "team": 1},
        {"id": 102, "web_name": "Bravo", "team": 2},
        {"id": 103, "web_name": "Charlie", "team": 3},
        {"id": 104, "web_name": "Delta", "team": 4},
    ]


class _ProjectionSet:
    def __init__(self, projections):
        self.projections = projections
        self._by_id = {int(p.player_id): p for p in projections}
        self._by_pos = {}
        for projection in projections:
            self._by_pos.setdefault(projection.position, []).append(projection)

    def get_by_id(self, player_id):
        try:
            return self._by_id.get(int(player_id))
        except (TypeError, ValueError):
            return None

    def get_by_position(self, position):
        return list(self._by_pos.get(position, []))


def _projection(
    player_id: int,
    name: str,
    team: str,
    position: str,
    next_gw: float,
    price: float,
    next6: Optional[float] = None,
    minutes: int = 90,
    injury_risk: bool = False,
):
    next6_pts = next6 if next6 is not None else next_gw * 6
    return SimpleNamespace(
        player_id=player_id,
        name=name,
        team=team,
        position=position,
        nextGW_pts=next_gw,
        next4_pts=round(next_gw * 4, 2),
        next6_pts=next6_pts,
        current_price=price,
        xMins_next=minutes,
        is_injury_risk=injury_risk,
        ownership_pct=20.0,
        floor=max(0.0, next_gw - 1.0),
        ceiling=next_gw + 1.5,
        volatility_score=0.4,
        points_per_million=round(next6_pts / max(price, 0.1), 3),
    )


def _decision() -> DecisionOutput:
    return DecisionOutput(
        primary_decision="HOLD",
        reasoning="Hold for now.",
        risk_scenarios=[],
        risk_posture="BALANCED",
    )


def test_fixture_dedupe_and_reschedule_create_true_dgw_without_false_positives() -> None:
    fixtures = [
        # Unique fixture in GW30
        {"id": 1001, "event": 30, "team_h": 1, "team_a": 2, "team_h_difficulty": 2, "team_a_difficulty": 3},
        # Duplicate row of same fixture id must be deduped
        {"id": 1001, "event": 30, "team_h": 1, "team_a": 2, "team_h_difficulty": 2, "team_a_difficulty": 3},
        # Rescheduled additional GW30 fixture for team 1 => true DGW
        {"id": 1002, "event": 30, "team_h": 3, "team_a": 1, "team_h_difficulty": 2, "team_a_difficulty": 4},
        # Fallback-key dedupe (no id, exact duplicate rows)
        {"event": 31, "team_h": 1, "team_a": 4, "kickoff_time": "2026-03-20T19:00:00Z"},
        {"event": 31, "team_h": 1, "team_a": 4, "kickoff_time": "2026-03-20T19:00:00Z"},
    ]

    context = build_fixture_horizon_context(
        fixtures=fixtures,
        teams=_teams(),
        players=_players(),
        start_gw=30,
        horizon_gws=8,
        squad_player_refs=[{"player_id": 101, "name": "Alpha", "team": "AAA"}],
        candidate_player_refs=[],
        captain_candidate_refs=[],
    )

    team_map = context["team_gw_map"]
    team1_gw30 = [r for r in team_map["1"] if r["gw"] == 30][0]
    team2_gw30 = [r for r in team_map["2"] if r["gw"] == 30][0]
    team1_gw31 = [r for r in team_map["1"] if r["gw"] == 31][0]

    assert team1_gw30["fixture_count"] == 2
    assert team1_gw30["is_double"] is True
    assert team1_gw30["is_blank"] is False

    assert team2_gw30["fixture_count"] == 1
    assert team2_gw30["is_blank"] is False
    assert team2_gw30["is_double"] is False

    # No-id duplicate in GW31 should still count once.
    assert team1_gw31["fixture_count"] == 1


def test_weighted_score_prefers_near_dgw_over_near_blank() -> None:
    fixtures = [
        {"id": 2001, "event": 30, "team_h": 1, "team_a": 2, "team_h_difficulty": 2, "team_a_difficulty": 3},
        {"id": 2002, "event": 30, "team_h": 3, "team_a": 1, "team_h_difficulty": 2, "team_a_difficulty": 3},
        {"id": 2003, "event": 31, "team_h": 4, "team_a": 2, "team_h_difficulty": 3, "team_a_difficulty": 3},
    ]
    context = build_fixture_horizon_context(
        fixtures=fixtures,
        teams=_teams(),
        players=_players(),
        start_gw=30,
        horizon_gws=8,
        squad_player_refs=[],
        candidate_player_refs=[
            {"player_id": 101, "name": "Alpha", "team": "AAA", "next6_pts": 40},
            {"player_id": 104, "name": "Delta", "team": "DDD", "next6_pts": 40},
        ],
        captain_candidate_refs=[],
    )

    windows = context["candidate_player_windows"]
    alpha = next(w for w in windows if w["name"] == "Alpha")
    delta = next(w for w in windows if w["name"] == "Delta")

    assert alpha["summary"]["weighted_fixture_score"] > delta["summary"]["weighted_fixture_score"]


def test_start_gw_uses_next_gameweek_then_falls_back_to_current_gw() -> None:
    integration = FPLSageIntegration(team_id=1, config_file="/tmp/nonexistent-team-config.json")
    raw_data = {"fixtures": [], "teams": _teams(), "players": _players()}

    with_next = {"next_gameweek": 31, "current_squad": []}
    integration._inject_pre_analysis_fixture_horizon_context(with_next, raw_data, current_gw=29)
    assert with_next["fixture_horizon_context"]["start_gw"] == 31

    without_next = {"current_squad": []}
    integration._inject_pre_analysis_fixture_horizon_context(without_next, raw_data, current_gw=29)
    assert without_next["fixture_horizon_context"]["start_gw"] == 29


def test_dgw_bonus_is_gated_by_minutes_and_injury_risk() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor.fixture_horizon_context = {
        "player_summary_by_id": {
            101: {"near_dgw": 1, "far_dgw": 0, "near_bgw": 0, "far_bgw": 0},
        }
    }

    low_minutes = SimpleNamespace(player_id=101, xMins_next=45, is_injury_risk=False)
    fit_minutes = SimpleNamespace(player_id=101, xMins_next=85, is_injury_risk=False)
    injured = SimpleNamespace(player_id=101, xMins_next=85, is_injury_risk=True)

    assert advisor._horizon_transfer_adjustment(low_minutes) == 0.0
    assert advisor._horizon_transfer_adjustment(fit_minutes) > 0.0
    assert advisor._horizon_transfer_adjustment(injured) == 0.0


def test_transfer_scoring_prioritizes_immediate_dgw_candidates() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor.fixture_horizon_context = {
        "start_gw": 30,
        "player_summary_by_id": {
            201: {
                "near_dgw": 1,
                "far_dgw": 0,
                "near_bgw": 0,
                "far_bgw": 0,
                "next_dgw_gw": 30,
                "next_bgw_gw": None,
            },
            202: {
                "near_dgw": 0,
                "far_dgw": 0,
                "near_bgw": 0,
                "far_bgw": 0,
                "next_dgw_gw": None,
                "next_bgw_gw": None,
            },
        },
    }

    dgw_candidate = _projection(201, "DGW MID", "AAA", "MID", next_gw=6.0, price=7.0)
    single_candidate = _projection(202, "Single MID", "BBB", "MID", next_gw=6.2, price=7.0)

    dgw_score = advisor._score_candidate_for_strategy(dgw_candidate, "BALANCED")
    single_score = advisor._score_candidate_for_strategy(single_candidate, "BALANCED")

    assert dgw_score > single_score


def test_strategy_paths_skip_weakest_without_alternatives() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [
        {"player_id": 1, "name": "Weak DEF", "position": "DEF", "is_starter": True},
        {"player_id": 2, "name": "Playable MID", "position": "MID", "is_starter": True},
    ]
    projections = _ProjectionSet(
        [
            _projection(1, "Weak DEF", "AAA", "DEF", next_gw=2.0, price=5.0),
            _projection(2, "Playable MID", "BBB", "MID", next_gw=3.2, price=7.0),
            _projection(11, "Expensive DEF Alt", "CCC", "DEF", next_gw=5.5, price=8.0),
            _projection(12, "Good MID Alt", "DDD", "MID", next_gw=6.2, price=7.4),
        ]
    )

    paths, diagnostics = advisor._build_strategy_paths(
        squad=squad,
        projections=projections,
        bank_value=0.0,
        free_transfers=2,
    )

    assert diagnostics["strategy_starters_checked"] >= 2
    assert diagnostics["strategy_alternatives_considered"] >= 1
    assert diagnostics["strategy_paths_reason"] is None
    assert any(
        isinstance(path, dict) and path.get("out") and path.get("in")
        for path in paths.values()
    )


def test_near_threshold_scan_checks_beyond_first_three_starters() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [
        {"player_id": 1, "name": "DEF 1", "position": "DEF", "is_starter": True},
        {"player_id": 2, "name": "DEF 2", "position": "DEF", "is_starter": True},
        {"player_id": 3, "name": "DEF 3", "position": "DEF", "is_starter": True},
        {"player_id": 4, "name": "MID 4", "position": "MID", "is_starter": True},
    ]
    projections = _ProjectionSet(
        [
            _projection(1, "DEF 1", "AAA", "DEF", next_gw=2.0, price=5.0),
            _projection(2, "DEF 2", "BBB", "DEF", next_gw=2.1, price=5.0),
            _projection(3, "DEF 3", "CCC", "DEF", next_gw=2.2, price=5.0),
            _projection(4, "MID 4", "DDD", "MID", next_gw=4.0, price=7.0),
            _projection(41, "MID Alt", "AAA", "MID", next_gw=5.4, price=7.4),
        ]
    )

    moves, diagnostics = advisor._build_near_threshold_moves(
        squad=squad,
        projections=projections,
        bank_value=0.0,
        free_transfers=1,
        strategy_mode="BALANCED",
    )

    assert diagnostics["near_threshold_starters_checked"] == 4
    assert diagnostics["near_threshold_alternatives_considered"] >= 1
    assert len(moves) == 1
    assert moves[0]["out"] == "MID 4"
    assert moves[0]["in"] == "MID Alt"


def test_strategy_paths_prefer_distinct_in_and_out_per_mode_when_depth_exists() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [
        {"player_id": 1, "name": "DEF Base", "position": "DEF", "is_starter": True},
        {"player_id": 2, "name": "MID Base", "position": "MID", "is_starter": True},
        {"player_id": 3, "name": "FWD Base", "position": "FWD", "is_starter": True},
    ]
    projections = _ProjectionSet(
        [
            _projection(1, "DEF Base", "AAA", "DEF", next_gw=2.0, price=5.0),
            _projection(2, "MID Base", "BBB", "MID", next_gw=3.1, price=7.0),
            _projection(3, "FWD Base", "CCC", "FWD", next_gw=3.4, price=8.0),
            _projection(11, "DEF Alt A", "DDD", "DEF", next_gw=6.2, price=5.5),
            _projection(12, "DEF Alt B", "AAA", "DEF", next_gw=5.9, price=5.4),
            _projection(21, "MID Alt A", "DDD", "MID", next_gw=6.8, price=7.2),
            _projection(22, "MID Alt B", "AAA", "MID", next_gw=6.3, price=7.1),
            _projection(31, "FWD Alt A", "DDD", "FWD", next_gw=7.0, price=8.2),
            _projection(32, "FWD Alt B", "BBB", "FWD", next_gw=6.7, price=8.1),
        ]
    )

    paths, diagnostics = advisor._build_strategy_paths(
        squad=squad,
        projections=projections,
        bank_value=1.0,
        free_transfers=2,
    )

    assert diagnostics["strategy_paths_reason"] is None
    valid_paths = [path for path in paths.values() if isinstance(path, dict) and path.get("in") and path.get("out")]
    assert len(valid_paths) == 3
    out_ids = {path.get("out_player_id") for path in valid_paths}
    in_ids = {path.get("in_player_id") for path in valid_paths}
    assert len(out_ids) == 3
    assert len(in_ids) == 3


def test_near_threshold_prefers_closest_sub_threshold_candidate_not_first_ranked() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    required = advisor._required_gain("BALANCED", free_transfers=1)
    starter_next = 4.0
    starter_price = 7.0
    squad = [{"player_id": 1, "name": "MID Base", "position": "MID", "is_starter": True}]
    projections = _ProjectionSet(
        [
            _projection(1, "MID Base", "AAA", "MID", next_gw=starter_next, price=starter_price),
            # Better mode-score profile but farther from threshold.
            _projection(
                11,
                "Mode Favoured Alt",
                "BBB",
                "MID",
                next_gw=starter_next + required - 1.0,
                price=4.0,
                next6=(starter_next + required - 1.0) * 6,
            ),
            # Closer near-threshold candidate should be selected.
            _projection(
                12,
                "Closest Gap Alt",
                "CCC",
                "MID",
                next_gw=starter_next + required - 0.1,
                price=12.0,
                next6=(starter_next + required - 0.1) * 6,
            ),
        ]
    )

    moves, diagnostics = advisor._build_near_threshold_moves(
        squad=squad,
        projections=projections,
        bank_value=5.5,
        free_transfers=1,
        strategy_mode="BALANCED",
    )

    assert diagnostics["near_threshold_alternatives_considered"] >= 2
    assert len(moves) == 1
    assert moves[0]["out"] == "MID Base"
    assert moves[0]["in"] == "Closest Gap Alt"
    assert moves[0]["in_player_id"] == 12


def test_strategy_reason_is_set_when_no_valid_paths_exist() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [{"player_id": 1, "name": "Only DEF", "position": "DEF", "is_starter": True}]
    projections = _ProjectionSet(
        [
            _projection(1, "Only DEF", "AAA", "DEF", next_gw=2.0, price=5.0),
            _projection(10, "Injured DEF Alt", "BBB", "DEF", next_gw=4.0, price=5.4, injury_risk=True),
        ]
    )

    paths, diagnostics = advisor._build_strategy_paths(
        squad=squad,
        projections=projections,
        bank_value=0.0,
        free_transfers=1,
    )

    assert paths == {}
    assert diagnostics["strategy_paths_reason"] is not None


def test_strategy_paths_filter_out_candidates_that_would_create_fourth_player_from_same_team() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [
        {"player_id": 1, "name": "DEF Base", "position": "DEF", "team": "BBB", "is_starter": True},
        {"player_id": 2, "name": "MID One", "position": "MID", "team": "AAA", "is_starter": True},
        {"player_id": 3, "name": "FWD One", "position": "FWD", "team": "AAA", "is_starter": True},
        {"player_id": 4, "name": "MID Two", "position": "MID", "team": "AAA", "is_starter": True},
    ]
    projections = _ProjectionSet(
        [
            _projection(1, "DEF Base", "BBB", "DEF", next_gw=2.0, price=5.0),
            _projection(2, "MID One", "AAA", "MID", next_gw=4.0, price=7.0),
            _projection(3, "FWD One", "AAA", "FWD", next_gw=4.5, price=8.0),
            _projection(4, "MID Two", "AAA", "MID", next_gw=4.2, price=4.7),
            _projection(11, "Illegal DEF Target", "AAA", "DEF", next_gw=6.8, price=5.4),
            _projection(12, "Legal DEF Target", "BBB", "DEF", next_gw=5.9, price=5.4),
        ]
    )

    paths, diagnostics = advisor._build_strategy_paths(
        squad=squad,
        projections=projections,
        bank_value=0.5,
        free_transfers=1,
    )

    picks = [path.get("in") for path in paths.values() if isinstance(path, dict) and path.get("in")]
    assert "Illegal DEF Target" not in picks
    assert "Legal DEF Target" in picks
    assert diagnostics["strategy_team_limit_filtered"] >= 1


def test_bench_upgrade_recommendation_never_suggests_fourth_player_from_same_team() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [
        {"player_id": 1, "name": "AAA One", "position": "MID", "team": "AAA", "is_starter": True, "status_flag": "FIT"},
        {"player_id": 2, "name": "AAA Two", "position": "DEF", "team": "AAA", "is_starter": True, "status_flag": "FIT"},
        {"player_id": 3, "name": "AAA Three", "position": "FWD", "team": "AAA", "is_starter": True, "status_flag": "FIT"},
        {"player_id": 4, "name": "Weak Bench DEF", "position": "DEF", "team": "BBB", "is_starter": False, "status_flag": "FIT"},
    ]
    projections = _ProjectionSet(
        [
            _projection(1, "AAA One", "AAA", "MID", next_gw=6.0, price=7.0),
            _projection(2, "AAA Two", "AAA", "DEF", next_gw=5.5, price=5.0),
            _projection(3, "AAA Three", "AAA", "FWD", next_gw=6.5, price=8.0),
            _projection(4, "Weak Bench DEF", "BBB", "DEF", next_gw=1.0, price=4.0),
            _projection(11, "Illegal AAA Defender", "AAA", "DEF", next_gw=4.2, price=4.2),
            _projection(12, "Legal CCC Defender", "CCC", "DEF", next_gw=3.9, price=4.2),
        ]
    )
    team_data = {
        "current_squad": squad,
        "team_info": {"bank_value": 0.5},
    }

    recs = advisor.recommend_transfers(team_data, free_transfers=1, projections=projections)

    assert recs, "Expected at least one recommendation for weak bench upgrade"
    primary = recs[0]
    transfer_in = primary.get("transfer_in") or {}
    assert transfer_in.get("name") == "Legal CCC Defender"
    assert transfer_in.get("team") == "CCC"


def test_team_limit_enforcement_handles_full_name_vs_short_code_team_formats() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    squad = [
        {"player_id": 1, "name": "BOU One", "position": "MID", "team": "Bournemouth", "is_starter": True, "status_flag": "FIT"},
        {"player_id": 2, "name": "BOU Two", "position": "FWD", "team": "Bournemouth", "is_starter": True, "status_flag": "FIT"},
        {"player_id": 3, "name": "BOU Three", "position": "DEF", "team": "Bournemouth", "is_starter": True, "status_flag": "FIT"},
        {"player_id": 4, "name": "Mings", "position": "DEF", "team": "Aston Villa", "is_starter": True, "status_flag": "OUT", "news": "injury"},
    ]
    projections = _ProjectionSet(
        [
            _projection(4, "Mings", "AVL", "DEF", next_gw=0.0, price=4.5),
            _projection(11, "Truffert", "BOU", "DEF", next_gw=6.0, price=4.8),
            _projection(12, "Safe DEF", "FUL", "DEF", next_gw=5.2, price=4.8),
        ]
    )
    team_data = {
        "current_squad": squad,
        "team_info": {"bank_value": 0.5},
        "teams": [
            {"id": 3, "name": "Bournemouth", "short_name": "BOU"},
            {"id": 7, "name": "Aston Villa", "short_name": "AVL"},
            {"id": 8, "name": "Fulham", "short_name": "FUL"},
        ],
    }

    recs = advisor.recommend_transfers(team_data, free_transfers=1, projections=projections)

    assert recs, "Expected at least one recommendation"
    primary = recs[0]
    transfer_in = primary.get("transfer_in") or {}
    assert transfer_in.get("name") != "Truffert"
    assert transfer_in.get("team") == "FUL"


def test_recommendations_exclude_blank_next_gameweek_candidates() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor.fixture_horizon_context = {
        "start_gw": 30,
        "candidate_player_windows": [
            {
                "player_id": 11,
                "upcoming": [
                    {"gw": 30, "is_blank": True, "fixture_count": 0},
                ],
            },
            {
                "player_id": 12,
                "upcoming": [
                    {"gw": 30, "is_blank": False, "fixture_count": 1},
                ],
            },
        ],
        "player_summary_by_id": {
            11: {"next_bgw_gw": 30},
            12: {"next_bgw_gw": None},
        },
    }
    squad = [
        {
            "player_id": 4,
            "name": "Mings",
            "position": "DEF",
            "team": "AVL",
            "is_starter": True,
            "status_flag": "OUT",
            "news": "injury",
        },
    ]
    projections = _ProjectionSet(
        [
            _projection(4, "Mings", "AVL", "DEF", next_gw=0.0, price=4.5),
            _projection(11, "Blank DEF", "BOU", "DEF", next_gw=7.0, price=4.8),
            _projection(12, "Playable DEF", "FUL", "DEF", next_gw=5.6, price=4.8),
        ]
    )
    team_data = {
        "current_squad": squad,
        "team_info": {"bank_value": 0.5},
        "teams": [
            {"id": 7, "name": "Aston Villa", "short_name": "AVL"},
            {"id": 3, "name": "Bournemouth", "short_name": "BOU"},
            {"id": 8, "name": "Fulham", "short_name": "FUL"},
        ],
        "fixture_horizon_context": advisor.fixture_horizon_context,
    }

    recs = advisor.recommend_transfers(team_data, free_transfers=1, projections=projections)

    assert recs, "Expected at least one recommendation"
    transfer_in = (recs[0].get("transfer_in") or {}).get("name")
    assert transfer_in == "Playable DEF"


def test_recommendations_exclude_blank_candidates_when_summary_is_missing() -> None:
    advisor = TransferAdvisor(risk_posture="BALANCED")
    advisor.fixture_horizon_context = {
        "start_gw": 30,
        "candidate_player_windows": [
            {
                "player_id": 21,
                "upcoming": [
                    {"gw": 30, "is_blank": True, "fixture_count": 0},
                ],
            },
            {
                "player_id": 22,
                "upcoming": [
                    {"gw": 30, "is_blank": False, "fixture_count": 1},
                ],
            },
        ],
        # Intentionally sparse summary map to validate window-based fallback.
        "player_summary_by_id": {
            22: {"next_bgw_gw": None},
        },
    }

    squad = [
        {
            "player_id": 4,
            "name": "Mings",
            "position": "DEF",
            "team": "AVL",
            "is_starter": True,
            "status_flag": "OUT",
            "news": "injury",
        },
    ]
    projections = _ProjectionSet(
        [
            _projection(4, "Mings", "AVL", "DEF", next_gw=0.0, price=4.5),
            _projection(21, "Window Blank DEF", "BOU", "DEF", next_gw=7.2, price=4.8),
            _projection(22, "Window Playable DEF", "FUL", "DEF", next_gw=5.5, price=4.8),
        ]
    )
    team_data = {
        "current_squad": squad,
        "team_info": {"bank_value": 0.5},
        "teams": [
            {"id": 7, "name": "Aston Villa", "short_name": "AVL"},
            {"id": 3, "name": "Bournemouth", "short_name": "BOU"},
            {"id": 8, "name": "Fulham", "short_name": "FUL"},
        ],
        "fixture_horizon_context": advisor.fixture_horizon_context,
    }

    recs = advisor.recommend_transfers(team_data, free_transfers=1, projections=projections)

    assert recs, "Expected at least one recommendation"
    transfer_in = (recs[0].get("transfer_in") or {}).get("name")
    assert transfer_in == "Window Playable DEF"


def test_contract_enforcement_preserves_duplicate_name_paths_when_ids_differ() -> None:
    decision = {
        "strategy_paths": {
            "safe": {
                "out": "Starter One",
                "in": "Alex",
                "out_player_id": 201,
                "in_player_id": 900,
            },
            "balanced": {
                "out": "Starter Two",
                "in": "Alex",
                "out_player_id": 202,
                "in_player_id": 901,
            },
        }
    }
    team_data = {
        "current_squad": [
            {"player_id": 201, "name": "Starter One"},
            {"player_id": 500, "name": "Alex"},
        ]
    }

    result = DecisionContractEnforcer.enforce_strategy_paths_contract(decision, team_data)

    assert result.remediated_count == 0
    assert decision["strategy_paths"]["safe"] is not None
    assert decision["strategy_paths"]["balanced"] is not None


def test_attach_fixture_planner_builds_content_with_complete_inputs() -> None:
    integration = FPLSageIntegration(team_id=1, config_file="/tmp/nonexistent-team-config.json")
    team_data = {
        "next_gameweek": 30,
        "current_squad": [
            {"player_id": 101, "id": 101, "name": "Alpha", "team": 1},
            {"player_id": 102, "id": 102, "name": "Bravo", "team": 2},
        ],
    }
    raw_data = {
        "fixtures": [
            {"id": 3001, "event": 30, "team_h": 1, "team_a": 2, "team_h_difficulty": 2, "team_a_difficulty": 3},
            {"id": 3002, "event": 31, "team_h": 3, "team_a": 1, "team_h_difficulty": 2, "team_a_difficulty": 4},
        ],
        "teams": _teams(),
        "players": _players(),
    }
    projections = _ProjectionSet(
        [
            _projection(101, "Alpha", "AAA", "MID", next_gw=5.0, price=8.0),
            _projection(102, "Bravo", "BBB", "MID", next_gw=4.5, price=7.5),
            _projection(103, "Charlie", "CCC", "MID", next_gw=5.8, price=7.9),
        ]
    )
    decision = _decision()

    integration._attach_fixture_planner_to_decision(
        decision=decision,
        team_data=team_data,
        raw_data=raw_data,
        current_gw=29,
        projections=projections,
    )

    assert decision.fixture_planner is not None
    assert len(decision.fixture_planner["gw_timeline"]) == 8
    assert len(decision.fixture_planner["squad_windows"]) >= 1
    assert decision.fixture_planner_reason is None


def test_attach_fixture_planner_recomputes_when_initial_payload_is_empty(monkeypatch) -> None:
    integration = FPLSageIntegration(team_id=1, config_file="/tmp/nonexistent-team-config.json")
    team_data = {
        "next_gameweek": 30,
        "current_squad": [
            {"player_id": 101, "id": 101, "name": "Alpha", "team": 1},
            {"player_id": 102, "id": 102, "name": "Bravo", "team": 2},
        ],
    }
    raw_data = {
        "fixtures": [
            {"id": 4001, "event": 30, "team_h": 1, "team_a": 2, "team_h_difficulty": 2, "team_a_difficulty": 3},
        ],
        "teams": _teams(),
        "players": _players(),
    }
    projections = _ProjectionSet(
        [
            _projection(101, "Alpha", "AAA", "MID", next_gw=5.0, price=8.0),
            _projection(102, "Bravo", "BBB", "MID", next_gw=4.5, price=7.5),
            _projection(103, "Charlie", "CCC", "MID", next_gw=5.8, price=7.9),
        ]
    )
    decision = _decision()
    call_counter = {"count": 0}
    real_builder = build_fixture_horizon_context

    def _fake_builder(*args, **kwargs):
        call_counter["count"] += 1
        if call_counter["count"] == 1:
            return {
                "start_gw": 30,
                "horizon_gws": 8,
                "gw_timeline": [],
                "squad_player_windows": [],
                "candidate_player_windows": [],
                "key_planning_notes": [],
            }
        return real_builder(*args, **kwargs)

    monkeypatch.setattr(integration_module, "build_fixture_horizon_context", _fake_builder)

    integration._attach_fixture_planner_to_decision(
        decision=decision,
        team_data=team_data,
        raw_data=raw_data,
        current_gw=29,
        projections=projections,
    )

    assert call_counter["count"] >= 2
    assert decision.fixture_planner is not None
    assert len(decision.fixture_planner["gw_timeline"]) == 8
    assert decision.fixture_planner_reason is None


def test_attach_fixture_planner_sets_reason_only_for_true_data_absence(monkeypatch) -> None:
    integration = FPLSageIntegration(team_id=1, config_file="/tmp/nonexistent-team-config.json")
    team_data = {"next_gameweek": 30, "current_squad": [{"player_id": 101, "name": "Alpha", "team": 1}]}
    raw_data = {"fixtures": [], "teams": [], "players": []}
    projections = _ProjectionSet([_projection(101, "Alpha", "AAA", "MID", next_gw=5.0, price=8.0)])
    decision = _decision()

    def _always_empty(*_args, **_kwargs):
        return {
            "start_gw": 30,
            "horizon_gws": 8,
            "gw_timeline": [],
            "squad_player_windows": [],
            "candidate_player_windows": [],
            "key_planning_notes": [],
        }

    monkeypatch.setattr(integration_module, "build_fixture_horizon_context", _always_empty)

    integration._attach_fixture_planner_to_decision(
        decision=decision,
        team_data=team_data,
        raw_data=raw_data,
        current_gw=29,
        projections=projections,
    )

    assert decision.fixture_planner is not None
    assert decision.fixture_planner["gw_timeline"] == []
    assert decision.fixture_planner_reason is not None
    assert "missing fixtures, teams, players" in decision.fixture_planner_reason
