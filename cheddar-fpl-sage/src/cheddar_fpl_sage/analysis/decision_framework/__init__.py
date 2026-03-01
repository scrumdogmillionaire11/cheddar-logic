"""
Decision Framework Package

Provides structured decision-making components for FPL Sage including
exception hierarchy, data models, constants, and domain modules.
"""

from .exceptions import (
    FPLSageError, DataValidationError, ConfigurationError,
    PlayerNotFoundError, ProjectionMissingError, ChipAnalysisError,
    TransferValidationError, FormationError
)
from .models import (
    TransferRecommendation, CaptainPick, ChipRecommendation,
    OptimizedXI, DecisionSummary
)
from .constants import (
    MANUAL_PLAYER_ID_START, is_manual_player,
    MIN_GOALKEEPERS, MAX_GOALKEEPERS, MIN_DEFENDERS, MAX_DEFENDERS,
    MIN_MIDFIELDERS, MAX_MIDFIELDERS, MIN_FORWARDS, MAX_FORWARDS,
    SQUAD_SIZE, STARTING_XI_SIZE, MAX_PLAYERS_PER_TEAM,
    FALLBACK_PROJECTION_PTS, FALLBACK_NEXT_3GW_PTS, FALLBACK_NEXT_5GW_PTS,
    RISK_POSTURES, CHIP_NAMES, POSITIONS,
    TRANSFER_HORIZON_SHORT, TRANSFER_HORIZON_MEDIUM, TRANSFER_HORIZON_LONG
)
from .config_models import (
    TeamConfig, ChipStatus, ManualTransfer, InjuryOverride,
    ChipPolicy, ChipWindow, ManualOverrides
)
from .chip_analyzer import ChipAnalyzer
from .transfer_advisor import TransferAdvisor
from .captain_selector import CaptainSelector
from .output_formatter import OutputFormatter

__all__ = [
    # Domain modules
    "ChipAnalyzer",
    "TransferAdvisor",
    "CaptainSelector",
    "OutputFormatter",
    # Exceptions
    "FPLSageError", "DataValidationError", "ConfigurationError",
    "PlayerNotFoundError", "ProjectionMissingError", "ChipAnalysisError",
    "TransferValidationError", "FormationError",
    # Models
    "TransferRecommendation", "CaptainPick", "ChipRecommendation",
    "OptimizedXI", "DecisionSummary",
    # Config models
    "TeamConfig", "ChipStatus", "ManualTransfer", "InjuryOverride",
    "ChipPolicy", "ChipWindow", "ManualOverrides",
    # Constants
    "MANUAL_PLAYER_ID_START", "is_manual_player",
    "MIN_GOALKEEPERS", "MAX_GOALKEEPERS", "MIN_DEFENDERS", "MAX_DEFENDERS",
    "MIN_MIDFIELDERS", "MAX_MIDFIELDERS", "MIN_FORWARDS", "MAX_FORWARDS",
    "SQUAD_SIZE", "STARTING_XI_SIZE", "MAX_PLAYERS_PER_TEAM",
    "FALLBACK_PROJECTION_PTS", "FALLBACK_NEXT_3GW_PTS", "FALLBACK_NEXT_5GW_PTS",
    "RISK_POSTURES", "CHIP_NAMES", "POSITIONS",
    "TRANSFER_HORIZON_SHORT", "TRANSFER_HORIZON_MEDIUM", "TRANSFER_HORIZON_LONG"
]
