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
