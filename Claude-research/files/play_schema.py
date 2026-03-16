# shared/play_schema.py
# Canonical output objects for both systems.
#
# DESIGN CONTRACT:
#   EdgePlay    → System A only. Has edge_pct, tier, kelly_stake. NO proj_value.
#   ProjectionPlay → System B only. Has proj_value, floor, ceiling. NO edge_pct.
#
# Both share: play_id, system, sport, game/player, pick/recommended_side,
#             reasoning, generated_at.
#
# The `system` field is the routing key downstream (dashboard, Play Locker, etc.)

from __future__ import annotations
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Optional
import uuid

from shared.constants import (
    System, EdgeTier, ConfidenceTier, Sport, MarketType, PropType
)


# ── System A Output ────────────────────────────────────────────────────────────

@dataclass
class EdgePlay:
    """
    Output of System A — Market Edge Finder.
    Produced when a real odds line exists and model finds pricing inefficiency.
    """
    system: str              = field(default=System.EDGE, init=False)
    play_id: str             = field(default_factory=lambda: str(uuid.uuid4()))
    sport: str               = ""               # Sport enum value
    game: str                = ""               # "BUF @ NYJ"
    market_type: str         = ""               # MarketType enum value
    pick: str                = ""               # "UNDER 44.5" | "BUF +3.5"
    edge_pct: float          = 0.0              # e.g. 6.2 (percent)
    tier: str                = EdgeTier.PASS    # HOT | WATCH | PASS
    kelly_stake: float       = 0.0              # units (partial Kelly 0.5x)
    implied_prob: float      = 0.0              # market implied prob post-vig
    true_prob: float         = 0.0              # model estimated true prob
    reasoning: list[str]     = field(default_factory=list)
    generated_at: str        = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    # ── Fields intentionally ABSENT from EdgePlay ─────────────────────────────
    # proj_value, floor, ceiling, confidence — those live on ProjectionPlay only.

    def to_dict(self) -> dict:
        return asdict(self)

    def is_actionable(self) -> bool:
        """True if tier is HOT or WATCH — surfaced to user."""
        return self.tier in (EdgeTier.HOT, EdgeTier.WATCH)

    def __post_init__(self):
        # Guard: edge_pct must be non-negative
        if self.edge_pct < 0:
            raise ValueError(f"edge_pct cannot be negative: {self.edge_pct}")
        # Guard: implied_prob must be valid probability
        if not (0.0 <= self.implied_prob <= 1.0):
            raise ValueError(f"implied_prob out of range: {self.implied_prob}")


# ── System B Output ────────────────────────────────────────────────────────────

@dataclass
class ProjectionPlay:
    """
    Output of System B — Projection Engine.
    Produced when a stat model generates a player or team projection.
    No edge_pct — no real line to beat (or line intentionally ignored per design).
    """
    system: str              = field(default=System.PROJECTION, init=False)
    play_id: str             = field(default_factory=lambda: str(uuid.uuid4()))
    sport: str               = ""               # Sport enum value
    game: str                = ""               # "BUF @ NYJ"
    player: str              = ""               # "Nikola Jokic" | "" for team props
    prop_type: str           = ""               # PropType enum value
    proj_value: float        = 0.0              # e.g. 54.2 (points)
    floor: float             = 0.0              # low end of confidence band
    ceiling: float           = 0.0             # high end of confidence band
    recommended_side: str    = ""               # "OVER" | "UNDER"
    confidence: str          = ConfidenceTier.LOW
    line_available: bool     = False            # True if Odds API has this prop line
    # NOTE: if line_available=True, we still show projection only (per design contract)
    reasoning: list[str]     = field(default_factory=list)
    generated_at: str        = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    # ── Fields intentionally ABSENT from ProjectionPlay ───────────────────────
    # edge_pct, tier (EdgeTier), kelly_stake — those live on EdgePlay only.

    def to_dict(self) -> dict:
        return asdict(self)

    def is_surfaceable(self) -> bool:
        """True if confidence is HIGH or MEDIUM — surfaced to user."""
        return self.confidence in (ConfidenceTier.HIGH, ConfidenceTier.MEDIUM)

    def __post_init__(self):
        # Guard: floor <= proj_value <= ceiling
        if not (self.floor <= self.proj_value <= self.ceiling):
            raise ValueError(
                f"Projection out of band: floor={self.floor}, "
                f"proj={self.proj_value}, ceiling={self.ceiling}"
            )
        # Guard: recommended_side must be OVER or UNDER
        if self.recommended_side not in ("OVER", "UNDER", ""):
            raise ValueError(
                f"recommended_side must be 'OVER' or 'UNDER', got: {self.recommended_side}"
            )


# ── Unified type alias for downstream consumers ────────────────────────────────

Play = EdgePlay | ProjectionPlay


def play_from_dict(d: dict) -> Play:
    """
    Reconstruct a Play from a dict (e.g. loaded from play_log.db).
    Routes by system field.
    """
    if d.get("system") == System.EDGE:
        return EdgePlay(**{k: v for k, v in d.items() if k != "system"})
    elif d.get("system") == System.PROJECTION:
        return ProjectionPlay(**{k: v for k, v in d.items() if k != "system"})
    else:
        raise ValueError(f"Unknown system tag: {d.get('system')}")
