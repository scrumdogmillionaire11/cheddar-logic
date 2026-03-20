"""
Invariant harness for the chip_engine foundation (WI-0513).

Covers:
  - One chip per GW (FIRE gated by chips_available)
  - WATCH requires watch_until > current_gw
  - Forced decisions require forced_by; PASS/WATCH must not carry forced_by
  - reason_codes always populated
  - Force logic never bypasses hard vetoes (unavailable chip)
  - Horizon suppression: a would-be FIRE is capped to WATCH when a
    materially better window is imminent
  - Score clamping
  - Horizon penalty shape
  - validate_decision raises on each violation
"""

import pytest

from cheddar_fpl_sage.analysis.decision_framework.chip_engine import (
    ChipAction,
    ChipDecision,
    GameweekState,
    better_window_ahead,
    clamp_score,
    horizon_adjusted_score,
    normalise_force_escalation,
    suppress_or_fire,
    validate_decision,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _state(
    current_gw: int = 20,
    total_gws: int = 38,
    chips_available=("Wildcard",),
    chips_used=(),
    window_scores=None,
    risk_posture: str = "BALANCED",
) -> GameweekState:
    if window_scores is None:
        window_scores = ((current_gw, 50.0),)
    return GameweekState(
        current_gw=current_gw,
        total_gws=total_gws,
        chips_available=frozenset(chips_available),
        chips_used=frozenset(chips_used),
        window_scores=tuple(window_scores),
        risk_posture=risk_posture,
    )


def _valid_fire(chip: str = "Wildcard") -> ChipDecision:
    return ChipDecision(
        action=ChipAction.FIRE,
        chip_type=chip,
        reason_codes=["good_window"],
    )


def _valid_watch(chip: str = "Wildcard", watch_until: int = 25) -> ChipDecision:
    return ChipDecision(
        action=ChipAction.WATCH,
        chip_type=chip,
        reason_codes=["better_window_imminent"],
        watch_until=watch_until,
    )


def _valid_pass(chip: str = "Wildcard") -> ChipDecision:
    return ChipDecision(
        action=ChipAction.PASS,
        chip_type=chip,
        reason_codes=["low_value_window"],
    )


# ===========================================================================
# validate_decision invariants
# ===========================================================================

class TestValidateDecisionInvariants:
    """validate_decision must raise ValueError for each violated invariant."""

    def test_valid_fire_passes(self):
        state = _state(chips_available=("Wildcard",))
        validate_decision(_valid_fire("Wildcard"), state)  # no raise

    def test_valid_watch_passes(self):
        state = _state(current_gw=20, chips_available=("Wildcard",))
        validate_decision(_valid_watch("Wildcard", watch_until=25), state)  # no raise

    def test_valid_pass_passes(self):
        state = _state(chips_available=("Wildcard",))
        validate_decision(_valid_pass("Wildcard"), state)  # no raise

    # Invariant 1: reason_codes must be non-empty
    def test_empty_reason_codes_raises(self):
        state = _state(chips_available=("Wildcard",))
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type="Wildcard",
            reason_codes=[],
        )
        with pytest.raises(ValueError, match="reason_codes"):
            validate_decision(decision, state)

    # Invariant 2: WATCH requires watch_until
    def test_watch_without_watch_until_raises(self):
        state = _state(current_gw=20, chips_available=("Wildcard",))
        decision = ChipDecision(
            action=ChipAction.WATCH,
            chip_type="Wildcard",
            reason_codes=["something"],
            watch_until=None,
        )
        with pytest.raises(ValueError, match="watch_until"):
            validate_decision(decision, state)

    def test_watch_with_watch_until_not_greater_than_current_gw_raises(self):
        state = _state(current_gw=20, chips_available=("Wildcard",))
        decision = ChipDecision(
            action=ChipAction.WATCH,
            chip_type="Wildcard",
            reason_codes=["something"],
            watch_until=20,  # equal to current_gw — not strictly greater
        )
        with pytest.raises(ValueError, match="watch_until"):
            validate_decision(decision, state)

    def test_watch_with_past_watch_until_raises(self):
        state = _state(current_gw=20, chips_available=("Wildcard",))
        decision = ChipDecision(
            action=ChipAction.WATCH,
            chip_type="Wildcard",
            reason_codes=["something"],
            watch_until=15,  # in the past
        )
        with pytest.raises(ValueError, match="watch_until"):
            validate_decision(decision, state)

    # Invariant 3 & 4: forced_by set ↔ action is FIRE
    def test_forced_by_set_on_pass_raises(self):
        state = _state(chips_available=("Wildcard",))
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type="Wildcard",
            reason_codes=["something"],
            forced_by="some_rule",
        )
        with pytest.raises(ValueError, match="forced_by"):
            validate_decision(decision, state)

    def test_forced_by_set_on_watch_raises(self):
        state = _state(current_gw=20, chips_available=("Wildcard",))
        decision = ChipDecision(
            action=ChipAction.WATCH,
            chip_type="Wildcard",
            reason_codes=["something"],
            watch_until=25,
            forced_by="some_rule",
        )
        with pytest.raises(ValueError, match="forced_by"):
            validate_decision(decision, state)

    # Invariant 5: FIRE requires chip in chips_available
    def test_fire_chip_not_available_raises(self):
        """One chip per GW: if chip is already used, FIRE must be rejected."""
        state = _state(chips_available=("Free Hit",))  # Wildcard NOT available
        decision = ChipDecision(
            action=ChipAction.FIRE,
            chip_type="Wildcard",
            reason_codes=["good_window"],
        )
        with pytest.raises(ValueError, match="chips_available"):
            validate_decision(decision, state)

    def test_fire_with_no_chips_available_raises(self):
        state = _state(chips_available=())  # ALL chips used
        decision = ChipDecision(
            action=ChipAction.FIRE,
            chip_type="Wildcard",
            reason_codes=["good_window"],
        )
        with pytest.raises(ValueError, match="chips_available"):
            validate_decision(decision, state)


# ===========================================================================
# clamp_score
# ===========================================================================

class TestClampScore:
    def test_within_range_unchanged(self):
        assert clamp_score(50.0, 0.0, 100.0) == 50.0

    def test_below_lo_clamped_to_lo(self):
        assert clamp_score(-5.0, 0.0, 100.0) == 0.0

    def test_above_hi_clamped_to_hi(self):
        assert clamp_score(120.0, 0.0, 100.0) == 100.0

    def test_at_lo_boundary(self):
        assert clamp_score(0.0, 0.0, 100.0) == 0.0

    def test_at_hi_boundary(self):
        assert clamp_score(100.0, 0.0, 100.0) == 100.0

    def test_lo_gt_hi_raises(self):
        with pytest.raises(ValueError):
            clamp_score(50.0, 90.0, 10.0)


# ===========================================================================
# horizon_adjusted_score / horizon_penalty
# ===========================================================================

class TestHorizonAdjustedScore:
    def test_late_season_no_discount(self):
        """GW 30 of 38 is past the ramp-start; score is unchanged."""
        raw = 70.0
        adjusted = horizon_adjusted_score(raw, gw=30, total_gws=38)
        assert abs(adjusted - raw) < 0.01

    def test_early_season_score_discounted(self):
        """GW 1 of 38 should produce a discounted score."""
        raw = 70.0
        adjusted = horizon_adjusted_score(raw, gw=1, total_gws=38)
        assert adjusted < raw

    def test_gw1_discount_at_least_min_multiplier(self):
        """GW 1 discount never exceeds _HORIZON_MIN_MULTIPLIER (0.60) reduction."""
        from cheddar_fpl_sage.analysis.decision_framework.chip_engine.shared import (
            _HORIZON_MIN_MULTIPLIER,
        )
        raw = 100.0
        adjusted = horizon_adjusted_score(raw, gw=1, total_gws=38)
        assert adjusted >= raw * _HORIZON_MIN_MULTIPLIER - 0.001

    def test_monotone_increasing_discount(self):
        """Later gameweeks should never produce lower adjusted scores given same base."""
        raw = 60.0
        scores = [horizon_adjusted_score(raw, gw=gw, total_gws=38) for gw in range(1, 39)]
        for i in range(len(scores) - 1):
            assert scores[i] <= scores[i + 1] + 0.001, (
                f"Score decreased from GW {i+1} to GW {i+2}"
            )


# ===========================================================================
# better_window_ahead
# ===========================================================================

class TestBetterWindowAhead:
    def test_no_future_windows_returns_none(self):
        assert better_window_ahead(60.0, ()) is None

    def test_future_not_materially_better_returns_none(self):
        # 62 / 60 = 1.033 — below the 10 % threshold
        result = better_window_ahead(60.0, ((25, 62.0),), threshold=0.10)
        assert result is None

    def test_future_materially_better_returns_best_gw(self):
        # 70 / 60 = 1.167 — above 10 % threshold
        result = better_window_ahead(60.0, ((25, 70.0), (28, 65.0)), threshold=0.10)
        assert result == (25, 70.0)

    def test_returns_highest_future_score(self):
        # GW 28 = 80 is materially better than current 60
        result = better_window_ahead(60.0, ((25, 70.0), (28, 80.0)), threshold=0.10)
        assert result is not None
        assert result[0] == 28

    def test_exact_threshold_boundary(self):
        # 66.0 / 60.0 = 1.10 — exactly at threshold: should count
        result = better_window_ahead(60.0, ((25, 66.0),), threshold=0.10)
        assert result == (25, 66.0)


# ===========================================================================
# suppress_or_fire
# ===========================================================================

class TestSuppressOrFire:
    def test_pass_action_passes_through(self):
        state = _state(current_gw=20, window_scores=((20, 60.0), (25, 80.0)))
        action, watch_until, _, _, extras = suppress_or_fire(
            ChipAction.PASS, state, current_score=60.0
        )
        assert action is ChipAction.PASS
        assert watch_until is None
        assert extras == []

    def test_watch_action_passes_through(self):
        state = _state(current_gw=20, window_scores=((20, 60.0), (25, 80.0)))
        action, watch_until, _, _, extras = suppress_or_fire(
            ChipAction.WATCH, state, current_score=60.0
        )
        assert action is ChipAction.WATCH
        assert watch_until is None

    def test_fire_suppressed_to_watch_when_better_window_exists(self):
        """
        Key horizon-suppression test.
        Current window score = 55; future window at GW 28 scores 75.
        75 / 55 = 1.36 — materially better → FIRE must become WATCH.
        """
        state = _state(
            current_gw=20,
            window_scores=((20, 55.0), (28, 75.0)),
        )
        action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
            ChipAction.FIRE, state, current_score=55.0
        )
        assert action is ChipAction.WATCH, (
            "Expected FIRE to be suppressed to WATCH but got %s" % action
        )
        assert watch_until == 28
        assert best_future_score == pytest.approx(75.0)
        assert "better_window_imminent" in extras

    def test_fire_not_suppressed_when_no_materially_better_window(self):
        state = _state(
            current_gw=20,
            window_scores=((20, 70.0), (28, 72.0)),  # 72/70 = 1.03 < 10 %
        )
        action, watch_until, _, _, extras = suppress_or_fire(
            ChipAction.FIRE, state, current_score=70.0
        )
        assert action is ChipAction.FIRE
        assert watch_until is None
        assert extras == []

    def test_fire_not_suppressed_when_no_future_windows(self):
        state = _state(current_gw=38, window_scores=((38, 70.0),))  # last GW
        action, _, _, _, _ = suppress_or_fire(
            ChipAction.FIRE, state, current_score=70.0
        )
        assert action is ChipAction.FIRE


# ===========================================================================
# normalise_force_escalation (hard-veto)
# ===========================================================================

class TestNormaliseForceEscalation:
    def test_not_forced_returns_decision_unchanged(self):
        state = _state(chips_available=("Wildcard",))
        base = _valid_pass("Wildcard")
        result = normalise_force_escalation(
            base, is_forced=False, forced_by_label="any", chip_type="Wildcard", state=state
        )
        assert result.action is ChipAction.PASS

    def test_forced_with_available_chip_returns_fire(self):
        state = _state(chips_available=("Wildcard",))
        base = _valid_watch("Wildcard", watch_until=25)
        result = normalise_force_escalation(
            base,
            is_forced=True,
            forced_by_label="season_horizon_last_window",
            chip_type="Wildcard",
            state=state,
        )
        assert result.action is ChipAction.FIRE
        assert result.forced_by == "season_horizon_last_window"
        assert result.watch_until is None
        assert any("season_horizon_last_window" in r for r in result.reason_codes)

    def test_force_vetoed_when_chip_unavailable(self):
        """Force must NEVER override when chip is already used (hard veto)."""
        state = _state(chips_available=("Free Hit",))  # Wildcard NOT available
        base = _valid_pass("Wildcard")
        result = normalise_force_escalation(
            base,
            is_forced=True,
            forced_by_label="season_horizon_last_window",
            chip_type="Wildcard",
            state=state,
        )
        assert result.action is ChipAction.PASS, (
            "Force must not bypass hard veto: chip is unavailable"
        )
        assert result.forced_by is None
        assert "chip_unavailable" in result.reason_codes
        assert "force_vetoed" in result.reason_codes

    def test_force_vetoed_when_all_chips_used(self):
        """Same veto when chips_available is empty."""
        state = _state(chips_available=())
        base = _valid_pass("Wildcard")
        result = normalise_force_escalation(
            base,
            is_forced=True,
            forced_by_label="some_rule",
            chip_type="Wildcard",
            state=state,
        )
        assert result.action is ChipAction.PASS
        assert "chip_unavailable" in result.reason_codes

    def test_forced_decision_passes_validate_decision(self):
        """A correctly forced decision must pass the full invariant check."""
        state = _state(chips_available=("Wildcard",))
        base = _valid_pass("Wildcard")
        result = normalise_force_escalation(
            base,
            is_forced=True,
            forced_by_label="test_rule",
            chip_type="Wildcard",
            state=state,
        )
        validate_decision(result, state)  # must not raise

    def test_vetoed_decision_passes_validate_decision(self):
        """A vetoed force decision must also pass the invariant check."""
        state = _state(chips_available=("Free Hit",))
        base = _valid_pass("Wildcard")
        result = normalise_force_escalation(
            base,
            is_forced=True,
            forced_by_label="test_rule",
            chip_type="Wildcard",
            state=state,
        )
        validate_decision(result, state)  # must not raise


# ===========================================================================
# End-to-end: horizon suppression caps FIRE to WATCH, passes invariants
# ===========================================================================

class TestHorizonSuppressionEndToEnd:
    """
    Acceptance test: a would-be FIRE is downgraded to WATCH when a
    materially better window is imminent, and the resulting decision
    passes all invariant checks.
    """

    def test_fire_capped_to_watch_passes_all_invariants(self):
        state = GameweekState(
            current_gw=18,
            total_gws=38,
            chips_available=frozenset({"Wildcard"}),
            chips_used=frozenset(),
            window_scores=((18, 50.0), (24, 70.0)),  # GW 24 is 40 % better
        )

        # Simulate evaluator proposing FIRE
        proposed_action = ChipAction.FIRE
        current_score = 50.0

        action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
            proposed_action, state, current_score=current_score
        )

        assert action is ChipAction.WATCH
        assert watch_until == 24

        # Build a valid ChipDecision from suppression output
        decision = ChipDecision(
            action=action,
            chip_type="Wildcard",
            reason_codes=["good_squad_depth"] + extras,
            watch_until=watch_until,
            current_window_score=current_score,
            best_future_window_score=best_future_score,
            best_future_window_gw=best_future_gw,
        )

        # Must pass all invariants
        validate_decision(decision, state)

        assert "better_window_imminent" in decision.reason_codes
        assert decision.watch_until == 24


# ===========================================================================
# GameweekState construction guards
# ===========================================================================

class TestGameweekStateGuards:
    def test_invalid_gw_below_one_raises(self):
        with pytest.raises(ValueError):
            GameweekState(
                current_gw=0,
                total_gws=38,
                chips_available=frozenset(),
                chips_used=frozenset(),
                window_scores=(),
            )

    def test_invalid_gw_above_total_raises(self):
        with pytest.raises(ValueError):
            GameweekState(
                current_gw=39,
                total_gws=38,
                chips_available=frozenset(),
                chips_used=frozenset(),
                window_scores=(),
            )

    def test_valid_boundary_gw38_passes(self):
        state = GameweekState(
            current_gw=38,
            total_gws=38,
            chips_available=frozenset(),
            chips_used=frozenset(),
            window_scores=((38, 60.0),),
        )
        assert state.current_gw == 38
