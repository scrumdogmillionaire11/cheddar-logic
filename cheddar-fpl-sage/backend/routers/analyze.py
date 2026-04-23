"""
Analyze endpoints for FPL Sage API.
Handles triggering analysis and retrieving results.
"""
from typing import Optional, Dict, Any, List
from fastapi import APIRouter, BackgroundTasks, HTTPException, status, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import logging
import asyncio
from datetime import datetime, timezone
import uuid

from backend.config import settings
from backend.models.api_models import (
    AnalyzeRequest,
    AnalyzeResponse,
    ErrorResponse,
)
from backend.models.manual_overrides import (
    ManualOverridesRequest,
    DetailedAnalysisResponse,
)
from backend.services.engine_service import engine_service
from backend.services.cache_service import cache_service
from backend.services.contract_transformer import (
    build_dashboard_contract,
    build_detailed_analysis_contract,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/analyze", tags=["analysis"])

WS_PHASE_MESSAGES = {
    "initializing": "Initializing analysis engine...",
    "data_collection": "Collecting latest FPL data...",
    "injury_analysis": "Analyzing injury and availability signals...",
    "transfer_optimization": "Optimizing transfer recommendations...",
    "chip_strategy": "Evaluating chip strategy...",
    "captain_analysis": "Scoring captaincy options...",
    "finalization": "Finalizing output payload...",
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ws_progress_payload(phase: str, progress: float) -> Dict[str, object]:
    return {
        "type": "progress",
        "phase": phase,
        "progress": progress,
        "message": WS_PHASE_MESSAGES.get(phase, "Analysis in progress"),
        "timestamp": _utc_now_iso(),
    }


def _is_complete_status(job_status: Optional[str]) -> bool:
    return str(job_status).lower() in {"complete", "completed"}


def _cached_result_meets_fpl_contract(payload: Optional[Dict]) -> bool:
    """Guard against serving stale/legacy cached payloads missing FPL dashboard contract fields."""
    if not isinstance(payload, dict):
        return False

    manager_state = payload.get("manager_state")
    if not isinstance(manager_state, dict):
        return False
    if manager_state.get("risk_posture") is None:
        return False
    if manager_state.get("strategy_mode") is None:
        return False
    if manager_state.get("free_transfers") is None:
        return False

    fixture_planner = payload.get("fixture_planner")
    if not isinstance(fixture_planner, dict):
        return False
    for key in ["gw_timeline", "squad_windows", "target_windows", "key_planning_notes"]:
        if not isinstance(fixture_planner.get(key), list):
            return False

    starting_xi = payload.get("starting_xi")
    if isinstance(starting_xi, list) and starting_xi:
        has_any_price = any(
            isinstance(player, dict) and player.get("price") is not None
            for player in starting_xi
        )
        if not has_any_price:
            return False

    return True


def _titleize_token(value: Any) -> Optional[str]:
    token = str(value or "").strip()
    if not token:
        return None
    return token.replace("_", " ").replace("-", " ").title()


def _followed_label(value: Any, positive: str, negative: str) -> Optional[str]:
    if value is True:
        return positive
    if value is False:
        return negative
    return None


def _weekly_report_card_payload(weekly_review: Any) -> Optional[Dict[str, Any]]:
    """Flatten the retrospective card into the frontend's legacy weekly report shape."""
    if not isinstance(weekly_review, dict):
        return None

    metrics = weekly_review.get("metrics")
    if not isinstance(metrics, dict):
        metrics = {}

    history_available = bool(metrics.get("history_available"))
    has_any_signal = any(
        metrics.get(key) is not None
        for key in ["previous_gw", "points", "points_delta", "rank", "rank_delta"]
    )
    if not history_available and not has_any_signal:
        return None

    drift_flags = metrics.get("drift_flags")
    if not isinstance(drift_flags, list):
        drift_flags = []

    scenario_notes = weekly_review.get("highlights")
    if not isinstance(scenario_notes, list):
        scenario_notes = []

    return {
        "gameweek": metrics.get("previous_gw"),
        "expected_pts": None,
        "actual_pts": metrics.get("points"),
        "captain_accuracy": _followed_label(
            metrics.get("captain_followed"),
            "Followed recommendation",
            "Ignored recommendation",
        ),
        "transfer_quality": _followed_label(
            metrics.get("recommendation_followed"),
            "Followed recommendation",
            "Ignored recommendation",
        ),
        "missed_opportunities": [],
        "profile_adherence": _titleize_token(metrics.get("process_verdict")),
        "drift_flags": [str(flag) for flag in drift_flags if flag is not None],
        "verdict": weekly_review.get("summary"),
        "scenario_notes": [str(note) for note in scenario_notes if note is not None],
    }


@router.post(
    "",
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        200: {"description": "Cached result returned"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        429: {"model": ErrorResponse, "description": "Rate limited"},
    },
)
async def trigger_analysis(
    request: AnalyzeRequest,
    background_tasks: BackgroundTasks,
):
    """
    Trigger a new FPL analysis for the given team.

    - **team_id**: FPL team ID (required, 1-20000000 range)
    - **gameweek**: Target gameweek (optional, defaults to current)

    Returns cached result immediately if available (within 5 minutes).
    Otherwise returns an analysis_id that can be used to poll for results.
    """
    # Validate team_id range (FPL IDs are typically 1-20M)
    if request.team_id < 1 or request.team_id > 20_000_000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "Invalid team_id",
                "detail": f"team_id must be between 1 and 20000000, got {request.team_id}",
                "code": "INVALID_TEAM_ID",
            },
        )

    # Validate gameweek if provided
    if request.gameweek is not None:
        if request.gameweek < 1 or request.gameweek > 38:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={
                    "error": "Invalid gameweek",
                    "detail": f"gameweek must be between 1 and 38, got {request.gameweek}",
                    "code": "INVALID_GAMEWEEK",
                },
            )

    # Check cache first (skip if ANY manual overrides provided)
    has_overrides = (
        request.available_chips or 
        request.free_transfers is not None or 
        request.risk_posture or 
        request.manual_transfers or
        request.injury_overrides or
        request.thresholds
    )
    
    if not has_overrides:
        cached_result = cache_service.get_cached_analysis(request.team_id, request.gameweek)
        if cached_result and _cached_result_meets_fpl_contract(cached_result):
            logger.info("Returning cached analysis result")
            analysis_id = str(uuid.uuid4())
            
            return JSONResponse(
                status_code=status.HTTP_200_OK,
                content={
                    "analysis_id": analysis_id,
                    "status": "completed",
                    "contract_status": "complete",
                    "team_id": request.team_id,
                    "created_at": _utc_now_iso(),
                    "estimated_duration_seconds": 0,
                    "results": cached_result,
                    "cached": True,
                },
                headers={"X-Cache": "HIT"},
            )
        if cached_result:
            logger.info(
                "Skipping cached analysis for team_id=%s due to contract mismatch; running fresh analysis.",
                request.team_id,
            )

    # Prepare overrides if any manual inputs specified
    overrides = {}
    if request.available_chips:
        overrides["available_chips"] = request.available_chips
        logger.info(f"Manual chip overrides: {request.available_chips}")
    if request.free_transfers is not None:
        overrides["free_transfers"] = request.free_transfers
        logger.info(f"Manual free transfers: {request.free_transfers}")
    if request.risk_posture:
        overrides["risk_posture"] = request.risk_posture
        logger.info(f"🎯 API RECEIVED risk_posture: {request.risk_posture}")
    else:
        logger.warning("⚠️ No risk_posture in request!")
    if request.manual_transfers:
        overrides["manual_transfers"] = [
            {"player_out": t.player_out, "player_in": t.player_in} 
            for t in request.manual_transfers
        ]
        logger.info(f"Manual transfers: {len(request.manual_transfers)} recorded")
    if request.injury_overrides:
        overrides["injury_overrides"] = [ov.model_dump() for ov in request.injury_overrides]
        logger.info(f"Manual injury overrides: {len(request.injury_overrides)} recorded")
    if request.thresholds:
        overrides["thresholds"] = request.thresholds.model_dump(exclude_none=True)
        logger.info("Risk thresholds override received")
    if request.user_id:
        overrides["user_id"] = request.user_id
    if request.source:
        overrides["source"] = request.source

    # Create analysis job with overrides
    job = engine_service.create_analysis(request.team_id, request.gameweek, overrides)
    logger.info("Created analysis job %s", job.analysis_id)

    # Schedule background task with overrides
    background_tasks.add_task(
        run_analysis_task,
        job.analysis_id,
        request.team_id,
        request.gameweek,
        overrides if overrides else None,
    )

    return AnalyzeResponse(
        analysis_id=job.analysis_id,
        status="queued",
        team_id=request.team_id,
        created_at=job.created_at,
        estimated_duration_seconds=settings.ANALYSIS_ESTIMATED_DURATION_SECONDS,
    )


async def run_analysis_task(
    analysis_id: str,
    team_id: int,
    gameweek: Optional[int],
    overrides: Optional[Dict] = None,
):
    """Background task to run the analysis and cache results."""
    job = engine_service.get_job(analysis_id)
    
    try:
        results = await engine_service.run_analysis(analysis_id, overrides=overrides)

        # Cache successful results ONLY if no overrides were used
        if not overrides:
            cache_service.cache_analysis(team_id, gameweek, results)
            logger.info(f"Analysis {analysis_id} completed and cached")
        else:
            logger.info(f"Analysis {analysis_id} completed (not cached due to overrides)")
    except Exception as e:
        logger.exception(f"Analysis {analysis_id} failed: {e}")
        # Store error state in job so clients can see what went wrong
        if job:
            job.status = "failed"
            job.error = str(e)
            job.completed_at = datetime.now(timezone.utc)
            engine_service._persist_job(job)


@router.get(
    "/{analysis_id}",
    responses={
        404: {"model": ErrorResponse, "description": "Analysis not found"},
    },
)
async def get_analysis_status(analysis_id: str):
    """
    Get the status and results of an analysis.

    - **analysis_id**: The ID returned from POST /analyze

    Returns contract-shaped analysis details. While running, status remains queued/analyzing.
    """
    job = engine_service.get_job(analysis_id)

    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "Analysis not found",
                "detail": f"No analysis found with ID: {analysis_id}",
                "code": "ANALYSIS_NOT_FOUND",
            },
        )

    payload = build_detailed_analysis_contract(job)
    payload["progress"] = job.progress
    payload["phase"] = job.phase
    return payload


@router.get(
    "/{analysis_id}/dashboard",
    responses={
        404: {"model": ErrorResponse, "description": "Analysis not found"},
    },
)
async def get_analysis_dashboard_summary(analysis_id: str):
    """Return dashboard-optimized summary payload for Cheddar integration."""
    job = engine_service.get_job(analysis_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "Analysis not found",
                "detail": f"No analysis found with ID: {analysis_id}",
                "code": "ANALYSIS_NOT_FOUND",
            },
        )
    detailed = build_detailed_analysis_contract(job)
    return build_dashboard_contract(detailed)


@router.websocket("/{analysis_id}/stream")
async def stream_analysis_progress(websocket: WebSocket, analysis_id: str):
    """
    WebSocket endpoint for streaming analysis progress.

    Connect to receive real-time updates during analysis:
    - {"type": "progress", "phase": "...", "progress": 35, "message": "...", "timestamp": "..."}
    - {"type": "complete", "analysis_id": "...", "status": "success", "timestamp": "..."}
    - {"type": "error", "error": "...", "details": "...", "timestamp": "..."}

    Connection closes automatically when analysis completes or fails.
    """
    await websocket.accept()
    logger.info(f"WebSocket connected for analysis {analysis_id}")

    job = engine_service.get_job(analysis_id)
    if not job:
        await websocket.send_json({
            "type": "error",
            "error": "Analysis not found",
            "details": "No analysis job found for provided ID",
            "timestamp": _utc_now_iso(),
        })
        await websocket.close(code=4004)
        return

    # If already completed, send completion and close
    if _is_complete_status(job.status):
        await websocket.send_json({
            "type": "complete",
            "analysis_id": analysis_id,
            "status": "success",
            "timestamp": _utc_now_iso(),
        })
        await websocket.close()
        return

    if job.status == "failed":
        await websocket.send_json({
            "type": "error",
            "error": job.error,
            "details": "Analysis execution failed",
            "timestamp": _utc_now_iso(),
        })
        await websocket.close(code=4000)
        return

    # Create async queue for progress updates
    progress_queue: asyncio.Queue = asyncio.Queue()

    def on_progress(progress: float, phase: str):
        """Callback invoked by engine service on progress."""
        try:
            progress_queue.put_nowait({"progress": progress, "phase": phase})
        except asyncio.QueueFull:
            pass  # Drop if queue is full (shouldn't happen)

    # Register callback
    engine_service.register_progress_callback(analysis_id, on_progress)

    try:
        # Send current state
        await websocket.send_json(_ws_progress_payload(job.phase or "initializing", float(job.progress or 0)))

        # Stream updates until complete
        while True:
            # Check if job completed
            job = engine_service.get_job(analysis_id)
            if not job:
                break

            if _is_complete_status(job.status):
                await websocket.send_json({
                    "type": "complete",
                    "analysis_id": analysis_id,
                    "status": "success",
                    "timestamp": _utc_now_iso(),
                })
                break

            if job.status == "failed":
                await websocket.send_json({
                    "type": "error",
                    "error": job.error,
                    "details": "Analysis execution failed",
                    "timestamp": _utc_now_iso(),
                })
                break

            # Wait for progress update with timeout
            try:
                update = await asyncio.wait_for(
                    progress_queue.get(),
                    timeout=2.0  # Poll every 2 seconds max
                )
                await websocket.send_json(
                    _ws_progress_payload(
                        str(update.get("phase") or "finalization"),
                        float(update.get("progress") or 0),
                    )
                )
            except asyncio.TimeoutError:
                # No update during this tick; continue waiting.
                continue

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected for analysis {analysis_id}")
    except Exception as e:
        logger.exception(f"WebSocket error for analysis {analysis_id}")
        try:
            await websocket.send_json({
                "type": "error",
                "error": str(e),
                "details": "WebSocket stream error",
                "timestamp": _utc_now_iso(),
            })
        except Exception:
            pass
    finally:
        logger.info(f"WebSocket closing for analysis {analysis_id}")


@router.post(
    "/interactive",
    response_model=AnalyzeResponse,
    status_code=status.HTTP_202_ACCEPTED,
    responses={
        400: {"model": ErrorResponse, "description": "Invalid request"},
    },
)
async def trigger_interactive_analysis(
    request: ManualOverridesRequest,
    background_tasks: BackgroundTasks,
):
    """
    Trigger analysis with manual overrides (chips, transfers, injuries).
    
    Allows you to override:
    - available_chips: Force specific chips to be available
    - free_transfers: Override the number of free transfers
    - injury_overrides: Manual player injury status
    - thresholds: Risk posture thresholds for decision guidance
    - force_refresh: Bypass cache and run fresh analysis
    
    Returns an analysis_id for polling/WebSocket tracking.
    """
    # Validate team_id
    if request.team_id < 1 or request.team_id > 20_000_000:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": "Invalid team_id",
                "detail": "team_id must be between 1 and 20000000",
                "code": "INVALID_TEAM_ID",
            },
        )
    
    # Skip cache for interactive requests - they often have overrides
    # Create analysis job with overrides
    job = engine_service.create_analysis(
        request.team_id,
        gameweek=None,
        overrides={
            "available_chips": request.available_chips,
            "free_transfers": request.free_transfers,
            "injury_overrides": [ov.model_dump() for ov in (request.injury_overrides or [])],
            "risk_posture": request.risk_posture,
            "manual_transfers": request.manual_transfers,
            "thresholds": request.thresholds.model_dump(exclude_none=True) if request.thresholds else None,
            "user_id": request.user_id,
            "source": request.source,
        }
    )
    logger.info("Created interactive analysis job %s", job.analysis_id)
    
    # Schedule background task
    background_tasks.add_task(
        run_analysis_task,
        job.analysis_id,
        request.team_id,
        None,  # gameweek
        overrides={
            "available_chips": request.available_chips,
            "free_transfers": request.free_transfers,
            "injury_overrides": [ov.model_dump() for ov in (request.injury_overrides or [])],
            "risk_posture": request.risk_posture,
            "manual_transfers": request.manual_transfers,
            "thresholds": request.thresholds.model_dump(exclude_none=True) if request.thresholds else None,
            "user_id": request.user_id,
            "source": request.source,
        }
    )
    
    return AnalyzeResponse(
        analysis_id=job.analysis_id,
        status="queued",
        team_id=request.team_id,
        created_at=job.created_at,
        estimated_duration_seconds=settings.ANALYSIS_ESTIMATED_DURATION_SECONDS,
    )


@router.get(
    "/{analysis_id}/projections",
    response_model=DetailedAnalysisResponse,
    responses={
        404: {"model": ErrorResponse, "description": "Analysis not found"},
        425: {"model": ErrorResponse, "description": "Analysis not ready"},
        500: {"model": ErrorResponse, "description": "Analysis failed"},
    },
)
async def get_detailed_projections(analysis_id: str):
    """
    Get detailed player projections for a completed analysis.
    
    Returns:
    - Starting XI projections with expected points
    - Bench projections
    - Transfer targets (if recommendations exist)
    - Risk scenarios
    - Chip guidance
    
    Only available after analysis completes.
    """
    job = engine_service.get_job(analysis_id)
    
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "Analysis not found",
                "detail": f"No analysis found with ID: {analysis_id}",
                "code": "ANALYSIS_NOT_FOUND",
            },
        )

    if str(job.status).lower() == "failed":
        failure_detail = f"Analysis failed: {job.error or 'Unknown analysis error'}"
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={
                "error": "Analysis failed",
                "detail": failure_detail,
                "code": "ANALYSIS_FAILED",
            },
        )

    if not _is_complete_status(job.status):
        raise HTTPException(
            status_code=status.HTTP_425_TOO_EARLY,
            detail={
                "error": "Analysis not ready",
                "detail": f"Analysis is {job.status}, not complete",
                "code": "ANALYSIS_NOT_READY",
            },
        )
    
    # Extract detailed data from results
    results = job.results or {}
    weekly_report_card = _weekly_report_card_payload(results.get("weekly_review"))
    scenario_notes: List[str] = []
    if isinstance(results.get("scenario_notes"), list):
        scenario_notes.extend(
            str(note) for note in results.get("scenario_notes", []) if note is not None
        )
    if weekly_report_card and isinstance(weekly_report_card.get("scenario_notes"), list):
        scenario_notes.extend(
            str(note) for note in weekly_report_card.get("scenario_notes", []) if note is not None
        )
    if not scenario_notes:
        scenario_notes = None
    
    # Build detailed response - use all transformed result keys
    response = DetailedAnalysisResponse(
        team_name=results.get("team_name", "Unknown Team"),
        manager_name=results.get("manager_name", "Unknown Manager"),
        current_gw=results.get("current_gw"),
        overall_rank=results.get("overall_rank"),
        overall_points=results.get("overall_points"),
        free_transfers=results.get("free_transfers"),
        risk_posture=results.get("risk_posture"),
        
        # Primary decision
        primary_decision=results.get("primary_decision", "HOLD"),
        decision_status=results.get("decision_status"),
        decision_state=results.get("decision_state"),
        critical_failure_reason=results.get("critical_failure_reason"),
        chip_instruction=results.get("chip_instruction"),
        recovery_plan=results.get("recovery_plan"),
        structural_weakness_summary=results.get("structural_weakness_summary"),
        confidence=results.get("confidence", "MEDIUM"),
        reasoning=results.get("reasoning", "Analysis complete"),
        strategy_mode=results.get("strategy_mode"),
        manager_state=results.get("manager_state"),

        # Transfer details
        transfer_recommendations=results.get("transfer_recommendations", []),
        transfer_plans=results.get("transfer_plans"),
        near_threshold_moves=results.get("near_threshold_moves"),
        near_threshold_reason=results.get("near_threshold_reason"),
        strategy_paths=results.get("strategy_paths"),
        strategy_paths_reason=results.get("strategy_paths_reason"),
        squad_issues=results.get("squad_issues"),
        captain=results.get("captain"),
        vice_captain=results.get("vice_captain"),
        captain_delta=results.get("captain_delta"),
        
        # Player projections - current and projected
        starting_xi_projections=results.get("starting_xi", []),
        bench_projections=results.get("bench", []),
        lineup_decision=results.get("lineup_decision"),
        projected_xi=results.get("projected_xi", []),
        projected_bench=results.get("projected_bench", []),
        transfer_targets=results.get("transfer_targets"),
        
        # Risk & chips
        risk_scenarios=results.get("risk_scenarios", []),
        chip_recommendation=results.get("chip_recommendation"),
        chip_timing_outlook=results.get("chip_timing_outlook"),
        fixture_planner=results.get("fixture_planner"),
        fixture_planner_reason=results.get("fixture_planner_reason"),
        available_chips=results.get("available_chips", []),
        squad_health=results.get("squad_health"),
        weekly_report_card=weekly_report_card,
        confidence_band=results.get("confidence_band"),
        relative_risk=results.get("relative_risk"),
        explainability=results.get("explainability"),
        scenario_notes=scenario_notes,
    )
    
    return response
