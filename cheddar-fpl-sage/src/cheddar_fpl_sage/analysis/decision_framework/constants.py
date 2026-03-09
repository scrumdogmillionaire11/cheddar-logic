"""
Constants for FPL decision framework.
Centralizes magic numbers and configuration defaults.
"""
from typing import Optional

# Manual player identification
# Players manually added (not from FPL API) use IDs >= this value
MANUAL_PLAYER_ID_START = 900000

# Formation constraints (FPL rules)
MIN_GOALKEEPERS = 1
MAX_GOALKEEPERS = 2
MIN_DEFENDERS = 3
MAX_DEFENDERS = 5
MIN_MIDFIELDERS = 2
MAX_MIDFIELDERS = 5
MIN_FORWARDS = 1
MAX_FORWARDS = 3
SQUAD_SIZE = 15
STARTING_XI_SIZE = 11
MAX_PLAYERS_PER_TEAM = 3

# Projection defaults for manual/fallback players
FALLBACK_PROJECTION_PTS = 5.0
FALLBACK_NEXT_3GW_PTS = 15.0
FALLBACK_NEXT_5GW_PTS = 25.0

# Risk posture options (Manager Risk Tolerance)
RISK_POSTURES = ["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]
DEFAULT_RISK_POSTURE = "BALANCED"

# Strategy mode options (rank-aware planning layer)
STRATEGY_MODES = ["DEFEND", "CONTROLLED", "BALANCED", "RECOVERY"]
DEFAULT_STRATEGY_MODE = "BALANCED"

# Chip names (consistent naming)
CHIP_NAMES = frozenset([
    "Wildcard", "Free Hit", "Bench Boost", "Triple Captain"
])

# Valid positions
POSITIONS = frozenset(["GKP", "DEF", "MID", "FWD"])

# Point horizons for transfer evaluation
TRANSFER_HORIZON_SHORT = 3  # gameweeks
TRANSFER_HORIZON_MEDIUM = 5
TRANSFER_HORIZON_LONG = 8


def is_manual_player(player_id: int) -> bool:
    """Check if a player ID represents a manually added player."""
    return player_id >= MANUAL_PLAYER_ID_START


def normalize_risk_posture(value: Optional[str] = None) -> str:
    """
    Normalize and validate risk posture string.
    
    Args:
        value: User-provided risk posture (case-insensitive) or None
        
    Returns:
        Normalized risk posture (uppercase)
        
    Raises:
        ValueError: If value is not in RISK_POSTURES
    """
    if value is None or not value.strip():
        return DEFAULT_RISK_POSTURE
    
    normalized = value.strip().upper()
    if normalized not in RISK_POSTURES:
        valid = ", ".join(RISK_POSTURES)
        raise ValueError(
            f"Invalid risk_posture '{value}'. Must be one of: {valid}"
        )
    return normalized


def get_volatility_multiplier(risk_posture: str) -> float:
    """
    Get volatility penalty multiplier for given risk posture.
    
    CONSERVATIVE: 1.25x (more penalty, avoid volatile transfers)
    BALANCED: 1.0x (neutral)
    AGGRESSIVE: 0.8x (less penalty, tolerate volatility for upside)
    """
    multipliers = {
        "CONSERVATIVE": 1.25,
        "BALANCED": 1.0,
        "AGGRESSIVE": 0.8
    }
    return multipliers.get(risk_posture, 1.0)


def derive_rank_bucket(overall_rank: Optional[int]) -> str:
    """
    Map overall rank to explicit bucket used by strategy mode.

    Buckets:
    - <= 50k: elite
    - 50,001-500k: strong
    - 500,001-3M: mid
    - > 3M: recovery
    """
    if not overall_rank or overall_rank <= 0:
        return "unknown"
    if overall_rank <= 50_000:
        return "elite"
    if overall_rank <= 500_000:
        return "strong"
    if overall_rank <= 3_000_000:
        return "mid"
    return "recovery"


def derive_strategy_mode(
    overall_rank: Optional[int],
    risk_posture: str = DEFAULT_RISK_POSTURE,
) -> str:
    """
    Derive strategy mode from rank bucket + risk posture nudge.
    """
    posture = normalize_risk_posture(risk_posture)
    bucket = derive_rank_bucket(overall_rank)

    base_by_bucket = {
        "elite": "DEFEND",
        "strong": "CONTROLLED",
        "mid": "BALANCED",
        "recovery": "RECOVERY",
        "unknown": DEFAULT_STRATEGY_MODE,
    }
    base_mode = base_by_bucket.get(bucket, DEFAULT_STRATEGY_MODE)

    # Conservative shifts one step safer, aggressive shifts one step riskier.
    order = ["DEFEND", "CONTROLLED", "BALANCED", "RECOVERY"]
    idx = order.index(base_mode)
    if posture == "CONSERVATIVE":
        idx = max(0, idx - 1)
    elif posture == "AGGRESSIVE":
        idx = min(len(order) - 1, idx + 1)

    return order[idx]


def get_transfer_threshold_base(strategy_mode: str) -> float:
    """
    Base projected gain required before FT multiplier is applied.
    """
    base = {
        "DEFEND": 2.8,
        "CONTROLLED": 2.2,
        "BALANCED": 1.8,
        "RECOVERY": 0.9,
        "DEFAULT": 1.8,
    }
    return base.get((strategy_mode or "").upper(), base["DEFAULT"])
