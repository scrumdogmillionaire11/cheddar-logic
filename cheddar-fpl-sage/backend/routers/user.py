"""User analysis history, performance, analytics, and memory endpoints."""
from typing import Literal, Optional

from fastapi import APIRouter, Query

from backend.models.receipt_api_models import DecisionMemorySummary, UserAnalyticsResponse
from backend.services.engine_service import engine_service
from backend.services.receipt_service import receipt_service

router = APIRouter(prefix="/user", tags=["user"])


@router.get("/{user_id}/analyses")
async def get_user_analysis_history(
    user_id: str,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    season: Optional[str] = Query(None),
    sort_by: Literal["created_at", "gameweek"] = Query("created_at"),
):
    """Return analysis history for a user."""
    return engine_service.list_user_analyses(
        user_id=user_id,
        limit=limit,
        offset=offset,
        season=season,
        sort_by=sort_by,
    )


@router.get("/{user_id}/performance")
async def get_user_performance(
    user_id: str,
    season: Optional[str] = Query(None),
    include_details: bool = Query(False),
):
    """Return aggregated performance metrics for a user."""
    return engine_service.get_user_performance(
        user_id=user_id,
        season=season,
        include_details=include_details,
    )


@router.get("/{manager_id}/analytics", response_model=UserAnalyticsResponse)
async def get_user_analytics(
    manager_id: str,
    season: Optional[str] = Query(None),
):
    """Return receipt-backed analytics for a manager (WI-0658)."""
    return receipt_service.get_analytics(manager_id=manager_id, season=season)


@router.get("/{manager_id}/memory", response_model=DecisionMemorySummary)
async def get_user_memory(manager_id: str):
    """Return deterministic drift-flag summary for a manager (WI-0658)."""
    return receipt_service.get_memory(manager_id=manager_id)
