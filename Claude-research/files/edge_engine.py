# system_a/edge_engine.py
# Market-aware edge computation for System A.
#
# THIS IS THE FIXED VERSION of computeEdgePct().
# Previous bug: moneyline win-prob math was applied to spread and total markets.
# Fix: market_type now routes to the correct probability model before edge calc.
#
# Three edge models:
#   1. IMPLIED_PROB  → moneylines, BTTs, any binary outcome with no spread
#      edge = true_prob - implied_prob
#
#   2. NORMAL_CDF    → spreads and totals, where sigma matters
#      edge = Φ((model_line - market_line) / sigma) - 0.5
#      then expressed as percentage above break-even (52.38% for -110)
#
#   3. DIRECT        → markets where model outputs implied prob directly (xG models)
#      edge = model_implied_prob - market_implied_prob

from __future__ import annotations
import math
from shared.constants import (
    MarketType, Sport, EdgeTier, get_edge_tier, EDGE_WATCH_THRESHOLD
)
from shared.sigma_config import get_sigma
from shared.kelly import compute_kelly_stake
from shared.play_schema import EdgePlay

# Markets that use implied probability directly (no sigma needed)
IMPLIED_PROB_MARKETS = {
    MarketType.MLB_F5_MONEYLINE,
    MarketType.MLB_UNDERDOG_ML,
    MarketType.NBA_MONEYLINE,
    MarketType.NHL_ML_INCL_OT,
    MarketType.EPL_HOME_WIN_XG,
    MarketType.EPL_ASIAN_HANDICAP,  # goal-line uses sigma actually — see below
    MarketType.NCAAM_SLIGHT_DOG_ML,
    MarketType.MLS_HOME_WIN_XG,
    MarketType.UCL_HOME_WIN_XG,
    MarketType.UCL_BTTS,
}

# Markets that use normal CDF (spread/total with sigma)
NORMAL_CDF_MARKETS = {
    MarketType.NFL_SITUATIONAL_TOTAL,
    MarketType.NFL_DIV_DOG_SPREAD,
    MarketType.NFL_RLM_SPREAD,
    MarketType.NFL_ALT_SPREAD,
    MarketType.MLB_TOTAL,
    MarketType.MLB_RUNLINE_DOG,
    MarketType.NBA_TOTAL_PACE,
    MarketType.NBA_ALT_SPREAD_REST,
    MarketType.NHL_TOTAL_OVER,
    MarketType.EPL_ASIAN_HANDICAP,  # goal-line, uses sigma 0.9
    MarketType.NCAAM_MID_MAJOR_SPREAD,
    MarketType.NCAAM_TOTAL_PACE,
    MarketType.MLS_ASIAN_HANDICAP,
    MarketType.MLS_TOTAL,
    MarketType.UCL_ASIAN_HANDICAP,
}

# Break-even win rate for standard -110 lines
BREAKEVEN_110 = 0.5238


def _normal_cdf(x: float) -> float:
    """Standard normal CDF using math.erf approximation."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def compute_edge_pct(
    sport: str,
    market_type: str,
    model_prob: float,        # model's estimated true win probability (0–1)
    implied_prob: float,      # market implied prob after vig removal (0–1)
    model_line: float = 0.0,  # model's number (e.g. projected total = 43.2)
    market_line: float = 0.0, # market's posted number (e.g. total = 45.5)
) -> float:
    """
    Compute edge percentage for a System A market play.

    Returns edge as a float percentage (e.g. 6.2 for 6.2%).
    Returns 0.0 if no edge detected or market type not recognised.

    Args:
        sport:        Sport enum string
        market_type:  MarketType enum string — determines which model to use
        model_prob:   Model's estimated win probability (used for implied-prob markets)
        implied_prob: Market's implied probability post vig-removal
        model_line:   Model's projected line number (used for normal-CDF markets)
        market_line:  Market's posted line number (used for normal-CDF markets)
    """
    if market_type in NORMAL_CDF_MARKETS:
        return _edge_normal_cdf(sport, market_type, model_line, market_line, implied_prob)
    elif market_type in IMPLIED_PROB_MARKETS:
        return _edge_implied_prob(model_prob, implied_prob)
    else:
        import warnings
        warnings.warn(
            f"[edge_engine] Unknown market_type '{market_type}' for sport '{sport}'. "
            "Returning 0.0 edge. Add to NORMAL_CDF_MARKETS or IMPLIED_PROB_MARKETS.",
            UserWarning,
        )
        return 0.0


def _edge_implied_prob(model_prob: float, implied_prob: float) -> float:
    """
    Edge for moneyline / binary markets.
    Simple difference between model's estimated true prob and market implied prob.
    Expressed as percentage.
    """
    raw_edge = model_prob - implied_prob
    return round(raw_edge * 100.0, 2)


def _edge_normal_cdf(
    sport: str,
    market_type: str,
    model_line: float,
    market_line: float,
    implied_prob: float,
) -> float:
    """
    Edge for spread/total markets using normal CDF.

    Logic:
      1. Get sigma for this sport+market_type
      2. Compute how many sigma our model line differs from market line
      3. Convert to win probability via normal CDF
      4. Subtract break-even win rate (52.38% at -110)
      5. Express as percentage edge above break-even
    """
    sigma = get_sigma(sport, market_type)
    if sigma <= 0:
        return 0.0

    # z-score: how many sigma is the model's line vs. the market's line
    z = (model_line - market_line) / sigma

    # Win probability from CDF
    # If model_line > market_line (we like the OVER / we think the number is low):
    #   z > 0 → CDF > 0.5 → positive edge
    # If model_line < market_line (we like the UNDER):
    #   z < 0 → CDF < 0.5 → but edge should still be positive if meaningful
    #   In that case caller should pass market_line - model_line as the diff
    win_prob = _normal_cdf(z)

    # Edge above break-even
    breakeven = BREAKEVEN_110  # standard -110 assumption
    # Adjust if implied_prob is significantly different from -110 equivalent
    if implied_prob > 0:
        breakeven = implied_prob

    edge = (win_prob - breakeven) * 100.0
    return round(edge, 2)


def remove_vig(odds_side_a: float, odds_side_b: float) -> tuple[float, float]:
    """
    Remove vig from American odds pair and return true implied probabilities.

    Args:
        odds_side_a: American odds for side A (e.g. -110)
        odds_side_b: American odds for side B (e.g. -110)

    Returns:
        (implied_prob_a, implied_prob_b) after vig normalisation
    """
    def american_to_implied(odds: float) -> float:
        if odds < 0:
            return (-odds) / (-odds + 100)
        else:
            return 100 / (odds + 100)

    raw_a = american_to_implied(odds_side_a)
    raw_b = american_to_implied(odds_side_b)
    total = raw_a + raw_b  # > 1.0 due to vig

    return (raw_a / total, raw_b / total)


def build_edge_play(
    sport: str,
    game: str,
    market_type: str,
    pick: str,
    edge_pct: float,
    implied_prob: float,
    true_prob: float,
    reasoning: list[str],
    bankroll_units: float = 100.0,
) -> EdgePlay:
    """
    Assemble a fully populated EdgePlay from edge computation outputs.
    This is the standard factory — all System A models call this.
    """
    tier = get_edge_tier(edge_pct)
    stake = compute_kelly_stake(edge_pct, implied_prob, bankroll_units)

    return EdgePlay(
        sport=sport,
        game=game,
        market_type=market_type,
        pick=pick,
        edge_pct=edge_pct,
        tier=tier,
        kelly_stake=stake,
        implied_prob=implied_prob,
        true_prob=true_prob,
        reasoning=reasoning,
    )
