"""Tests for deterministic Bench Boost + Triple Captain evaluators (WI-0515)."""

from cheddar_fpl_sage.analysis.decision_framework.chip_engine import (
    ChipAction,
    GameweekState,
    validate_decision,
)
from cheddar_fpl_sage.analysis.decision_framework.chip_engine.bench_boost_triple_captain import (
    BenchBoostInputs,
    TripleCaptainInputs,
    evaluate_bench_boost,
    evaluate_triple_captain,
)


def _state(
    current_gw: int = 20,
    total_gws: int = 38,
    chips_available=("Bench Boost", "Triple Captain"),
    chips_used=(),
    window_scores=None,
) -> GameweekState:
    if window_scores is None:
        window_scores = ((current_gw, 60.0),)
    return GameweekState(
        current_gw=current_gw,
        total_gws=total_gws,
        chips_available=frozenset(chips_available),
        chips_used=frozenset(chips_used),
        window_scores=tuple(window_scores),
    )


def _bb_inputs(**overrides) -> BenchBoostInputs:
    defaults = dict(
        bench_projected_total=58.0,
        dgw_bench_bonus=6.0,
        blank_starter_penalty=4.0,
        blank_starters=frozenset(),
    )
    defaults.update(overrides)
    return BenchBoostInputs(**defaults)


def _tc_inputs(**overrides) -> TripleCaptainInputs:
    defaults = dict(
        captain_projection=28.0,
        dgw_multiplier=1.5,
        ownership_effect_bps=6.0,
        fixture_quality_bps=4.0,
        captain_available=True,
        better_future_window=20.0,
    )
    defaults.update(overrides)
    return TripleCaptainInputs(**defaults)


class TestBenchBoost:
    def test_fire_for_strong_window(self):
        state = _state(current_gw=20, window_scores=((20, 60.0),))
        decision = evaluate_bench_boost(state, _bb_inputs())
        assert decision.action is ChipAction.FIRE
        assert "bench_boost:good_window_score" in decision.reason_codes
        validate_decision(decision, state)

    def test_watch_when_future_window_is_materially_better(self):
        state = _state(current_gw=20, window_scores=((20, 60.0), (25, 80.0)))
        decision = evaluate_bench_boost(state, _bb_inputs())
        assert decision.action is ChipAction.WATCH
        assert decision.watch_until == 25
        assert "better_window_imminent" in decision.reason_codes
        validate_decision(decision, state)

    def test_pass_below_threshold(self):
        state = _state(current_gw=20, window_scores=((20, 35.0),))
        decision = evaluate_bench_boost(
            state,
            _bb_inputs(bench_projected_total=32.0, dgw_bench_bonus=3.0, blank_starter_penalty=5.0),
        )
        assert decision.action is ChipAction.PASS
        assert "bench_boost:below_threshold" in decision.reason_codes
        validate_decision(decision, state)

    def test_soft_escalation_allows_fire_at_lower_threshold(self):
        state = _state(current_gw=31, window_scores=((31, 46.0),))
        decision = evaluate_bench_boost(
            state,
            _bb_inputs(bench_projected_total=44.0, dgw_bench_bonus=4.0, blank_starter_penalty=2.0),
        )
        assert decision.action is ChipAction.FIRE
        assert "bench_boost:soft_escalation_80pct" in decision.reason_codes

    def test_hard_escalation_forces_fire_and_sets_forced_by(self):
        state = _state(current_gw=36, window_scores=((36, 30.0), (38, 50.0)))
        decision = evaluate_bench_boost(
            state,
            _bb_inputs(bench_projected_total=28.0, dgw_bench_bonus=3.0, blank_starter_penalty=1.0),
        )
        assert decision.action is ChipAction.FIRE
        assert decision.forced_by == "season_horizon_last_window"
        assert "bench_boost:hard_escalation_92pct" in decision.reason_codes
        validate_decision(decision, state)

    def test_emergency_window_forces_fire(self):
        state = _state(current_gw=37, window_scores=((37, 10.0),))
        decision = evaluate_bench_boost(
            state,
            _bb_inputs(bench_projected_total=1.0, dgw_bench_bonus=1.0, blank_starter_penalty=0.0),
        )
        assert decision.action is ChipAction.FIRE
        assert "bench_boost:son_emergency" in decision.reason_codes
        assert decision.forced_by == "season_horizon_last_window"

    def test_hard_veto_blank_starter_overrides_force(self):
        state = _state(current_gw=38, window_scores=((38, 80.0),))
        decision = evaluate_bench_boost(
            state,
            _bb_inputs(blank_starters=frozenset({"Saka"})),
            force=True,
        )
        assert decision.action is ChipAction.PASS
        assert "bench_boost:blank_starter" in decision.reason_codes
        assert decision.forced_by is None
        validate_decision(decision, state)


class TestTripleCaptain:
    def test_fire_for_strong_window(self):
        state = _state(current_gw=20, window_scores=((20, 52.0),))
        decision = evaluate_triple_captain(state, _tc_inputs())
        assert decision.action is ChipAction.FIRE
        assert "triple_captain:good_window_score" in decision.reason_codes
        validate_decision(decision, state)

    def test_watch_when_better_window_ahead(self):
        state = _state(current_gw=20, window_scores=((20, 52.0),))
        decision = evaluate_triple_captain(
            state,
            _tc_inputs(captain_projection=20.0, dgw_multiplier=2.0, better_future_window=60.0),
        )
        assert decision.action is ChipAction.WATCH
        assert decision.watch_until == 21
        assert "triple_captain:better_window_ahead" in decision.reason_codes
        validate_decision(decision, state)

    def test_pass_below_threshold(self):
        state = _state(current_gw=20, window_scores=((20, 20.0),))
        decision = evaluate_triple_captain(
            state,
            _tc_inputs(
                captain_projection=14.0,
                dgw_multiplier=1.0,
                ownership_effect_bps=2.0,
                fixture_quality_bps=2.0,
                better_future_window=15.0,
            ),
        )
        assert decision.action is ChipAction.PASS
        assert "triple_captain:below_threshold" in decision.reason_codes
        validate_decision(decision, state)

    def test_soft_escalation_allows_fire_at_lower_threshold(self):
        state = _state(current_gw=31, window_scores=((31, 42.0),))
        decision = evaluate_triple_captain(
            state,
            _tc_inputs(
                captain_projection=18.0,
                dgw_multiplier=2.0,
                ownership_effect_bps=3.0,
                fixture_quality_bps=3.0,
                better_future_window=38.0,
            ),
        )
        assert decision.action is ChipAction.FIRE
        assert "triple_captain:soft_escalation_80pct" in decision.reason_codes

    def test_hard_escalation_forces_fire_and_sets_forced_by(self):
        state = _state(current_gw=36, window_scores=((36, 30.0), (38, 60.0)))
        decision = evaluate_triple_captain(
            state,
            _tc_inputs(
                captain_projection=16.0,
                dgw_multiplier=1.5,
                ownership_effect_bps=2.0,
                fixture_quality_bps=2.0,
                better_future_window=25.0,
            ),
        )
        assert decision.action is ChipAction.FIRE
        assert decision.forced_by == "season_horizon_last_window"
        assert "triple_captain:hard_escalation_92pct" in decision.reason_codes
        validate_decision(decision, state)

    def test_emergency_window_forces_fire(self):
        state = _state(current_gw=36, window_scores=((36, 10.0),))
        decision = evaluate_triple_captain(
            state,
            _tc_inputs(
                captain_projection=1.0,
                dgw_multiplier=1.0,
                ownership_effect_bps=0.0,
                fixture_quality_bps=0.1,
                better_future_window=0.0,
            ),
        )
        assert decision.action is ChipAction.FIRE
        assert "triple_captain:son_emergency" in decision.reason_codes
        assert decision.forced_by == "season_horizon_last_window"

    def test_hard_veto_blank_captain_overrides_force(self):
        state = _state(current_gw=38, window_scores=((38, 80.0),))
        decision = evaluate_triple_captain(
            state,
            _tc_inputs(captain_available=False),
            force=True,
        )
        assert decision.action is ChipAction.PASS
        assert "triple_captain:blank_captain" in decision.reason_codes
        assert decision.forced_by is None
        validate_decision(decision, state)