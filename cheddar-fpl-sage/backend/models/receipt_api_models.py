"""API request/response contracts for decision receipts (WI-0658)."""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class DecisionReceiptCreateRequest(BaseModel):
    """Request body for POST /api/v1/decision-receipts."""

    session_id: str
    manager_id: str
    decision_type: str
    rationale: str
    payload: Dict[str, Any] = Field(default_factory=dict)
    user_choice: Optional[Dict[str, Any]] = None
    applied_overrides: Optional[Dict[str, Any]] = None
    outcome: Optional[Literal["followed", "ignored", "partial"]] = None
    process_verdict: Optional[Literal["good_process", "bad_process"]] = None


class DecisionReceiptResponse(BaseModel):
    """Response shape for a single decision receipt."""

    receipt_id: str
    session_id: str
    manager_id: str
    decision_type: str
    rationale: str
    payload: Dict[str, Any]
    issued_at: str  # ISO8601 string for JSON transport
    schema_version: str
    user_choice: Optional[Dict[str, Any]] = None
    applied_overrides: Optional[Dict[str, Any]] = None
    outcome: Optional[Literal["followed", "ignored", "partial"]] = None
    process_verdict: Optional[Literal["good_process", "bad_process"]] = None
    drift_flags: List[str] = Field(default_factory=list)


class UserAnalyticsResponse(BaseModel):
    """Aggregated analytics for a manager derived from their decision receipts."""

    manager_id: str
    season: Optional[str] = None
    adoption_rate: float = Field(
        0.0, ge=0.0, le=1.0,
        description="Fraction of receipts where manager followed or partially followed"
    )
    transfer_quality: float = Field(
        0.0, ge=0.0, le=1.0,
        description="Fraction of transfer receipts with outcome='followed'"
    )
    captain_accuracy: float = Field(
        0.0, ge=0.0, le=1.0,
        description="Fraction of captain receipts with outcome='followed'"
    )
    missed_opportunity_count: int = Field(
        0, ge=0,
        description="Count of ignored captain or transfer receipts"
    )
    receipt_count: int = Field(0, ge=0)


class DecisionMemorySummary(BaseModel):
    """Deterministic drift-flag summary for a manager's decision history."""

    manager_id: str
    bench_neglect: bool = False
    overreaction: bool = False
    excessive_templating: bool = False
    overpunting: bool = False
    receipt_count: int = 0
    evidence: Dict[str, int] = Field(default_factory=dict)
