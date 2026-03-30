"""Draft-session request/response models.

WI-0654: Draft sessions API, draft builder, and collaborative constraints.

These are the *API contract* models for the /api/v1/draft-sessions surface.
They are separate from the durable storage models in product_models.py.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


# ── Collaborative constraint model ────────────────────────────────────────────


class DraftConstraints(BaseModel):
    """All supported collaborative constraints for draft generation.

    Defaults represent a neutral/balanced profile.  Any field can be omitted
    and the builder will apply the default.
    """

    locked_players: List[int] = Field(
        default_factory=list,
        description="FPL player element IDs that MUST appear in every build.",
    )
    banned_players: List[int] = Field(
        default_factory=list,
        description="FPL player element IDs excluded from every build.",
    )
    club_caps: Dict[str, int] = Field(
        default_factory=dict,
        description=(
            "Maximum players allowed from each club. "
            "Key = three-letter team abbreviation (e.g. 'MCI'), value = max "
            "count (1–3).  Unspecified clubs default to FPL's global cap of 3."
        ),
    )
    bench_quality_target: Literal["low", "medium", "high"] = Field(
        "medium",
        description=(
            "'high' allocates more budget to bench cover; "
            "'low' concentrates budget on the starting XI."
        ),
    )
    premium_count_target: int = Field(
        3,
        ge=0,
        le=6,
        description=(
            "Number of premium players (≥8.0m) to target in the starting XI."
        ),
    )
    differential_slots_target: int = Field(
        0,
        ge=0,
        le=5,
        description=(
            "Number of differential slots (<5 % ownership) in the starting XI. "
            "0 = template build; ≥1 increases ceiling while reducing floor."
        ),
    )
    uncertainty_tolerance: Literal["low", "medium", "high"] = Field(
        "medium",
        description=(
            "'low' picks safe/highly-predictable players; "
            "'high' accepts form/injury-risk players with upside."
        ),
    )
    early_transfer_tolerance: bool = Field(
        False,
        description=(
            "When True the builder is allowed to suggest moves with a "
            "≤1 GW payback horizon (speculative early transfers)."
        ),
    )


# ── Player entry (pool / build output) ───────────────────────────────────────


class PlayerEntry(BaseModel):
    """A single player in a pool or a generated build."""

    fpl_player_id: int = Field(..., description="FPL API player element ID.")
    player_name: str = Field(..., description="Display name.")
    position: Literal["GKP", "DEF", "MID", "FWD"] = Field(
        ..., description="FPL position."
    )
    team_short: str = Field(..., description="Three-letter team abbreviation.")
    price: float = Field(..., description="Transfer price in £m.")
    ownership_pct: float = Field(
        0.0, ge=0.0, le=100.0, description="Selected-by percentage."
    )
    form: float = Field(0.0, description="Recent-form score (FPL rolling avg).")
    is_locked: bool = Field(False, description="Sourced from locked_players constraint.")
    is_differential: bool = Field(
        False, description="Flagged as differential (<5 % ownership)."
    )


# ── Build output ──────────────────────────────────────────────────────────────


class DraftBuild(BaseModel):
    """A complete generated FPL build (15-player squad)."""

    build_type: Literal["primary", "contrast"] = Field(
        ...,
        description=(
            "'primary' = conservative/template build; "
            "'contrast' = ceiling/differential build."
        ),
    )
    players: List[PlayerEntry] = Field(
        ..., description="Ordered list of 15 players (11 starters + 4 bench)."
    )
    total_value: float = Field(
        ..., description="Total squad value in £m."
    )
    formation: str = Field(
        ..., description="Starting-XI formation string, e.g. '4-4-2'."
    )
    strategy_label: str = Field(
        ..., description="Short human-readable strategy label."
    )
    rationale: str = Field(
        ..., description="One-paragraph explanation of build choices."
    )
    constraints_applied: List[str] = Field(
        default_factory=list,
        description="List of constraint keys that visibly affected this build.",
    )
    squad_meta: Dict[str, Any] = Field(
        default_factory=dict,
        description="Optional structured metadata (club counts, etc.).",
    )


# ── Tradeoff note ─────────────────────────────────────────────────────────────


class TradeoffNote(BaseModel):
    """A single tradeoff comparison between primary and contrast builds."""

    topic: str = Field(
        ..., description="What this comparison is about (e.g. 'Differentials')."
    )
    primary_choice: str = Field(
        ..., description="What the primary build chose and why."
    )
    contrast_choice: str = Field(
        ..., description="What the contrast build chose and why."
    )
    implication: str = Field(
        ..., description="Practical implication for the manager."
    )


# ── Session CRUD request/response ────────────────────────────────────────────


class DraftSessionCreateRequest(BaseModel):
    """Payload for POST /api/v1/draft-sessions."""

    manager_id: str = Field(..., description="Sage-internal manager UUID.")
    gameweek: int = Field(..., ge=1, le=38, description="Target FPL gameweek.")
    constraints: Optional[DraftConstraints] = Field(
        None,
        description=(
            "Optional initial constraints. "
            "If omitted a neutral default constraint set is applied."
        ),
    )


class DraftSessionPatchRequest(BaseModel):
    """Payload for PATCH /api/v1/draft-sessions/{id}.

    Either ``constraints`` or ``intent_text`` (or both) must be present.
    """

    constraints: Optional[DraftConstraints] = Field(
        None, description="Explicit constraint overrides."
    )
    intent_text: Optional[str] = Field(
        None,
        description=(
            "Free-form collaborative constraint phrase, e.g. 'keep Salah' or "
            "'stronger bench'.  Parsed into constraint fields; "
            "unrecognised fragments return guided feedback rather than silent "
            "acceptance."
        ),
    )


class DraftSessionResponse(BaseModel):
    """Response for session CRUD operations."""

    session_id: str
    manager_id: str
    gameweek: int
    status: Literal["open", "completed", "abandoned"]
    constraints: DraftConstraints
    started_at: str = Field(..., description="ISO-8601 UTC timestamp.")
    completed_at: Optional[str] = Field(None)


# ── Generate request/response ─────────────────────────────────────────────────


class DraftGenerateRequest(BaseModel):
    """Payload for POST /api/v1/draft-sessions/{id}/generate.

    ``player_pool`` is optional.  When omitted the builder uses a curated
    default pool representative of a typical FPL season mid-point.
    Providing an explicit pool enables unit testing with synthetic data.
    """

    player_pool: Optional[List[PlayerEntry]] = Field(
        None,
        description=(
            "Explicit player pool to select from.  Each position must have "
            "sufficient candidates (≥2 per slot) for a full 15-man squad."
        ),
    )


class DraftGenerateResponse(BaseModel):
    """Response for POST /api/v1/draft-sessions/{id}/generate."""

    session_id: str
    primary_build: DraftBuild
    contrast_build: DraftBuild
    tradeoff_notes: List[TradeoffNote]
    constraints_snapshot: DraftConstraints = Field(
        ...,
        description="Constraint state used for this generation (for audit trail).",
    )


# ── Intent-parse response ─────────────────────────────────────────────────────


class IntentParseResult(BaseModel):
    """Result of parsing a free-form collaborative constraint phrase."""

    recognized_constraints: DraftConstraints = Field(
        ...,
        description="Constraint fields populated from recognized patterns.",
    )
    unrecognized_fragments: List[str] = Field(
        default_factory=list,
        description=(
            "Portions of the input that were not recognized.  "
            "Empty when the full phrase is understood."
        ),
    )
    guidance: List[str] = Field(
        default_factory=list,
        description=(
            "Suggestions for reformulating unrecognized fragments into supported "
            "constraint phrases."
        ),
    )
    fully_recognized: bool = Field(
        ..., description="True when every part of the input was recognized."
    )
