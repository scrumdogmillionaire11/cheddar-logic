"""
Dashboard Data Export Router
Provides formatted data for external FPL dashboards.
"""
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
import logging

from backend.services.engine_service import engine_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

ACTIVE_STATUSES = {"queued", "running", "analyzing", "pending"}


# Response Models
class PlayerData(BaseModel):
    name: str
    team: str
    position: str
    cost: Optional[float] = None
    ownership_pct: Optional[float] = None
    expected_points: Optional[float] = None
    injury_status: Optional[str] = None
    is_captain: bool = False
    is_vice_captain: bool = False
    in_starting_11: bool = True


class WeaknessData(BaseModel):
    type: str  # injury, form, suspension, squad_rule
    severity: str  # high, medium, low
    player: str
    detail: str
    action: str


class TransferTarget(BaseModel):
    name: str
    team: str
    position: str
    cost: Optional[float] = None
    expected_points: Optional[float] = None
    priority: Optional[str] = None
    reason: Optional[str] = None
    injury_status: Optional[str] = None


class ChipAdvice(BaseModel):
    chip: str
    recommendation: str
    reason: str
    timing: Optional[str] = None


class DashboardData(BaseModel):
    gameweek: Dict[str, Any]
    my_team: Optional[Dict[str, Any]] = None
    weaknesses: List[WeaknessData] = []
    transfer_targets: List[TransferTarget] = []
    chip_advice: List[ChipAdvice] = []
    captain_advice: Optional[Dict[str, Any]] = None
    decision_summary: Optional[Dict[str, str]] = None
    metadata: Dict[str, Any]


@router.get(
    "/{analysis_id}",
    response_model=DashboardData,
    responses={
        404: {"description": "Analysis not found"},
        202: {"description": "Analysis still running"},
    },
)
async def get_dashboard_data(analysis_id: str):
    """
    Get formatted dashboard data from a completed analysis.
    
    This endpoint transforms FPL Sage analysis output into a format
    compatible with external FPL dashboards.
    
    **Returns:**
    - gameweek: Current gameweek info and deadline
    - my_team: Starting 11 and bench players
    - weaknesses: Injury/form/suspension risks
    - transfer_targets: Recommended transfers with priority
    - chip_advice: Chip timing recommendations
    - captain_advice: Captain and vice-captain picks
    - decision_summary: High-level decision and reasoning
    """
    # Get analysis results
    job = engine_service.get_job(analysis_id)
    
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis {analysis_id} not found"
        )
    
    if str(job.status).lower() in ACTIVE_STATUSES:
        raise HTTPException(
            status_code=status.HTTP_202_ACCEPTED,
            detail=f"Analysis still {job.status}. Try again in a few seconds."
        )
    
    if str(job.status).lower() == "failed":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Analysis failed: {job.error}"
        )
    
    # Parse the analysis results
    results = job.results
    if not results:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Analysis completed but no results found"
        )
    
    # Extract decision data
    decision = results.get("decision", {})
    
    # Build dashboard response
    dashboard_data = {
        "gameweek": {
            "current": results.get("gameweek"),
            "season": results.get("season", "2025-26"),
            "deadline": None,  # TODO: Add from FPL API if needed
        },
        "my_team": _build_team_data(results),
        "weaknesses": _extract_weaknesses(decision),
        "transfer_targets": _extract_transfer_targets(decision),
        "chip_advice": _extract_chip_advice(decision),
        "captain_advice": _extract_captain_advice(decision),
        "decision_summary": {
            "decision": decision.get("primary_decision", "UNKNOWN"),
            "reasoning": decision.get("reasoning", "No reasoning available"),
            "status": decision.get("decision_status", "UNKNOWN"),
            "confidence": str(decision.get("confidence_score", 0.0)),
        },
        "metadata": {
            "analysis_id": analysis_id,
            "generated_at": results.get("generated_at"),
            "analysis_timestamp": results.get("analysis_timestamp"),
            "run_id": results.get("run_id"),
        }
    }
    
    return DashboardData(**dashboard_data)


def _build_team_data(results: Dict) -> Optional[Dict[str, Any]]:
    """Extract team data from analysis results."""
    # This would need access to the actual team picks
    # For now, return basic structure
    # TODO: Load from model_inputs or enhanced_fpl_data
    return {
        "starting_11": [],  # Would populate from analysis
        "bench": [],
        "value": None,
        "bank": None,
        "transfers_available": None,
    }


def _extract_weaknesses(decision: Dict) -> List[WeaknessData]:
    """Extract team weaknesses from decision data."""
    weaknesses = []
    
    # Check for squad rule violations
    block_reason = decision.get("block_reason")
    if block_reason and "violation" in block_reason.lower():
        weaknesses.append(WeaknessData(
            type="squad_rule",
            severity="high",
            player="Squad",
            detail=block_reason,
            action="Immediate transfer required"
        ))
    
    # Extract from transfer recommendations
    transfers = decision.get("transfer_recommendations", [])
    for t in transfers:
        if t.get("priority") == "URGENT":
            reason = t.get("reason", "")
            
            # Determine weakness type
            weakness_type = "form"
            if "injury" in reason.lower() or "injured" in reason.lower():
                weakness_type = "injury"
            elif "violation" in reason.lower():
                weakness_type = "squad_rule"
            elif "suspend" in reason.lower():
                weakness_type = "suspension"
            
            if t.get("action") == "OUT":
                weaknesses.append(WeaknessData(
                    type=weakness_type,
                    severity="high" if t.get("priority") == "URGENT" else "medium",
                    player=t.get("player_name", "Unknown"),
                    detail=reason,
                    action=f"Transfer out (replace with {_get_matching_in_player(transfers, t)})"
                ))
    
    # Check risk scenarios
    risk_scenarios = decision.get("risk_scenarios", [])
    for risk in risk_scenarios:
        if risk.get("risk_level") == "critical":
            weaknesses.append(WeaknessData(
                type="risk",
                severity="high",
                player="Team",
                detail=risk.get("condition", "Unknown risk"),
                action=risk.get("mitigation_action", "Review team")
            ))
    
    return weaknesses


def _get_matching_in_player(transfers: List, out_transfer: Dict) -> str:
    """Find the IN transfer that matches this OUT transfer."""
    for t in transfers:
        if t.get("action") == "IN" and t.get("priority") == out_transfer.get("priority"):
            return t.get("player_name", "suggested player")
    return "suggested player"


def _extract_transfer_targets(decision: Dict) -> List[TransferTarget]:
    """Extract transfer recommendations."""
    targets = []
    
    transfers = decision.get("transfer_recommendations", [])
    for t in transfers:
        if t.get("action") == "IN":
            targets.append(TransferTarget(
                name=t.get("player_name", "Unknown"),
                team=t.get("team", ""),
                position=t.get("position", ""),
                cost=t.get("price"),
                expected_points=t.get("expected_points"),
                priority=t.get("priority"),
                reason=t.get("reason"),
                injury_status=t.get("injury_status", "Unknown")
            ))
    
    # Sort by priority (URGENT first) and expected points
    priority_order = {"URGENT": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3}
    targets.sort(
        key=lambda x: (
            priority_order.get(x.priority or "LOW", 4),
            -(x.expected_points or 0)
        )
    )
    
    return targets[:5]  # Top 5 targets


def _extract_chip_advice(decision: Dict) -> List[ChipAdvice]:
    """Extract chip timing recommendations."""
    advice = []
    
    chip_guidance = decision.get("chip_guidance")
    if chip_guidance:
        # Format depends on chip_guidance structure
        # For now, return basic advice
        advice.append(ChipAdvice(
            chip="Wildcard",
            recommendation="Check analysis for details",
            reason="See full analysis output",
            timing=None
        ))
    
    # Check for Free Hit context
    free_hit_context = decision.get("free_hit_context")
    if free_hit_context:
        advice.append(ChipAdvice(
            chip="Free Hit",
            recommendation="Available for use",
            reason="See free_hit_plan in full analysis",
            timing="This gameweek"
        ))
    
    return advice


def _extract_captain_advice(decision: Dict) -> Optional[Dict[str, Any]]:
    """Extract captain recommendations."""
    captaincy = decision.get("captaincy")
    if not captaincy:
        return None
    
    captain = captaincy.get("captain", {})
    vice = captaincy.get("vice_captain", {})
    
    return {
        "captain": {
            "name": captain.get("name"),
            "team": captain.get("team"),
            "position": captain.get("position"),
            "ownership_pct": captain.get("ownership_pct"),
            "expected_points": captain.get("rationale", "").split("(")[1].split("pts")[0] if "pts" in captain.get("rationale", "") else None,
            "rationale": captain.get("rationale"),
        },
        "vice_captain": {
            "name": vice.get("name"),
            "team": vice.get("team"),
            "position": vice.get("position"),
            "ownership_pct": vice.get("ownership_pct"),
            "rationale": vice.get("rationale"),
        },
        "alternatives": [
            {
                "name": c.get("name"),
                "team": c.get("team"),
                "expected_points": c.get("nextGW_pts"),
                "ownership_pct": c.get("ownership_pct"),
            }
            for c in captaincy.get("candidate_pool", [])[:3]
        ]
    }


@router.get(
    "/{analysis_id}/simple",
    responses={
        404: {"description": "Analysis not found"},
        202: {"description": "Analysis still running"},
    },
)
async def get_simple_dashboard_data(analysis_id: str):
    """
    Get simplified dashboard data (minimal structure).
    
    This endpoint provides the absolute minimum data structure
    for quick dashboard integration without strict typing.
    """
    job = engine_service.get_job(analysis_id)
    
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Analysis {analysis_id} not found"
        )
    
    if str(job.status).lower() in ACTIVE_STATUSES:
        return {
            "status": job.status,
            "message": "Analysis in progress"
        }
    
    if str(job.status).lower() == "failed":
        return {
            "status": "failed",
            "error": job.error
        }
    
    results = job.results
    if not results:
        return {
            "status": "completed",
            "message": "Analysis completed but no results available"
        }
    
    decision = results.get("decision", {})
    
    # Ultra-simple format
    return {
        "status": "completed",
        "gameweek": results.get("gameweek"),
        "decision": decision.get("primary_decision"),
        "reasoning": decision.get("reasoning"),
        "transfers": decision.get("transfer_recommendations", []),
        "captain": decision.get("captaincy", {}).get("captain", {}),
        "analysis_id": analysis_id,
        "timestamp": results.get("generated_at"),
    }
