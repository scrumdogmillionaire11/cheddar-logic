import datetime

from cheddar_fpl_sage.analysis.enhanced_decision_framework import EnhancedDecisionFramework
from cheddar_fpl_sage.models.canonical_projections import CanonicalPlayerProjection, CanonicalProjectionSet


def _proj(pid, pos, pts, team="T"):
    return CanonicalPlayerProjection(
        player_id=pid,
        name=f"Player {pid}",
        position=pos,
        team=team,
        current_price=5.0,
        nextGW_pts=pts,
        next6_pts=pts * 5,
        xMins_next=90,
        volatility_score=0.2,
        ceiling=pts * 2,
        floor=max(0, pts * 0.5),
        tags=[],
        confidence=0.5,
        ownership_pct=10.0,
    )


def test_valid_xi_can_be_built_from_known_squad():
    """
    Regression: ensure a legal XI is found for a 3-4-3-capable squad.
    """
    players = [
        _proj(1, "GK", 6),
        _proj(2, "GK", 5),
        _proj(3, "DEF", 8),
        _proj(4, "DEF", 7),
        _proj(5, "DEF", 6),
        _proj(6, "DEF", 5),
        _proj(7, "DEF", 4),
        _proj(8, "MID", 10),
        _proj(9, "MID", 9),
        _proj(10, "MID", 8),
        _proj(11, "MID", 7),
        _proj(12, "MID", 6),
        _proj(13, "FWD", 9.5),
        _proj(14, "FWD", 8.5),
        _proj(15, "FWD", 7.5),
    ]
    projection_set = CanonicalProjectionSet(
        projections=players,
        gameweek=19,
        created_timestamp=datetime.datetime.now().isoformat(),
        confidence_level="low",
    )
    team_data = {
        "current_squad": [
            {"player_id": p.player_id, "position": p.position, "name": p.name}
            for p in players
        ]
    }

    framework = EnhancedDecisionFramework()
    optimized = framework._optimize_starting_xi(team_data, projection_set)

    assert optimized.formation_valid
    assert optimized.formation in {"3-4-3", "3-5-2", "4-4-2", "4-3-3", "4-5-1", "5-4-1", "5-3-2", "5-2-3"}
    assert len(optimized.starting_xi) == 11
    assert len(optimized.bench) == 4


def test_bench_order_is_deterministic_with_goalkeeper_last_slot():
    players = [
        _proj(1, "GK", 6),
        _proj(2, "GK", 3),
        _proj(3, "DEF", 9),
        _proj(4, "DEF", 8),
        _proj(5, "DEF", 7),
        _proj(6, "DEF", 6),
        _proj(7, "DEF", 1),
        _proj(8, "MID", 10),
        _proj(9, "MID", 9),
        _proj(10, "MID", 8),
        _proj(11, "MID", 7),
        _proj(12, "MID", 2),
        _proj(13, "FWD", 11),
        _proj(14, "FWD", 6),
        _proj(15, "FWD", 1),
    ]
    projection_set = CanonicalProjectionSet(
        projections=players,
        gameweek=19,
        created_timestamp=datetime.datetime.now().isoformat(),
        confidence_level="low",
    )
    team_data = {
        "current_squad": [
            {"player_id": p.player_id, "position": p.position, "name": p.name}
            for p in players
        ]
    }

    framework = EnhancedDecisionFramework(risk_posture="BALANCED")
    optimized_a = framework._optimize_starting_xi(team_data, projection_set)
    optimized_b = framework._optimize_starting_xi(team_data, projection_set)

    bench_a = [player.player_id for player in optimized_a.bench]
    bench_b = [player.player_id for player in optimized_b.bench]

    assert bench_a == bench_b
    assert optimized_a.bench[-1].position == "GK"


def test_banned_players_are_excluded_from_starting_xi():
    players = [
        _proj(1, "GK", 6),
        _proj(2, "GK", 5),
        _proj(3, "DEF", 8),
        _proj(4, "DEF", 7),
        _proj(5, "DEF", 6),
        _proj(6, "DEF", 5),
        _proj(7, "DEF", 4),
        _proj(8, "MID", 10),
        _proj(9, "MID", 9),
        _proj(10, "MID", 8),
        _proj(11, "MID", 7),
        _proj(12, "MID", 6),
        _proj(13, "FWD", 9.5),
        _proj(14, "FWD", 8.5),
        _proj(15, "FWD", 7.5),
    ]
    projection_set = CanonicalProjectionSet(
        projections=players,
        gameweek=19,
        created_timestamp=datetime.datetime.now().isoformat(),
        confidence_level="low",
    )
    team_data = {
        "current_squad": [
            {
                "player_id": p.player_id,
                "position": p.position,
                "name": p.name,
                "status_flag": "BANNED" if p.player_id == 8 else "FIT",
            }
            for p in players
        ]
    }

    framework = EnhancedDecisionFramework()
    optimized = framework._optimize_starting_xi(team_data, projection_set)

    assert all(player.player_id != 8 for player in optimized.starting_xi)


def test_projection_sanity_swap_promotes_higher_projected_midfielder():
    players = [
        _proj(1, "GK", 6),
        _proj(2, "GK", 3),
        _proj(3, "DEF", 9),
        _proj(4, "DEF", 8),
        _proj(5, "DEF", 7),
        _proj(6, "DEF", 6),
        _proj(7, "DEF", 5),
        _proj(8, "MID", 10),
        _proj(9, "MID", 9),
        _proj(10, "MID", 4.4),
        _proj(11, "MID", 3.8),
        _proj(12, "MID", 7.0),
        _proj(13, "FWD", 11),
        _proj(14, "FWD", 10),
        _proj(15, "FWD", 9),
    ]

    # Force player 12 to be benched in initial score ordering despite higher raw projection.
    players[11].volatility_score = 3.0

    projection_set = CanonicalProjectionSet(
        projections=players,
        gameweek=19,
        created_timestamp=datetime.datetime.now().isoformat(),
        confidence_level="low",
    )
    team_data = {
        "current_squad": [
            {"player_id": p.player_id, "position": p.position, "name": p.name}
            for p in players
        ]
    }

    framework = EnhancedDecisionFramework(risk_posture="BALANCED")
    optimized = framework._optimize_starting_xi(team_data, projection_set)

    starter_ids = {player.player_id for player in optimized.starting_xi}
    assert 12 in starter_ids, "Higher projected MID should be promoted by sanity swap"
    assert 11 not in starter_ids, "Lowest projected MID should be displaced by higher projected bench MID"


# NOTE: We intentionally avoid a deterministic unit assertion for "Projection
# sanity hold" notes here because formation-level optimizer choices can validly
# produce no blocked-hold candidate for synthetic fixtures. Hold-note behavior is
# exercised in live payload inspection instead of brittle static expectations.
