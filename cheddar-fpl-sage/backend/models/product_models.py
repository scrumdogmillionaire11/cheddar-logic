"""Versioned contract models for FPL Sage product store.

WI-0652: Product-store foundation and versioned contracts.

These models are Sage-owned, durable, and schema-versioned.
They are kept entirely separate from the transient analysis-job
contracts in api_models.py and from Redis job state.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ── Contract schema version ───────────────────────────────────────────────────
PRODUCT_SCHEMA_VERSION = "1.0"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _new_id() -> str:
    return str(uuid.uuid4())


# ── Manager Profile ───────────────────────────────────────────────────────────


class ManagerProfile(BaseModel):
    """Durable FPL manager profile.

    Primary owner of all sessions/receipts for a given FPL account.
    """

    manager_id: str = Field(default_factory=_new_id, description="Sage-internal manager UUID")
    fpl_team_id: int = Field(..., description="FPL team entry ID (from FPL API)")
    team_name: str = Field(..., description="FPL team name")
    player_name: str = Field(..., description="Manager's real name from FPL API")
    registered_at: datetime = Field(default_factory=_utcnow, description="First seen timestamp (UTC)")
    updated_at: datetime = Field(default_factory=_utcnow, description="Last upsert timestamp (UTC)")
    schema_version: str = Field(default=PRODUCT_SCHEMA_VERSION, description="Contract version")


# ── Draft Session ─────────────────────────────────────────────────────────────


class DraftSession(BaseModel):
    """A planning/draft session for a manager in a given gameweek.

    One session groups all candidates, upload, audit, and receipts.
    """

    session_id: str = Field(default_factory=_new_id, description="Unique session UUID")
    manager_id: str = Field(..., description="Owner manager UUID")
    gameweek: int = Field(..., description="FPL gameweek this session targets", ge=1, le=38)
    started_at: datetime = Field(default_factory=_utcnow, description="Session start timestamp (UTC)")
    completed_at: Optional[datetime] = Field(None, description="Session completion timestamp (UTC)")
    status: Literal["open", "completed", "abandoned"] = Field("open", description="Session lifecycle status")
    schema_version: str = Field(default=PRODUCT_SCHEMA_VERSION, description="Contract version")


# ── Draft Candidate ───────────────────────────────────────────────────────────


class DraftCandidate(BaseModel):
    """A player candidate evaluated during a draft session."""

    candidate_id: str = Field(default_factory=_new_id, description="Unique candidate UUID")
    session_id: str = Field(..., description="Parent session UUID")
    fpl_player_id: int = Field(..., description="FPL API player element ID")
    player_name: str = Field(..., description="Player display name")
    position: Literal["GKP", "DEF", "MID", "FWD"] = Field(..., description="FPL position")
    team_short: str = Field(..., description="Three-letter team abbreviation")
    recommended: bool = Field(False, description="Whether Sage recommended this player")
    score: Optional[float] = Field(None, description="Computed recommendation score")
    rationale: Optional[str] = Field(None, description="Human-readable recommendation rationale")
    schema_version: str = Field(default=PRODUCT_SCHEMA_VERSION, description="Contract version")


# ── Parsed Squad ──────────────────────────────────────────────────────────────


class ParsedSquad(BaseModel):
    """Squad parsed from a screenshot, manual entry, or FPL API.

    Captures the raw input alongside the structured player list for auditability.
    """

    squad_id: str = Field(default_factory=_new_id, description="Unique squad snapshot UUID")
    session_id: str = Field(..., description="Parent session UUID")
    source_type: Literal["screenshot", "manual", "api"] = Field("api", description="How the squad was obtained")
    raw_input: Optional[str] = Field(None, description="Raw text/OCR input (if applicable)")
    players: List[Dict[str, Any]] = Field(default_factory=list, description="Parsed player entries")
    parsed_at: datetime = Field(default_factory=_utcnow, description="Parse timestamp (UTC)")
    schema_version: str = Field(default=PRODUCT_SCHEMA_VERSION, description="Contract version")


# ── Draft Audit ───────────────────────────────────────────────────────────────


class DraftAudit(BaseModel):
    """Immutable audit event appended during a draft session.

    Append-only.  Never mutate an existing audit entry.
    """

    audit_id: str = Field(default_factory=_new_id, description="Unique audit event UUID")
    session_id: str = Field(..., description="Parent session UUID")
    event_type: str = Field(
        ...,
        description=(
            "Audit event label, e.g. 'session_opened', 'candidate_added', "
            "'squad_parsed', 'receipt_issued', 'session_completed'"
        ),
    )
    payload: Dict[str, Any] = Field(default_factory=dict, description="Event-specific structured payload")
    occurred_at: datetime = Field(default_factory=_utcnow, description="Event timestamp (UTC)")
    schema_version: str = Field(default=PRODUCT_SCHEMA_VERSION, description="Contract version")


# ── Decision Receipt ──────────────────────────────────────────────────────────


class DecisionReceipt(BaseModel):
    """A decision issued to a manager by the Sage engine.

    Records what was decided, why, and when — durable for post-hoc review.
    """

    receipt_id: str = Field(default_factory=_new_id, description="Unique receipt UUID")
    session_id: str = Field(..., description="Parent session UUID")
    manager_id: str = Field(..., description="Recipient manager UUID")
    decision_type: str = Field(
        ...,
        description="Decision category, e.g. 'captain', 'transfer', 'chip', 'formation'",
    )
    rationale: str = Field(..., description="Human-readable reason for the decision")
    payload: Dict[str, Any] = Field(
        default_factory=dict,
        description="Structured decision data (player IDs, scores, etc.)",
    )
    issued_at: datetime = Field(default_factory=_utcnow, description="Receipt issuance timestamp (UTC)")
    schema_version: str = Field(default=PRODUCT_SCHEMA_VERSION, description="Contract version")
    # WI-0658: extended outcome-tracking fields (all optional for backward compat)
    user_choice: Optional[Dict[str, Any]] = Field(
        None, description="What the manager actually chose (if known)"
    )
    applied_overrides: Optional[Dict[str, Any]] = Field(
        None, description="Manual overrides applied to this decision"
    )
    outcome: Optional[Literal["followed", "ignored", "partial"]] = Field(
        None,
        description="Retrospective recommendation adherence status (weekly-review evaluated)",
    )
    process_verdict: Optional[Literal["good_process", "bad_process"]] = Field(
        None,
        description="Retrospective process-quality verdict from weekly-review evaluation",
    )
    drift_flags: List[str] = Field(
        default_factory=list,
        description="Retrospective drift signals for this receipt (weekly-review derived)",
    )
