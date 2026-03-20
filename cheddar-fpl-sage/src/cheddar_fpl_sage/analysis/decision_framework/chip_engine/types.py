"""
Immutable data contracts for the chip evaluation engine.

Design constraints
------------------
* All types are intentionally free of any frontend representation fields
  (no 'label', 'badge_colour', 'icon', etc.).  Transport/display layers own
  that mapping.
* GameweekState is frozen — chip evaluators must never mutate it.
* ChipDecision invariants are declared in the docstring and enforced by
  shared.validate_decision().  Callers are expected to run validate_decision
  on every ChipDecision they produce.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Tuple


class ChipAction(str, Enum):
    """Outcome of a single chip evaluation pass."""

    FIRE = "FIRE"    # Play the chip this gameweek.
    WATCH = "WATCH"  # Conditions are good but a materially better window is
                     # imminent; hold and re-evaluate at watch_until.
    PASS = "PASS"    # Do not play this chip (chip unavailable, low-value
                     # window, or hard veto applies).


@dataclass(frozen=True)
class GameweekState:
    """
    Immutable snapshot of the manager's situation for one gameweek evaluation.

    Passed into every chip evaluator and shared helper.  Never mutated.

    Attributes
    ----------
    current_gw:
        The gameweek being evaluated (1-based, 1–38 in a standard season).
    total_gws:
        Total gameweeks in the season (normally 38).
    chips_available:
        Frozenset of chip names that have NOT yet been played, e.g.
        frozenset({"Wildcard", "Free Hit"}).  Evaluators must not fire a chip
        that is absent from this set.
    chips_used:
        Frozenset of chip names already played this season.
    window_scores:
        Tuple of (gameweek, projected_window_score) pairs, sorted ascending by
        gameweek.  Covers the current GW and any future candidate windows.
        Projected scores are dimensionless floats (higher = better).
    risk_posture:
        Manager's declared risk tolerance. One of "CONSERVATIVE", "BALANCED",
        or "AGGRESSIVE".  Defaults to "BALANCED".
    """

    current_gw: int
    total_gws: int
    chips_available: frozenset
    chips_used: frozenset
    window_scores: Tuple[Tuple[int, float], ...]
    risk_posture: str = "BALANCED"

    def __post_init__(self) -> None:
        if self.current_gw < 1 or self.current_gw > self.total_gws:
            raise ValueError(
                f"current_gw {self.current_gw!r} must be in "
                f"[1, {self.total_gws}]"
            )
        if self.total_gws < 1:
            raise ValueError(f"total_gws must be ≥ 1, got {self.total_gws!r}")


@dataclass
class ChipDecision:
    """
    Output of a single chip evaluation.

    Invariants (enforced by shared.validate_decision)
    --------------------------------------------------
    1. ``reason_codes`` is always non-empty.
    2. If ``action == WATCH``, ``watch_until`` must be set and greater than
       the current gameweek (callers should pass the state for validation).
    3. If ``forced_by`` is set, ``action`` must be ``FIRE``.
    4. If ``action != FIRE``, ``forced_by`` must be ``None``.
    5. A chip that is not in ``GameweekState.chips_available`` must never
       carry ``action == FIRE``.

    Attributes
    ----------
    action:
        The recommended action for this chip this gameweek.
    chip_type:
        Human-readable chip name, e.g. "Wildcard".  Must match a key that
        chip evaluators understand; not validated here.
    reason_codes:
        Non-empty list of snake_case reason identifiers, e.g.
        ``["dge_window_high", "bench_depth_poor"]``.
    watch_until:
        Gameweek number at which to re-evaluate; required when action is WATCH.
    forced_by:
        Identifier of the rule/trigger that escalated the decision to FIRE,
        e.g. ``"season_horizon_last_window"``.  Must be None for WATCH/PASS.
    current_window_score:
        Projected score for the current window (informational).
    best_future_window_score:
        Projected score for the best upcoming window (informational).
    best_future_window_gw:
        GW of the best upcoming window (informational).
    confidence:
        Evaluator's confidence in this decision: "HIGH", "MEDIUM", or "LOW".
    """

    action: ChipAction
    chip_type: str
    reason_codes: List[str] = field(default_factory=list)

    # WATCH metadata
    watch_until: Optional[int] = None

    # Force-escalation metadata
    forced_by: Optional[str] = None

    # Diagnostic scores — informational only, not used in invariant checks
    current_window_score: Optional[float] = None
    best_future_window_score: Optional[float] = None
    best_future_window_gw: Optional[int] = None

    confidence: str = "MEDIUM"
