"""
chip_engine — deterministic FPL chip evaluation foundation.

Public surface:
    types   → GameweekState, ChipDecision, ChipAction
    shared  → clamp_score, horizon_adjusted_score, suppress_or_fire,
              normalise_force_escalation, validate_decision
"""

from .types import ChipAction, ChipDecision, GameweekState
from .shared import (
    clamp_score,
    horizon_adjusted_score,
    better_window_ahead,
    suppress_or_fire,
    normalise_force_escalation,
    validate_decision,
)
from .wildcard_free_hit import (
    FreeHitInputs,
    WildcardInputs,
    evaluate_free_hit,
    evaluate_wildcard,
)

__all__ = [
    # types
    "ChipAction",
    "ChipDecision",
    "GameweekState",
    # shared helpers
    "clamp_score",
    "horizon_adjusted_score",
    "better_window_ahead",
    "suppress_or_fire",
    "normalise_force_escalation",
    "validate_decision",
    # wildcard + free hit
    "WildcardInputs",
    "FreeHitInputs",
    "evaluate_wildcard",
    "evaluate_free_hit",
]
