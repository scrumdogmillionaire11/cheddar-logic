"""Draft-sessions router — POST/GET/PATCH /api/v1/draft-sessions + generate.

WI-0654: Draft sessions API, draft builder, and collaborative constraints.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status

from backend.models.draft_api_models import (
    DraftGenerateRequest,
    DraftGenerateResponse,
    DraftSessionCreateRequest,
    DraftSessionPatchRequest,
    DraftSessionResponse,
)
from backend.services.draft_service import draft_service
from cheddar_fpl_sage.analysis import draft_builder

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/draft-sessions", tags=["draft-sessions"])


@router.post("", response_model=DraftSessionResponse, status_code=201)
async def create_draft_session(
    request: DraftSessionCreateRequest,
) -> DraftSessionResponse:
    """Create a new draft session for a manager and gameweek."""
    return draft_service.create_session(request)


@router.get("/{session_id}", response_model=DraftSessionResponse)
async def get_draft_session(session_id: str) -> DraftSessionResponse:
    """Retrieve current session state including active constraints."""
    result = draft_service.get_session(session_id)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Draft session '{session_id}' not found.",
        )
    return result


@router.patch("/{session_id}", response_model=DraftSessionResponse)
async def patch_draft_session(
    session_id: str,
    request: DraftSessionPatchRequest,
) -> DraftSessionResponse:
    """Update session constraints via explicit fields or a natural-language phrase.

    - Supply ``constraints`` for structured overrides.
    - Supply ``intent_text`` for collaborative phrases such as 'keep Salah' or
      'make this safer'.
    - Both can be supplied simultaneously; explicit constraints take precedence.
    - Unrecognised intent phrases fail closed: the response will carry guidance
      rather than silently accepting unknown text.
    """
    if request.constraints is None and request.intent_text is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one of 'constraints' or 'intent_text' must be provided.",
        )
    result = draft_service.patch_session(session_id, request)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Draft session '{session_id}' not found.",
        )
    return result


@router.post("/{session_id}/generate", response_model=DraftGenerateResponse)
async def generate_draft(
    session_id: str,
    request: DraftGenerateRequest,
) -> DraftGenerateResponse:
    """Generate a primary (conservative) and contrast (differential) build.

    Uses the session's current constraint state.  Optionally accepts an
    explicit ``player_pool`` to override the default curated pool.
    """
    session = draft_service.get_session(session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Draft session '{session_id}' not found.",
        )

    constraints = session.constraints

    try:
        primary, contrast, tradeoff_notes = draft_builder.generate(
            constraints=constraints,
            player_pool=request.player_pool or None,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc

    logger.info(
        "Generated builds for session %s: primary=%s contrast=%s",
        session_id,
        primary.strategy_label,
        contrast.strategy_label,
    )

    return DraftGenerateResponse(
        session_id=session_id,
        primary_build=primary,
        contrast_build=contrast,
        tradeoff_notes=tradeoff_notes,
        constraints_snapshot=constraints,
    )
