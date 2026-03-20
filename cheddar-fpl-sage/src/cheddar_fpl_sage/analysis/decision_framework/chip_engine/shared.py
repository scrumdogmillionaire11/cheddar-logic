"""
Stateless shared helpers for the FPL chip evaluation engine.

All functions here are pure: they take values, return values, and never mutate
their arguments or module-level state.  This makes them trivially testable and
safe to call from any chip evaluator in parallel.

Public API
----------
clamp_score                  — bound a float to [lo, hi]
horizon_adjusted_score       — discount chip value for too-early use
better_window_ahead          — detect a materially superior future window
suppress_or_fire             — apply horizon suppression and return updated action
normalise_force_escalation   — upgrade decision to FIRE when a hard rule fires
validate_decision            — assert all ChipDecision invariants
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from .types import ChipAction, ChipDecision, GameweekState

# ---------------------------------------------------------------------------
# Score clamping
# ---------------------------------------------------------------------------

def clamp_score(score: float, lo: float = 0.0, hi: float = 100.0) -> float:
    """
    Return ``score`` clamped to the closed interval [lo, hi].

    Parameters
    ----------
    score:
        The raw projected score to clamp.
    lo:
        Lower bound (inclusive).  Defaults to 0.
    hi:
        Upper bound (inclusive).  Defaults to 100.

    Returns
    -------
    float
        ``lo`` if score < lo, ``hi`` if score > hi, else ``score``.

    Raises
    ------
    ValueError
        If ``lo > hi``.
    """
    if lo > hi:
        raise ValueError(f"clamp_score: lo ({lo}) must be ≤ hi ({hi})")
    return max(lo, min(hi, score))


# ---------------------------------------------------------------------------
# Season-horizon scoring
# ---------------------------------------------------------------------------

_HORIZON_RAMP_START_FRACTION = 0.70   # begin penalty after 70 % of season
_HORIZON_MIN_MULTIPLIER = 0.60         # max 40 % discount at GW 1
_HORIZON_FLOOR_FRACTION = 0.92         # no further discount below 92 % of season

def horizon_penalty(gw: int, total_gws: int) -> float:
    """
    Return a [0, 1] multiplier that discounts chip value when a chip is
    played very early in the season.

    * GW ≥ 70 % of total_gws: no discount (multiplier = 1.0).
    * GW = 1: maximum discount (multiplier = ``_HORIZON_MIN_MULTIPLIER``).
    * Between those extremes: linear interpolation.

    Parameters
    ----------
    gw:
        Gameweek number (1-based).
    total_gws:
        Total gameweeks in the season.

    Returns
    -------
    float
        Multiplier in [``_HORIZON_MIN_MULTIPLIER``, 1.0].
    """
    ramp_start_gw = _HORIZON_RAMP_START_FRACTION * total_gws
    if gw >= ramp_start_gw:
        return 1.0
    # Linear ramp from min multiplier (at GW 1) to 1.0 (at ramp_start_gw)
    frac = (gw - 1) / max(ramp_start_gw - 1, 1)
    raw = _HORIZON_MIN_MULTIPLIER + (1.0 - _HORIZON_MIN_MULTIPLIER) * frac
    return clamp_score(raw, _HORIZON_MIN_MULTIPLIER, 1.0)


def horizon_adjusted_score(base_score: float, gw: int, total_gws: int) -> float:
    """
    Apply the season-horizon penalty to ``base_score``.

    Parameters
    ----------
    base_score:
        Raw window score (dimensionless float, typically 0–100).
    gw:
        Gameweek number at which the chip would be played (1-based).
    total_gws:
        Total gameweeks in the season.

    Returns
    -------
    float
        ``base_score * horizon_penalty(gw, total_gws)``.
    """
    return base_score * horizon_penalty(gw, total_gws)


# ---------------------------------------------------------------------------
# Better-window suppression
# ---------------------------------------------------------------------------

_DEFAULT_MATERIALLY_BETTER_THRESHOLD = 0.10   # 10 % improvement threshold


def better_window_ahead(
    current_score: float,
    future_windows: Tuple[Tuple[int, float], ...],
    threshold: float = _DEFAULT_MATERIALLY_BETTER_THRESHOLD,
) -> Optional[Tuple[int, float]]:
    """
    Return the best upcoming window if it is materially better than the
    current one, else return ``None``.

    "Materially better" means::

        best_future_score >= current_score * (1 + threshold)

    Parameters
    ----------
    current_score:
        Projected score for the current window.
    future_windows:
        Tuple of (gameweek, projected_score) for future candidate windows,
        ordered arbitrarily.
    threshold:
        Fractional improvement required for suppression.  Default 0.10 (10 %).

    Returns
    -------
    (int, float) | None
        ``(gw, score)`` of the best future window if it meets the threshold,
        otherwise ``None``.
    """
    if not future_windows:
        return None
    best_gw, best_score = max(future_windows, key=lambda t: t[1])
    if best_score >= current_score * (1.0 + threshold):
        return (best_gw, best_score)
    return None


def suppress_or_fire(
    proposed_action: ChipAction,
    state: GameweekState,
    current_score: float,
    threshold: float = _DEFAULT_MATERIALLY_BETTER_THRESHOLD,
) -> Tuple[ChipAction, Optional[int], Optional[float], Optional[int], List[str]]:
    """
    Apply horizon suppression: if a materially better window is upcoming,
    downgrade a proposed FIRE to WATCH.  PASS and already-WATCH proposals
    are returned unchanged.

    Parameters
    ----------
    proposed_action:
        The action the evaluator wants to take before suppression check.
    state:
        Immutable gameweek context.
    current_score:
        Projected window score for the current GW.
    threshold:
        Suppression threshold forwarded to ``better_window_ahead``.

    Returns
    -------
    (action, watch_until, best_future_score, best_future_gw, extra_reason_codes)
        ``action``              — possibly downgraded from FIRE to WATCH.
        ``watch_until``         — GW to hold until (set when action → WATCH).
        ``best_future_score``   — score of the best future window, or None.
        ``best_future_gw``      — GW of the best future window, or None.
        ``extra_reason_codes``  — additional reason codes to append.
    """
    if proposed_action is not ChipAction.FIRE:
        return proposed_action, None, None, None, []

    future_windows = tuple(
        (gw, score)
        for gw, score in state.window_scores
        if gw > state.current_gw
    )
    result = better_window_ahead(current_score, future_windows, threshold)
    if result is None:
        return proposed_action, None, None, None, []

    best_gw, best_score = result
    return (
        ChipAction.WATCH,
        best_gw,
        best_score,
        best_gw,
        ["better_window_imminent"],
    )


# ---------------------------------------------------------------------------
# Force-escalation normalisation
# ---------------------------------------------------------------------------

def normalise_force_escalation(
    decision: ChipDecision,
    is_forced: bool,
    forced_by_label: str,
    chip_type: str,
    state: GameweekState,
) -> ChipDecision:
    """
    If ``is_forced`` is True, upgrade ``decision.action`` to FIRE (overriding
    any WATCH/PASS result) and set ``forced_by`` to ``forced_by_label``, unless
    the chip is absent from ``state.chips_available`` (hard veto: the chip has
    already been used or is otherwise unavailable).

    Parameters
    ----------
    decision:
        The base decision produced by the evaluator.
    is_forced:
        Whether a hard rule is demanding the chip be played now.
    forced_by_label:
        Identifier for the forcing rule, e.g. ``"season_horizon_last_window"``.
    chip_type:
        The chip being evaluated, e.g. ``"Wildcard"``.
    state:
        Gameweek context; used only to check ``chips_available`` for the hard
        veto guard.

    Returns
    -------
    ChipDecision
        A new ChipDecision (original is not mutated).  If force applies, action
        is FIRE and forced_by is set.  If the chip is unavailable, the force is
        silently absorbed and PASS is returned with a ``chip_unavailable`` code.
    """
    if not is_forced:
        return decision

    # Hard veto: chip is not available — force cannot override this.
    if chip_type not in state.chips_available:
        return ChipDecision(
            action=ChipAction.PASS,
            chip_type=chip_type,
            reason_codes=list(dict.fromkeys(
                decision.reason_codes + ["chip_unavailable", "force_vetoed"]
            )),
            watch_until=None,
            forced_by=None,
            current_window_score=decision.current_window_score,
            best_future_window_score=decision.best_future_window_score,
            best_future_window_gw=decision.best_future_window_gw,
            confidence="HIGH",
        )

    return ChipDecision(
        action=ChipAction.FIRE,
        chip_type=chip_type,
        reason_codes=list(dict.fromkeys(
            decision.reason_codes + [f"forced_by_{forced_by_label}"]
        )),
        watch_until=None,
        forced_by=forced_by_label,
        current_window_score=decision.current_window_score,
        best_future_window_score=decision.best_future_window_score,
        best_future_window_gw=decision.best_future_window_gw,
        confidence="HIGH",
    )


# ---------------------------------------------------------------------------
# Invariant validation
# ---------------------------------------------------------------------------

def validate_decision(decision: ChipDecision, state: GameweekState) -> None:
    """
    Assert all ChipDecision invariants.  Raises ``ValueError`` if any are
    violated.  Intended to be called on every decision produced by an evaluator
    before it is returned to the caller.

    Invariants checked
    ------------------
    1. ``reason_codes`` must be non-empty.
    2. If ``action == WATCH``, ``watch_until`` must be set and
       ``watch_until > state.current_gw``.
    3. If ``forced_by`` is set, ``action`` must be ``FIRE``.
    4. If ``action != FIRE``, ``forced_by`` must be ``None``.
    5. If ``action == FIRE``, the chip must be in
       ``state.chips_available`` (one-chip-per-GW hard gate).

    Parameters
    ----------
    decision:
        The decision to validate.
    state:
        Context against which invariants are checked.

    Raises
    ------
    ValueError
        With a descriptive message for the first invariant that fails.
    """
    prefix = f"ChipDecision({decision.chip_type!r}, {decision.action})"

    # 1. reason_codes must be populated
    if not decision.reason_codes:
        raise ValueError(
            f"{prefix}: reason_codes must be non-empty; got {decision.reason_codes!r}"
        )

    # 2. WATCH requires watch_until > current_gw
    if decision.action is ChipAction.WATCH:
        if decision.watch_until is None:
            raise ValueError(
                f"{prefix}: action=WATCH but watch_until is None"
            )
        if decision.watch_until <= state.current_gw:
            raise ValueError(
                f"{prefix}: watch_until ({decision.watch_until}) must be > "
                f"current_gw ({state.current_gw})"
            )

    # 3. forced_by set → action must be FIRE
    if decision.forced_by is not None and decision.action is not ChipAction.FIRE:
        raise ValueError(
            f"{prefix}: forced_by={decision.forced_by!r} is set but "
            f"action={decision.action} (expected FIRE)"
        )

    # 4. action != FIRE → forced_by must be None
    if decision.action is not ChipAction.FIRE and decision.forced_by is not None:
        raise ValueError(
            f"{prefix}: action={decision.action} must not have "
            f"forced_by={decision.forced_by!r}"
        )

    # 5. FIRE requires chip in chips_available
    if decision.action is ChipAction.FIRE:
        if decision.chip_type not in state.chips_available:
            raise ValueError(
                f"{prefix}: action=FIRE but chip {decision.chip_type!r} is "
                f"not in chips_available={set(state.chips_available)!r}"
            )
