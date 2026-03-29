"""
Advisor router for fixture difficulty run-in context.
"""

from __future__ import annotations

import logging

import aiohttp
from fastapi import APIRouter, HTTPException, Query

from cheddar_fpl_sage.analysis.fixture_difficulty import (
    DEFAULT_WINDOW,
    compute_run_in_fdr,
    fetch_fixtures_and_bootstrap,
    get_current_gw,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/advisor", tags=["advisor"])


@router.get("")
async def get_run_in_fdr(
    player_id: int = Query(..., description="FPL player element ID"),
    team_id: int = Query(..., description="FPL team ID"),
    window: int = Query(DEFAULT_WINDOW, ge=1, le=38, description="Number of gameweeks to inspect"),
):
    try:
        async with aiohttp.ClientSession() as session:
            fixtures, bootstrap = await fetch_fixtures_and_bootstrap(session)

        current_gw = get_current_gw(bootstrap)
        run_in_fdr = compute_run_in_fdr(
            player_id=player_id,
            team_id=team_id,
            fixtures=fixtures,
            current_gw=current_gw,
            window=window,
        )
        return {
            "player_id": player_id,
            "team_id": team_id,
            "current_gw": current_gw,
            "window": window,
            "run_in_fdr": run_in_fdr,
        }
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Advisor endpoint failed")
        raise HTTPException(status_code=502, detail=f"Failed to compute run-in FDR: {exc}") from exc
