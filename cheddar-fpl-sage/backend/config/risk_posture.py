"""
Canonical risk posture configuration.

This is the single source of truth for all posture-driven thresholds, weights,
and toggles.  Every module that needs posture-specific behaviour should import
``get_posture_config()`` from here — never duplicate the values inline.

Usage::

    from backend.config.risk_posture import get_posture_config
    cfg = get_posture_config("AGGRESSIVE")
    if weighted_gain >= cfg.hit_threshold_net_pts:
        ...
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PostureName = Literal["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]
PostureSignal = Literal["CHASE", "HOLD", "PROTECT"]


@dataclass(frozen=True)
class RiskPostureConfig:
    """
    All posture-driven parameters in one place.

    Scoring parameters change *how options rank*.
    Threshold parameters change *what is allowed*.
    Policy toggles change *which option is selected*.
    """

    name: PostureName

    # ── Hit / transfer ROI ────────────────────────────────────────────────────
    # Minimum weighted net gain required to approve a hit.
    hit_threshold_net_pts: float
    # Time-horizon weights for hit ROI: short = next 2 GW, mid = next 6 GW.
    hit_short_weight: float
    hit_mid_weight: float

    # ── Transfer candidate scoring ────────────────────────────────────────────
    # Fraction of the score that comes from ceiling (P75) vs floor (P25).
    # sum must equal 1.0; aggressive favours ceiling, conservative favours floor.
    transfer_ceiling_weight: float
    transfer_floor_weight: float

    # ── Volatility / fragility penalties ─────────────────────────────────────
    # These multiply the volatility and fragility penalty terms in scoring.
    # Higher = more penalty = more risk-averse.
    volatility_penalty_weight: float
    fragility_penalty_weight: float

    # ── Ownership / template bias ─────────────────────────────────────────────
    # Positive values reward template alignment; negative values penalise it
    # (i.e. reward differentials).
    ownership_bias_weight: float

    # ── Differential captain bias ─────────────────────────────────────────────
    # Scales the differential_bonus (inverse of ownership) applied to captain
    # scoring.  0.0 means no differential bonus (conservative); 0.6 means
    # aggressive posture actively seeks leveraged captains.
    diff_captain_bias: float

    # ── Chip thresholds ───────────────────────────────────────────────────────
    bench_boost_threshold_pts: float   # combined bench expected points required
    bench_fragility_tolerance: float   # max bench fragility score for BB to fire
    wildcard_weakness_threshold: int   # squad weakness count to trigger WC hint

    # ── Selection policy toggles ──────────────────────────────────────────────
    # If True, break captain ties by preferring the highest-owned option.
    captain_template_tiebreak: bool

    # ── Communication ─────────────────────────────────────────────────────────
    posture_signal_default: PostureSignal


# ─────────────────────────────────────────────────────────────────────────────
# Canonical config values
# ─────────────────────────────────────────────────────────────────────────────

RISK_POSTURE_CONFIGS: dict[str, RiskPostureConfig] = {
    "AGGRESSIVE": RiskPostureConfig(
        name="AGGRESSIVE",
        # Hit: thin +1.5 net pts clears threshold; weight the next 2 GWs heavily
        hit_threshold_net_pts=1.5,
        hit_short_weight=0.70,
        hit_mid_weight=0.30,
        # Transfer: 70% ceiling-oriented scoring
        transfer_ceiling_weight=0.70,
        transfer_floor_weight=0.30,
        # Scoring: tolerate volatility and fragility; penalise template overlap
        volatility_penalty_weight=0.30,
        fragility_penalty_weight=0.25,
        ownership_bias_weight=-0.30,
        # Captain: strong differential bias
        diff_captain_bias=0.60,
        # Chips: fire earlier
        bench_boost_threshold_pts=14.0,
        bench_fragility_tolerance=0.65,
        wildcard_weakness_threshold=3,
        captain_template_tiebreak=False,
        posture_signal_default="CHASE",
    ),
    "BALANCED": RiskPostureConfig(
        name="BALANCED",
        hit_threshold_net_pts=3.0,
        hit_short_weight=0.50,
        hit_mid_weight=0.50,
        transfer_ceiling_weight=0.50,
        transfer_floor_weight=0.50,
        volatility_penalty_weight=0.50,
        fragility_penalty_weight=0.50,
        ownership_bias_weight=0.00,
        diff_captain_bias=0.25,
        bench_boost_threshold_pts=16.0,
        bench_fragility_tolerance=0.45,
        wildcard_weakness_threshold=4,
        captain_template_tiebreak=True,
        posture_signal_default="HOLD",
    ),
    "CONSERVATIVE": RiskPostureConfig(
        name="CONSERVATIVE",
        # Hit: need +6 net pts to justify the cost; weight mid-horizon
        hit_threshold_net_pts=6.0,
        hit_short_weight=0.30,
        hit_mid_weight=0.70,
        # Transfer: 70% floor-oriented scoring
        transfer_ceiling_weight=0.30,
        transfer_floor_weight=0.70,
        # Scoring: heavy penalties; reward template alignment
        volatility_penalty_weight=0.75,
        fragility_penalty_weight=0.80,
        ownership_bias_weight=0.30,
        # Captain: no differential bias — always prefer safe/template pick
        diff_captain_bias=0.00,
        # Chips: fire only when clearly warranted
        bench_boost_threshold_pts=18.0,
        bench_fragility_tolerance=0.25,
        wildcard_weakness_threshold=4,
        captain_template_tiebreak=True,
        posture_signal_default="PROTECT",
    ),
}


def get_posture_config(posture: str | None) -> RiskPostureConfig:
    """
    Return the RiskPostureConfig for the given posture name.

    Normalises case and falls back to BALANCED for None / unknown values so
    callers never need to guard against missing config.
    """
    if not posture:
        return RISK_POSTURE_CONFIGS["BALANCED"]
    normalized = posture.strip().upper()
    return RISK_POSTURE_CONFIGS.get(normalized, RISK_POSTURE_CONFIGS["BALANCED"])
