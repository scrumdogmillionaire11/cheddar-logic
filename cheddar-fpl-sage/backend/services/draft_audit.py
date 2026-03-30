"""Draft audit scoring service — WI-0656.

score_audit(build, archetype) -> AuditResponse

Scores a DraftBuild across 8 dimensions.  All scoring is pure arithmetic
over the PlayerEntry list — no external calls, no randomness.  Results are
fully deterministic for the same input.

Dimension definitions:
  structure            — position-slot validity of the 15-player squad
  philosophy_fit       — alignment between build choices and the manager archetype
  captaincy_strength   — quality of the top captaincy candidates by form × price
  template_exposure    — fraction of starters with ownership_pct > 20
  fragility            — fraction of starters that are risky (differential or low form)
  correlation_exposure — club concentration risk among starters
  exit_liquidity       — fraction of players priced < 6.0 (hard to move out)
  time_to_fix          — heuristic ease-of-pivot based on locked / banned counts

Score semantics: higher score = more risk / worse outcome for the given
dimension **except** for philosophy_fit and captaincy_strength where higher
score = better fit / stronger captain options.

Label thresholds (applied uniformly after computing score):
  >= 0.65 -> "strong"   (dimension-positive, see per-dimension inversion notes)
  >= 0.35 -> "ok"
  else    -> "weak"

For risk dimensions (fragility, correlation_exposure, exit_liquidity,
time_to_fix) the raw score is a risk measure. A HIGH risk score is therefore
labelled "weak". We handle this by inverting these scores before labelling:
  inverted_score = 1.0 - raw_score
  label = label_for(inverted_score)
  The stored AuditDimension.score remains the raw value for downstream logic.
"""
from __future__ import annotations

from collections import Counter
from typing import List

from backend.models.draft_api_models import DraftBuild, PlayerEntry
from backend.models.draft_analysis_api_models import AuditDimension, AuditResponse, ManagerArchetype

# ── Constants ──────────────────────────────────────────────────────────────────

_DIMENSION_NAMES = [
    "structure",
    "philosophy_fit",
    "captaincy_strength",
    "template_exposure",
    "fragility",
    "correlation_exposure",
    "exit_liquidity",
    "time_to_fix",
]

# FPL position count requirements for a valid 15-player squad
_POSITION_SLOTS = {"GKP": 2, "DEF": 5, "MID": 5, "FWD": 3}
_STARTER_COUNT = 11

# Dimensions where a HIGH raw score indicates RISK (label inverted for thresholds)
_RISK_DIMENSIONS = {"fragility", "correlation_exposure", "exit_liquidity", "time_to_fix"}

# Archetype → commentary style tag used in text generation
_ARCHETYPE_STYLE: dict[str, str] = {
    "Safe Template": "template-focused",
    "Balanced Climber": "balanced",
    "Aggressive Hunter": "ceiling-chasing",
    "Value/Flex Builder": "flexibility-first",
    "Set-and-Hold": "stability-focused",
}


# ── Scoring helpers ────────────────────────────────────────────────────────────


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def _label(score: float, is_risk_dimension: bool = False) -> str:
    """Compute human-readable label.

    For risk dimensions a HIGH score is bad, so we invert before thresholding.
    """
    effective = (1.0 - score) if is_risk_dimension else score
    if effective >= 0.65:
        return "strong"
    elif effective >= 0.35:
        return "ok"
    else:
        return "weak"


def _starters(players: List[PlayerEntry]) -> List[PlayerEntry]:
    """Return the first 11 players (starter slots by convention)."""
    return players[:_STARTER_COUNT]


# ── Dimension scorers ─────────────────────────────────────────────────────────


def _score_structure(build: DraftBuild) -> float:
    """Proportion of required slots filled correctly.

    Full 15-slot squad in valid position distribution → 1.0.
    Penalties applied proportionally to missing or invalid slots.
    """
    players = build.players
    if not players:
        return 0.0

    counts = Counter(p.position for p in players)
    total_slots = sum(_POSITION_SLOTS.values())  # 15
    total_players = len(players)

    # Penalise if player count is off
    count_penalty = abs(total_players - total_slots) / total_slots

    # Penalise per position imbalance
    position_penalties = 0.0
    for pos, required in _POSITION_SLOTS.items():
        got = counts.get(pos, 0)
        position_penalties += max(0, required - got)  # only penalise shortfall

    position_penalty = position_penalties / total_slots
    raw = 1.0 - count_penalty - position_penalty
    return _clamp(raw)


def _score_philosophy_fit(build: DraftBuild, archetype: str) -> float:
    """How well the build aligns to the manager archetype.

    Aggressive Hunter rewards differentials + high ceiling (low ownership).
    Safe Template rewards high ownership + template overlap.
    Value/Flex Builder rewards good price-to-form ratio.
    Balanced Climber / Set-and-Hold reward moderate ownership (20–50%).
    """
    starters = _starters(build.players)
    if not starters:
        return 0.0

    differential_fraction = sum(1 for p in starters if p.is_differential) / len(starters)
    # High-ownership fraction (proxy for template overlap)
    high_ownership = sum(1 for p in starters if p.ownership_pct > 20.0) / len(starters)
    low_ownership = 1.0 - high_ownership

    if archetype == "Aggressive Hunter":
        # Rewards differentials + ceiling; low template overlap is fine
        return _clamp(0.6 * differential_fraction + 0.4 * low_ownership)

    elif archetype == "Safe Template":
        # Rewards template overlap (high ownership)
        return _clamp(high_ownership)

    elif archetype == "Value/Flex Builder":
        # Rewards value picks: form/price ratio
        avg_form_price = sum(p.form / max(p.price, 0.1) for p in starters) / len(starters)
        # Normalise: typical good ratio is ~0.8–1.2; cap at 1.5
        return _clamp(avg_form_price / 1.5)

    elif archetype == "Set-and-Hold":
        # Rewards moderate ownership (stable, not fly-by-night picks)
        moderate = sum(1 for p in starters if 15.0 <= p.ownership_pct <= 60.0) / len(starters)
        return _clamp(moderate)

    else:  # "Balanced Climber"
        # Mix of differential and template elements
        balanced = 0.5 * high_ownership + 0.5 * (0.3 + differential_fraction * 0.5)
        return _clamp(balanced)


def _score_captaincy_strength(build: DraftBuild) -> float:
    """Score based on quality of top captaincy candidates.

    Uses top-3 players by form × price composite as captain candidates.
    Higher composite → stronger captaincy options.
    """
    starters = _starters(build.players)
    if not starters:
        return 0.0

    composites = sorted(
        [p.form * p.price for p in starters], reverse=True
    )
    top3 = composites[:3]
    avg_top3 = sum(top3) / len(top3)
    # Normalise: 8.0 form × 13.0 price = 104 is close to theoretical max for a GW
    return _clamp(avg_top3 / 104.0)


def _score_template_exposure(build: DraftBuild, archetype: str) -> float:
    """Fraction of starters with ownership_pct > 20.

    High ownership = higher template exposure.
    For Safe Template this is a positive signal.
    For Aggressive Hunter this is a negative signal.
    The raw score is the exposure fraction (0.0–1.0).
    """
    starters = _starters(build.players)
    if not starters:
        return 0.0
    return sum(1 for p in starters if p.ownership_pct > 20.0) / len(starters)


def _score_fragility(build: DraftBuild) -> float:
    """Fraction of starters that are fragile (differential OR low form < 4.0).

    Higher = more fragile / risky squad.
    """
    starters = _starters(build.players)
    if not starters:
        return 0.0
    fragile = sum(1 for p in starters if p.is_differential or p.form < 4.0)
    return fragile / len(starters)


def _score_correlation_exposure(build: DraftBuild) -> float:
    """Max club representation in starters / 11.

    > 3 same-club starters raises the score significantly.
    """
    starters = _starters(build.players)
    if not starters:
        return 0.0
    club_counts = Counter(p.team_short for p in starters)
    max_club = max(club_counts.values())
    # Base score = max_club / 11; apply progressive penalty above 3
    base = max_club / len(starters)
    if max_club > 3:
        base = _clamp(base + (max_club - 3) * 0.08)
    return _clamp(base)


def _score_exit_liquidity(build: DraftBuild) -> float:
    """Fraction of all 15 players priced < 6.0 (cheap / hard-to-sell).

    Higher = worse liquidity.
    """
    players = build.players
    if not players:
        return 0.0
    return sum(1 for p in players if p.price < 6.0) / len(players)


def _score_time_to_fix(build: DraftBuild) -> float:
    """Heuristic: how many players are locked + banned indicators.

    Fewer locked = easier to pivot (lower score = better time_to_fix).
    Also checks constraints_applied for 'banned' keyword.
    """
    locked_count = sum(1 for p in build.players if p.is_locked)
    banned_hint = sum(
        1 for c in build.constraints_applied if "banned" in c.lower() or "ban" in c.lower()
    )
    total_players = max(len(build.players), 1)
    raw = (locked_count + banned_hint) / total_players
    return _clamp(raw)


# ── Commentary generation ──────────────────────────────────────────────────────


def _commentary(
    name: str,
    score: float,
    archetype: str,
    build: DraftBuild,
) -> str:
    """Generate archetype-aware commentary for a dimension."""
    style = _ARCHETYPE_STYLE.get(archetype, "balanced")
    starters = _starters(build.players)

    if name == "structure":
        counts = Counter(p.position for p in build.players)
        if score >= 0.9:
            return (
                f"Squad structure is valid: {counts['GKP']} GKP, {counts['DEF']} DEF, "
                f"{counts['MID']} MID, {counts['FWD']} FWD."
            )
        else:
            missing = [
                f"{required - counts.get(pos, 0)} {pos}"
                for pos, required in _POSITION_SLOTS.items()
                if counts.get(pos, 0) < required
            ]
            return f"Structure concerns: missing slots — {', '.join(missing) or 'none'}."

    elif name == "philosophy_fit":
        diff_count = sum(1 for p in starters if p.is_differential)
        high_own = sum(1 for p in starters if p.ownership_pct > 20)
        if style == "template-focused":
            return (
                f"Template alignment: {high_own}/11 starters are high-ownership (>20%). "
                f"As a Safe Template manager, {('high' if high_own >= 7 else 'moderate')} "
                f"coverage is {'good' if high_own >= 7 else 'below target'}."
            )
        elif style == "ceiling-chasing":
            return (
                f"Ceiling alignment: {diff_count}/11 starters are differentials. "
                f"Aggressive Hunter managers benefit from {'strong' if diff_count >= 3 else 'limited'} "
                f"differential exposure."
            )
        elif style == "flexibility-first":
            avg_fpr = sum(p.form / max(p.price, 0.1) for p in starters) / max(len(starters), 1)
            return (
                f"Value orientation: avg form/price ratio = {avg_fpr:.2f}. "
                f"{'Good' if avg_fpr >= 0.7 else 'Modest'} value extraction for a Value/Flex Builder."
            )
        elif style == "stability-focused":
            moderate = sum(1 for p in starters if 15.0 <= p.ownership_pct <= 60.0)
            return (
                f"Stability alignment: {moderate}/11 starters in stable ownership band (15–60%). "
                f"{'Well suited' if moderate >= 6 else 'Below ideal'} for a Set-and-Hold approach."
            )
        else:  # balanced
            return (
                f"Balanced profile: {high_own}/11 template picks, {diff_count}/11 differentials. "
                f"{'Good balance' if 3 <= diff_count <= 6 else 'Moderate balance'} for a Balanced Climber."
            )

    elif name == "captaincy_strength":
        top_players = sorted(starters, key=lambda p: p.form * p.price, reverse=True)[:3]
        names = ", ".join(p.player_name for p in top_players)
        return (
            f"Top captaincy options: {names}. "
            f"Combined form-value composite: "
            f"{sum(p.form * p.price for p in top_players):.1f} "
            f"({'strong' if score >= 0.5 else 'moderate'} ceiling)."
        )

    elif name == "template_exposure":
        high_own = sum(1 for p in starters if p.ownership_pct > 20)
        if archetype in ("Safe Template", "Set-and-Hold"):
            return (
                f"{high_own}/11 starters are template picks (>20% ownership). "
                f"{'Good template coverage as expected' if high_own >= 6 else 'Low template overlap — more exposure risk'}."
            )
        elif archetype == "Aggressive Hunter":
            return (
                f"{high_own}/11 starters are template picks (>20% ownership). "
                f"{'High template overlap limits ceiling for Aggressive Hunter' if high_own >= 6 else 'Low template overlap suits your archetype'}."
            )
        else:
            return (
                f"{high_own}/11 starters are template picks (>20% ownership). "
                f"{'Broad template coverage' if high_own >= 7 else 'Selective template picks'}."
            )

    elif name == "fragility":
        fragile = sum(1 for p in starters if p.is_differential or p.form < 4.0)
        low_form = sum(1 for p in starters if p.form < 4.0)
        diffs = sum(1 for p in starters if p.is_differential)
        return (
            f"{fragile}/11 starters are fragile ({low_form} low-form, {diffs} differentials). "
            f"{'High fragility — significant floor risk' if score >= 0.5 else 'Manageable fragility level'}."
        )

    elif name == "correlation_exposure":
        club_counts = Counter(p.team_short for p in starters)
        top_club, top_count = club_counts.most_common(1)[0] if club_counts else ("?", 0)
        return (
            f"Highest club concentration: {top_count} starters from {top_club}. "
            f"{'High correlation risk — fixtures/injuries amplified' if top_count > 3 else 'Manageable club concentration'}."
        )

    elif name == "exit_liquidity":
        cheap = sum(1 for p in build.players if p.price < 6.0)
        return (
            f"{cheap}/15 players priced below £6.0m. "
            f"{'Poor exit liquidity — hard to sell for upgrades' if score >= 0.5 else 'Reasonable flexibility to move funds'}."
        )

    elif name == "time_to_fix":
        locked = sum(1 for p in build.players if p.is_locked)
        return (
            f"{locked} locked players. "
            f"{'Heavy constraints limit pivot options' if score >= 0.4 else 'Good flexibility to pivot the squad'}."
        )

    return f"{name}: score={score:.2f}."


# ── Main service function ─────────────────────────────────────────────────────


def score_audit(build: DraftBuild, archetype: str) -> AuditResponse:
    """Score a DraftBuild across all 8 dimensions.

    Args:
        build:     The squad to audit.
        archetype: Manager archetype string from ManagerArchetype literal.

    Returns:
        AuditResponse with exactly 8 AuditDimension entries.
    """
    raw_scores: dict[str, float] = {
        "structure": _score_structure(build),
        "philosophy_fit": _score_philosophy_fit(build, archetype),
        "captaincy_strength": _score_captaincy_strength(build),
        "template_exposure": _score_template_exposure(build, archetype),
        "fragility": _score_fragility(build),
        "correlation_exposure": _score_correlation_exposure(build),
        "exit_liquidity": _score_exit_liquidity(build),
        "time_to_fix": _score_time_to_fix(build),
    }

    dimensions: list[AuditDimension] = []
    for name in _DIMENSION_NAMES:
        score = raw_scores[name]
        is_risk = name in _RISK_DIMENSIONS
        label = _label(score, is_risk_dimension=is_risk)
        commentary = _commentary(name, score, archetype, build)
        dimensions.append(
            AuditDimension(name=name, score=score, label=label, commentary=commentary)
        )

    # Overall verdict
    avg_quality = (
        raw_scores["structure"]
        + raw_scores["philosophy_fit"]
        + raw_scores["captaincy_strength"]
        + (1.0 - raw_scores["fragility"])
        + (1.0 - raw_scores["correlation_exposure"])
    ) / 5.0

    if avg_quality >= 0.7:
        verdict_quality = "strong"
    elif avg_quality >= 0.45:
        verdict_quality = "solid"
    else:
        verdict_quality = "weak"

    overall_verdict = (
        f"Overall this is a {verdict_quality} build for a {archetype} manager. "
        f"Structure scores {raw_scores['structure']:.2f}, captaincy strength "
        f"{raw_scores['captaincy_strength']:.2f}."
    )

    # what_breaks_this: top 2–4 risk dimensions by raw risk score
    risk_scores = [
        ("fragility", raw_scores["fragility"]),
        ("correlation_exposure", raw_scores["correlation_exposure"]),
        ("exit_liquidity", raw_scores["exit_liquidity"]),
        ("time_to_fix", raw_scores["time_to_fix"]),
    ]
    risk_scores.sort(key=lambda x: x[1], reverse=True)

    _break_templates = {
        "fragility": "High fragility: several low-form or differential starters may underperform.",
        "correlation_exposure": "Club correlation: multiple starters from the same club amplify fixture/injury risk.",
        "exit_liquidity": "Exit liquidity: many cheap players limit your ability to raise funds mid-GW.",
        "time_to_fix": "Locked constraints: heavy locking limits tactical pivots during the week.",
    }

    what_breaks = [_break_templates[name] for name, _ in risk_scores[:4]]
    # Ensure at least 2 entries even if all risk scores are near zero
    if len(what_breaks) < 2:
        what_breaks = list(_break_templates.values())[:2]

    return AuditResponse(
        session_id="",  # Caller (router) sets session_id
        archetype=archetype,  # type: ignore[arg-type]
        dimensions=dimensions,
        overall_verdict=overall_verdict,
        what_breaks_this=what_breaks[:4],
    )
