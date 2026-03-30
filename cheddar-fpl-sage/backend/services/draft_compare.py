"""Draft comparison service — WI-0656.

compare_drafts(build_a, build_b, archetype) -> CompareResponse

Compares two DraftBuilds across all 8 audit dimensions via score_audit().
Winner determination is archetype-weighted to reflect what the manager values.
"""
from __future__ import annotations

from backend.models.draft_api_models import DraftBuild
from backend.models.draft_analysis_api_models import (
    CompareDelta,
    CompareResponse,
    CompareWinner,
)
from backend.services.draft_audit import score_audit, _DIMENSION_NAMES

# ── Archetype weights ─────────────────────────────────────────────────────────
# Each archetype maps dimension names to their relative importance weight.
# Weights must sum to a positive total (they are normalised internally).

_ARCHETYPE_WEIGHTS: dict[str, dict[str, float]] = {
    "Safe Template": {
        "structure": 1.5,
        "philosophy_fit": 1.0,
        "captaincy_strength": 1.0,
        "template_exposure": 1.5,
        "fragility": 1.5,
        "correlation_exposure": 0.5,
        "exit_liquidity": 0.5,
        "time_to_fix": 0.5,
    },
    "Set-and-Hold": {
        "structure": 1.5,
        "philosophy_fit": 1.0,
        "captaincy_strength": 1.0,
        "template_exposure": 1.5,
        "fragility": 1.5,
        "correlation_exposure": 0.5,
        "exit_liquidity": 0.5,
        "time_to_fix": 0.5,
    },
    "Aggressive Hunter": {
        "structure": 0.5,
        "philosophy_fit": 1.5,
        "captaincy_strength": 1.5,
        "template_exposure": 0.5,
        "fragility": 0.5,
        "correlation_exposure": 0.5,
        "exit_liquidity": 1.5,
        "time_to_fix": 1.0,
    },
    "Value/Flex Builder": {
        "structure": 0.5,
        "philosophy_fit": 1.5,
        "captaincy_strength": 1.0,
        "template_exposure": 0.5,
        "fragility": 0.5,
        "correlation_exposure": 0.5,
        "exit_liquidity": 2.0,
        "time_to_fix": 1.5,
    },
    "Balanced Climber": {
        "structure": 1.0,
        "philosophy_fit": 1.0,
        "captaincy_strength": 1.0,
        "template_exposure": 1.0,
        "fragility": 1.0,
        "correlation_exposure": 1.0,
        "exit_liquidity": 1.0,
        "time_to_fix": 1.0,
    },
}

# For risk dimensions a higher raw score is worse, so we invert for comparison
_RISK_DIMENSIONS = {"fragility", "correlation_exposure", "exit_liquidity", "time_to_fix"}

# Margin threshold for declaring a winner (< 0.05 → tie)
_TIE_THRESHOLD = 0.05


# ── Dimension-level explanation templates ─────────────────────────────────────

_DIM_EXPLANATIONS: dict[str, dict[str, str]] = {
    "structure": {
        "a": "Squad A has better position balance and slot coverage.",
        "b": "Squad B has better position balance and slot coverage.",
        "tie": "Both squads have equivalent structural validity.",
    },
    "philosophy_fit": {
        "a": "Squad A aligns more closely with the stated archetype's priorities.",
        "b": "Squad B aligns more closely with the stated archetype's priorities.",
        "tie": "Both squads offer similar philosophy fit for this archetype.",
    },
    "captaincy_strength": {
        "a": "Squad A carries stronger captain candidates by form and value.",
        "b": "Squad B carries stronger captain candidates by form and value.",
        "tie": "Both squads offer comparable captaincy quality.",
    },
    "template_exposure": {
        "a": "Squad A provides better template ownership alignment.",
        "b": "Squad B provides better template ownership alignment.",
        "tie": "Both squads have similar template exposure.",
    },
    "fragility": {
        "a": "Squad A is less fragile — fewer low-form or differential risks.",
        "b": "Squad B is less fragile — fewer low-form or differential risks.",
        "tie": "Both squads carry similar fragility risk.",
    },
    "correlation_exposure": {
        "a": "Squad A has lower club concentration risk.",
        "b": "Squad B has lower club concentration risk.",
        "tie": "Both squads have similar club correlation exposure.",
    },
    "exit_liquidity": {
        "a": "Squad A has better exit liquidity — more sellable assets.",
        "b": "Squad B has better exit liquidity — more sellable assets.",
        "tie": "Both squads have comparable liquidity.",
    },
    "time_to_fix": {
        "a": "Squad A is easier to pivot with fewer locked constraints.",
        "b": "Squad B is easier to pivot with fewer locked constraints.",
        "tie": "Both squads have similar pivot flexibility.",
    },
}


# ── Main service function ─────────────────────────────────────────────────────


def compare_drafts(
    build_a: DraftBuild,
    build_b: DraftBuild,
    archetype: str,
) -> CompareResponse:
    """Compare two DraftBuilds across all 8 dimensions.

    Args:
        build_a:   First squad.
        build_b:   Second squad.
        archetype: Manager archetype for weighting the overall winner.

    Returns:
        CompareResponse with winner, per-dimension deltas, and prose summary.
    """
    audit_a = score_audit(build_a, archetype)
    audit_b = score_audit(build_b, archetype)

    scores_a = {d.name: d.score for d in audit_a.dimensions}
    scores_b = {d.name: d.score for d in audit_b.dimensions}

    weights = _ARCHETYPE_WEIGHTS.get(archetype, _ARCHETYPE_WEIGHTS["Balanced Climber"])

    # Per-dimension winner determination
    deltas: list[CompareDelta] = []
    weighted_votes: dict[str, float] = {"a": 0.0, "b": 0.0, "tie": 0.0}

    for dim_name in _DIMENSION_NAMES:
        score_a = scores_a[dim_name]
        score_b = scores_b[dim_name]
        w = weights.get(dim_name, 1.0)

        # For risk dimensions: lower is better, so invert for comparison
        is_risk = dim_name in _RISK_DIMENSIONS
        eff_a = (1.0 - score_a) if is_risk else score_a
        eff_b = (1.0 - score_b) if is_risk else score_b

        diff = eff_a - eff_b
        margin_val = abs(diff)

        if margin_val < _TIE_THRESHOLD:
            dim_winner: CompareWinner = "tie"
            weighted_votes["tie"] += w
        elif diff > 0:
            dim_winner = "a"
            weighted_votes["a"] += w * margin_val
        else:
            dim_winner = "b"
            weighted_votes["b"] += w * margin_val

        margin_str = f"+{diff:+.2f}" if diff >= 0 else f"{diff:.2f}"
        explanation = _DIM_EXPLANATIONS.get(dim_name, {}).get(
            dim_winner, f"Squad {dim_winner.upper()} wins on {dim_name}."
        )

        deltas.append(
            CompareDelta(
                dimension=dim_name,
                winner=dim_winner,
                margin=margin_str,
                explanation=explanation,
            )
        )

    # Overall winner: highest weighted vote
    vote_a = weighted_votes["a"]
    vote_b = weighted_votes["b"]

    if abs(vote_a - vote_b) < 0.001:
        overall_winner: CompareWinner = "tie"
    elif vote_a > vote_b:
        overall_winner = "a"
    else:
        overall_winner = "b"

    # Identify the deciding dimensions for winner_rationale
    if overall_winner == "tie":
        deciding_dims = [d.dimension for d in deltas if d.winner == "tie"][:2]
        rationale = (
            f"The two squads are essentially equivalent across all weighted dimensions "
            f"under the {archetype} archetype. "
            f"Neither shows a decisive edge on the key criteria."
        )
    else:
        winning_deltas = [d for d in deltas if d.winner == overall_winner]
        deciding_dims = [d.dimension for d in winning_deltas[:3]]
        squad_label = "Squad A" if overall_winner == "a" else "Squad B"
        rationale = (
            f"{squad_label} wins under the {archetype} archetype, "
            f"primarily on: {', '.join(deciding_dims)}. "
            f"These dimensions carry the highest weight for this profile."
        )

    # Archetype fit note
    style_notes: dict[str, str] = {
        "Safe Template": (
            "Safe Template managers weight structure, fragility, and template exposure most heavily — "
            "the winner excels where volatility is contained."
        ),
        "Set-and-Hold": (
            "Set-and-Hold managers favour stability and structure; "
            "the winner offers a more predictable, low-maintenance squad."
        ),
        "Aggressive Hunter": (
            "Aggressive Hunter managers prize captaincy upside, philosophy fit, and exit liquidity — "
            "the winner delivers on ceiling over floor."
        ),
        "Value/Flex Builder": (
            "Value/Flex Builder managers focus on exit liquidity and time-to-fix flexibility; "
            "the winner keeps more options open mid-season."
        ),
        "Balanced Climber": (
            "Balanced Climber managers weight all dimensions equally; "
            "the winner demonstrates consistent quality across the board."
        ),
    }
    archetype_fit_note = style_notes.get(
        archetype,
        f"The {archetype} archetype's weighting influenced dimension priority and the overall outcome.",
    )

    return CompareResponse(
        winner=overall_winner,
        winner_rationale=rationale,
        deltas=deltas,
        archetype_fit_note=archetype_fit_note,
    )
