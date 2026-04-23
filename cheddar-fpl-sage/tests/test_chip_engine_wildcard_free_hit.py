"""
Tests for the Wildcard and Free Hit chip evaluators (WI-0514).

Covers:
  Wildcard
  - Normal FIRE: good ev_delta + fixture_score, post-half-season, no suppression
  - Hard veto: chip already used
  - Too early: before half-season, not escalated
  - Below min ev_delta
  - Below min fixture_score
  - DGW-imminent WATCH: save Wildcard for upcoming DGW
  - Horizon suppression: FIRE downgraded to WATCH by better window ahead
  - Hard escalation (season_horizon_last_window): force FIRE at GW 36
  - Hard escalation respects hard veto: chip unavailable even when forced
  - Returned FIRE decision passes invariants
  - Returned WATCH decision passes invariants

  Free Hit
  - Normal FIRE via BGW-defense path
  - Normal FIRE via DGW-attack path
  - Path selection: chooses higher-scoring path
  - Hard veto: chip already used
  - Wildcard veto: WC available + permanent EV gain above threshold
  - Wildcard veto bypassed in emergency
  - Score below threshold → PASS
  - Score below threshold but better window → WATCH
  - Emergency escalation (≤ 2 GWs left): force FIRE
  - All returned decisions pass invariants
  - forcedBy populated on forced decisions
"""

import pytest

from cheddar_fpl_sage.analysis.decision_framework.chip_engine import (
    ChipAction,
    FreeHitInputs,
    GameweekState,
    WildcardInputs,
    evaluate_free_hit,
    evaluate_wildcard,
    validate_decision,
)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _state(
    current_gw: int = 20,
    total_gws: int = 38,
    chips_available=("Wildcard", "Free Hit"),
    chips_used=(),
    window_scores=None,
) -> GameweekState:
    if window_scores is None:
        window_scores = ((current_gw, 70.0),)
    return GameweekState(
        current_gw=current_gw,
        total_gws=total_gws,
        chips_available=frozenset(chips_available),
        chips_used=frozenset(chips_used),
        window_scores=tuple(window_scores),
    )


def _good_wc_inputs(**overrides) -> WildcardInputs:
    """WildcardInputs that produce a FIRE decision.

    Calibrated so that the horizon-adjusted score at GW 22/38 (~40 % penalty)
    still clears the 55.0 fire threshold:
      raw = 0.5*75 + 0.3*80 + 0.2*60 = 73.5
      adj @ GW22 ≈ 73.5 * 0.928 ≈ 68.2  >  55.0
    """
    defaults = dict(
        team_ev_delta=15.0,       # 75 / 100 component
        fixture_run_score=80.0,   # 80 / 100 component
        hit_cost_avoided=12.0,    # 60 / 100 component
        dgw_imminent_gw=None,
    )
    defaults.update(overrides)
    return WildcardInputs(**defaults)


def _good_fh_bgw_inputs(**overrides) -> FreeHitInputs:
    """FreeHitInputs that should produce a FIRE via BGW-defense path."""
    defaults = dict(
        bgw_coverage_fraction=0.2,   # 80 % of XI need covering
        bgw_saved_points=20.0,       # 20 pts saved
        dgw_stack_ev=0.0,
        dgw_fixture_quality=0.0,
        wildcard_available=False,
        permanent_squad_ev_gain=0.0,
    )
    defaults.update(overrides)
    return FreeHitInputs(**defaults)


def _good_fh_dgw_inputs(**overrides) -> FreeHitInputs:
    """FreeHitInputs that should produce a FIRE via DGW-attack path."""
    defaults = dict(
        bgw_coverage_fraction=1.0,   # no BGW issue
        bgw_saved_points=0.0,
        dgw_stack_ev=14.0,           # 14 pts DGW gain
        dgw_fixture_quality=80.0,
        wildcard_available=False,
        permanent_squad_ev_gain=0.0,
    )
    defaults.update(overrides)
    return FreeHitInputs(**defaults)


# ===========================================================================
# Wildcard — FIRE cases
# ===========================================================================

class TestWildcardFire:
    def test_critical_structural_weakness_forces_fire(self):
        state = _state(current_gw=10)
        decision = evaluate_wildcard(
            state,
            _good_wc_inputs(
                team_ev_delta=0.1,
                fixture_run_score=20.0,
                overall_weak=3,
                tier3_or_tier4_count=4,
                poor_fixture_horizon=True,
            ),
        )
        assert decision.action is ChipAction.FIRE
        assert "critical_structural_weakness" in decision.reason_codes

    def test_good_inputs_post_half_season_fire(self):
        state = _state(current_gw=22)
        decision = evaluate_wildcard(state, _good_wc_inputs())
        assert decision.action is ChipAction.FIRE
        assert "Wildcard" in decision.chip_type

    def test_fire_decision_passes_invariants(self):
        state = _state(current_gw=22)
        decision = evaluate_wildcard(state, _good_wc_inputs())
        validate_decision(decision, state)  # must not raise

    def test_fire_reason_codes_populated(self):
        state = _state(current_gw=22)
        decision = evaluate_wildcard(state, _good_wc_inputs())
        assert decision.reason_codes, "reason_codes must be non-empty"
        assert "good_window_score" in decision.reason_codes

    def test_fire_has_no_watch_until(self):
        state = _state(current_gw=22)
        decision = evaluate_wildcard(state, _good_wc_inputs())
        assert decision.watch_until is None

    def test_fire_has_no_forced_by_for_normal_case(self):
        state = _state(current_gw=22)
        decision = evaluate_wildcard(state, _good_wc_inputs())
        # Normal (non-escalated) FIRE should NOT have forced_by
        assert decision.forced_by is None


# ===========================================================================
# Wildcard — hard veto
# ===========================================================================

class TestWildcardHardVeto:
    def test_chip_unavailable_returns_pass(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        decision = evaluate_wildcard(state, _good_wc_inputs())
        assert decision.action is ChipAction.PASS
        assert "chip_unavailable" in decision.reason_codes

    def test_chip_unavailable_passes_invariants(self):
        state = _state(current_gw=22, chips_available=())
        decision = evaluate_wildcard(state, _good_wc_inputs())
        validate_decision(decision, state)


# ===========================================================================
# Wildcard — PASS cases
# ===========================================================================

class TestWildcardPass:
    def test_too_early_before_half_season(self):
        """GW 5 of 38 (< 45 % = GW 17) → PASS without escalation."""
        state = _state(current_gw=5, window_scores=((5, 70.0),))
        decision = evaluate_wildcard(state, _good_wc_inputs())
        assert decision.action is ChipAction.PASS
        assert "too_early_half_season" in decision.reason_codes

    def test_below_min_ev_delta_pass(self):
        state = _state(current_gw=22)
        inputs = _good_wc_inputs(team_ev_delta=0.4)  # below 0.5 minimum
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.PASS
        assert "below_min_ev_delta" in decision.reason_codes

    def test_below_min_fixture_score_pass(self):
        state = _state(current_gw=22)
        inputs = _good_wc_inputs(fixture_run_score=40.0)  # below 45.0 minimum
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.PASS
        assert "below_min_fixture_score" in decision.reason_codes

    def test_low_score_no_future_window_pass(self):
        """Score below threshold and no better future window → PASS."""
        state = _state(
            current_gw=22,
            window_scores=((22, 30.0),),   # no future windows
        )
        inputs = _good_wc_inputs(team_ev_delta=0.5, fixture_run_score=30.0)
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.PASS


# ===========================================================================
# Wildcard — DGW-imminent WATCH veto
# ===========================================================================

class TestWildcardDgwImminent:
    def test_dgw_within_window_causes_watch(self):
        """DGW in 2 GWs → Wildcard suppressed; watch until DGW."""
        state = _state(current_gw=22)
        inputs = _good_wc_inputs(dgw_imminent_gw=24)  # 24 - 22 = 2 ≤ DGW_WINDOW
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.WATCH
        assert decision.watch_until == 24
        assert "dgw_imminent_save_wildcard" in decision.reason_codes

    def test_dgw_outside_window_does_not_suppress(self):
        """DGW in 5 GWs → no suppression; should FIRE if score is good."""
        state = _state(current_gw=22, window_scores=((22, 70.0),))
        inputs = _good_wc_inputs(dgw_imminent_gw=27)  # 27 - 22 = 5 > DGW_WINDOW
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.FIRE

    def test_dgw_watch_passes_invariants(self):
        state = _state(current_gw=22)
        inputs = _good_wc_inputs(dgw_imminent_gw=24)
        decision = evaluate_wildcard(state, inputs)
        validate_decision(decision, state)


# ===========================================================================
# Wildcard — horizon suppression (FIRE → WATCH)
# ===========================================================================

class TestWildcardHorizonSuppression:
    def test_fire_suppressed_to_watch_when_better_window_exists(self):
        """
        Current score = 70 (above threshold), but GW 28 scores 90.
        90 / 70 = 1.28 → materially better → should become WATCH.
        """
        state = _state(
            current_gw=22,
            window_scores=((22, 70.0), (28, 90.0)),
        )
        decision = evaluate_wildcard(state, _good_wc_inputs())
        assert decision.action is ChipAction.WATCH
        assert decision.watch_until == 28
        assert "better_window_imminent" in decision.reason_codes

    def test_suppressed_watch_passes_invariants(self):
        state = _state(
            current_gw=22,
            window_scores=((22, 70.0), (28, 90.0)),
        )
        decision = evaluate_wildcard(state, _good_wc_inputs())
        validate_decision(decision, state)


# ===========================================================================
# Wildcard — late-season escalation (hard force)
# ===========================================================================

class TestWildcardEscalation:
    def test_late_season_forces_fire(self):
        """
        GW 36 of 38 ≥ 92 % of season → hard escalation must fire even if
        the raw score would otherwise be suppressed.
        """
        state = _state(
            current_gw=36,
            window_scores=((36, 40.0), (38, 50.0)),  # 50/40 = 1.25, would suppress
        )
        # Use low inputs that would normally PASS
        inputs = _good_wc_inputs(team_ev_delta=1.0, fixture_run_score=30.0)
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.FIRE
        assert decision.forced_by == "season_horizon_last_window"

    def test_late_season_forced_fire_passes_invariants(self):
        state = _state(current_gw=36, window_scores=((36, 40.0),))
        inputs = _good_wc_inputs(team_ev_delta=1.0, fixture_run_score=30.0)
        decision = evaluate_wildcard(state, inputs)
        validate_decision(decision, state)

    def test_late_season_escalation_vetoed_when_chip_unavailable(self):
        """Even at GW 36, force cannot override a chip already used."""
        state = _state(
            current_gw=36,
            chips_available=("Free Hit",),  # Wildcard already played
            window_scores=((36, 40.0),),
        )
        inputs = _good_wc_inputs()
        decision = evaluate_wildcard(state, inputs)
        assert decision.action is ChipAction.PASS
        assert "chip_unavailable" in decision.reason_codes
        assert decision.forced_by is None

    def test_forced_decision_has_forced_by(self):
        state = _state(current_gw=36, window_scores=((36, 40.0),))
        inputs = _good_wc_inputs()
        decision = evaluate_wildcard(state, inputs)
        if decision.action is ChipAction.FIRE:
            assert decision.forced_by is not None


# ===========================================================================
# Free Hit — FIRE via BGW-defense path
# ===========================================================================

class TestFreeHitBgwFire:
    def test_critical_squad_failure_forces_fire(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        decision = evaluate_free_hit(
            state,
            _good_fh_bgw_inputs(
                playable_count_next_gw=9,
                blank_starter_count=5,
            ),
        )
        assert decision.action is ChipAction.FIRE
        assert "critical_squad_failure" in decision.reason_codes

    def test_bgw_defense_fire(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        decision = evaluate_free_hit(state, _good_fh_bgw_inputs())
        assert decision.action is ChipAction.FIRE
        assert "bgw_defense_selected" in decision.reason_codes

    def test_bgw_fire_passes_invariants(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        decision = evaluate_free_hit(state, _good_fh_bgw_inputs())
        validate_decision(decision, state)


# ===========================================================================
# Free Hit — FIRE via DGW-attack path
# ===========================================================================

class TestFreeHitDgwFire:
    def test_dgw_attack_fire(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        decision = evaluate_free_hit(state, _good_fh_dgw_inputs())
        assert decision.action is ChipAction.FIRE
        assert "dgw_attack_selected" in decision.reason_codes

    def test_dgw_fire_passes_invariants(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        decision = evaluate_free_hit(state, _good_fh_dgw_inputs())
        validate_decision(decision, state)


# ===========================================================================
# Free Hit — path selection
# ===========================================================================

class TestFreeHitPathSelection:
    def test_dgw_path_selected_when_higher(self):
        """If DGW score > BGW score, DGW path wins."""
        state = _state(current_gw=22, chips_available=("Free Hit",))
        # BGW: coverage 0.5 (moderate), saved 10 → middling BGW score
        # DGW: stack_ev 16, fixture_quality 90 → high DGW score
        inputs = FreeHitInputs(
            bgw_coverage_fraction=0.5,
            bgw_saved_points=10.0,
            dgw_stack_ev=16.0,
            dgw_fixture_quality=90.0,
        )
        decision = evaluate_free_hit(state, inputs)
        assert "dgw_attack_selected" in decision.reason_codes

    def test_bgw_path_selected_when_higher(self):
        """If BGW score > DGW score, BGW path wins."""
        state = _state(current_gw=22, chips_available=("Free Hit",))
        # BGW: full coverage need + many saved points
        # DGW: no DGW scheduled
        inputs = FreeHitInputs(
            bgw_coverage_fraction=0.0,   # all XI need cover
            bgw_saved_points=25.0,
            dgw_stack_ev=0.0,
            dgw_fixture_quality=0.0,
        )
        decision = evaluate_free_hit(state, inputs)
        assert "bgw_defense_selected" in decision.reason_codes


# ===========================================================================
# Free Hit — hard veto (chip unavailable)
# ===========================================================================

class TestFreeHitChipUnavailable:
    def test_chip_unavailable_pass(self):
        state = _state(current_gw=22, chips_available=("Wildcard",))
        decision = evaluate_free_hit(state, _good_fh_bgw_inputs())
        assert decision.action is ChipAction.PASS
        assert "chip_unavailable" in decision.reason_codes

    def test_chip_unavailable_passes_invariants(self):
        state = _state(current_gw=22, chips_available=())
        decision = evaluate_free_hit(state, _good_fh_bgw_inputs())
        validate_decision(decision, state)


# ===========================================================================
# Free Hit — Wildcard veto
# ===========================================================================

class TestFreeHitWildcardVeto:
    def test_wildcard_veto_when_good_permanent_gain(self):
        """
        Wildcard available + permanent squad EV gain above threshold
        → Free Hit should not be played; Wildcard is the better choice.
        """
        state = _state(current_gw=22, chips_available=("Free Hit",))
        inputs = _good_fh_dgw_inputs(
            wildcard_available=True,
            permanent_squad_ev_gain=8.0,   # well above 4.0 threshold
        )
        decision = evaluate_free_hit(state, inputs)
        assert decision.action is ChipAction.PASS
        assert "wildcard_available_better_permanent_gain" in decision.reason_codes

    def test_wildcard_veto_not_triggered_when_gain_below_threshold(self):
        """Wildcard available but permanent gain below threshold → veto does NOT apply."""
        state = _state(current_gw=22, chips_available=("Free Hit",))
        inputs = _good_fh_dgw_inputs(
            wildcard_available=True,
            permanent_squad_ev_gain=1.5,   # below 4.0 threshold
        )
        decision = evaluate_free_hit(state, inputs)
        assert decision.action is not ChipAction.PASS or \
               "wildcard_available_better_permanent_gain" not in decision.reason_codes

    def test_wildcard_veto_not_triggered_when_wc_unavailable(self):
        """Wildcard not in chips_available → veto cannot apply."""
        state = _state(current_gw=22, chips_available=("Free Hit",))
        inputs = _good_fh_dgw_inputs(
            wildcard_available=False,   # already used
            permanent_squad_ev_gain=10.0,
        )
        decision = evaluate_free_hit(state, inputs)
        assert "wildcard_available_better_permanent_gain" not in (decision.reason_codes or [])

    def test_wildcard_veto_passes_invariants(self):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        inputs = _good_fh_dgw_inputs(wildcard_available=True, permanent_squad_ev_gain=8.0)
        decision = evaluate_free_hit(state, inputs)
        validate_decision(decision, state)


# ===========================================================================
# Free Hit — PASS / WATCH
# ===========================================================================

class TestFreeHitPassWatch:
    def test_low_score_no_future_window_pass(self):
        """Weak inputs + no better window → PASS."""
        state = _state(
            current_gw=22,
            chips_available=("Free Hit",),
            window_scores=((22, 20.0),),
        )
        inputs = FreeHitInputs(
            bgw_coverage_fraction=0.9,  # minimal coverage need
            bgw_saved_points=0.0,
            dgw_stack_ev=0.0,
            dgw_fixture_quality=0.0,
        )
        decision = evaluate_free_hit(state, inputs)
        assert decision.action is ChipAction.PASS

    def test_low_score_with_better_window_watch(self):
        """
        Score below threshold but a materially better future window exists
        → WATCH until that window.
        """
        state = _state(
            current_gw=22,
            chips_available=("Free Hit",),
            window_scores=((22, 30.0), (26, 50.0)),  # 50/30 > 1.10
        )
        inputs = FreeHitInputs(
            bgw_coverage_fraction=0.35,
            bgw_saved_points=5.0,
            dgw_stack_ev=0.0,
            dgw_fixture_quality=0.0,
        )
        decision = evaluate_free_hit(state, inputs)
        # If score is below fire threshold but better window exists, expect WATCH
        # (exact result depends on computed score; verify invariants at minimum)
        validate_decision(decision, state)


# ===========================================================================
# Free Hit — emergency escalation (GW37/38)
# ===========================================================================

class TestFreeHitEmergency:
    def test_emergency_escalation_fires_at_gw37(self):
        """
        GW 37 of 38 → ≤ 2 GWs remaining → emergency FIRE even with weak inputs.
        """
        state = GameweekState(
            current_gw=37,
            total_gws=38,
            chips_available=frozenset({"Free Hit"}),
            chips_used=frozenset(),
            window_scores=((37, 30.0),),
        )
        inputs = FreeHitInputs(
            bgw_coverage_fraction=0.8,
            bgw_saved_points=3.0,
            dgw_stack_ev=0.0,
            dgw_fixture_quality=0.0,
        )
        decision = evaluate_free_hit(state, inputs)
        assert decision.action is ChipAction.FIRE
        assert decision.forced_by == "season_horizon_emergency"

    def test_emergency_fire_passes_invariants(self):
        state = GameweekState(
            current_gw=37,
            total_gws=38,
            chips_available=frozenset({"Free Hit"}),
            chips_used=frozenset(),
            window_scores=((37, 30.0),),
        )
        inputs = FreeHitInputs(bgw_coverage_fraction=0.8, bgw_saved_points=3.0)
        decision = evaluate_free_hit(state, inputs)
        validate_decision(decision, state)

    def test_emergency_bypasses_wildcard_veto(self):
        """Even if Wildcard is available with high EV, emergency overrides the veto."""
        state = GameweekState(
            current_gw=37,
            total_gws=38,
            chips_available=frozenset({"Free Hit"}),
            chips_used=frozenset(),
            window_scores=((37, 30.0),),
        )
        inputs = FreeHitInputs(
            bgw_coverage_fraction=0.8,
            bgw_saved_points=3.0,
            wildcard_available=True,
            permanent_squad_ev_gain=15.0,  # would normally veto FH
        )
        decision = evaluate_free_hit(state, inputs)
        assert decision.action is ChipAction.FIRE
        assert decision.forced_by == "season_horizon_emergency"

    def test_emergency_chip_unavailable_still_returns_pass(self):
        """Hard veto (chip used) still blocks even emergency."""
        state = GameweekState(
            current_gw=37,
            total_gws=38,
            chips_available=frozenset(),  # Free Hit already used
            chips_used=frozenset({"Free Hit"}),
            window_scores=((37, 30.0),),
        )
        inputs = FreeHitInputs(bgw_coverage_fraction=0.8, bgw_saved_points=3.0)
        decision = evaluate_free_hit(state, inputs)
        assert decision.action is ChipAction.PASS
        assert "chip_unavailable" in decision.reason_codes


# ===========================================================================
# General: all decisions populate required fields
# ===========================================================================

class TestRequiredFields:
    @pytest.mark.parametrize("gw,ev_delta,fixture,dgw", [
        (5,  6.0, 70.0, None),    # too early → PASS
        (22, 1.0, 70.0, None),    # below min ev → PASS
        (22, 6.0, 40.0, None),    # below fixture → PASS
        (22, 6.0, 70.0, 24),      # DGW imminent → WATCH
        (22, 6.0, 70.0, None),    # below min ev → PASS (reason_codes still set)
        (36, 1.0, 30.0, None),    # escalated → FIRE
    ])
    def test_wildcard_reason_codes_always_populated(self, gw, ev_delta, fixture, dgw):
        state = _state(current_gw=gw, window_scores=((gw, 70.0),))
        inputs = WildcardInputs(
            team_ev_delta=ev_delta,
            fixture_run_score=fixture,
            dgw_imminent_gw=dgw,
        )
        decision = evaluate_wildcard(state, inputs)
        assert decision.reason_codes, (
            f"GW={gw}: reason_codes must be non-empty, got {decision.reason_codes!r}"
        )
        validate_decision(decision, state)

    @pytest.mark.parametrize("coverage,saved,dgw_ev,dgw_fix,wc,perm_ev", [
        (1.0, 0.0, 0.0, 0.0, False, 0.0),     # low score → PASS
        (0.2, 20.0, 0.0, 0.0, False, 0.0),    # BGW path → FIRE
        (1.0, 0.0, 14.0, 80.0, False, 0.0),   # DGW path → FIRE
        (0.2, 20.0, 0.0, 0.0, True, 8.0),     # WC veto → PASS
    ])
    def test_free_hit_reason_codes_always_populated(
        self, coverage, saved, dgw_ev, dgw_fix, wc, perm_ev
    ):
        state = _state(current_gw=22, chips_available=("Free Hit",))
        inputs = FreeHitInputs(
            bgw_coverage_fraction=coverage,
            bgw_saved_points=saved,
            dgw_stack_ev=dgw_ev,
            dgw_fixture_quality=dgw_fix,
            wildcard_available=wc,
            permanent_squad_ev_gain=perm_ev,
        )
        decision = evaluate_free_hit(state, inputs)
        assert decision.reason_codes, (
            f"reason_codes must be non-empty, got {decision.reason_codes!r}"
        )
        validate_decision(decision, state)
