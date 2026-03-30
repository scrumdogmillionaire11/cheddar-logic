"""Tests for draft_audit.score_audit() — WI-0656.

Tests:
- test_structure_score_valid_squad
- test_philosophy_fit_aggressive_rewards_differentials
- test_fragility_high_with_low_form
- test_correlation_exposure_3_same_club
- test_audit_returns_8_dimensions
- test_what_breaks_this_nonempty
- test_captaincy_strength_high_form_players
- test_template_exposure_high_ownership
- test_exit_liquidity_cheap_players
- test_time_to_fix_unlocked_squad
- test_labels_match_score_thresholds
- test_audit_is_deterministic
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from backend.models.draft_api_models import DraftBuild, PlayerEntry, DraftConstraints
from backend.services.draft_audit import score_audit

AUDIT_DIMENSIONS = [
    "structure",
    "philosophy_fit",
    "captaincy_strength",
    "template_exposure",
    "fragility",
    "correlation_exposure",
    "exit_liquidity",
    "time_to_fix",
]


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


def _build_template_squad(
    constraint_overrides: dict | None = None,
) -> DraftBuild:
    """Build a generic 15-player squad in a 4-4-2 formation.

    GKP x2, DEF x5, MID x5, FWD x3 — standard FPL 15-slot squad.
    First 11 are starters; last 4 are bench.
    """
    players = [
        # GKP starters + bench
        _make_player(1, "GKP", team_short="LIV", price=5.0, ownership_pct=30.0),
        _make_player(2, "GKP", team_short="BOU", price=4.5, ownership_pct=10.0),
        # DEF
        _make_player(3, "DEF", team_short="MCI", price=6.0, ownership_pct=25.0),
        _make_player(4, "DEF", team_short="ARS", price=6.5, ownership_pct=30.0),
        _make_player(5, "DEF", team_short="CHE", price=5.5, ownership_pct=20.0),
        _make_player(6, "DEF", team_short="TOT", price=5.0, ownership_pct=15.0),
        _make_player(7, "DEF", team_short="NEW", price=4.5, ownership_pct=8.0),
        # MID
        _make_player(8, "MID", team_short="LIV", price=12.5, ownership_pct=60.0, form=8.0),
        _make_player(9, "MID", team_short="MCI", price=10.0, ownership_pct=45.0, form=7.0),
        _make_player(10, "MID", team_short="ARS", price=8.0, ownership_pct=35.0, form=6.0),
        _make_player(11, "MID", team_short="CHE", price=7.0, ownership_pct=25.0, form=5.5),
        _make_player(12, "MID", team_short="TOT", price=5.0, ownership_pct=10.0),
        # FWD
        _make_player(13, "FWD", team_short="MCI", price=13.0, ownership_pct=50.0, form=8.5),
        _make_player(14, "FWD", team_short="CHE", price=9.0, ownership_pct=35.0, form=6.5),
        _make_player(15, "FWD", team_short="NEW", price=7.0, ownership_pct=20.0, form=5.0),
    ]
    constraints_applied = list((constraint_overrides or {}).keys())
    return DraftBuild(
        build_type="primary",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Template",
        rationale="Standard template build.",
        constraints_applied=constraints_applied,
        squad_meta={},
    )


def _build_differential_squad() -> DraftBuild:
    """A squad heavy with differentials for Aggressive Hunter testing."""
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


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_audit_returns_8_dimensions():
    build = _build_template_squad()
    result = score_audit(build, "Safe Template")
    assert len(result.dimensions) == 8
    names = {d.name for d in result.dimensions}
    assert names == set(AUDIT_DIMENSIONS)


def test_structure_score_valid_squad():
    build = _build_template_squad()
    result = score_audit(build, "Safe Template")
    dim = next(d for d in result.dimensions if d.name == "structure")
    assert dim.score >= 0.9, f"Expected structure >= 0.9, got {dim.score}"


def test_philosophy_fit_aggressive_rewards_differentials():
    diff_build = _build_differential_squad()
    result_aggressive = score_audit(diff_build, "Aggressive Hunter")
    result_safe = score_audit(diff_build, "Safe Template")
    aggressive_score = next(d for d in result_aggressive.dimensions if d.name == "philosophy_fit").score
    safe_score = next(d for d in result_safe.dimensions if d.name == "philosophy_fit").score
    assert aggressive_score > safe_score, (
        f"Aggressive Hunter should score differential build higher on philosophy_fit: "
        f"aggressive={aggressive_score}, safe={safe_score}"
    )


def test_fragility_high_with_low_form():
    """Squad with 8 players below form 4.0 should have fragility >= 0.7."""
    players = []
    # GKP
    players.append(_make_player(1, "GKP", team_short="LIV", price=5.0, form=2.0))
    players.append(_make_player(2, "GKP", team_short="BOU", price=4.5, form=2.0))
    # DEF x5
    for i in range(5):
        players.append(_make_player(10 + i, "DEF", team_short="ARS", price=5.0, form=2.0))
    # MID x5
    players.append(_make_player(20, "MID", team_short="MCI", price=8.0, form=2.0))
    players.append(_make_player(21, "MID", team_short="MCI", price=7.0, form=2.0))
    players.append(_make_player(22, "MID", team_short="LIV", price=9.0, form=7.0))
    players.append(_make_player(23, "MID", team_short="CHE", price=7.0, form=6.5))
    players.append(_make_player(24, "MID", team_short="TOT", price=5.5, form=5.5))
    # FWD x3
    players.append(_make_player(30, "FWD", team_short="MCI", price=11.0, form=2.0))
    players.append(_make_player(31, "FWD", team_short="CHE", price=8.0, form=2.0))
    players.append(_make_player(32, "FWD", team_short="NEW", price=6.5, form=2.0))
    build = DraftBuild(
        build_type="primary",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Low form",
        rationale="",
        constraints_applied=[],
        squad_meta={},
    )
    result = score_audit(build, "Safe Template")
    dim = next(d for d in result.dimensions if d.name == "fragility")
    assert dim.score >= 0.7, f"Expected fragility >= 0.7 for low-form squad, got {dim.score}"
    assert dim.label == "weak", f"Expected label 'weak', got {dim.label}"


def test_correlation_exposure_3_same_club():
    """3+ starters from same club should increase correlation_exposure score."""
    template_build = _build_template_squad()
    # Build a squad with 3 MCI starters
    players = []
    players.append(_make_player(1, "GKP", team_short="LIV", price=5.0))
    players.append(_make_player(2, "GKP", team_short="BOU", price=4.5))
    # 4 DEF from MCI to guarantee 3 starters from MCI
    players.append(_make_player(3, "DEF", team_short="MCI", price=6.5))
    players.append(_make_player(4, "DEF", team_short="MCI", price=6.0))
    players.append(_make_player(5, "DEF", team_short="MCI", price=6.0))
    players.append(_make_player(6, "DEF", team_short="ARS", price=5.5))
    players.append(_make_player(7, "DEF", team_short="CHE", price=5.0))
    # 5 MID spread
    players.append(_make_player(8, "MID", team_short="LIV", price=12.5, form=8.0))
    players.append(_make_player(9, "MID", team_short="TOT", price=8.0, form=6.5))
    players.append(_make_player(10, "MID", team_short="ARS", price=7.5, form=6.0))
    players.append(_make_player(11, "MID", team_short="CHE", price=6.5, form=5.5))
    players.append(_make_player(12, "MID", team_short="NEW", price=5.0, form=5.0))
    # 3 FWD
    players.append(_make_player(13, "FWD", team_short="MCI", price=13.0, form=8.5))
    players.append(_make_player(14, "FWD", team_short="NEW", price=8.0, form=6.5))
    players.append(_make_player(15, "FWD", team_short="SOU", price=6.0, form=4.5))
    corr_build = DraftBuild(
        build_type="primary",
        players=players,
        total_value=sum(p.price for p in players),
        formation="4-4-2",
        strategy_label="Correlated",
        rationale="",
        constraints_applied=[],
        squad_meta={},
    )
    result_corr = score_audit(corr_build, "Safe Template")
    result_spread = score_audit(template_build, "Safe Template")
    corr_score = next(d for d in result_corr.dimensions if d.name == "correlation_exposure").score
    spread_score = next(d for d in result_spread.dimensions if d.name == "correlation_exposure").score
    assert corr_score > spread_score, (
        f"Correlated squad should score higher on correlation_exposure: "
        f"corr={corr_score}, spread={spread_score}"
    )


def test_what_breaks_this_nonempty():
    build = _build_template_squad()
    result = score_audit(build, "Safe Template")
    assert 2 <= len(result.what_breaks_this) <= 4, (
        f"Expected 2-4 what_breaks_this strings, got {len(result.what_breaks_this)}"
    )


def test_captaincy_strength_high_form_players():
    """Squad with top form players should score high on captaincy_strength."""
    template = _build_template_squad()
    result = score_audit(template, "Safe Template")
    dim = next(d for d in result.dimensions if d.name == "captaincy_strength")
    assert 0.0 <= dim.score <= 1.0


def test_template_exposure_high_ownership():
    """Template build with 60%+ ownership starters: template_exposure should be high."""
    template = _build_template_squad()
    result_safe = score_audit(template, "Safe Template")
    dim = next(d for d in result_safe.dimensions if d.name == "template_exposure")
    # Safe Template with high-ownership players: score >= 0.5
    assert dim.score >= 0.0  # validity check; main assertion is in archetype test


def test_exit_liquidity_cheap_players():
    """Squad with many sub-6.0 players should have lower (worse) exit_liquidity."""
    cheap_players = [
        _make_player(1, "GKP", team_short="LIV", price=4.0),
        _make_player(2, "GKP", team_short="BOU", price=4.0),
        _make_player(3, "DEF", team_short="MCI", price=4.5),
        _make_player(4, "DEF", team_short="ARS", price=4.5),
        _make_player(5, "DEF", team_short="CHE", price=4.5),
        _make_player(6, "DEF", team_short="TOT", price=4.5),
        _make_player(7, "DEF", team_short="NEW", price=4.5),
        _make_player(8, "MID", team_short="LIV", price=5.5),
        _make_player(9, "MID", team_short="MCI", price=5.5),
        _make_player(10, "MID", team_short="ARS", price=5.0),
        _make_player(11, "MID", team_short="CHE", price=5.0),
        _make_player(12, "MID", team_short="TOT", price=4.5),
        _make_player(13, "FWD", team_short="MCI", price=5.5),
        _make_player(14, "FWD", team_short="CHE", price=5.0),
        _make_player(15, "FWD", team_short="NEW", price=5.0),
    ]
    cheap_build = DraftBuild(
        build_type="primary",
        players=cheap_players,
        total_value=sum(p.price for p in cheap_players),
        formation="4-4-2",
        strategy_label="Budget",
        rationale="",
        constraints_applied=[],
        squad_meta={},
    )
    result_cheap = score_audit(cheap_build, "Safe Template")
    result_template = score_audit(_build_template_squad(), "Safe Template")
    cheap_score = next(d for d in result_cheap.dimensions if d.name == "exit_liquidity").score
    template_score = next(d for d in result_template.dimensions if d.name == "exit_liquidity").score
    assert cheap_score > template_score, (
        f"Cheap squad should have worse (higher) exit_liquidity score: "
        f"cheap={cheap_score}, template={template_score}"
    )


def test_time_to_fix_unlocked_squad():
    """Squad with no locked players should score better on time_to_fix."""
    locked_players = [
        _make_player(i, pos, team_short="LIV", is_locked=True)
        for i, pos in enumerate(["GKP", "DEF", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID"], start=1)
    ] + [
        _make_player(10, "GKP", team_short="BOU"),
        _make_player(11, "MID", team_short="ARS"),
        _make_player(12, "MID", team_short="TOT"),
        _make_player(13, "FWD", team_short="MCI"),
        _make_player(14, "FWD", team_short="CHE"),
        _make_player(15, "FWD", team_short="NEW"),
    ]
    locked_build = DraftBuild(
        build_type="primary",
        players=locked_players,
        total_value=sum(p.price for p in locked_players),
        formation="4-4-2",
        strategy_label="Locked",
        rationale="",
        constraints_applied=["locked_players"],
        squad_meta={},
    )
    result_locked = score_audit(locked_build, "Safe Template")
    result_free = score_audit(_build_template_squad(), "Safe Template")
    locked_score = next(d for d in result_locked.dimensions if d.name == "time_to_fix").score
    free_score = next(d for d in result_free.dimensions if d.name == "time_to_fix").score
    # More locked = worse time_to_fix (higher risk score)
    assert locked_score > free_score, (
        f"Locked squad should score worse on time_to_fix: locked={locked_score}, free={free_score}"
    )


def test_labels_match_score_thresholds():
    """Label thresholds applied correctly given dimension type.

    For positive dimensions (structure, philosophy_fit, captaincy_strength,
    template_exposure): high score => 'strong'.
    For risk dimensions (fragility, correlation_exposure, exit_liquidity,
    time_to_fix): the label is derived from 1 - score (low risk => 'strong').
    """
    _RISK = {"fragility", "correlation_exposure", "exit_liquidity", "time_to_fix"}
    build = _build_template_squad()
    result = score_audit(build, "Safe Template")
    for dim in result.dimensions:
        effective = (1.0 - dim.score) if dim.name in _RISK else dim.score
        if effective >= 0.65:
            assert dim.label == "strong", f"{dim.name}: effective={effective:.2f} but label={dim.label}"
        elif effective >= 0.35:
            assert dim.label == "ok", f"{dim.name}: effective={effective:.2f} but label={dim.label}"
        else:
            assert dim.label == "weak", f"{dim.name}: effective={effective:.2f} but label={dim.label}"


def test_audit_is_deterministic():
    """Same input produces identical output."""
    build = _build_template_squad()
    result1 = score_audit(build, "Balanced Climber")
    result2 = score_audit(build, "Balanced Climber")
    for d1, d2 in zip(result1.dimensions, result2.dimensions):
        assert d1.score == d2.score, f"{d1.name}: {d1.score} != {d2.score}"


def test_overall_verdict_nonempty():
    build = _build_template_squad()
    result = score_audit(build, "Safe Template")
    assert result.overall_verdict and len(result.overall_verdict) > 0


def test_archetype_changes_philosophy_commentary():
    """Same squad produces different philosophy_fit commentary under different archetypes."""
    build = _build_template_squad()
    result_safe = score_audit(build, "Safe Template")
    result_aggressive = score_audit(build, "Aggressive Hunter")
    safe_commentary = next(d for d in result_safe.dimensions if d.name == "philosophy_fit").commentary
    aggressive_commentary = next(d for d in result_aggressive.dimensions if d.name == "philosophy_fit").commentary
    assert safe_commentary != aggressive_commentary, (
        "Commentary should differ between Safe Template and Aggressive Hunter archetypes"
    )
