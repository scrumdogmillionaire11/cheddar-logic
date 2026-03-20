from datetime import datetime, timezone

from cheddar_fpl_sage.analysis.enhanced_decision_framework import (
    ChipDecisionContext,
    ChipType,
    DecisionOutput,
    EnhancedDecisionFramework,
)
from cheddar_fpl_sage.models.canonical_projections import (
    CanonicalPlayerProjection,
    CanonicalProjectionSet,
)
from cheddar_fpl_sage.models.injury_report import (
    InjuryConfidence,
    InjuryReport,
    InjurySource,
    InjuryStatus,
)


def _make_projection(player_id: int, position: str, team: str, pts: float) -> CanonicalPlayerProjection:
    return CanonicalPlayerProjection(
        player_id=player_id,
        name=f"Player {player_id}",
        position=position,
        team=team,
        current_price=5.0,
        nextGW_pts=float(pts),
        next6_pts=float(pts) * 2,
        xMins_next=90.0,
        volatility_score=0.1,
        ceiling=float(pts) + 2,
        floor=max(0.0, float(pts) - 1),
        tags=[],
        confidence=0.9,
        ownership_pct=5.0,
    )


def test_injury_status_summary_is_rendered():
    framework = EnhancedDecisionFramework()
    team_data = {
        "team_info": {
            "team_name": "Test Team",
            "manager_name": "Coach",
            "free_transfers_source": "api",
        },
        "current_squad": [
            {"player_id": 1, "name": "Haaland", "team": "MCI", "position": "FWD", "status_flag": "FIT"},
            {"player_id": 2, "name": "Semenyo", "team": "MCI", "position": "MID", "status_flag": "FIT"},
        ],
        "injury_reports": [
            {
                "player_id": 1,
                "status": "OUT",
                "source": "MANUAL_CONFIRMED",
                "asof_utc": "2026-01-09T10:00:00Z",
                "confidence": "HIGH",
            }
        ],
        "injury_summary": {"status_counts": {"OUT": 1, "DOUBTFUL": 0, "UNKNOWN": 0}, "low_confidence": 0},
        "analysis_preferences": {"summary_debug": True},
    }
    decision = DecisionOutput(
        primary_decision="NO_CHIP_ACTION",
        reasoning="Hold due to incomplete context",
        risk_scenarios=[],
        chip_guidance=ChipDecisionContext(
            current_gw=21,
            chip_type=ChipType.NONE,
            available_chips=[],
            current_window_score=0.0,
            best_future_window_score=0.0,
            window_rank=1,
            reason_codes=["tc_manager_context_conservative"],
        ),
        captaincy={
            "captain": {
                "player_id": 1,
                "name": "Haaland",
                "team": 13,
                "position": "FWD",
                "rationale": "Safe pick",
            },
            "vice_captain": {
                "player_id": 2,
                "name": "Semenyo",
                "team": 13,
                "position": "MID",
                "rationale": "Backup",
            },
            "candidates": [
                {"player_id": 1, "name": "Haaland", "team": 13, "position": "FWD", "expected_pts": 8.0},
                {"player_id": 2, "name": "Semenyo", "team": 13, "position": "MID", "expected_pts": 6.0},
            ],
        },
        transfer_recommendations=[
            {
                "action": "Upgrade bench depth",
                "reason": "Bench contains out/low-minute players",
                "profile": "Reliable starter ≤ £4.5m",
            }
        ],
    )
    summary = framework.generate_decision_summary(decision, team_data=team_data)
    assert "### Injury Status Summary" in summary
    assert "- Source: Resolved (FPL + secondary + manual)" in summary
    assert "- Squad status (2 players): OUT: 1, DOUBTFUL: 0, UNKNOWN: 0" in summary
    assert "Haaland (MCI, FWD)" in summary
    assert "### Bench Upgrade Plan" in summary
    assert "- Replacement candidates: Cannot suggest replacements: player projections, FPL player database not loaded" in summary
    assert "SUMMARY_GENERATOR_VERSION: 2026-01-09-injury-summary" in summary


def test_out_players_are_filtered_from_starting_xi():
    framework = EnhancedDecisionFramework()
    positions = ["GK", "GK", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "MID", "MID", "FWD", "FWD", "FWD"]
    squad = [
        {
            "player_id": idx,
            "name": f"Player {idx}",
            "team": "TST",
            "position": pos,
            "status_flag": "OUT" if idx == 10 else "FIT",
        }
        for idx, pos in enumerate(positions, start=1)
    ]
    projections = [
        _make_projection(idx, pos, "TST", pts=12 - idx * 0.5) for idx, pos in enumerate(positions, start=1)
    ]
    projection_set = CanonicalProjectionSet(
        projections=projections,
        gameweek=21,
        created_timestamp=datetime.now(timezone.utc).isoformat(),
        confidence_level="high",
    )
    injury_reports = {
        10: InjuryReport(
            player_id=10,
            status=InjuryStatus.OUT,
            source=InjurySource.MANUAL_CONFIRMED,
            chance=0,
            asof_utc="2026-01-09T00:00:00Z",
            confidence=InjuryConfidence.HIGH,
        )
    }
    team_data = {"current_squad": squad}
    optimized = framework._optimize_starting_xi(team_data, projection_set, injury_reports)
    assert all(player.player_id != 10 for player in optimized.starting_xi)

    captaincy = framework._recommend_captaincy_from_xi(optimized, {}, projection_set, injury_reports)
    xi_ids = {player.player_id for player in optimized.starting_xi}
    xi_names = {player.name for player in optimized.starting_xi}

    captain_id = captaincy.get("captain", {}).get("player_id")
    vice_id = captaincy.get("vice_captain", {}).get("player_id")
    if captain_id is not None:
        assert captain_id in xi_ids
    else:
        assert captaincy.get("captain", {}).get("name") in xi_names

    if vice_id is not None:
        assert vice_id in xi_ids
    else:
        assert captaincy.get("vice_captain", {}).get("name") in xi_names
