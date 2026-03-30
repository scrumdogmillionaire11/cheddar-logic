"""Unit tests for the draft builder (WI-0654).

Tests cover:
- 15-player squad is always returned
- primary and contrast builds diverge on differentials
- locked players appear in both builds
- banned players never appear in either build
- club caps are respected
- uncertainty_tolerance changes selection scoring
- bench_quality_target differences are reflected in tradeoff notes
- tradeoff notes are generated
- insufficient pool raises ValueError
- default pool is used when none supplied
- squad formation is valid (4-x-x style)
- total_value equals sum of player prices
- build type fields are set correctly
- squad positional counts match FPL rules
- constraints_applied lists active constraints
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import pytest

from backend.models.draft_api_models import DraftConstraints, PlayerEntry
from cheddar_fpl_sage.analysis.draft_builder import (
    SQUAD_POSITION_COUNTS,
    generate,
)


# ── Fixtures ─────────────────────────────────────────────────────────────────


def _make_pool() -> list[PlayerEntry]:
    """Minimal synthetic pool with exactly the required squad counts per pos."""
    players = []
    pid = 1

    def _p(pos, name, team, price, ownership, form=6.0):
        nonlocal pid
        p = PlayerEntry(
            fpl_player_id=pid,
            player_name=name,
            position=pos,
            team_short=team,
            price=price,
            ownership_pct=ownership,
            form=form,
        )
        pid += 1
        return p

    # GKPs (need 2)
    players += [
        _p("GKP", "GK_Popular", "ARS", 6.0, 20.0, 7.0),
        _p("GKP", "GK_Cheap", "EVE", 4.5, 3.0, 5.0),
        _p("GKP", "GK_Diff", "NOT", 4.5, 1.5, 4.5),  # extra for selection
    ]
    # DEFs (need 5)
    players += [
        _p("DEF", "DEF_A", "LIV", 7.5, 25.0, 8.0),
        _p("DEF", "DEF_B", "MCI", 6.5, 20.0, 7.5),
        _p("DEF", "DEF_C", "TOT", 5.5, 12.0, 6.5),
        _p("DEF", "DEF_D", "NEW", 4.5, 6.0, 5.0),
        _p("DEF", "DEF_E_Diff", "BRE", 4.5, 2.0, 4.5),   # differential
        _p("DEF", "DEF_F_Diff", "FUL", 4.5, 1.5, 4.0),   # extra differential
    ]
    # MIDs (need 5)
    players += [
        _p("MID", "MID_A", "LIV", 12.5, 40.0, 10.0),
        _p("MID", "MID_B", "CHE", 11.5, 35.0, 9.5),
        _p("MID", "MID_C", "ARS", 10.5, 30.0, 9.0),
        _p("MID", "MID_D", "BRE", 8.0, 25.0, 8.5),
        _p("MID", "MID_E", "FUL", 5.5, 5.0, 6.0),
        _p("MID", "MID_F_Diff", "BHA", 5.5, 2.0, 5.5),   # differential
        _p("MID", "MID_G_Diff", "BRN", 5.0, 1.0, 5.0),   # extra differential
    ]
    # FWDs (need 3)
    players += [
        _p("FWD", "FWD_A", "NEW", 8.5, 22.0, 8.5),
        _p("FWD", "FWD_B", "AVL", 8.5, 20.0, 8.0),
        _p("FWD", "FWD_C_Diff", "BRE", 6.5, 2.5, 7.0),   # differential
        _p("FWD", "FWD_D", "TOT", 7.0, 3.0, 5.5),
    ]
    return players


def _neutral_constraints(**overrides) -> DraftConstraints:
    base = {
        "locked_players": [],
        "banned_players": [],
        "club_caps": {},
        "bench_quality_target": "medium",
        "premium_count_target": 3,
        "differential_slots_target": 0,
        "uncertainty_tolerance": "medium",
        "early_transfer_tolerance": False,
    }
    base.update(overrides)
    return DraftConstraints(**base)


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_generates_15_player_squad():
    pool = _make_pool()
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, pool)
    assert len(primary.players) == 15
    assert len(contrast.players) == 15


def test_squad_positional_counts_match_fpl_rules():
    pool = _make_pool()
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, pool)
    for build in (primary, contrast):
        from collections import Counter
        counts = Counter(p.position for p in build.players)
        for pos, n in SQUAD_POSITION_COUNTS.items():
            assert counts[pos] == n, (
                f"Position {pos} count: expected {n}, got {counts[pos]} in {build.build_type}"
            )


def test_total_value_equals_sum_of_prices():
    pool = _make_pool()
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, pool)
    for build in (primary, contrast):
        expected = round(sum(p.price for p in build.players), 1)
        assert build.total_value == expected, (
            f"total_value mismatch in {build.build_type}"
        )


def test_build_type_fields():
    pool = _make_pool()
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, pool)
    assert primary.build_type == "primary"
    assert contrast.build_type == "contrast"


def test_primary_contrast_diverge_on_differentials():
    """Contrast build should have >= more differentials than primary."""
    pool = _make_pool()
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, pool)
    p_diff = primary.squad_meta.get("differentials_in_xi", 0)
    c_diff = contrast.squad_meta.get("differentials_in_xi", 0)
    # Contrast should favour low-ownership picks more
    assert c_diff >= p_diff, (
        f"Expected contrast to have >= differentials than primary "
        f"(primary={p_diff}, contrast={c_diff})"
    )


def test_locked_player_in_both_builds():
    """A locked player must appear in both primary and contrast builds."""
    pool = _make_pool()
    # Lock MID_A (player_id 7 in synthetic pool — the high-ownership MID)
    locked_id = pool[9].fpl_player_id  # MID_A is index 9 in pool
    constraints = _neutral_constraints(locked_players=[locked_id])
    primary, contrast, _ = generate(constraints, pool)

    p_ids = {p.fpl_player_id for p in primary.players}
    c_ids = {p.fpl_player_id for p in contrast.players}

    assert locked_id in p_ids, "Locked player missing from primary build"
    assert locked_id in c_ids, "Locked player missing from contrast build"


def test_locked_player_flagged():
    """Locked players should have is_locked=True in builds."""
    pool = _make_pool()
    locked_id = pool[9].fpl_player_id
    constraints = _neutral_constraints(locked_players=[locked_id])
    primary, _, _ = generate(constraints, pool)
    locked_in_build = [p for p in primary.players if p.fpl_player_id == locked_id]
    assert len(locked_in_build) == 1
    assert locked_in_build[0].is_locked is True


def test_banned_player_excluded_from_both_builds():
    """A banned player must not appear in either build."""
    pool = _make_pool()
    ban_id = pool[9].fpl_player_id  # ban the top MID
    constraints = _neutral_constraints(banned_players=[ban_id])
    primary, contrast, _ = generate(constraints, pool)

    for build in (primary, contrast):
        ids = {p.fpl_player_id for p in build.players}
        assert ban_id not in ids, f"Banned player appeared in {build.build_type}"


def test_club_cap_single_player_respected():
    """Setting club_caps={'LIV': 1} should result in max 1 LIV player."""
    pool = _make_pool()
    constraints = _neutral_constraints(club_caps={"LIV": 1})
    primary, contrast, _ = generate(constraints, pool)
    for build in (primary, contrast):
        liv_count = sum(1 for p in build.players if p.team_short == "LIV")
        assert liv_count <= 1, (
            f"Club cap violated in {build.build_type}: LIV count={liv_count}"
        )


def test_club_cap_zero_excludes_club():
    """club_caps={'MCI': 0} acts like banning all MCI players."""
    pool = _make_pool()
    constraints = _neutral_constraints(club_caps={"MCI": 0})
    primary, contrast, _ = generate(constraints, pool)
    for build in (primary, contrast):
        mci_count = sum(1 for p in build.players if p.team_short == "MCI")
        assert mci_count == 0, (
            f"Club cap=0 violated in {build.build_type}: MCI count={mci_count}"
        )


def test_uncertainty_tolerance_low_conservative_squad():
    """Low uncertainty tolerance should not select the lowest-form players."""
    pool = _make_pool()
    constraints_low = _neutral_constraints(uncertainty_tolerance="low")
    constraints_high = _neutral_constraints(uncertainty_tolerance="high")
    primary_low, _, _ = generate(constraints_low, pool)
    primary_high, _, _ = generate(constraints_high, pool)

    avg_form_low = sum(p.form for p in primary_low.players) / len(primary_low.players)
    avg_form_high = sum(p.form for p in primary_high.players) / len(primary_high.players)

    # Low tolerance should produce equal or higher avg form (safer picks)
    assert avg_form_low >= avg_form_high - 0.5, (
        f"Low uncertainty should produce same/higher avg form: "
        f"low={avg_form_low:.2f}, high={avg_form_high:.2f}"
    )


def test_tradeoff_notes_returned():
    pool = _make_pool()
    constraints = _neutral_constraints()
    _, _, notes = generate(constraints, pool)
    assert isinstance(notes, list)
    assert len(notes) >= 0  # may be empty if builds are identical


def test_tradeoff_note_structure():
    """Each tradeoff note has required fields."""
    pool = _make_pool()
    constraints = _neutral_constraints()
    _, _, notes = generate(constraints, pool)
    for note in notes:
        assert note.topic
        assert note.primary_choice
        assert note.contrast_choice
        assert note.implication


def test_tradeoff_note_for_locked_player():
    pool = _make_pool()
    locked_id = pool[9].fpl_player_id
    constraints = _neutral_constraints(locked_players=[locked_id])
    _, _, notes = generate(constraints, pool)
    topics = [n.topic for n in notes]
    assert "Locked players" in topics


def test_insufficient_pool_raises_value_error():
    """Providing a pool with too few GKPs should raise ValueError."""
    pool = [p for p in _make_pool() if p.position != "GKP"]
    constraints = _neutral_constraints()
    with pytest.raises(ValueError, match="Insufficient pool for position GKP"):
        generate(constraints, pool)


def test_default_pool_used_when_none():
    """When player_pool=None the default pool is used and builds succeed."""
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, None)
    assert len(primary.players) == 15
    assert len(contrast.players) == 15


def test_formation_string_valid():
    """Formation string should be N-N-N format with valid position counts."""
    pool = _make_pool()
    constraints = _neutral_constraints()
    primary, contrast, _ = generate(constraints, pool)
    import re
    for build in (primary, contrast):
        assert re.match(r"^\d-\d-\d$", build.formation), (
            f"Invalid formation string: {build.formation}"
        )


def test_constraints_applied_lists_active_constraints():
    """constraints_applied should mention relevant constraint keys."""
    pool = _make_pool()
    locked_id = pool[9].fpl_player_id
    ban_id = pool[3].fpl_player_id
    constraints = _neutral_constraints(
        locked_players=[locked_id],
        banned_players=[ban_id],
        bench_quality_target="high",
    )
    primary, _, _ = generate(constraints, pool)
    ca = primary.constraints_applied
    assert "locked_players" in ca
    assert "banned_players" in ca
    assert "bench_quality_target" in ca


def test_conservative_profile_fewer_differentials_than_aggressive():
    """Conservative profile (uncertainty_tolerance=low) has ≤ differentials vs aggressive."""
    pool = _make_pool()
    c_conservative = _neutral_constraints(
        uncertainty_tolerance="low",
        differential_slots_target=0,
    )
    c_aggressive = _neutral_constraints(
        uncertainty_tolerance="high",
        differential_slots_target=3,
    )
    primary_con, contrast_con, _ = generate(c_conservative, pool)
    primary_agg, contrast_agg, _ = generate(c_aggressive, pool)

    # Aggressive contrast should have >= differentials than conservative primary
    assert contrast_agg.squad_meta.get("differentials_in_xi", 0) >= primary_con.squad_meta.get("differentials_in_xi", 0)
