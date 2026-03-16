# shared/kelly.py
# Partial Kelly (0.5x) stake sizing for System A edge plays only.
# System B projections do NOT use Kelly — no edge_pct, no stake.
#
# Research basis:
# - Full Kelly → 100% bankruptcy rate in simulations (Wharton, 2023)
# - Half Kelly (0.5x) → optimal risk-adjusted growth
# - Conservative threshold: only size when edge_pct >= EDGE_WATCH_THRESHOLD

from shared.constants import EDGE_WATCH_THRESHOLD, EDGE_HOT_THRESHOLD

# Maximum stake per play as fraction of bankroll (hard cap)
MAX_KELLY_FRACTION = 0.05   # never risk more than 5% of bankroll on one play
MIN_KELLY_FRACTION = 0.005  # floor — below this, not worth placing

KELLY_MULTIPLIER = 0.5      # half Kelly


def compute_kelly_stake(
    edge_pct: float,
    implied_prob: float,
    bankroll_units: float = 100.0,
) -> float:
    """
    Compute recommended stake in units using partial (0.5x) Kelly criterion.

    Args:
        edge_pct:       Model edge as a percentage (e.g. 6.2 for 6.2%)
        implied_prob:   Market implied probability after vig removal (0.0–1.0)
        bankroll_units: Total bankroll in units (default 100u = 1% per unit)

    Returns:
        Recommended stake in units, capped at MAX_KELLY_FRACTION of bankroll.
        Returns 0.0 if edge is below minimum threshold.

    Kelly formula:
        f* = (bp - q) / b
        where b = net odds (decimal - 1), p = true win prob, q = 1 - p
        true_win_prob = implied_prob + edge_pct/100
    """
    if edge_pct < EDGE_WATCH_THRESHOLD:
        return 0.0

    # Convert edge to true probability estimate
    true_prob = implied_prob + (edge_pct / 100.0)
    true_prob = min(true_prob, 0.99)  # cap at 99% — never be certain

    # Derive net decimal odds from implied probability
    # implied_prob = 1 / decimal_odds → decimal_odds = 1 / implied_prob
    if implied_prob <= 0:
        return 0.0
    decimal_odds = 1.0 / implied_prob
    b = decimal_odds - 1.0  # net odds (profit per unit risked)

    q = 1.0 - true_prob

    # Full Kelly fraction
    if b <= 0:
        return 0.0
    full_kelly = (b * true_prob - q) / b

    # Apply partial multiplier
    partial_kelly = full_kelly * KELLY_MULTIPLIER

    # Clamp to safe range
    fraction = max(MIN_KELLY_FRACTION, min(partial_kelly, MAX_KELLY_FRACTION))

    # Convert fraction to units
    stake_units = fraction * bankroll_units

    return round(stake_units, 2)


def format_stake_display(stake_units: float) -> str:
    """Human-readable stake string for dashboard display."""
    if stake_units <= 0:
        return "NO BET"
    return f"{stake_units:.1f}u"
