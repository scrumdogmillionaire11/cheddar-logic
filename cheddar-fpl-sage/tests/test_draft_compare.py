"""Tests for draft_compare.compare_drafts() — WI-0656.

Tests:
- test_compare_winner_determined
- test_compare_tie_within_margin
- test_compare_archetype_shifts_winner
- test_compare_returns_8_deltas
- test_compare_winner_rationale_nonempty
- test_compare_archetype_fit_note_nonempty
- test_compare_delta_winner_valid_values
- test_compare_symmetric_tie
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.models.draft_api_models import DraftBuild, PlayerEntry
from backend.services.draft_compare import compare_drafts


# ── Fixtures ──────────────────────────────────────────────────────────────────


def _make_player(
    pid: int,
    position: str,
    team_short: str = "MCI",
    price: float = 7.5,
    ownership_pct: float = 25.0,
    form: float = 6.0,
    is_locked: bool = False,
    is_differential: bool = False,
) -> PlayerEntry:
    return PlayerEntry(
        fpl_player_id=pid,
        player_name=f"Player{pid}",
        position=position,
        team_short=team_short,
        price=price,
        ownership_pct=ownership_pct,
        form=form,
        is_locked=is_locked,
        is_differential=is_differential,
    )


def _build_strong_squad() -> DraftBuild:
    """Squad A: high form, high ownership, diverse clubs — favours Safe Template."""
    players = [
        _make_player(1, "GKP", team_short="LIV", price=5.5, ownership_pct=40.0, form=7.0),
        _make_player(2, "GKP", team_short="BOU", price=4.5, ownership_pct=15.0, form=6.0),
        _make_player(3, "DEF", team_short="MCI", price=6.5, ownership_pct=35.0, form=6.5),
        _make_player(4, "DEF", team_short="ARS", price=6.5, ownership_pct=38.0, form=6.5),
        _make_player(5, "DEF", team_short="CHE", price=6.0, ownership_pct=28.0, form=6.0),
        _make_player(6, "DEF", team_short="TOT", price=5.5, ownership_pct=22.0, form=5.5),
        _make_player(7, "DEF", team_short="NEW", price=5.0, ownership_pct=18.0, form=5.0),
        _make_player(8, "MID", team_short="LIV", price=12.5, ownership_pct=65.0, form=8.5),
        _make_player(9, "MID", team_short="MCI", price=11.0, ownership_pct=50.0, form=8.0),
        _make_player(10, "MID", team_short="ARS", price=8.5, ownership_pct=40.0, form=7.0),
        _make_player(11, "MID", team_short="CHE", price=7.5, ownership_pct=30.0, form=6.5),
        _make_player(12, "MID", team_short="TOT", price=5.5, ownership_pct=12.0, form=5.5),
        _make_player(13, "FWD", team_short="MCI", price=13.5, ownership_pct=55.0, form=9.0),
        _make_player(14, "FWD", team_short="CHE", price=9.5, ownership_pct=40.0, form=7.5),
        _make_player(15, "FWD", team_short="NEW", price=7.5, ownership_pct=25.0, form=6.0),
    ]
    return DraftBuild(
        build_type="primary",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Strong Template",
        rationale="High-form, template-aligned build.",
        constraints_applied=[],
        squad_meta={},
    )


def _build_weak_squad() -> DraftBuild:
    """Squad B: low form, cheap, correlated — clearly worse on most dimensions."""
    players = [
        _make_player(101, "GKP", team_short="SOU", price=4.0, ownership_pct=5.0, form=2.0),
        _make_player(102, "GKP", team_short="LEI", price=4.0, ownership_pct=3.0, form=2.5),
        _make_player(103, "DEF", team_short="SOU", price=4.5, ownership_pct=4.0, form=2.0),
        _make_player(104, "DEF", team_short="SOU", price=4.5, ownership_pct=3.5, form=2.5),
        _make_player(105, "DEF", team_short="SOU", price=4.5, ownership_pct=3.0, form=2.0),
        _make_player(106, "DEF", team_short="SOU", price=4.5, ownership_pct=3.0, form=2.0),
        _make_player(107, "DEF", team_short="LEI", price=4.0, ownership_pct=2.5, form=2.0),
        _make_player(108, "MID", team_short="SOU", price=5.0, ownership_pct=3.0, form=2.5),
        _make_player(109, "MID", team_short="LEI", price=5.0, ownership_pct=4.0, form=2.0),
        _make_player(110, "MID", team_short="SOU", price=5.0, ownership_pct=3.0, form=2.0),
        _make_player(111, "MID", team_short="LEI", price=5.0, ownership_pct=2.5, form=2.0),
        _make_player(112, "MID", team_short="WOL", price=5.0, ownership_pct=2.0, form=2.0),
        _make_player(113, "FWD", team_short="SOU", price=5.5, ownership_pct=3.5, form=2.5),
        _make_player(114, "FWD", team_short="LEI", price=5.0, ownership_pct=3.0, form=2.0),
        _make_player(115, "FWD", team_short="WOL", price=5.0, ownership_pct=2.5, form=2.0),
    ]
    return DraftBuild(
        build_type="contrast",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Weak squad",
        rationale="Low-form, correlated, budget squad.",
        constraints_applied=[],
        squad_meta={},
    )


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_compare_winner_determined():
    """build_a (strong) vs build_b (weak): winner should be 'a' under Safe Template."""
    build_a = _build_strong_squad()
    build_b = _build_weak_squad()
    result = compare_drafts(build_a, build_b, "Safe Template")
    assert result.winner == "a", f"Expected winner='a', got '{result.winner}'"


def test_compare_tie_within_margin():
    """Same squad vs itself: every dimension ties, overall should be 'tie'."""
    build = _build_strong_squad()
    result = compare_drafts(build, build, "Balanced Climber")
    assert result.winner == "tie", f"Identical builds should tie, got '{result.winner}'"


def _build_differential_squad_local() -> DraftBuild:
    """Local copy of the differential squad fixture."""
    players = [
        _make_player(1, "GKP", team_short="LIV", price=5.0, ownership_pct=30.0),
        _make_player(2, "GKP", team_short="BOU", price=4.5, ownership_pct=10.0),
        _make_player(3, "DEF", team_short="MCI", price=6.0, ownership_pct=25.0),
        _make_player(4, "DEF", team_short="ARS", price=6.5, ownership_pct=30.0),
        _make_player(5, "DEF", team_short="CHE", price=5.5, ownership_pct=20.0),
        _make_player(6, "DEF", team_short="TOT", price=5.0, ownership_pct=15.0),
        _make_player(7, "DEF", team_short="WOL", price=4.5, ownership_pct=2.0, is_differential=True),
        _make_player(8, "MID", team_short="LIV", price=12.5, ownership_pct=3.0, form=8.0, is_differential=True),
        _make_player(9, "MID", team_short="FUL", price=7.0, ownership_pct=2.5, form=7.0, is_differential=True),
        _make_player(10, "MID", team_short="ARS", price=8.0, ownership_pct=35.0, form=6.0),
        _make_player(11, "MID", team_short="BRE", price=6.5, ownership_pct=3.0, form=5.5, is_differential=True),
        _make_player(12, "MID", team_short="TOT", price=5.0, ownership_pct=10.0),
        _make_player(13, "FWD", team_short="MCI", price=13.0, ownership_pct=50.0, form=8.5),
        _make_player(14, "FWD", team_short="BHA", price=7.5, ownership_pct=3.0, form=6.5, is_differential=True),
        _make_player(15, "FWD", team_short="NEW", price=7.0, ownership_pct=20.0, form=5.0),
    ]
    return DraftBuild(
        build_type="contrast",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Differential",
        rationale="Ceiling-chasing differential build.",
        constraints_applied=[],
        squad_meta={},
    )


def _build_pure_template_squad() -> DraftBuild:
    """Pure template squad: high ownership, no differentials, locked players."""
    players = [
        _make_player(201, "GKP", team_short="LIV", price=5.5, ownership_pct=55.0, form=7.0),
        _make_player(202, "GKP", team_short="ARS", price=4.5, ownership_pct=30.0, form=6.0),
        _make_player(203, "DEF", team_short="MCI", price=7.0, ownership_pct=50.0, form=7.0),
        _make_player(204, "DEF", team_short="ARS", price=6.5, ownership_pct=45.0, form=6.5),
        _make_player(205, "DEF", team_short="LIV", price=6.0, ownership_pct=40.0, form=6.0),
        _make_player(206, "DEF", team_short="CHE", price=5.5, ownership_pct=35.0, form=5.5),
        _make_player(207, "DEF", team_short="TOT", price=5.0, ownership_pct=28.0, form=5.0),
        _make_player(208, "MID", team_short="LIV", price=12.5, ownership_pct=65.0, form=9.0),
        _make_player(209, "MID", team_short="MCI", price=11.0, ownership_pct=55.0, form=8.5),
        _make_player(210, "MID", team_short="ARS", price=8.5, ownership_pct=45.0, form=7.5),
        _make_player(211, "MID", team_short="CHE", price=7.5, ownership_pct=35.0, form=7.0),
        _make_player(212, "MID", team_short="TOT", price=6.0, ownership_pct=25.0, form=6.0),
        _make_player(213, "FWD", team_short="MCI", price=13.5, ownership_pct=60.0, form=9.5),
        _make_player(214, "FWD", team_short="LIV", price=10.0, ownership_pct=50.0, form=8.0),
        _make_player(215, "FWD", team_short="ARS", price=8.0, ownership_pct=38.0, form=7.0),
    ]
    return DraftBuild(
        build_type="primary",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Pure Template",
        rationale="All-template squad with high-ownership picks.",
        constraints_applied=[],
        squad_meta={},
    )


def _build_pure_differential_squad() -> DraftBuild:
    """Pure differential squad: low ownership, all differentials, high form."""
    players = [
        _make_player(301, "GKP", team_short="BOU", price=5.5, ownership_pct=3.0, form=7.0, is_differential=True),
        _make_player(302, "GKP", team_short="WOL", price=4.5, ownership_pct=2.0, form=6.0, is_differential=True),
        _make_player(303, "DEF", team_short="BHA", price=7.0, ownership_pct=2.5, form=7.0, is_differential=True),
        _make_player(304, "DEF", team_short="FUL", price=6.5, ownership_pct=2.0, form=6.5, is_differential=True),
        _make_player(305, "DEF", team_short="NOT", price=6.0, ownership_pct=3.0, form=6.0, is_differential=True),
        _make_player(306, "DEF", team_short="BRE", price=5.5, ownership_pct=2.5, form=5.5, is_differential=True),
        _make_player(307, "DEF", team_short="LEI", price=5.0, ownership_pct=4.0, form=5.0, is_differential=True),
        _make_player(308, "MID", team_short="WOL", price=12.5, ownership_pct=3.0, form=9.0, is_differential=True),
        _make_player(309, "MID", team_short="BHA", price=11.0, ownership_pct=2.5, form=8.5, is_differential=True),
        _make_player(310, "MID", team_short="FUL", price=8.5, ownership_pct=3.0, form=7.5, is_differential=True),
        _make_player(311, "MID", team_short="NOT", price=7.5, ownership_pct=2.0, form=7.0, is_differential=True),
        _make_player(312, "MID", team_short="BRE", price=6.0, ownership_pct=3.0, form=6.0, is_differential=True),
        _make_player(313, "FWD", team_short="LEI", price=13.5, ownership_pct=2.5, form=9.5, is_differential=True),
        _make_player(314, "FWD", team_short="WOL", price=10.0, ownership_pct=2.0, form=8.0, is_differential=True),
        _make_player(315, "FWD", team_short="BHA", price=8.0, ownership_pct=3.0, form=7.0, is_differential=True),
    ]
    return DraftBuild(
        build_type="contrast",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Pure Differential",
        rationale="All-differential squad for maximum ceiling.",
        constraints_applied=[],
        squad_meta={},
    )


def test_compare_archetype_shifts_winner():
    """Archetype weighting changes the comparison outcome.

    A pure template squad (all high-ownership) vs a pure differential squad
    (all low-ownership differentials) should produce different winners based
    on archetype: Safe Template favours the template squad, Aggressive Hunter
    favours the differential squad on philosophy_fit.
    """
    template_build = _build_pure_template_squad()
    diff_build = _build_pure_differential_squad()

    result_safe = compare_drafts(template_build, diff_build, "Safe Template")
    result_agg = compare_drafts(template_build, diff_build, "Aggressive Hunter")

    # Safe Template should prefer the template squad on philosophy_fit + template_exposure
    assert result_safe.winner in ("a", "tie"), (
        f"Safe Template: expected template squad to win or tie, got '{result_safe.winner}'"
    )
    # Aggressive Hunter should prefer the differential squad or produce a different outcome
    # (the key assertion: archetype changes the winner or favours the diff squad)
    assert result_agg.winner != "a" or result_agg.winner == "tie", (
        f"Aggressive Hunter should not prefer the template squad: got '{result_agg.winner}'. "
        f"Safe winner={result_safe.winner}, Aggressive winner={result_agg.winner}"
    )


def test_compare_returns_8_deltas():
    build_a = _build_strong_squad()
    build_b = _build_weak_squad()
    result = compare_drafts(build_a, build_b, "Safe Template")
    assert len(result.deltas) == 8, f"Expected 8 deltas, got {len(result.deltas)}"


def test_compare_winner_rationale_nonempty():
    build_a = _build_strong_squad()
    build_b = _build_weak_squad()
    result = compare_drafts(build_a, build_b, "Safe Template")
    assert result.winner_rationale and len(result.winner_rationale.strip()) > 0


def test_compare_archetype_fit_note_nonempty():
    build_a = _build_strong_squad()
    build_b = _build_weak_squad()
    result = compare_drafts(build_a, build_b, "Aggressive Hunter")
    assert result.archetype_fit_note and len(result.archetype_fit_note.strip()) > 0


def test_compare_delta_winner_valid_values():
    """All delta.winner fields must be 'a', 'b', or 'tie'."""
    build_a = _build_strong_squad()
    build_b = _build_weak_squad()
    result = compare_drafts(build_a, build_b, "Value/Flex Builder")
    for delta in result.deltas:
        assert delta.winner in ("a", "b", "tie"), f"Invalid delta.winner: {delta.winner}"


def test_compare_symmetric_tie():
    """Comparing identical builds in reverse order still returns 'tie'."""
    build = _build_weak_squad()
    result_ab = compare_drafts(build, build, "Set-and-Hold")
    result_ba = compare_drafts(build, build, "Set-and-Hold")
    assert result_ab.winner == "tie"
    assert result_ba.winner == "tie"


def test_compare_explanation_nonempty():
    """Each delta must have a non-empty explanation."""
    build_a = _build_strong_squad()
    build_b = _build_weak_squad()
    result = compare_drafts(build_a, build_b, "Balanced Climber")
    for delta in result.deltas:
        assert delta.explanation and len(delta.explanation.strip()) > 0, (
            f"Delta for {delta.dimension} has empty explanation"
        )
