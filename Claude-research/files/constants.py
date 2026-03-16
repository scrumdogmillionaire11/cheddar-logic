# shared/constants.py
# Single source of truth for all thresholds, tier labels, and type strings.
# Neither system_a nor system_b should hardcode any of these values.

from enum import Enum

# ── System tags ────────────────────────────────────────────────────────────────
class System(str, Enum):
    EDGE       = "edge"        # System A: market-line-based edge finder
    PROJECTION = "projection"  # System B: stat-model projection engine

# ── System A: Edge tiers ───────────────────────────────────────────────────────
class EdgeTier(str, Enum):
    HOT   = "HOT"    # edge_pct >= EDGE_HOT_THRESHOLD
    WATCH = "WATCH"  # edge_pct >= EDGE_WATCH_THRESHOLD
    PASS  = "PASS"   # edge_pct < EDGE_WATCH_THRESHOLD — do not surface

EDGE_HOT_THRESHOLD   = 5.0   # %
EDGE_WATCH_THRESHOLD = 3.0   # %
EDGE_PASS_THRESHOLD  = 0.0   # anything below WATCH

def get_edge_tier(edge_pct: float) -> EdgeTier:
    if edge_pct >= EDGE_HOT_THRESHOLD:
        return EdgeTier.HOT
    elif edge_pct >= EDGE_WATCH_THRESHOLD:
        return EdgeTier.WATCH
    else:
        return EdgeTier.PASS

# ── System B: Projection confidence tiers ─────────────────────────────────────
class ConfidenceTier(str, Enum):
    HIGH   = "HIGH"    # sigma <= CONF_HIGH_SIGMA
    MEDIUM = "MEDIUM"  # sigma <= CONF_MEDIUM_SIGMA
    LOW    = "LOW"     # sigma > CONF_MEDIUM_SIGMA — surface but flag

CONF_HIGH_SIGMA   = 3.0
CONF_MEDIUM_SIGMA = 6.0

def get_confidence_tier(sigma: float) -> ConfidenceTier:
    if sigma <= CONF_HIGH_SIGMA:
        return ConfidenceTier.HIGH
    elif sigma <= CONF_MEDIUM_SIGMA:
        return ConfidenceTier.MEDIUM
    else:
        return ConfidenceTier.LOW

# ── System B: Win rate recalibration trigger ───────────────────────────────────
WIN_RATE_RECAL_THRESHOLD   = 0.48   # flag model if rolling win rate drops below 48%
WIN_RATE_MIN_SAMPLE        = 20     # minimum plays before win rate is evaluated

# ── Sports ─────────────────────────────────────────────────────────────────────
class Sport(str, Enum):
    NFL   = "NFL"
    MLB   = "MLB"
    NBA   = "NBA"
    NHL   = "NHL"
    EPL   = "EPL"
    NCAAM = "NCAAM"
    MLS   = "MLS"
    UCL   = "UCL"

# ── System A: Market types (must match Odds API key normalization) ──────────────
class MarketType(str, Enum):
    # NFL
    NFL_SITUATIONAL_TOTAL  = "nfl_situational_total"
    NFL_DIV_DOG_SPREAD     = "nfl_div_dog_spread"
    NFL_RLM_SPREAD         = "nfl_rlm_spread"
    NFL_ALT_SPREAD         = "nfl_alt_spread"
    # MLB
    MLB_F5_MONEYLINE       = "mlb_f5_moneyline"
    MLB_UNDERDOG_ML        = "mlb_underdog_ml"
    MLB_TOTAL              = "mlb_total"
    MLB_RUNLINE_DOG        = "mlb_runline_dog"
    # NBA
    NBA_TOTAL_PACE         = "nba_total_pace"
    NBA_ALT_SPREAD_REST    = "nba_alt_spread_rest"
    NBA_MONEYLINE          = "nba_moneyline"
    # NHL
    NHL_TOTAL_OVER         = "nhl_total_over"
    NHL_ML_INCL_OT         = "nhl_ml_incl_ot"
    # EPL
    EPL_HOME_WIN_XG        = "epl_home_win_xg"
    EPL_ASIAN_HANDICAP     = "epl_asian_handicap"
    # NCAAM
    NCAAM_MID_MAJOR_SPREAD = "ncaam_mid_major_spread"
    NCAAM_TOTAL_PACE       = "ncaam_total_pace"
    NCAAM_SLIGHT_DOG_ML    = "ncaam_slight_dog_ml"
    # MLS
    MLS_HOME_WIN_XG        = "mls_home_win_xg"
    MLS_ASIAN_HANDICAP     = "mls_asian_handicap"
    MLS_TOTAL              = "mls_total"
    # UCL
    UCL_ASIAN_HANDICAP     = "ucl_asian_handicap"
    UCL_HOME_WIN_XG        = "ucl_home_win_xg"
    UCL_BTTS               = "ucl_btts"

# ── System B: Prop types ───────────────────────────────────────────────────────
class PropType(str, Enum):
    # NFL
    RUSH_YDS   = "rush_yds"
    REC_YDS    = "rec_yds"
    RECEPTIONS = "receptions"
    PASS_YDS   = "pass_yds"
    # MLB
    PITCHER_K  = "pitcher_k"
    OUTS_REC   = "outs_recorded"
    BATTER_K   = "batter_k"
    HITS       = "hits"
    # NBA
    POINTS     = "points"
    REBOUNDS   = "rebounds"
    ASSISTS    = "assists"
    PRA        = "pra"
    # NHL
    SHOTS_OG   = "shots_on_goal"
    GK_SAVES   = "goalie_saves"
    TOI        = "time_on_ice"
    PP_POINTS  = "pp_points"
    NHL_1P_TOT = "nhl_1p_total"
    # Soccer (EPL/MLS/UCL)
    SHOTS_OT   = "shots_on_target"
    SOC_SAVES  = "gk_saves"
    PASSES     = "passes_completed"
    # NCAAM
    NCAAM_PTS  = "ncaam_points"
    NCAAM_REB  = "ncaam_rebounds"
    NCAAM_AST  = "ncaam_assists"

# ── Tier routing: which prop types belong to which volatility tier ─────────────
TIER1_PROPS = {  # Low volatility — volume/behavior stats — primary targets
    PropType.SHOTS_OG, PropType.GK_SAVES, PropType.TOI,
    PropType.PITCHER_K, PropType.OUTS_REC,
    PropType.PRA, PropType.REBOUNDS,
    PropType.RUSH_YDS, PropType.REC_YDS,
    PropType.SHOTS_OT, PropType.SOC_SAVES,
}

TIER2_PROPS = {  # Medium volatility — execution stats with matchup edge
    PropType.POINTS, PropType.ASSISTS, PropType.RECEPTIONS,
    PropType.PASS_YDS, PropType.BATTER_K, PropType.HITS,
    PropType.PP_POINTS, PropType.NHL_1P_TOT,
    PropType.PASSES, PropType.NCAAM_PTS, PropType.NCAAM_REB,
}

TIER3_PROPS = {  # High volatility — avoid or surface with LOW confidence only
    # (goals, TDs, HRs, first scorers — not modeled in System B)
}
