# system_b/projection_engine.py
# Core projection math for System B — Projection Engine.
#
# Every sport projector calls these functions. None of them touch edge_pct.
#
# Three-stage model per projection:
#   Stage 1: Rolling weighted average (recent form, decay-weighted)
#   Stage 2: Matchup adjustment (opponent rank vs. this stat category)
#   Stage 3: Confidence band (floor/ceiling from historical sigma for this prop)

from __future__ import annotations
import math
import statistics
from shared.constants import (
    PropType, ConfidenceTier, get_confidence_tier, TIER1_PROPS, TIER2_PROPS
)
from shared.play_schema import ProjectionPlay


# ── Stage 1: Rolling weighted average ─────────────────────────────────────────

# How many recent games to use per prop tier
ROLLING_WINDOW = {
    "tier1": 10,  # volume/behavior props — stable, use more games
    "tier2": 7,   # execution props — more recency-sensitive
}

# Decay weights: most recent game gets highest weight
# Generated as geometric series: w_i = decay^i, normalised
DECAY_RATE = 0.85  # each game back is worth 85% of the previous


def weighted_rolling_average(
    game_values: list[float],
    prop_type: str,
    decay: float = DECAY_RATE,
) -> float:
    """
    Compute decay-weighted rolling average of recent game values.

    Args:
        game_values: List of stat values, most recent LAST (e.g. [22, 18, 31, 25])
        prop_type:   PropType string — determines window size
        decay:       Geometric decay factor per game back

    Returns:
        Weighted average as float
    """
    tier = "tier1" if prop_type in TIER1_PROPS else "tier2"
    window = ROLLING_WINDOW[tier]

    # Use only the most recent N games
    recent = game_values[-window:] if len(game_values) >= window else game_values
    if not recent:
        return 0.0

    # Build weights: most recent = highest weight
    weights = [decay ** i for i in range(len(recent) - 1, -1, -1)]
    total_weight = sum(weights)

    weighted_sum = sum(v * w for v, w in zip(recent, weights))
    return weighted_sum / total_weight


# ── Stage 2: Matchup adjustment ────────────────────────────────────────────────

def apply_matchup_adjustment(
    base_projection: float,
    opponent_rank: int,     # 1 = best defense vs. this stat, 30 = worst
    n_teams: int = 30,      # league size (30 NBA, 30 MLB, 32 NFL, 32 NHL, 20 EPL)
    max_adjustment_pct: float = 0.15,  # cap at ±15% adjustment
) -> float:
    """
    Adjust base projection up or down based on opponent defensive rank.

    Logic:
      - Rank 1 (best defense) → max negative adjustment (suppress projection)
      - Rank N (worst defense) → max positive adjustment (inflate projection)
      - Rank ~N/2 (league average) → no adjustment

    Returns:
        Adjusted projection value
    """
    if n_teams <= 1:
        return base_projection

    # Normalize rank to [-0.5, +0.5] range
    # Rank 1 → -0.5 (suppress), Rank N → +0.5 (inflate)
    normalized = (opponent_rank - 1) / (n_teams - 1) - 0.5

    # Scale to max_adjustment_pct
    adjustment_pct = normalized * max_adjustment_pct * 2

    return base_projection * (1 + adjustment_pct)


# ── Stage 3: Confidence band ───────────────────────────────────────────────────

def compute_confidence_band(
    projection: float,
    historical_values: list[float],
    prop_type: str,
) -> tuple[float, float, float, str]:
    """
    Compute floor, ceiling, sigma, and confidence tier from historical distribution.

    Args:
        projection:        Final adjusted projection value
        historical_values: Full season game log values (not just rolling window)
        prop_type:         PropType string

    Returns:
        (floor, ceiling, sigma, confidence_tier)
        floor    = projection - 1 std dev
        ceiling  = projection + 1 std dev
        sigma    = standard deviation of historical distribution
        confidence = ConfidenceTier based on sigma
    """
    if len(historical_values) < 3:
        # Not enough data — wide band, low confidence
        sigma = projection * 0.30  # assume 30% uncertainty
        return (
            max(0.0, projection - sigma),
            projection + sigma,
            sigma,
            ConfidenceTier.LOW,
        )

    sigma = statistics.stdev(historical_values)

    floor   = max(0.0, projection - sigma)
    ceiling = projection + sigma

    confidence = get_confidence_tier(sigma)

    return (round(floor, 1), round(ceiling, 1), round(sigma, 2), confidence)


# ── Recommended side ───────────────────────────────────────────────────────────

def get_recommended_side(
    projection: float,
    prop_line: float | None,
    floor: float,
    ceiling: float,
) -> str:
    """
    Determine OVER or UNDER recommendation.

    If a prop_line exists (from Odds API): compare projection to line.
    If no line: compare to midpoint of confidence band.

    Returns "OVER", "UNDER", or "" if projection is too close to line to call.
    """
    MINIMUM_GAP_PCT = 0.03  # projection must differ by ≥3% to make a call

    reference = prop_line if prop_line is not None else (floor + ceiling) / 2

    if reference <= 0:
        return ""

    gap_pct = (projection - reference) / reference

    if gap_pct > MINIMUM_GAP_PCT:
        return "OVER"
    elif gap_pct < -MINIMUM_GAP_PCT:
        return "UNDER"
    else:
        return ""  # too close to call — suppress this play


# ── Factory: build a ProjectionPlay ───────────────────────────────────────────

def build_projection_play(
    sport: str,
    game: str,
    player: str,
    prop_type: str,
    game_log: list[float],        # full season game log, most recent last
    opponent_rank: int,           # opponent defensive rank vs. this stat
    n_teams: int,                 # league size for normalisation
    reasoning: list[str],
    prop_line: float | None = None,  # Odds API line if available (kept separate)
    line_available: bool = False,
) -> ProjectionPlay | None:
    """
    Standard factory for all System B projectors.
    Returns None if projection should be suppressed (no recommended side).
    """
    if not game_log:
        return None

    # Stage 1: weighted rolling average
    base = weighted_rolling_average(game_log, prop_type)

    # Stage 2: matchup adjustment
    adjusted = apply_matchup_adjustment(base, opponent_rank, n_teams)

    # Stage 3: confidence band
    floor, ceiling, sigma, confidence = compute_confidence_band(
        adjusted, game_log, prop_type
    )

    # Recommended side
    side = get_recommended_side(adjusted, prop_line, floor, ceiling)
    if not side:
        return None  # too close to call — don't surface

    return ProjectionPlay(
        sport=sport,
        game=game,
        player=player,
        prop_type=prop_type,
        proj_value=round(adjusted, 1),
        floor=floor,
        ceiling=ceiling,
        recommended_side=side,
        confidence=confidence,
        line_available=line_available,
        reasoning=reasoning,
    )
