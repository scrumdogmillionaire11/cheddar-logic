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
    why_now: Optional[str] = None
    risk_note: Optional[str] = None
    horizon_gws: Optional[int] = None


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


class LineupPlayer(BaseModel):
    player_id: int | str
    name: str
    team: str
    position: Literal["GK", "DEF", "MID", "FWD"]
    projected_points: float
    expected_minutes: Optional[float] = None
    flags: list[str] = Field(default_factory=list)
    badges: list[str] = Field(default_factory=list)
    start_reason: Optional[str] = None


class BenchPlayer(BaseModel):
    player_id: int | str
    name: str
    team: Optional[str] = None
    position: Literal["GK", "DEF", "MID", "FWD"]
    bench_order: int
    projected_points: float
    expected_minutes: Optional[float] = None
    flags: list[str] = Field(default_factory=list)
    bench_reason: Optional[str] = None


class OptimizedLineupResponse(BaseModel):
    formation: str
    risk_profile: Literal["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]
    lineup_confidence: Literal["HIGH", "MEDIUM", "LOW"]
    formation_reason: str
    risk_profile_effect: Optional[str] = None
    notes: list[str] = Field(default_factory=list)
    starters: list[LineupPlayer] = Field(default_factory=list)
    bench: list[BenchPlayer] = Field(default_factory=list)
    captain_player_id: Optional[int | str] = None
    vice_captain_player_id: Optional[int | str] = None


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
    risk_posture: Literal[
        "CHASE",
        "DEFEND",
        "BALANCED",
        "CONSERVATIVE",
        "AGGRESSIVE",
    ] = "BALANCED"
    strategy_mode: Literal["DEFEND", "CONTROLLED", "BALANCED", "RECOVERY"] = "BALANCED"


class ManagerState(BaseModel):
    """Rank-aware strategy context surfaced to API/UI layers."""
    overall_rank: Optional[int] = None
    risk_posture: str = "BALANCED"
    strategy_mode: str = "BALANCED"
    rank_bucket: str = "unknown"
    free_transfers: int = 0
