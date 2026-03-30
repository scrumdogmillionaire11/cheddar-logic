"""Draft builder — rule-driven FPL squad generation.

WI-0654: Draft sessions API, draft builder, and collaborative constraints.

The builder takes a ``DraftConstraints`` + an optional player pool and returns:
  - A ``primary`` build  — conservative/template approach
  - A ``contrast`` build — ceiling/differential approach
  - A list of ``TradeoffNote`` objects comparing the two

IMPORTANT: Generation is purely rule-driven.  No opaque model preferences or
assistant-generated player rankings are injected here.  Selection is
determined exclusively by the constraints and the pool's numeric attributes
(price, form, ownership_pct).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

from backend.models.draft_api_models import (
    DraftBuild,
    DraftConstraints,
    PlayerEntry,
    TradeoffNote,
)

logger = logging.getLogger(__name__)

# ── FPL squad structure constants ────────────────────────────────────────────

SQUAD_POSITION_COUNTS: Dict[str, int] = {
    "GKP": 2,
    "DEF": 5,
    "MID": 5,
    "FWD": 3,
}
SQUAD_SIZE = 15
STARTER_COUNT = 11
BUDGET = 100.0
GLOBAL_CLUB_CAP = 3
PREMIUM_THRESHOLD = 8.0          # £m — counts as "premium"
DIFFERENTIAL_OWNERSHIP_CAP = 5.0  # % — below this = differential

# Minimum players per position in a valid starting XI
MIN_STARTERS_BY_POSITION: Dict[str, int] = {
    "GKP": 1,
    "DEF": 3,
    "MID": 2,
    "FWD": 1,
}
MAX_STARTERS_BY_POSITION: Dict[str, int] = {
    "GKP": 1,
    "DEF": 5,
    "MID": 5,
    "FWD": 3,
}

# Default 4-4-2 formation (used when no constraint profile provided)
DEFAULT_FORMATION = "4-4-2"
DEFAULT_STARTERS: Dict[str, int] = {"GKP": 1, "DEF": 4, "MID": 4, "FWD": 2}


# ── Default player pool ──────────────────────────────────────────────────────

DEFAULT_PLAYER_POOL: List[Dict[str, Any]] = [
    # GKP — 2 starters needed in squad
    {"fpl_player_id": 1, "player_name": "Raya", "position": "GKP", "team_short": "ARS", "price": 5.8, "ownership_pct": 20.0, "form": 6.5},
    {"fpl_player_id": 2, "player_name": "Flekken", "position": "GKP", "team_short": "BRE", "price": 4.5, "ownership_pct": 10.0, "form": 5.0},
    {"fpl_player_id": 3, "player_name": "Schmeichel", "position": "GKP", "team_short": "NOT", "price": 4.5, "ownership_pct": 3.0, "form": 4.5},
    # DEF — 5 needed in squad
    {"fpl_player_id": 4, "player_name": "Alexander-Arnold", "position": "DEF", "team_short": "LIV", "price": 7.5, "ownership_pct": 25.0, "form": 8.0},
    {"fpl_player_id": 5, "player_name": "Trippier", "position": "DEF", "team_short": "NEW", "price": 7.0, "ownership_pct": 18.0, "form": 7.0},
    {"fpl_player_id": 6, "player_name": "Pedro Porro", "position": "DEF", "team_short": "TOT", "price": 6.0, "ownership_pct": 12.0, "form": 6.5},
    {"fpl_player_id": 7, "player_name": "Mykolenko", "position": "DEF", "team_short": "EVE", "price": 4.5, "ownership_pct": 7.0, "form": 5.0},
    {"fpl_player_id": 8, "player_name": "Castagne", "position": "DEF", "team_short": "FUL", "price": 4.5, "ownership_pct": 4.0, "form": 4.5},
    {"fpl_player_id": 9, "player_name": "Wan-Bissaka", "position": "DEF", "team_short": "WHU", "price": 4.5, "ownership_pct": 2.5, "form": 4.0},
    {"fpl_player_id": 10, "player_name": "Gvardiol", "position": "DEF", "team_short": "MCI", "price": 6.8, "ownership_pct": 22.0, "form": 7.5},
    {"fpl_player_id": 11, "player_name": "Saliba", "position": "DEF", "team_short": "ARS", "price": 6.0, "ownership_pct": 30.0, "form": 7.0},
    # MID — 5 needed in squad
    {"fpl_player_id": 12, "player_name": "Salah", "position": "MID", "team_short": "LIV", "price": 12.8, "ownership_pct": 40.0, "form": 10.0},
    {"fpl_player_id": 13, "player_name": "Mbeumo", "position": "MID", "team_short": "BRE", "price": 8.0, "ownership_pct": 28.0, "form": 9.0},
    {"fpl_player_id": 14, "player_name": "Saka", "position": "MID", "team_short": "ARS", "price": 10.5, "ownership_pct": 32.0, "form": 9.0},
    {"fpl_player_id": 15, "player_name": "Palmer", "position": "MID", "team_short": "CHE", "price": 11.5, "ownership_pct": 35.0, "form": 9.5},
    {"fpl_player_id": 16, "player_name": "Andreas", "position": "MID", "team_short": "FUL", "price": 5.5, "ownership_pct": 6.0, "form": 6.5},
    {"fpl_player_id": 17, "player_name": "Son", "position": "MID", "team_short": "TOT", "price": 9.5, "ownership_pct": 15.0, "form": 7.5},
    {"fpl_player_id": 18, "player_name": "Adingra", "position": "MID", "team_short": "BHA", "price": 5.5, "ownership_pct": 3.5, "form": 5.5},
    {"fpl_player_id": 19, "player_name": "Diogo Jota", "position": "MID", "team_short": "LIV", "price": 8.0, "ownership_pct": 4.0, "form": 7.0},
    # FWD — 3 needed in squad
    {"fpl_player_id": 20, "player_name": "Watkins", "position": "FWD", "team_short": "AVL", "price": 8.5, "ownership_pct": 22.0, "form": 8.5},
    {"fpl_player_id": 21, "player_name": "Isak", "position": "FWD", "team_short": "NEW", "price": 8.5, "ownership_pct": 20.0, "form": 8.0},
    {"fpl_player_id": 22, "player_name": "Wissa", "position": "FWD", "team_short": "BRE", "price": 6.5, "ownership_pct": 8.0, "form": 7.5},
    {"fpl_player_id": 23, "player_name": "Solanke", "position": "FWD", "team_short": "TOT", "price": 7.0, "ownership_pct": 3.0, "form": 5.5},
    {"fpl_player_id": 24, "player_name": "Iheanacho", "position": "FWD", "team_short": "LEI", "price": 4.5, "ownership_pct": 1.5, "form": 4.0},
]


def _pool_as_entries(raw: List[Dict[str, Any]]) -> List[PlayerEntry]:
    return [PlayerEntry(**p) for p in raw]


def _flag_players(
    entries: List[PlayerEntry],
    locked_ids: set,
) -> List[PlayerEntry]:
    """Mark locked and differential flags in-place (returns same list)."""
    for p in entries:
        p.is_locked = p.fpl_player_id in locked_ids
        p.is_differential = p.ownership_pct < DIFFERENTIAL_OWNERSHIP_CAP
    return entries


# ── Core selection helpers ────────────────────────────────────────────────────


def _apply_exclusions(
    pool: List[PlayerEntry],
    banned: List[int],
) -> List[PlayerEntry]:
    """Remove banned players from pool."""
    banned_set = set(banned)
    return [p for p in pool if p.fpl_player_id not in banned_set]


def _club_count(players: List[PlayerEntry]) -> Dict[str, int]:
    counts: Dict[str, int] = defaultdict(int)
    for p in players:
        counts[p.team_short] += 1
    return dict(counts)


def _club_cap_ok(
    player: PlayerEntry,
    selected: List[PlayerEntry],
    club_caps: Dict[str, int],
) -> bool:
    """Return True if adding this player respects club caps."""
    cap = club_caps.get(player.team_short, GLOBAL_CLUB_CAP)
    current = sum(1 for p in selected if p.team_short == player.team_short)
    return current < cap


def _select_position_players(
    pos: str,
    needed: int,
    pool: List[PlayerEntry],
    already_selected: List[PlayerEntry],
    constraints: DraftConstraints,
    prefer_differential: bool,
    bench_budget_fraction: float,
) -> List[PlayerEntry]:
    """Select ``needed`` players for ``pos`` from ``pool``.

    Strategy:
    - Locked players in this position are always included first.
    - Remaining slots filled by scoring candidates.
    - ``prefer_differential`` (contrast mode) weights ownership_pct inversely.
    - ``bench_budget_fraction`` controls how much to spend per bench slot.
    """
    pos_pool = [p for p in pool if p.position == pos]
    selected_ids = {p.fpl_player_id for p in already_selected}

    # Always include locked players first
    locked = [
        p for p in pos_pool
        if p.is_locked and p.fpl_player_id not in selected_ids
        and _club_cap_ok(p, already_selected, constraints.club_caps)
    ]
    result: List[PlayerEntry] = locked[:needed]
    already_selected = already_selected + result
    remaining_needed = needed - len(result)

    if remaining_needed == 0:
        return result

    # Score remaining candidates
    candidates = [
        p for p in pos_pool
        if p.fpl_player_id not in selected_ids
        and p.fpl_player_id not in {r.fpl_player_id for r in result}
        and not p.is_locked
        and _club_cap_ok(p, already_selected, constraints.club_caps)
    ]

    def _score(p: PlayerEntry) -> float:
        form_weight = p.form * 2.0
        if prefer_differential:
            # Reward low-ownership in contrast mode
            ownership_weight = max(0.0, (DIFFERENTIAL_OWNERSHIP_CAP - p.ownership_pct)) * 1.5
        else:
            # Reward high-ownership in primary mode (safe picks)
            ownership_weight = p.ownership_pct * 0.1

        # Uncertainty tolerance adjusts risk appetite
        if constraints.uncertainty_tolerance == "low":
            # Penalise very low-form players heavily
            risk_adj = -max(0.0, 7.0 - p.form) * 0.5
        elif constraints.uncertainty_tolerance == "high":
            # Reward upside (form + ownership spread)
            risk_adj = p.form * 0.5
        else:
            risk_adj = 0.0

        return form_weight + ownership_weight + risk_adj

    candidates.sort(key=_score, reverse=True)
    filled = list(candidates[:remaining_needed])
    result.extend(filled)
    return result


def _derive_formation(starters: List[PlayerEntry]) -> str:
    counts = defaultdict(int)
    for p in starters:
        counts[p.position] += 1
    d = counts.get("DEF", 0)
    m = counts.get("MID", 0)
    f = counts.get("FWD", 0)
    return f"{d}-{m}-{f}"


def _pick_starters(
    squad: List[PlayerEntry],
    constraints: DraftConstraints,
) -> Tuple[List[PlayerEntry], List[PlayerEntry]]:
    """Split a 15-player squad into 11 starters + 4 bench.

    Locked players are always starters when possible.
    GKP bench is the cheaper of the two keepers.
    """
    by_pos: Dict[str, List[PlayerEntry]] = defaultdict(list)
    for p in squad:
        by_pos[p.position].append(p)

    starters: List[PlayerEntry] = []
    bench: List[PlayerEntry] = []

    # GKP: 1 starter, 1 bench — starter = higher-priced (or locked)
    gkps = sorted(by_pos["GKP"], key=lambda p: (p.is_locked, p.price), reverse=True)
    if gkps:
        starters.append(gkps[0])
    if len(gkps) > 1:
        bench.append(gkps[1])

    # DEF, MID, FWD — maintain 4-4-2 as default
    target = dict(DEFAULT_STARTERS)
    for pos in ("DEF", "MID", "FWD"):
        players = sorted(by_pos[pos], key=lambda p: (p.is_locked, p.form), reverse=True)
        n_start = min(target[pos], len(players))
        starters.extend(players[:n_start])
        bench.extend(players[n_start:])

    # If we somehow ended up with <11 starters, pull from bench
    while len(starters) < STARTER_COUNT and bench:
        starters.append(bench.pop(0))

    return starters[:STARTER_COUNT], bench[:4]


def _build_squad(
    constraints: DraftConstraints,
    pool: List[PlayerEntry],
    prefer_differential: bool,
    strategy_label: str,
    build_type: Literal["primary", "contrast"],
) -> DraftBuild:
    """Select a valid 15-player squad from ``pool`` applying ``constraints``."""
    # Apply bans
    eligible = _apply_exclusions(pool, constraints.banned_players)

    selected: List[PlayerEntry] = []
    applied_constraints: List[str] = []

    if constraints.banned_players:
        applied_constraints.append("banned_players")
    if constraints.locked_players:
        applied_constraints.append("locked_players")
    if constraints.club_caps:
        applied_constraints.append("club_caps")

    # Bench budget fraction
    bench_fractions = {"low": 0.10, "medium": 0.15, "high": 0.22}
    bench_frac = bench_fractions[constraints.bench_quality_target]

    if constraints.bench_quality_target != "medium":
        applied_constraints.append("bench_quality_target")
    if constraints.differential_slots_target > 0:
        applied_constraints.append("differential_slots_target")
    if constraints.uncertainty_tolerance != "medium":
        applied_constraints.append("uncertainty_tolerance")
    if constraints.premium_count_target != 3:
        applied_constraints.append("premium_count_target")

    # Select players position by position
    for pos, count in SQUAD_POSITION_COUNTS.items():
        picks = _select_position_players(
            pos=pos,
            needed=count,
            pool=eligible,
            already_selected=selected,
            constraints=constraints,
            prefer_differential=prefer_differential,
            bench_budget_fraction=bench_frac,
        )
        selected.extend(picks)

    # Mark differentials
    locked_set = set(constraints.locked_players)
    for p in selected:
        p.is_locked = p.fpl_player_id in locked_set
        p.is_differential = p.ownership_pct < DIFFERENTIAL_OWNERSHIP_CAP

    total_value = round(sum(p.price for p in selected), 1)
    starters, bench = _pick_starters(selected, constraints)
    ordered = starters + bench
    formation = _derive_formation(starters)

    # Count differentials and premiums in starters
    n_diff = sum(1 for p in starters if p.is_differential)
    n_premium = sum(1 for p in starters if p.price >= PREMIUM_THRESHOLD)

    # Club distribution
    club_counts = _club_count(ordered)

    if build_type == "primary":
        rationale = (
            f"Conservative template build targeting high-ownership players to minimise "
            f"rank deviation.  {n_premium} premium players in the XI provide a reliable "
            f"scoring floor.  Uncertainty tolerance is '{constraints.uncertainty_tolerance}', "
            f"bench quality target is '{constraints.bench_quality_target}'.  "
            f"Squad value: £{total_value}m."
        )
    else:
        rationale = (
            f"Contrast/ceiling build with {n_diff} differential slot(s) (<5% ownership) "
            f"for rank-climbing upside.  {n_premium} premium anchor(s) provide a scoring "
            f"floor while lower-owned picks maximise green-arrow potential.  "
            f"Uncertainty tolerance is '{constraints.uncertainty_tolerance}'.  "
            f"Squad value: £{total_value}m."
        )

    return DraftBuild(
        build_type=build_type,
        players=ordered,
        total_value=total_value,
        formation=formation,
        strategy_label=strategy_label,
        rationale=rationale,
        constraints_applied=applied_constraints,
        squad_meta={
            "starter_count": len(starters),
            "bench_count": len(bench),
            "differentials_in_xi": n_diff,
            "premiums_in_xi": n_premium,
            "club_counts": club_counts,
        },
    )


# ── Tradeoff notes ────────────────────────────────────────────────────────────


def _generate_tradeoff_notes(
    primary: DraftBuild,
    contrast: DraftBuild,
    constraints: DraftConstraints,
) -> List[TradeoffNote]:
    notes: List[TradeoffNote] = []

    p_diff = primary.squad_meta.get("differentials_in_xi", 0)
    c_diff = contrast.squad_meta.get("differentials_in_xi", 0)
    if c_diff != p_diff:
        notes.append(
            TradeoffNote(
                topic="Differentials",
                primary_choice=f"{p_diff} differential(s) — lower variance, tracks template.",
                contrast_choice=f"{c_diff} differential(s) — higher upside for rank gains.",
                implication=(
                    "More differentials increase both upside and downside. "
                    "Choose contrast if you need to climb the overall rankings."
                ),
            )
        )

    p_premium = primary.squad_meta.get("premiums_in_xi", 0)
    c_premium = contrast.squad_meta.get("premiums_in_xi", 0)
    if c_premium != p_premium:
        notes.append(
            TradeoffNote(
                topic="Premium count",
                primary_choice=f"{p_premium} premium(s) — reliable scoring foundation.",
                contrast_choice=f"{c_premium} premium(s) — budget redistributed to differentials.",
                implication=(
                    "Fewer premiums free up funds for differential picks but increase "
                    "sensitivity to blanks or injuries among star players."
                ),
            )
        )

    p_val = primary.total_value
    c_val = contrast.total_value
    if abs(p_val - c_val) >= 0.5:
        notes.append(
            TradeoffNote(
                topic="Squad value",
                primary_choice=f"£{p_val}m — concentrated in reliable starters.",
                contrast_choice=f"£{c_val}m — spread differently across differential slots.",
                implication=(
                    "A lower total value in the contrast build releases funds for "
                    "differential picks at the cost of raw quality depth."
                ),
            )
        )

    if constraints.locked_players:
        locked_names = [
            p.player_name
            for p in primary.players
            if p.is_locked
        ]
        names_str = ", ".join(locked_names) if locked_names else str(constraints.locked_players)
        notes.append(
            TradeoffNote(
                topic="Locked players",
                primary_choice=f"Both builds include {names_str} (locked constraint).",
                contrast_choice=f"Both builds include {names_str} (locked constraint).",
                implication=(
                    "Locked players reduce selection freedom; remaining slots must "
                    "satisfy value/formation requirements."
                ),
            )
        )

    if constraints.bench_quality_target != "medium":
        notes.append(
            TradeoffNote(
                topic="Bench quality",
                primary_choice=f"Bench quality target: '{constraints.bench_quality_target}'.",
                contrast_choice="Same bench target applied to both builds.",
                implication=(
                    "'high' bench target shifts ~10% more budget to cover picks, "
                    "reducing starter quality; 'low' concentrates budget in the XI."
                ),
            )
        )

    return notes


# ── Public API ────────────────────────────────────────────────────────────────

# Valid Literal type re-declaration to make _build_squad inline annotation happy
from typing import Literal  # noqa: E402 — needed for the inner function calls


def generate(
    constraints: DraftConstraints,
    player_pool: Optional[List[PlayerEntry]] = None,
) -> Tuple[DraftBuild, DraftBuild, List[TradeoffNote]]:
    """Generate primary and contrast builds given constraints.

    Args:
        constraints: Validated DraftConstraints.
        player_pool: Optional explicit pool.  Uses DEFAULT_PLAYER_POOL when None.

    Returns:
        (primary_build, contrast_build, tradeoff_notes)

    Raises:
        ValueError: If the pool is insufficient for any required position.
    """
    if player_pool is None:
        pool = _flag_players(_pool_as_entries(DEFAULT_PLAYER_POOL), set(constraints.locked_players))
    else:
        pool = _flag_players(list(player_pool), set(constraints.locked_players))

    # Validate pool has enough players per position
    for pos, needed in SQUAD_POSITION_COUNTS.items():
        available = [p for p in pool if p.position == pos]
        if len(available) < needed:
            raise ValueError(
                f"Insufficient pool for position {pos}: "
                f"need {needed}, have {len(available)}."
            )

    # Primary: conservative (prefer high-ownership, no forced differentials)
    primary_constraints = constraints.model_copy()
    primary = _build_squad(
        constraints=primary_constraints,
        pool=pool,
        prefer_differential=False,
        strategy_label="Conservative template",
        build_type="primary",
    )

    # Contrast: differential (invert ownership preference)
    contrast_constraints = constraints.model_copy(
        update={"differential_slots_target": max(constraints.differential_slots_target, 2)}
    )
    contrast = _build_squad(
        constraints=contrast_constraints,
        pool=pool,
        prefer_differential=True,
        strategy_label="Ceiling / differential",
        build_type="contrast",
    )

    tradeoff_notes = _generate_tradeoff_notes(primary, contrast, constraints)

    logger.info(
        "Generated primary (£%sm, %s diff) and contrast (£%sm, %s diff) builds.",
        primary.total_value,
        primary.squad_meta.get("differentials_in_xi"),
        contrast.total_value,
        contrast.squad_meta.get("differentials_in_xi"),
    )

    return primary, contrast, tradeoff_notes
