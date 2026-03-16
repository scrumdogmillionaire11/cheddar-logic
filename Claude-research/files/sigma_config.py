# shared/sigma_config.py
# Sport- and market-specific sigma (standard deviation) values used by
# edge_engine.computeEdgePct() in System A.
#
# Sigma represents the expected outcome distribution width for a given market.
# Tighter markets (efficient) get lower sigma; softer markets get higher sigma.
# These values are calibrated from research and should be recalibrated
# periodically against your CLV tracking data.
#
# Rule: NEVER use the same sigma for spread vs total vs moneyline.
# Rule: NEVER use the same sigma for NBA spread vs NFL spread — market efficiency differs.

from shared.constants import Sport, MarketType

# ── Sigma table ────────────────────────────────────────────────────────────────
# Key: (Sport, MarketType)
# Value: sigma float — used in normal CDF edge calculation
#
# Interpretation:
#   Lower sigma = tighter distribution = harder to find edge
#   Higher sigma = wider distribution = more mispricing possible
#
# NFL: spread sigma ~13-14 pts (actual game margin std dev)
#      total sigma ~7-8 pts (scoring variance)
# NBA: spread sigma ~10-11 pts (high scoring parity)
#      total sigma ~12-13 pts (pace-driven variance)
# MLB: moneyline uses implied prob directly (no spread sigma needed)
#      total sigma ~1.5 runs
# NHL: total sigma ~1.2 goals (low scoring, high variance per goal)
# Soccer: moneyline uses implied prob; goal sigma ~0.8-1.0

SIGMA_TABLE: dict[tuple[str, str], float] = {

    # ── NFL ───────────────────────────────────────────────────────────────────
    (Sport.NFL, MarketType.NFL_SITUATIONAL_TOTAL):  7.5,   # weather/pace-adjusted
    (Sport.NFL, MarketType.NFL_DIV_DOG_SPREAD):    13.5,   # div game parity tighter
    (Sport.NFL, MarketType.NFL_RLM_SPREAD):        13.0,   # sharp-money signal
    (Sport.NFL, MarketType.NFL_ALT_SPREAD):        14.0,   # standard spread dist

    # ── MLB ───────────────────────────────────────────────────────────────────
    (Sport.MLB, MarketType.MLB_F5_MONEYLINE):       0.0,   # implied prob direct (no sigma)
    (Sport.MLB, MarketType.MLB_UNDERDOG_ML):        0.0,   # implied prob direct
    (Sport.MLB, MarketType.MLB_TOTAL):              1.6,   # run distribution
    (Sport.MLB, MarketType.MLB_RUNLINE_DOG):        1.5,   # fixed +1.5 spread

    # ── NBA ───────────────────────────────────────────────────────────────────
    (Sport.NBA, MarketType.NBA_TOTAL_PACE):        12.5,   # pace-adjusted; wider dist
    (Sport.NBA, MarketType.NBA_ALT_SPREAD_REST):   10.5,   # rest edge compresses dist
    (Sport.NBA, MarketType.NBA_MONEYLINE):          0.0,   # implied prob direct

    # ── NHL ───────────────────────────────────────────────────────────────────
    (Sport.NHL, MarketType.NHL_TOTAL_OVER):         1.3,   # goal distribution (tight)
    (Sport.NHL, MarketType.NHL_ML_INCL_OT):         0.0,   # implied prob direct

    # ── EPL ───────────────────────────────────────────────────────────────────
    (Sport.EPL, MarketType.EPL_HOME_WIN_XG):        0.0,   # implied prob direct
    (Sport.EPL, MarketType.EPL_ASIAN_HANDICAP):     0.9,   # goal-line spread

    # ── NCAAM ─────────────────────────────────────────────────────────────────
    (Sport.NCAAM, MarketType.NCAAM_MID_MAJOR_SPREAD): 11.0,  # higher variance than NBA
    (Sport.NCAAM, MarketType.NCAAM_TOTAL_PACE):       10.0,  # pace-driven
    (Sport.NCAAM, MarketType.NCAAM_SLIGHT_DOG_ML):     0.0,  # implied prob direct

    # ── MLS ───────────────────────────────────────────────────────────────────
    (Sport.MLS, MarketType.MLS_HOME_WIN_XG):        0.0,   # implied prob direct
    (Sport.MLS, MarketType.MLS_ASIAN_HANDICAP):     0.9,
    (Sport.MLS, MarketType.MLS_TOTAL):              0.85,  # low-scoring; tight

    # ── UCL ───────────────────────────────────────────────────────────────────
    (Sport.UCL, MarketType.UCL_ASIAN_HANDICAP):     0.85,
    (Sport.UCL, MarketType.UCL_HOME_WIN_XG):        0.0,
    (Sport.UCL, MarketType.UCL_BTTS):               0.0,   # implied prob direct
}

# Fallback sigma if a combo is not in the table.
# Deliberately conservative so we don't generate fake edge on unknown markets.
DEFAULT_SIGMA = 10.0


def get_sigma(sport: str, market_type: str) -> float:
    """
    Retrieve sigma for a given sport + market_type combo.
    Falls back to DEFAULT_SIGMA with a warning if not found.
    """
    key = (sport, market_type)
    if key not in SIGMA_TABLE:
        import warnings
        warnings.warn(
            f"[sigma_config] No sigma found for ({sport}, {market_type}). "
            f"Using default {DEFAULT_SIGMA}. Add to SIGMA_TABLE.",
            UserWarning,
            stacklevel=2,
        )
        return DEFAULT_SIGMA
    return SIGMA_TABLE[key]
