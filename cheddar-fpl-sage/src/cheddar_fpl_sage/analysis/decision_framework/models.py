"""
Pydantic data models for FPL Sage decision framework.

Provides validated data structures for transfer recommendations, captain picks,
chip decisions, and complete decision summaries.
"""

from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import datetime


class TransferRecommendation(BaseModel):
    """Single transfer recommendation with reasoning"""
    player_out_id: int
    player_out_name: str
    player_in_id: int
    player_in_name: str
    position: str
    net_gain_pts: float = Field(description="Expected point gain over horizon")
    reasoning: str
    confidence: Literal["HIGH", "MEDIUM", "LOW"] = "MEDIUM"


class CaptainPick(BaseModel):
    """Captain recommendation with alternatives"""
    captain_id: int
    captain_name: str
    expected_pts: float
    vice_captain_id: int
    vice_captain_name: str
    alternatives: list[dict] = Field(default_factory=list)
    reasoning: str


class ChipRecommendation(BaseModel):
    """Chip usage recommendation"""
    chip: Literal["Wildcard", "Free Hit", "Bench Boost", "Triple Captain", "None"]
    use_this_gw: bool = False
    optimal_window_gw: Optional[int] = None
    reasoning: str
    confidence: Literal["HIGH", "MEDIUM", "LOW"] = "MEDIUM"


class OptimizedXI(BaseModel):
    """Optimized starting XI with formation"""
    formation: str  # e.g., "3-4-3"
    starters: list[dict]  # List of player dicts with id, name, position, expected_pts
    bench: list[dict]
    captain_id: int
    vice_captain_id: int
    total_expected_pts: float


class DecisionSummary(BaseModel):
    """Complete decision output for a gameweek"""
    manager_id: int
    manager_name: str
    gameweek: int
    generated_at: datetime = Field(default_factory=datetime.now)
    transfers: list[TransferRecommendation] = Field(default_factory=list)
    captain: Optional[CaptainPick] = None
    chip: Optional[ChipRecommendation] = None
    optimized_xi: Optional[OptimizedXI] = None
    risk_posture: Literal["CHASE", "DEFEND", "BALANCED"] = "BALANCED"
