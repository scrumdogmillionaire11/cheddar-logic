"""
Deterministic Wildcard and Free Hit chip evaluators.

Both evaluators are stateless functions that consume a ``GameweekState`` plus
chip-specific scoring inputs and return a validated ``ChipDecision``.

Design constraints
------------------
* All shared helpers (horizon suppression, force-escalation, validation) come
  from ``chip_engine.shared`` — no duplication here.
* Scoring formulas are pure arithmetic over the input structs; no I/O, no
  randomness, no external state.
* Both evaluators call ``validate_decision`` before returning.

Public API
----------
evaluate_wildcard  — score current window; apply half-season minimums + DGW veto
evaluate_free_hit  — score BGW-defense and DGW-attack paths; pick stronger; WC veto
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional

from .shared import (
    clamp_score,
    horizon_adjusted_score,
    normalise_force_escalation,
    suppress_or_fire,
    validate_decision,
)
from .types import ChipAction, ChipDecision, GameweekState

# ---------------------------------------------------------------------------
# Wildcard constants
# ---------------------------------------------------------------------------

# Minimum season-window fraction before Wildcard can FIRE normally.
# Before this point a Wildcard play is suppressed unless forced.
_WC_HALF_SEASON_FRACTION = 0.45             # ~GW 17 in a 38-GW season

# Minimum inputs required to score above PASS threshold.
_WC_MIN_EV_DELTA = 2.0                      # points gained vs current squad
_WC_MIN_FIXTURE_SCORE = 50.0               # fixture run quality, 0-100

# Score weights
_WC_W_EV_DELTA = 0.50
_WC_W_FIXTURE = 0.30
_WC_W_HIT_AVOIDED = 0.20

# FIRE threshold after weighting + horizon adjustment
_WC_FIRE_THRESHOLD = 55.0

# Late-season hard escalation: fire if unused after this GW fraction
_WC_ESCALATION_FRACTION = 0.92              # ~GW 35 in a 38-GW season

# DGW-imminent window: suppress Wildcard if a DGW is this many GWs ahead
# (the Wildcard should be saved to capture the DGW instead)
_WC_DGW_SUPPRESS_WINDOW = 2

# ---------------------------------------------------------------------------
# Free Hit constants
# ---------------------------------------------------------------------------

# Minimum BGW defense score to prefer the BGW path
_FH_BGW_FIRE_THRESHOLD = 60.0

# Minimum DGW attack score to prefer the DGW path
_FH_DGW_FIRE_THRESHOLD = 60.0

# Score weights for BGW defense
_FH_BGW_W_COVERAGE = 0.60                  # fraction of XI covered by non-BGW players
_FH_BGW_W_SAVED_POINTS = 0.40             # expected pts saved vs no-Free-Hit

# Score weights for DGW attack
_FH_DGW_W_STACK_EV = 0.70                  # expected pts from DGW stack
_FH_DGW_W_FIXTURE_QUALITY = 0.30

# Wildcard hard veto: if Wildcard is still available AND the permanent EV gain
# would exceed this threshold, suppress Free Hit in favour of Wildcard.
_FH_WC_VETO_EV_THRESHOLD = 4.0            # points of permanent squad improvement

# Late-season emergency: if FH unused and <= this many GWs remain, fire.
_FH_EMERGENCY_GWS_LEFT = 2


# ---------------------------------------------------------------------------
# Input dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WildcardInputs:
    """
    Scoring inputs required by the Wildcard evaluator.

    Attributes
    ----------
    team_ev_delta:
        Expected-points improvement of the optimal new squad over the current
        squad across the next 5 GWs (dimensionless, can be negative).
    fixture_run_score:
        Quality of the new squad's fixture run over the next 5 GWs; 0-100.
    hit_cost_avoided:
        Transfer-hit cost avoided by using Wildcard instead of paid transfers;
        expressed as expected-point equivalent (e.g., 4 hits * 4pts = 16).
    dgw_imminent_gw:
        Gameweek number of the next DGW, or ``None`` if no DGW is scheduled.
    notes:
        Optional free-text memo for debugging; not used in scoring.
    """

    team_ev_delta: float
    fixture_run_score: float
    hit_cost_avoided: float = 0.0
    dgw_imminent_gw: Optional[int] = None
    notes: str = ""


@dataclass(frozen=True)
class FreeHitInputs:
    """
    Scoring inputs required by the Free Hit evaluator.

    Attributes
    ----------
    bgw_coverage_fraction:
        Fraction of starting-XI slots that can be covered by non-BGW players
        without Free Hit (0.0–1.0).  A value of 1.0 means no BGW issue.
    bgw_saved_points:
        Expected-point gain of using Free Hit for BGW defense vs not using it.
    dgw_stack_ev:
        Expected-point gain of the optimal DGW stack vs a normal single-GW
        squad.  0 if no DGW is scheduled.
    dgw_fixture_quality:
        Quality of the DGW fixtures for the stack; 0-100.
    wildcard_available:
        Whether the Wildcard chip is still in the manager's arsenal.
    permanent_squad_ev_gain:
        How much permanent squad EV improvement a Wildcard would deliver.
        Used only in the Wildcard veto guard; irrelevant when WC is used.
    notes:
        Optional free-text memo for debugging.
    """

    bgw_coverage_fraction: float = 1.0
    bgw_saved_points: float = 0.0
    dgw_stack_ev: float = 0.0
    dgw_fixture_quality: float = 0.0
    wildcard_available: bool = False
    permanent_squad_ev_gain: float = 0.0
    notes: str = ""


# ---------------------------------------------------------------------------
# Wildcard evaluator
# ---------------------------------------------------------------------------

def _score_wildcard(inputs: WildcardInputs) -> float:
    """
    Compute raw Wildcard window score in [0, 100].

    Combines team_ev_delta, fixture_run_score, and hit_cost_avoided using
    fixed weights.  Each component is clamped before weighting so a single
    extreme input cannot dominate.
    """
    # Normalise team_ev_delta to 0-100 range (cap at 20 pts gain = 100)
    ev_component = clamp_score(inputs.team_ev_delta / 20.0 * 100.0, 0.0, 100.0)
    fixture_component = clamp_score(inputs.fixture_run_score, 0.0, 100.0)
    # Normalise hit_cost_avoided (cap at 20 pts avoided = 100)
    hit_component = clamp_score(inputs.hit_cost_avoided / 20.0 * 100.0, 0.0, 100.0)

    raw = (
        _WC_W_EV_DELTA * ev_component
        + _WC_W_FIXTURE * fixture_component
        + _WC_W_HIT_AVOIDED * hit_component
    )
    return clamp_score(raw, 0.0, 100.0)


def evaluate_wildcard(
    state: GameweekState,
    inputs: WildcardInputs,
) -> ChipDecision:
    """
    Evaluate whether to play the Wildcard chip this gameweek.

    Decision pathway
    ----------------
    1. **Chip unavailable** → PASS (chip_unavailable).
    2. **Before half-season** → PASS (too_early_half_season) unless escalated.
    3. **Minimums not met** → PASS (below_min_ev_delta or below_min_fixture_score).
    4. **DGW-imminent veto** → WATCH until the DGW GW when a DGW is within
       ``_WC_DGW_SUPPRESS_WINDOW`` gameweeks (save Wildcard for DGW).
    5. **Score too low** → PASS or WATCH depending on horizon.
    6. **Score above threshold** → FIRE, unless `suppress_or_fire` finds a
       materially better upcoming window.
    7. **Late-season escalation** → FIRE forced by ``"season_horizon_last_window"``
       if unused past ``_WC_ESCALATION_FRACTION`` of the season.

    Parameters
    ----------
    state:
        Immutable gameweek context.
    inputs:
        Wildcard-specific scoring inputs.

    Returns
    -------
    ChipDecision
        Validated decision; action is FIRE, WATCH, or PASS.
    """
    chip_type = "Wildcard"
    reason_codes: List[str] = []

    # 1. Chip unavailable → hard PASS
    if chip_type not in state.chips_available:
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=["chip_unavailable"],
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    half_season_gw = _WC_HALF_SEASON_FRACTION * state.total_gws
    escalation_gw = _WC_ESCALATION_FRACTION * state.total_gws
    gws_left = state.total_gws - state.current_gw

    # 7. Pre-check late-season escalation (takes priority after availability)
    is_forced = state.current_gw >= escalation_gw
    force_label = "season_horizon_last_window"

    # 2. Before half-season (and no force)
    if state.current_gw < half_season_gw and not is_forced:
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=["too_early_half_season"],
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # 3. Minimum thresholds
    if inputs.team_ev_delta < _WC_MIN_EV_DELTA and not is_forced:
        reason_codes.append("below_min_ev_delta")
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=reason_codes,
            confidence="MEDIUM",
        )
        validate_decision(decision, state)
        return decision

    if inputs.fixture_run_score < _WC_MIN_FIXTURE_SCORE and not is_forced:
        reason_codes.append("below_min_fixture_score")
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=reason_codes,
            confidence="MEDIUM",
        )
        validate_decision(decision, state)
        return decision

    # 4. DGW-imminent veto (only when NOT forced by end-of-season)
    if (
        not is_forced
        and inputs.dgw_imminent_gw is not None
        and 0 < inputs.dgw_imminent_gw - state.current_gw <= _WC_DGW_SUPPRESS_WINDOW
    ):
        decision = ChipDecision(
            action=ChipAction.WATCH,
            chip_type=chip_type,
            reason_codes=["dgw_imminent_save_wildcard"],
            watch_until=inputs.dgw_imminent_gw,
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # Score + horizon adjustment
    raw_score = _score_wildcard(inputs)
    adj_score = horizon_adjusted_score(raw_score, state.current_gw, state.total_gws)

    # 5. Score below threshold → PASS (or WATCH if horizon improvement possible)
    if adj_score < _WC_FIRE_THRESHOLD and not is_forced:
        reason_codes.append("score_below_fire_threshold")
        # Use suppress_or_fire to see if a better upcoming window warrants WATCH
        action, watch_until, best_future_score, best_future_gw, extras = suppress_or_fire(
            ChipAction.FIRE, state, current_score=adj_score
        )
        if action is ChipAction.WATCH:
            decision = ChipDecision(
                action=ChipAction.WATCH,
                chip_type=chip_type,
                reason_codes=["score_below_fire_threshold"] + extras,
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

    # 6. Score above threshold — propose FIRE, then apply horizon suppression
    reason_codes.append("good_window_score")
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

    # 7. Apply force-escalation (may override WATCH → FIRE)
    decision = normalise_force_escalation(
        base_decision,
        is_forced=is_forced,
        forced_by_label=force_label,
        chip_type=chip_type,
        state=state,
    )
    validate_decision(decision, state)
    return decision


# ---------------------------------------------------------------------------
# Free Hit evaluator
# ---------------------------------------------------------------------------

def _score_bgw_defense(inputs: FreeHitInputs) -> float:
    """
    Score the BGW-defense path for Free Hit in [0, 100].

    A high score means: many XI slots need covering and a lot of points would
    be saved by using Free Hit.
    """
    # Coverage need: 1 - fraction already covered = fraction needing FH cover
    coverage_need = clamp_score(1.0 - inputs.bgw_coverage_fraction, 0.0, 1.0)
    coverage_component = coverage_need * 100.0  # 0–100

    # Normalize saved_points (cap at 30 pts saved = 100)
    saved_component = clamp_score(inputs.bgw_saved_points / 30.0 * 100.0, 0.0, 100.0)

    raw = (
        _FH_BGW_W_COVERAGE * coverage_component
        + _FH_BGW_W_SAVED_POINTS * saved_component
    )
    return clamp_score(raw, 0.0, 100.0)


def _score_dgw_attack(inputs: FreeHitInputs) -> float:
    """
    Score the DGW-attack path for Free Hit in [0, 100].

    A high score means: a strong DGW stack with good fixture quality.
    """
    # Normalize dgw_stack_ev (cap at 20 pts additional ev = 100)
    stack_component = clamp_score(inputs.dgw_stack_ev / 20.0 * 100.0, 0.0, 100.0)
    fixture_component = clamp_score(inputs.dgw_fixture_quality, 0.0, 100.0)

    raw = (
        _FH_DGW_W_STACK_EV * stack_component
        + _FH_DGW_W_FIXTURE_QUALITY * fixture_component
    )
    return clamp_score(raw, 0.0, 100.0)


def evaluate_free_hit(
    state: GameweekState,
    inputs: FreeHitInputs,
) -> ChipDecision:
    """
    Evaluate whether to play the Free Hit chip this gameweek.

    Decision pathway
    ----------------
    1. **Chip unavailable** → PASS (chip_unavailable).
    2. **Wildcard veto** → PASS if Wildcard is still available and the permanent
       squad EV gain from a Wildcard would exceed ``_FH_WC_VETO_EV_THRESHOLD``.
       Free Hit is a one-week chip; Wildcard offers durable improvement.
    3. **Score both paths** (BGW-defense and DGW-attack); pick the stronger one.
    4. **Horizon adjustment** on the selected score.
    5. **Score above threshold** → FIRE (after horizon-suppression check).
    6. **Score below threshold** → PASS or WATCH.
    7. **Emergency escalation** → FIRE if chip unused with ≤ 2 GWs remaining.

    Parameters
    ----------
    state:
        Immutable gameweek context.
    inputs:
        Free Hit-specific scoring inputs.

    Returns
    -------
    ChipDecision
        Validated decision; action is FIRE, WATCH, or PASS.
    """
    chip_type = "Free Hit"
    reason_codes: List[str] = []

    # 1. Chip unavailable → hard PASS
    if chip_type not in state.chips_available:
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=["chip_unavailable"],
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # 7. Emergency check (pre-computed; applied via force-escalation below)
    is_emergency = (state.total_gws - state.current_gw) <= _FH_EMERGENCY_GWS_LEFT
    force_label = "season_horizon_emergency"

    # 2. Wildcard veto — Wildcard offers permanent gain; FH is only one week
    if (
        inputs.wildcard_available
        and inputs.permanent_squad_ev_gain >= _FH_WC_VETO_EV_THRESHOLD
        and not is_emergency
    ):
        decision = ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=["wildcard_available_better_permanent_gain"],
            confidence="HIGH",
        )
        validate_decision(decision, state)
        return decision

    # 3. Score both paths and select stronger
    bgw_score = _score_bgw_defense(inputs)
    dgw_score = _score_dgw_attack(inputs)

    if dgw_score >= bgw_score:
        selected_score = dgw_score
        path_reason = "dgw_attack_selected"
    else:
        selected_score = bgw_score
        path_reason = "bgw_defense_selected"

    reason_codes.append(path_reason)
    threshold = _FH_DGW_FIRE_THRESHOLD if path_reason == "dgw_attack_selected" else _FH_BGW_FIRE_THRESHOLD

    # 4. Horizon adjustment
    adj_score = horizon_adjusted_score(selected_score, state.current_gw, state.total_gws)

    # 6. Score below threshold → PASS / WATCH
    if adj_score < threshold and not is_emergency:
        reason_codes.append("score_below_fire_threshold")
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

    # 5. Score above threshold → FIRE (with horizon suppression)
    reason_codes.append("good_window_score")
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

    # 7. Apply emergency escalation
    decision = normalise_force_escalation(
        base_decision,
        is_forced=is_emergency,
        forced_by_label=force_label,
        chip_type=chip_type,
        state=state,
    )
    validate_decision(decision, state)
    return decision
