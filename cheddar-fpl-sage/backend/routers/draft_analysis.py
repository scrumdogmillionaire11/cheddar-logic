"""Draft analysis router — WI-0656.

Provides:
  POST /draft-sessions/{session_id}/audit
  POST /draft-sessions/compare

These endpoints live under /api/v1 via main.py include_router registration.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, HTTPException

from backend.models.draft_analysis_api_models import (
    AuditRequest,
    AuditResponse,
    CompareRequest,
    CompareResponse,
)
from backend.services.draft_audit import score_audit
from backend.services.draft_compare import compare_drafts
from backend.services.draft_service import draft_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/draft-sessions", tags=["draft-analysis"])


@router.post("/compare", response_model=CompareResponse)
async def compare_endpoint(body: CompareRequest) -> CompareResponse:
    """Compare two draft builds and return a winner with per-dimension deltas.

    Accepts either:
    - (session_id_a + session_id_b): load builds from session store
    - (squad_a + squad_b): use inline DraftBuild objects directly

    Raises 404 if a referenced session does not exist or has no generated build.
    Raises 422 if neither session refs nor inline squads are provided, or on mixed input.
    """
    if body.session_id_a or body.session_id_b:
        # Session-based comparison: load generated builds from session store
        session_a = draft_service.get_session(body.session_id_a) if body.session_id_a else None
        session_b = draft_service.get_session(body.session_id_b) if body.session_id_b else None

        if body.session_id_a and session_a is None:
            raise HTTPException(
                status_code=404,
                detail=f"Session '{body.session_id_a}' not found.",
            )
        if body.session_id_b and session_b is None:
            raise HTTPException(
                status_code=404,
                detail=f"Session '{body.session_id_b}' not found.",
            )

        # Sessions exist but no generated build attached — require inline builds
        raise HTTPException(
            status_code=422,
            detail=(
                "Session-based comparison requires a prior /generate call on each session. "
                "Provide inline squad_a and squad_b instead, or call "
                "/draft-sessions/{id}/generate first."
            ),
        )

    # Inline squad comparison
    build_a = body.squad_a
    build_b = body.squad_b

    result = compare_drafts(build_a, build_b, body.archetype)
    logger.info("Draft comparison complete: winner=%s archetype=%s", result.winner, body.archetype)
    return result


@router.post("/{session_id}/audit", response_model=AuditResponse)
async def audit_endpoint(session_id: str, body: AuditRequest) -> AuditResponse:
    """Audit a draft build across 8 scoring dimensions.

    The build to audit can be provided as an inline DraftBuild in the request body.
    If no inline_build is provided, the endpoint returns 422 instructing the caller
    to either supply inline_build or call /generate first (session-stored build
    retrieval is not yet implemented).

    Raises 404 if the session does not exist.
    Raises 422 if no build is available to audit.
    """
    session = draft_service.get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=404,
            detail=f"Session '{session_id}' not found.",
        )

    if body.inline_build is None:
        raise HTTPException(
            status_code=422,
            detail=(
                "No build available for this session. "
                "Provide inline_build in the request body or call "
                "/draft-sessions/{id}/generate first."
            ),
        )

    build = body.inline_build
    result = score_audit(build, body.archetype)
    # Stamp the session_id onto the response
    result.session_id = session_id
    logger.info(
        "Audit complete: session=%s archetype=%s verdict=%s",
        session_id,
        body.archetype,
        result.overall_verdict[:60],
    )
    return result
