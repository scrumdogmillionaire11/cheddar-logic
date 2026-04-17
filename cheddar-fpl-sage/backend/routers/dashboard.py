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


def _card_payload(results: Dict[str, Any], card_key: str) -> Dict[str, Any]:
    card = results.get(card_key)
    if isinstance(card, dict):
        return card
    return {}


def _card_metrics(results: Dict[str, Any], card_key: str) -> Dict[str, Any]:
    metrics = _card_payload(results, card_key).get("metrics")
    if isinstance(metrics, dict):
        return metrics
    return {}


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
    
    gameweek_plan = _card_metrics(results, "gameweek_plan")
    captaincy_metrics = _card_metrics(results, "captaincy")
    
    # Build dashboard response
    dashboard_data = {
        "gameweek": {
            "current": gameweek_plan.get("gameweek") or results.get("gameweek") or results.get("current_gw"),
            "season": results.get("season", "2025-26"),
            "deadline": None,  # TODO: Add from FPL API if needed
        },
        "my_team": _build_team_data(results),
        "weaknesses": _extract_weaknesses(results),
        "transfer_targets": _extract_transfer_targets(results),
        "chip_advice": _extract_chip_advice(results),
        "captain_advice": _extract_captain_advice(results),
        "decision_summary": {
            "decision": gameweek_plan.get("primary_action") or results.get("primary_decision", "UNKNOWN"),
            "reasoning": gameweek_plan.get("justification") or _card_payload(results, "gameweek_plan").get("summary") or results.get("reasoning", "No reasoning available"),
            "status": str(_card_metrics(results, "chip_strategy").get("status") or results.get("decision_status", "UNKNOWN")),
            "confidence": str((_card_payload(results, "decision_confidence").get("score") or 0.0)),
        },
        "metadata": {
            "analysis_id": analysis_id,
            "generated_at": gameweek_plan.get("generated_at") or results.get("generated_at"),
            "analysis_timestamp": results.get("analysis_timestamp"),
            "run_id": results.get("run_id"),
        }
    }
    
    return DashboardData(**dashboard_data)


def _build_team_data(results: Dict) -> Optional[Dict[str, Any]]:
    """Extract team data from canonical squad_state card with compatibility fallback."""
    squad_metrics = _card_metrics(results, "squad_state")
    starting_xi = squad_metrics.get("starting_xi") if isinstance(squad_metrics.get("starting_xi"), list) else (results.get("starting_xi") or [])
    bench = squad_metrics.get("bench") if isinstance(squad_metrics.get("bench"), list) else (results.get("bench") or [])

    return {
        "starting_11": starting_xi,
        "bench": bench,
        "value": None,
        "bank": None,
        "transfers_available": _card_metrics(results, "gameweek_plan").get("free_transfers") or results.get("free_transfers"),
    }


def _extract_weaknesses(results: Dict[str, Any]) -> List[WeaknessData]:
    """Extract team weaknesses from canonical cards with compatibility fallback."""
    weaknesses = []
    squad_metrics = _card_metrics(results, "squad_state")
    squad_health = squad_metrics.get("squad_health") if isinstance(squad_metrics.get("squad_health"), dict) else {}
    if int(squad_health.get("injured", 0) or 0) > 0:
        weaknesses.append(
            WeaknessData(
                type="injury",
                severity="high",
                player="Squad",
                detail=f"{squad_health.get('injured')} injured players currently flagged.",
                action="Prioritize replacing unavailable starters.",
            )
        )

    bench_warning = squad_metrics.get("bench_warning") if isinstance(squad_metrics.get("bench_warning"), dict) else (results.get("bench_warning") or {})
    if bench_warning:
        weaknesses.append(
            WeaknessData(
                type="bench_depth",
                severity="medium",
                player="Bench",
                detail=bench_warning.get("warning_message", "Bench depth concern."),
                action=bench_warning.get("suggestion", "Review bench structure."),
            )
        )

    weekly_review_metrics = _card_metrics(results, "weekly_review")
    drift_flags = weekly_review_metrics.get("drift_flags")
    if isinstance(drift_flags, list):
        for flag in drift_flags:
            token = str(flag or "").strip()
            if token:
                weaknesses.append(
                    WeaknessData(
                        type="retrospective",
                        severity="medium",
                        player="Process",
                        detail=f"Retrospective drift signal: {token}",
                        action="Review prior gameweek decision execution.",
                    )
                )
    
    return weaknesses


def _extract_transfer_targets(results: Dict) -> List[TransferTarget]:
    """Extract transfer targets from canonical transfer_recommendation card."""
    targets = []

    transfer_metrics = _card_metrics(results, "transfer_recommendation")
    transfer_plans = transfer_metrics.get("transfer_plans")
    if isinstance(transfer_plans, dict):
        for key in ("primary", "secondary"):
            plan = transfer_plans.get(key)
            if isinstance(plan, dict) and plan.get("in"):
                targets.append(
                    TransferTarget(
                        name=plan.get("in", "Unknown"),
                        team="",
                        position="",
                        cost=plan.get("net_cost"),
                        expected_points=plan.get("delta_pts_4gw"),
                        priority=(plan.get("confidence") or "MEDIUM"),
                        reason=plan.get("reason"),
                        injury_status=None,
                    )
                )

        additional = transfer_plans.get("additional") or []
        if isinstance(additional, list):
            for plan in additional:
                if isinstance(plan, dict) and plan.get("in"):
                    targets.append(
                        TransferTarget(
                            name=plan.get("in", "Unknown"),
                            team="",
                            position="",
                            cost=plan.get("net_cost"),
                            expected_points=plan.get("delta_pts_4gw"),
                            priority=(plan.get("confidence") or "LOW"),
                            reason=plan.get("reason"),
                            injury_status=None,
                        )
                    )

    if not targets:
        # Compatibility fallback
        transfers = results.get("transfer_recommendations", [])
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


def _extract_chip_advice(results: Dict) -> List[ChipAdvice]:
    """Extract chip timing recommendations from canonical chip_strategy card."""
    advice = []
    chip_metrics = _card_metrics(results, "chip_strategy")
    verdict = str(chip_metrics.get("verdict") or results.get("chip_verdict") or "NONE").upper()
    recommendation = str(chip_metrics.get("status") or "PASS").upper()
    reason = chip_metrics.get("explanation") or _card_payload(results, "chip_strategy").get("summary") or results.get("chip_explanation") or "No chip advice provided."
    timing = None
    recommendation_meta = chip_metrics.get("recommendation")
    if isinstance(recommendation_meta, dict):
        best_gw = recommendation_meta.get("best_gw")
        if best_gw is not None:
            timing = f"Target GW {best_gw}"

    advice.append(
        ChipAdvice(
            chip=verdict,
            recommendation=recommendation,
            reason=reason,
            timing=timing,
        )
    )
    
    return advice


def _extract_captain_advice(results: Dict) -> Optional[Dict[str, Any]]:
    """Extract captain recommendations from canonical captaincy card."""
    captaincy = _card_metrics(results, "captaincy")
    if not captaincy:
        captain = results.get("captain") if isinstance(results.get("captain"), dict) else {}
        vice = results.get("vice_captain") if isinstance(results.get("vice_captain"), dict) else {}
    else:
        captain = captaincy.get("captain") if isinstance(captaincy.get("captain"), dict) else {}
        vice = captaincy.get("vice_captain") if isinstance(captaincy.get("vice_captain"), dict) else {}

    if not captain and not vice:
        return None

    return {
        "captain": {
            "name": captain.get("name"),
            "team": captain.get("team"),
            "position": captain.get("position"),
            "ownership_pct": captain.get("ownership_pct"),
            "expected_points": captain.get("expected_pts"),
            "rationale": captain.get("rationale"),
        },
        "vice_captain": {
            "name": vice.get("name"),
            "team": vice.get("team"),
            "position": vice.get("position"),
            "ownership_pct": vice.get("ownership_pct"),
            "rationale": vice.get("rationale"),
        },
        "alternatives": [],
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
    
    gameweek_plan = _card_metrics(results, "gameweek_plan")
    
    # Ultra-simple format
    return {
        "status": "completed",
        "gameweek": gameweek_plan.get("gameweek") or results.get("gameweek") or results.get("current_gw"),
        "decision": gameweek_plan.get("primary_action") or results.get("primary_decision"),
        "reasoning": gameweek_plan.get("justification") or _card_payload(results, "gameweek_plan").get("summary"),
        "transfers": [t.model_dump() for t in _extract_transfer_targets(results)],
        "captain": (_card_metrics(results, "captaincy").get("captain") or results.get("captain") or {}),
        "analysis_id": analysis_id,
        "timestamp": gameweek_plan.get("generated_at") or results.get("generated_at"),
    }
