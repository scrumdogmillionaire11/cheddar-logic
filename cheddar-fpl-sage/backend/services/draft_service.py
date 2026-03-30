"""Draft-session service — CRUD + constraint state management.

WI-0654: Draft sessions API, draft builder, and collaborative constraints.

Wraps ``ProductStore`` for session lifecycle.
Constraint state is stored as ``DraftAudit`` events (append-only, event_type
= 'constraints_updated') and reconstructed by replaying the audit log.  This
keeps the durable ``DraftSession`` model from WI-0652 unchanged.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from backend.models.draft_api_models import (
    DraftConstraints,
    DraftSessionCreateRequest,
    DraftSessionPatchRequest,
    DraftSessionResponse,
    IntentParseResult,
)
from backend.models.product_models import DraftAudit, DraftSession
from backend.services.draft_intent_parser import parse_intent
from backend.services.product_store import product_store

logger = logging.getLogger(__name__)


class DraftService:
    """Stateless service façade for draft-session operations.

    All state lives in a ``ProductStore``; this class adds:
    - Request validation and mapping
    - Constraint-state derivation from the audit trail
    - Intent-phrase parsing delegation

    The optional ``store`` parameter allows injecting a test-isolated store.
    When omitted the module-level ``product_store`` singleton is used.
    """

    def __init__(self, store=None) -> None:
        from backend.services.product_store import product_store as _default_store
        self._store = store or _default_store

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _get_current_constraints(self, session_id: str) -> DraftConstraints:
        """Replay ``constraints_updated`` audit events to get current state.

        Returns the constraints from the *last* such event, or neutral
        defaults if no constraint event has been recorded yet.
        """
        audits = self._store.list_audits(session_id=session_id)
        constraint_events = [
            a for a in audits if a.event_type == "constraints_updated"
        ]
        if not constraint_events:
            return DraftConstraints.model_construct(
                locked_players=[],
                banned_players=[],
                club_caps={},
                bench_quality_target="medium",
                premium_count_target=3,
                differential_slots_target=0,
                uncertainty_tolerance="medium",
                early_transfer_tolerance=False,
            )
        # Most recent event is last in list (append order)
        last = constraint_events[-1]
        return DraftConstraints.model_validate(last.payload)

    @staticmethod
    def _session_to_response(
        session: DraftSession,
        constraints: DraftConstraints,
    ) -> DraftSessionResponse:
        return DraftSessionResponse(
            session_id=session.session_id,
            manager_id=session.manager_id,
            gameweek=session.gameweek,
            status=session.status,
            constraints=constraints,
            started_at=session.started_at.isoformat(),
            completed_at=(
                session.completed_at.isoformat() if session.completed_at else None
            ),
        )

    # ── Public API ────────────────────────────────────────────────────────────

    def create_session(
        self, request: DraftSessionCreateRequest
    ) -> DraftSessionResponse:
        """Create and persist a new draft session."""
        constraints = request.constraints or DraftConstraints.model_construct(
            locked_players=[],
            banned_players=[],
            club_caps={},
            bench_quality_target="medium",
            premium_count_target=3,
            differential_slots_target=0,
            uncertainty_tolerance="medium",
            early_transfer_tolerance=False,
        )

        session = DraftSession.model_construct(
            session_id=str(uuid.uuid4()),
            manager_id=request.manager_id,
            gameweek=request.gameweek,
            started_at=datetime.now(timezone.utc),
            completed_at=None,
            status="open",
            schema_version="1.0",
        )
        self._store.create_session(session)

        # Record initial constraints as first audit event
        self._store.append_audit(
            DraftAudit(
                session_id=session.session_id,
                event_type="constraints_updated",
                payload=DraftConstraints.model_validate(
                    constraints if isinstance(constraints, dict) else constraints.model_dump()
                ).model_dump(),
            )
        )
        self._store.append_audit(
            DraftAudit(
                session_id=session.session_id,
                event_type="session_opened",
                payload={"manager_id": request.manager_id, "gameweek": request.gameweek},
            )
        )

        logger.info(
            "Created draft session %s for manager %s GW%s",
            session.session_id,
            request.manager_id,
            request.gameweek,
        )
        return self._session_to_response(session, DraftConstraints.model_validate(
            constraints if isinstance(constraints, dict) else constraints.model_dump()
        ))

    def patch_session(
        self,
        session_id: str,
        request: DraftSessionPatchRequest,
    ) -> Optional[DraftSessionResponse]:
        """Apply a constraint patch (explicit or intent-parse) to a session.

        Returns None if session not found.
        """
        session = self._store.get_session(session_id)
        if session is None:
            return None

        current = self._get_current_constraints(session_id)

        intent_result: Optional[IntentParseResult] = None
        if request.intent_text:
            intent_result = parse_intent(request.intent_text)
            # Merge intent-parsed constraints on top of current
            intent_data = intent_result.recognized_constraints.model_dump(
                exclude_defaults=False
            )
            # Only overlay non-default / non-empty values
            for field, value in intent_data.items():
                if value != getattr(DraftConstraints.model_construct(
                    locked_players=[], banned_players=[], club_caps={},
                    bench_quality_target="medium", premium_count_target=3,
                    differential_slots_target=0, uncertainty_tolerance="medium",
                    early_transfer_tolerance=False,
                ), field, None):
                    setattr(current, field, value)

        if request.constraints:
            # Explicit constraints fully override the current state
            current = request.constraints

        # Persist updated constraint state as a new audit event
        self._store.append_audit(
            DraftAudit(
                session_id=session_id,
                event_type="constraints_updated",
                payload=current.model_dump(),
            )
        )

        if intent_result and intent_result.unrecognized_fragments:
            self._store.append_audit(
                DraftAudit(
                    session_id=session_id,
                    event_type="intent_parse_partial",
                    payload={
                        "input": request.intent_text,
                        "unrecognized": intent_result.unrecognized_fragments,
                        "guidance": intent_result.guidance,
                    },
                )
            )
            logger.info(
                "Session %s: intent partially parsed; unrecognized=%s",
                session_id,
                intent_result.unrecognized_fragments,
            )

        logger.info("Patched draft session %s constraints.", session_id)
        return self._session_to_response(session, current)

    def get_session(self, session_id: str) -> Optional[DraftSessionResponse]:
        """Return current session state, or None if not found."""
        session = self._store.get_session(session_id)
        if session is None:
            return None
        constraints = self._get_current_constraints(session_id)
        return self._session_to_response(session, constraints)

    def parse_intent(
        self,
        text: str,
        player_pool=None,
    ) -> IntentParseResult:
        """Expose intent parsing as a service method (for testing / introspection)."""
        return parse_intent(text, player_pool)


# ── Module-level singleton ────────────────────────────────────────────────────
draft_service = DraftService()
