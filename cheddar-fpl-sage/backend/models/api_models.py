"""Pydantic models for API requests and responses."""
from datetime import datetime
from typing import Optional, Literal, Dict, Any, List
from pydantic import BaseModel, Field

from backend.models.manual_overrides import InjuryOverride, RiskThresholds


class ManualTransferInput(BaseModel):
    """Manual transfer entry"""
    player_out: str = Field(..., description="Player being transferred out")
    player_in: str = Field(..., description="Player being transferred in")


class AnalyzeRequest(BaseModel):
    """Request to analyze a team."""
    team_id: int = Field(..., description="FPL team ID", gt=0)
    user_id: Optional[str] = Field(None, description="Upstream user identifier for tracing only")
    source: Optional[str] = Field(None, description="Calling source identifier for tracing")
    gameweek: Optional[int] = Field(None, description="Gameweek to analyze (defaults to current)")
    available_chips: Optional[List[str]] = Field(
        None, 
        description="Override available chips (bench_boost, triple_captain, free_hit, wildcard)"
    )
    free_transfers: Optional[int] = Field(
        None,
        description="Override number of free transfers available",
        ge=0,
        le=5
    )
    risk_posture: Optional[Literal['conservative', 'balanced', 'aggressive']] = Field(
        None,
        description="Risk posture for recommendations"
    )
    thresholds: Optional[RiskThresholds] = Field(
        None,
        description="Risk posture thresholds for decision guidance"
    )
    manual_transfers: Optional[List[ManualTransferInput]] = Field(
        None,
        description="Transfers already made on FPL website (not yet in API)"
    )
    injury_overrides: Optional[List[InjuryOverride]] = Field(
        None,
        description="Manual injury status overrides"
    )


class AnalyzeResponse(BaseModel):
    """Response when analysis is queued."""
    analysis_id: str = Field(..., description="Unique analysis job ID")
    status: Literal["queued", "analyzing", "complete", "failed"]
    team_id: int = Field(..., description="FPL team ID")
    created_at: datetime
    estimated_duration_seconds: int = Field(..., description="Estimated processing duration in seconds")


class AnalysisStatus(BaseModel):
    """Status of an analysis job."""
    status: Literal["queued", "analyzing", "complete", "failed"]
    progress: Optional[float] = Field(None, description="Progress percentage (0-100)", ge=0, le=100)
    phase: Optional[str] = Field(None, description="Current phase of analysis")
    results: Optional[Dict[str, Any]] = Field(None, description="Analysis results when completed")
    error: Optional[str] = Field(None, description="Error message if failed")


class ErrorResponse(BaseModel):
    """Standardized API error envelope."""
    error: bool = Field(True, description="Always true for error responses")
    error_code: str = Field(..., description="Error code", examples=["RATE_LIMITED", "INVALID_TEAM_ID"])
    message: str = Field(..., description="Human-readable message")
    details: Dict[str, Any] = Field(default_factory=dict, description="Error details payload")
    timestamp: str = Field(..., description="UTC ISO-8601 timestamp")
