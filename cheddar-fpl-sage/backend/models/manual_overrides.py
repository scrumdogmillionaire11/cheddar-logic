"""
Models for manual overrides in FPL analysis
"""
from typing import Optional, Dict, List
from pydantic import BaseModel, Field


class InjuryOverride(BaseModel):
    """Manual injury status override for a player"""
    player_name: str = Field(..., description="Player name")
    status: str = Field(..., description="Injury status: FIT, DOUBTFUL, OUT")
    chance: Optional[int] = Field(None, description="Chance of playing (0-100)")


class RiskThresholds(BaseModel):
    """Risk posture thresholds for decision guidance."""
    transferGainFloor: Optional[float] = Field(None, description="Minimum transfer gain threshold")
    hitNetFloor: Optional[float] = Field(None, description="Minimum net gain after hit")
    maxHitsPerGW: Optional[int] = Field(None, description="Maximum hits per gameweek")
    chipDeployBoost: Optional[float] = Field(None, description="Chip deploy boost adjustment")
    captainDiffMaxOwnership: Optional[float] = Field(None, description="Max ownership for differential captain")
    bbMinBenchXPts: Optional[float] = Field(None, description="Minimum bench expected points for BB")
    tcRequiresDGW: Optional[bool] = Field(None, description="Require DGW for triple captain")


class ManualOverridesRequest(BaseModel):
    """Manual overrides to apply to analysis"""
    team_id: int = Field(..., description="FPL team ID", ge=1, le=20_000_000)
    user_id: Optional[str] = Field(None, description="Upstream user identifier for tracing only")
    source: Optional[str] = Field(None, description="Calling source identifier for tracing")
    
    # Chip overrides
    available_chips: Optional[List[str]] = Field(
        None,
        description="Override available chips (bench_boost, triple_captain, free_hit, wildcard)"
    )
    
    # Transfer overrides
    free_transfers: Optional[int] = Field(
        None,
        description="Override number of free transfers available",
        ge=0,
        le=5
    )
    
    # Risk posture
    risk_posture: Optional[str] = Field(
        None,
        description="Risk posture: conservative, balanced, aggressive"
    )
    
    # Manual transfers (from web UI)
    manual_transfers: Optional[List[Dict]] = Field(
        None,
        description="Manual transfers tracked by user"
    )
    
    # Injury overrides
    injury_overrides: Optional[List[InjuryOverride]] = Field(
        None,
        description="Manual injury status overrides"
    )

    # Risk thresholds (optional overrides)
    thresholds: Optional[RiskThresholds] = Field(
        None,
        description="Risk posture thresholds for decision guidance"
    )
    
    # Force re-analysis even if cached
    force_refresh: bool = Field(
        False,
        description="Force fresh analysis ignoring cache"
    )


class PlayerProjection(BaseModel):
    """Detailed player projection"""
    name: str
    team: str
    position: str
    price: float
    expected_pts: float
    ownership: Optional[float] = None
    form: Optional[float] = None
    fixture_difficulty: Optional[int] = None
    injury_status: Optional[str] = None
    playing_chance: Optional[int] = None
    reasoning: Optional[str] = None


class DetailedAnalysisResponse(BaseModel):
    """Detailed analysis with player projections"""
    # Basic info
    team_name: str
    manager_name: str
    current_gw: Optional[int]
    overall_rank: Optional[int]
    overall_points: Optional[int]
    
    # Decision
    primary_decision: str
    confidence: str
    reasoning: str
    
    # Transfers with detailed reasoning
    transfer_recommendations: List[Dict]
    transfer_plans: Optional[Dict] = None
    
    # Captaincy
    captain: Optional[Dict]
    vice_captain: Optional[Dict]
    captain_delta: Optional[Dict] = None
    
    # Detailed player projections - current squad
    starting_xi_projections: List[PlayerProjection]
    bench_projections: List[PlayerProjection]
    
    # Projected squad after recommended transfers
    projected_xi: Optional[List[PlayerProjection]] = None
    projected_bench: Optional[List[PlayerProjection]] = None
    
    # Transfer targets (if any)
    transfer_targets: Optional[List[PlayerProjection]] = None
    
    # Risk assessment
    risk_scenarios: List[Dict]
    
    # Chip guidance
    chip_recommendation: Optional[Dict]
    available_chips: List[str]
    
    # Squad health metrics
    squad_health: Optional[Dict] = None
