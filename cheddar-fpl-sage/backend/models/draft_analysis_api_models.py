"""Draft analysis request/response models — WI-0656.

Provides Pydantic models for:
- Audit: AuditRequest, AuditDimension, AuditResponse
- Compare: CompareRequest, CompareDelta, CompareResponse, CompareWinner
"""
from __future__ import annotations

from typing import List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

from backend.models.draft_api_models import DraftBuild

ManagerArchetype = Literal[
    "Safe Template",
    "Balanced Climber",
    "Aggressive Hunter",
    "Value/Flex Builder",
    "Set-and-Hold",
]

CompareWinner = Literal["a", "b", "tie"]


# ── Audit models ──────────────────────────────────────────────────────────────


class AuditRequest(BaseModel):
    """Payload for POST /api/v1/draft-sessions/{id}/audit."""

    archetype: ManagerArchetype = Field(
        "Safe Template",
        description="Manager archetype that modulates commentary and scoring emphasis.",
    )
    inline_build: Optional[DraftBuild] = Field(
        None,
        description=(
            "Optional explicit DraftBuild to audit. If omitted and no generated "
            "build exists for the session, a 422 is returned."
        ),
    )


class AuditDimension(BaseModel):
    """A single scored dimension in a draft audit."""

    name: str = Field(..., description="Dimension identifier (snake_case).")
    score: float = Field(..., ge=0.0, le=1.0, description="Normalised risk/fit score 0–1.")
    label: Literal["strong", "ok", "weak"] = Field(
        ..., description="Human-readable quality band."
    )
    commentary: str = Field(..., description="Archetype-aware explanation of this score.")


class AuditResponse(BaseModel):
    """Full audit result for a draft build.

    Always contains exactly 8 AuditDimension entries covering:
    structure, philosophy_fit, captaincy_strength, template_exposure,
    fragility, correlation_exposure, exit_liquidity, time_to_fix.
    """

    session_id: str = Field(..., description="The audited session ID.")
    archetype: ManagerArchetype = Field(..., description="Archetype used for this audit.")
    dimensions: List[AuditDimension] = Field(
        ...,
        description="Exactly 8 scored dimensions.",
        min_length=8,
        max_length=8,
    )
    overall_verdict: str = Field(
        ..., description="1–2 sentence summary of the squad's overall quality."
    )
    what_breaks_this: List[str] = Field(
        ...,
        description="2–4 strings identifying the highest-risk failure modes.",
        min_length=2,
        max_length=4,
    )


# ── Compare models ────────────────────────────────────────────────────────────


class CompareRequest(BaseModel):
    """Payload for POST /api/v1/draft-sessions/compare.

    Exactly one of the following pairs must be provided:
    - (session_id_a, session_id_b): load builds from session store
    - (squad_a, squad_b): use inline DraftBuild objects directly

    Mixed input (one session + one inline) is rejected with 422.
    """

    session_id_a: Optional[str] = Field(None, description="Session ID for squad A.")
    session_id_b: Optional[str] = Field(None, description="Session ID for squad B.")
    squad_a: Optional[DraftBuild] = Field(None, description="Inline build for squad A.")
    squad_b: Optional[DraftBuild] = Field(None, description="Inline build for squad B.")
    archetype: ManagerArchetype = Field(
        "Safe Template",
        description="Archetype used to weight the comparison.",
    )

    @model_validator(mode="after")
    def validate_input_pair(self) -> "CompareRequest":
        has_sessions = bool(self.session_id_a and self.session_id_b)
        has_squads = bool(self.squad_a and self.squad_b)
        mixed = (bool(self.session_id_a) ^ bool(self.squad_a)) and not (
            has_sessions or has_squads
        )

        if not has_sessions and not has_squads:
            raise ValueError(
                "Provide either (session_id_a + session_id_b) or (squad_a + squad_b)."
            )
        if mixed:
            raise ValueError(
                "Do not mix session references and inline squads. "
                "Provide either both session IDs or both inline builds."
            )
        return self


class CompareDelta(BaseModel):
    """Per-dimension winner and margin for a draft comparison."""

    dimension: str = Field(..., description="Dimension name.")
    winner: CompareWinner = Field(..., description="Which squad won this dimension.")
    margin: str = Field(..., description="Human-readable score margin (e.g. '+0.12').")
    explanation: str = Field(..., description="Prose explanation of why this squad won.")


class CompareResponse(BaseModel):
    """Full comparison result for two draft builds."""

    winner: CompareWinner = Field(
        ..., description="Overall winner across all archetype-weighted dimensions."
    )
    winner_rationale: str = Field(
        ...,
        description="1–2 sentence summary naming the deciding dimensions.",
    )
    deltas: List[CompareDelta] = Field(
        ..., description="Per-dimension breakdown (one entry per dimension)."
    )
    archetype_fit_note: str = Field(
        ...,
        description="Explains how the manager archetype preference influenced the outcome.",
    )
