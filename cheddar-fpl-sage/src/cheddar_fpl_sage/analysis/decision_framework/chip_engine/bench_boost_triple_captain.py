"""
Deterministic Bench Boost and Triple Captain evaluators.

March 2026 Chip Engine:
  - Bench Boost: scores projected bench total + DGW bench bonus - blank starter penalty
        * Hard veto if any starter is blank (unavailable/unknown)
    * WATCH progression with rewatch at current_gw + 2
    * Soft escalation at 80% of season
    * Hard escalation at 92% of season
    * SoN emergency at remaining GWs <= 1

  - Triple Captain: scores captain projection * DGW multiplier + ownership/fixture quality
    * Hard veto if captain is blank (unavailable/unknown)
    * Better window ahead hold: if better_window_ahead >= threshold, WATCH
    * Soft escalation at 80% of season
    * Hard escalation at 92% of season
    * SoN emergency at remaining GWs <= 2

Both use suppress_or_fire() to downgrade FIRE→WATCH if a future GW
window is >= 10% better (horizon suppression).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Set

from .shared import (
    clamp_score,
    normalise_force_escalation,
    suppress_or_fire,
    validate_decision,
)
from .types import (
    ChipAction,
    ChipDecision,
    GameweekState,
)


# -----------
# Bench Boost
# -----------

_BB_FIRE_THRESHOLD = 55.0
_BB_SOFT_ESCALATION_FRACTION = 0.80  # ~GW 30 in a 38-GW season
_BB_HARD_ESCALATION_FRACTION = 0.92  # ~GW 35 in a 38-GW season
_BB_SON_EMERGENCY_GWS = 1


@dataclass(frozen=True)
class BenchBoostInputs:
    """Bench Boost input context."""
    bench_projected_total: float  # Sum of bench player projections
    dgw_bench_bonus: float        # DGW boost % to bench subscore
    blank_starter_penalty: float  # Deduction if starter is blank (unavailable)
    blank_starters: Set[str]      # Set of starting-XI player identifiers not available (must be empty for FIRE)


# ----------------
# Triple Captain
# ----------------

_TC_FIRE_THRESHOLD = 50.0
_TC_SOFT_ESCALATION_FRACTION = 0.80  # ~GW 30 in a 38-GW season
_TC_HARD_ESCALATION_FRACTION = 0.92  # ~GW 35 in a 38-GW season
_TC_SON_EMERGENCY_GWS = 2


@dataclass(frozen=True)
class TripleCaptainInputs:
    """Triple Captain input context."""
    captain_projection: float      # Predicted points for captain for the GW
    dgw_multiplier: float          # DGW boost multiplier (1.0 to 1.5+)
    ownership_effect_bps: float    # Bonus points swing due to extreme ownership
    fixture_quality_bps: float     # Fixture difficulty bonus (easy fixture = higher)
    captain_available: bool        # True if captain is not blank (projected data ready)
    better_future_window: float    # Best 4-GW rolling score ahead (used for window-ahead veto)


# -----------
# Evaluators
# -----------

def evaluate_bench_boost(
    state: GameweekState,
    inputs: BenchBoostInputs,
    force: bool = False,
) -> ChipDecision:
    """
    Determine Bench Boost action (FIRE / WATCH / PASS).

    Hard veto: Any blank starter → cannot fire.
    Soft escalation: >= 80% of season → lower threshold by 20%.
    Hard escalation: >= 92% of season → lower threshold by 50%.
    SoN emergency: remaining GWs <= 1 → FIRE if score > 0.

    Parameters
    ----------
    state:
        Immutable gameweek context.
    inputs:
        Bench Boost-specific scoring inputs.
    force:
        Whether a hard rule is demanding the chip be played (e.g., last GW).

    Returns
    -------
    ChipDecision
        Validated decision; action is FIRE, WATCH, or PASS.
    """
    chip_type = "Bench Boost"
    reason_codes: List[str] = []

    # Chip unavailable → hard PASS
    if chip_type not in state.chips_available:
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=["chip_unavailable"],
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # Hard veto: blank starter
    if inputs.blank_starters:
        reason_codes.append("bench_boost:blank_starter")
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=reason_codes,
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # Base score: bench total + DGW bonus - blank starter penalty
    base_score = inputs.bench_projected_total + inputs.dgw_bench_bonus - inputs.blank_starter_penalty
    adj_score = clamp_score(base_score, 0.0, 100.0)

    # Determine escalation threshold
    season_progress = state.current_gw / state.total_gws
    remaining_gws = state.total_gws - state.current_gw

    threshold = _BB_FIRE_THRESHOLD
    escalation_gw = _BB_HARD_ESCALATION_FRACTION * state.total_gws
    is_forced = force or (state.current_gw >= escalation_gw)
    force_label = "season_horizon_last_window"

    if season_progress >= _BB_HARD_ESCALATION_FRACTION:  # ~92%
        threshold = _BB_FIRE_THRESHOLD * 0.5  # 27.5
        reason_codes.append("bench_boost:hard_escalation_92pct")
    elif season_progress >= _BB_SOFT_ESCALATION_FRACTION:  # ~80%
        threshold = _BB_FIRE_THRESHOLD * 0.8  # 44.0
        reason_codes.append("bench_boost:soft_escalation_80pct")

    # SoN emergency: remaining GWs <= 1
    if remaining_gws <= _BB_SON_EMERGENCY_GWS:
        reason_codes.append("bench_boost:son_emergency")
        if adj_score > 0:
            base_decision = ChipDecision(
                action=ChipAction.FIRE,
                chip_type=chip_type,
                reason_codes=reason_codes,
                current_window_score=adj_score,
                confidence="HIGH",
            )
            decision = normalise_force_escalation(
                base_decision,
                is_forced=True,
                forced_by_label=force_label,
                chip_type=chip_type,
                state=state,
            )
            validate_decision(decision, state)
            return decision

    # Score below threshold (not forced)
    if adj_score < threshold and not is_forced:
        reason_codes.append("bench_boost:below_threshold")
        # Use suppress_or_fire to see if a better upcoming window warrants WATCH
        action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
            ChipAction.FIRE, state, current_score=adj_score
        )
        if action is ChipAction.WATCH:
            decision = ChipDecision(
                action=ChipAction.WATCH,
                chip_type=chip_type,
                reason_codes=reason_codes + extras,
                watch_until=watch_until,
                current_window_score=adj_score,
                best_future_window_score=best_future_score,
                best_future_window_gw=best_future_gw,
                confidence="MEDIUM",
            )
        else:
            decision = ChipDecision(
                action=ChipAction.PASS,
                chip_type=chip_type,
                reason_codes=reason_codes,
                current_window_score=adj_score,
                confidence="MEDIUM",
            )
        validate_decision(decision, state)
        return decision

    # Score above threshold — propose FIRE, then apply horizon suppression
    reason_codes.append("bench_boost:good_window_score")
    action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
        ChipAction.FIRE, state, current_score=adj_score
    )
    base_decision = ChipDecision(
        action=action,
        chip_type=chip_type,
        reason_codes=reason_codes + extras,
        watch_until=watch_until,
        current_window_score=adj_score,
        best_future_window_score=best_future_score,
        best_future_window_gw=best_future_gw,
        confidence="HIGH" if action is ChipAction.FIRE else "MEDIUM",
    )

    # Apply force-escalation (may override WATCH → FIRE)
    decision = normalise_force_escalation(
        base_decision,
        is_forced=is_forced,
        forced_by_label=force_label,
        chip_type=chip_type,
        state=state,
    )
    validate_decision(decision, state)
    return decision


def evaluate_triple_captain(
    state: GameweekState,
    inputs: TripleCaptainInputs,
    force: bool = False,
) -> ChipDecision:
    """
    Determine Triple Captain action (FIRE / WATCH / PASS).

    Hard veto: Captain blank → cannot fire.
    Better window ahead: if best 4-GW window ahead >= 10% better, WATCH instead of FIRE.
    Soft escalation: >= 80% of season → lower threshold by 20%.
    Hard escalation: >= 92% of season → lower threshold by 50%.
    SoN emergency: remaining GWs <= 2 → FIRE if score > 0.

    Parameters
    ----------
    state:
        Immutable gameweek context.
    inputs:
        Triple Captain-specific scoring inputs.
    force:
        Whether a hard rule is demanding the chip be played (e.g., near end of season).

    Returns
    -------
    ChipDecision
        Validated decision; action is FIRE, WATCH, or PASS.
    """
    chip_type = "Triple Captain"
    reason_codes: List[str] = []

    # Chip unavailable → hard PASS
    if chip_type not in state.chips_available:
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=["chip_unavailable"],
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # Hard veto: captain blank
    if not inputs.captain_available:
        reason_codes.append("triple_captain:blank_captain")
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=reason_codes,
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # Base score: captain projection * DGW multiplier + ownership/fixture effects
    base_score = (inputs.captain_projection * inputs.dgw_multiplier) + inputs.ownership_effect_bps + inputs.fixture_quality_bps
    adj_score = clamp_score(base_score, 0.0, 100.0)

    # Determine escalation threshold
    season_progress = state.current_gw / state.total_gws
    remaining_gws = state.total_gws - state.current_gw

    threshold = _TC_FIRE_THRESHOLD
    escalation_gw = _TC_HARD_ESCALATION_FRACTION * state.total_gws
    is_forced = force or (state.current_gw >= escalation_gw)
    force_label = "season_horizon_last_window"

    if season_progress >= _TC_HARD_ESCALATION_FRACTION:  # ~92%
        threshold = _TC_FIRE_THRESHOLD * 0.5  # 25.0
        reason_codes.append("triple_captain:hard_escalation_92pct")
    elif season_progress >= _TC_SOFT_ESCALATION_FRACTION:  # ~80%
        threshold = _TC_FIRE_THRESHOLD * 0.8  # 40.0
        reason_codes.append("triple_captain:soft_escalation_80pct")

    # SoN emergency: remaining GWs <= 2
    if remaining_gws <= _TC_SON_EMERGENCY_GWS:
        reason_codes.append("triple_captain:son_emergency")
        if adj_score > 0:
            base_decision = ChipDecision(
                action=ChipAction.FIRE,
                chip_type=chip_type,
                reason_codes=reason_codes,
                current_window_score=adj_score,
                confidence="HIGH",
            )
            decision = normalise_force_escalation(
                base_decision,
                is_forced=True,
                forced_by_label=force_label,
                chip_type=chip_type,
                state=state,
            )
            validate_decision(decision, state)
            return decision

    # Better window ahead hold: if better window >= current score, WATCH
    if inputs.better_future_window > adj_score:
        watch_until = state.current_gw + 1
        reason_codes.append("triple_captain:better_window_ahead")
        decision = ChipDecision(
            action=ChipAction.WATCH,
            chip_type=chip_type,
            reason_codes=reason_codes,
            watch_until=watch_until,
            current_window_score=adj_score,
            best_future_window_score=inputs.better_future_window,
            confidence="MEDIUM",
        )
        validate_decision(decision, state)
        return decision

    # Score below threshold (not forced)
    if adj_score < threshold and not is_forced:
        reason_codes.append("triple_captain:below_threshold")
        # Use suppress_or_fire to see if a better upcoming window warrants WATCH
        action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
            ChipAction.FIRE, state, current_score=adj_score
        )
        if action is ChipAction.WATCH:
            decision = ChipDecision(
                action=ChipAction.WATCH,
                chip_type=chip_type,
                reason_codes=reason_codes + extras,
                watch_until=watch_until,
                current_window_score=adj_score,
                best_future_window_score=best_future_score,
                best_future_window_gw=best_future_gw,
                confidence="MEDIUM",
            )
        else:
            decision = ChipDecision(
                action=ChipAction.PASS,
                chip_type=chip_type,
                reason_codes=reason_codes,
                current_window_score=adj_score,
                confidence="MEDIUM",
            )
        validate_decision(decision, state)
        return decision

    # Score above threshold — propose FIRE, then apply horizon suppression
    reason_codes.append("triple_captain:good_window_score")
    action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
        ChipAction.FIRE, state, current_score=adj_score
    )
    base_decision = ChipDecision(
        action=action,
        chip_type=chip_type,
        reason_codes=reason_codes + extras,
        watch_until=watch_until,
        current_window_score=adj_score,
        best_future_window_score=best_future_score,
        best_future_window_gw=best_future_gw,
        confidence="HIGH" if action is ChipAction.FIRE else "MEDIUM",
    )

    # Apply force-escalation (may override WATCH → FIRE)
    decision = normalise_force_escalation(
        base_decision,
        is_forced=is_forced,
        forced_by_label=force_label,
        chip_type=chip_type,
        state=state,
    )
    validate_decision(decision, state)
    return decision

