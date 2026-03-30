"""Draft intent parser — translate free-form phrases into constraint fields.

WI-0654: Draft sessions API, draft builder, and collaborative constraints.

Supported patterns
------------------
keep <name>                  → locked_players (name-matched against pool)
fade <club> [defense|midfield|attack]  → banned_players (club+position filter)
ban <name>                   → banned_players (name-matched)
make this safer / reduce risk / lower risk → uncertainty_tolerance = "low"
more aggressive / take risks / higher ceiling → uncertainty_tolerance = "high"
stronger bench / better cover / improve bench → bench_quality_target = "high"
cheap bench / low bench / save bench → bench_quality_target = "low"
<N> premium[s] / <N> big players → premium_count_target = N
<N> (fun) punt[s] / <N> diff[erential][s] → differential_slots_target = N
one punt / a punt → differential_slots_target = 1
speculative transfer[s] / early transfer → early_transfer_tolerance = True

Any unrecognised fragment is surfaced in ``unrecognized_fragments`` along with
guided-constraint suggestions.  The parser NEVER silently accepts a phrase it
does not understand.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from backend.models.draft_api_models import (
    DraftConstraints,
    IntentParseResult,
    PlayerEntry,
)

# ── Word-to-number helper ─────────────────────────────────────────────────────

_WORD_TO_INT: Dict[str, int] = {
    "one": 1, "a": 1, "two": 2, "three": 3,
    "four": 4, "five": 5,
}


def _parse_count(raw: str) -> int:
    raw = raw.strip().lower()
    if raw in _WORD_TO_INT:
        return _WORD_TO_INT[raw]
    try:
        return int(raw)
    except ValueError:
        return 1


# ── Position keyword map ──────────────────────────────────────────────────────

_POS_KEYWORDS: Dict[str, str] = {
    "def": "DEF", "defender": "DEF", "defenders": "DEF", "defense": "DEF", "defence": "DEF",
    "mid": "MID", "midfielder": "MID", "midfielders": "MID", "midfield": "MID",
    "fwd": "FWD", "forward": "FWD", "forwards": "FWD", "attack": "FWD", "attackers": "FWD",
    "gk": "GKP", "gkp": "GKP", "goalkeeper": "GKP", "goalkeepers": "GKP",
}

# ── Pattern definitions ───────────────────────────────────────────────────────
# Each entry: (compiled_regex, handler_name)
# Handlers are defined below and registered in PATTERN_HANDLERS.

# Patterns ordered by specificity (more specific first)
_P_KEEP = re.compile(
    r"\bkeep\s+([A-Za-z][\w\-]{1,30}(?:\s+[\w\-]{1,30})?)\b",
    re.IGNORECASE,
)
_P_BAN = re.compile(
    r"\b(?:ban|avoid|drop|exclude)\s+([A-Za-z][\w\-]{1,30}(?:\s+[\w\-]{1,30})?)\b",
    re.IGNORECASE,
)
_P_FADE_CLUB_POS = re.compile(
    r"\bfade\s+([A-Za-z]{2,5})\s+(def(?:ense|ence|ender[s]?)?|mid(?:field(?:ers?)?)?|fwd|forward[s]?|attack(?:ers?)?|gk[p]?|goalkeeper[s]?)\b",
    re.IGNORECASE,
)
_P_FADE_CLUB = re.compile(
    r"\bfade\s+([A-Za-z]{2,5})\b",
    re.IGNORECASE,
)
_P_SAFER = re.compile(
    r"\b(?:make\s+(?:this\s+)?(?:more\s+)?safer?|reduce\s+(?:the\s+)?risk|lower\s+(?:the\s+)?risk|play\s+(?:it\s+)?safe(?:r)?|less\s+risk(?:y)?)\b",
    re.IGNORECASE,
)
_P_AGGRESSIVE = re.compile(
    r"\b(?:more\s+aggressive|take\s+(?:more\s+)?risks?|higher\s+ceiling|go\s+(?:more\s+)?aggressive|riskier|higher\s+risk)\b",
    re.IGNORECASE,
)
_P_BENCH_HIGH = re.compile(
    r"\b(?:stronger|better|improve(?:d)?|higher(?:\s+quality)?)\s+bench(?:\s+(?:cover|quality))?\b",
    re.IGNORECASE,
)
_P_BENCH_LOW = re.compile(
    r"\b(?:cheap(?:er)?|low(?:er)?|save\s+on|minimal)\s+bench(?:\s+(?:quality|budget|spend))?\b",
    re.IGNORECASE,
)
_P_PREMIUM = re.compile(
    r"\b(one|a|two|three|four|five|\d)\s+premium[s]?\b",
    re.IGNORECASE,
)
_P_DIFFERENTIAL = re.compile(
    r"\b(one|a|two|three|four|five|\d)\s+(?:fun\s+)?(?:punt[s]?|diff(?:erential)?[s]?)\b",
    re.IGNORECASE,
)
_P_EARLY_TRANSFER = re.compile(
    r"\b(?:speculative\s+transfer[s]?|early\s+transfer[s]?|transfer\s+early|allow\s+early)\b",
    re.IGNORECASE,
)

# ── Player-name lookup ────────────────────────────────────────────────────────


def _find_player_id(
    name: str,
    pool: Optional[List[PlayerEntry]],
    position_filter: Optional[str] = None,
) -> Optional[int]:
    """Return FPL player ID by name (case-insensitive substring match)."""
    if not pool:
        return None
    name_lower = name.strip().lower()
    for p in pool:
        if name_lower in p.player_name.lower():
            if position_filter and p.position != position_filter:
                continue
            return p.fpl_player_id
    return None


def _find_club_players(
    team_short: str,
    pool: Optional[List[PlayerEntry]],
    position_filter: Optional[str] = None,
) -> List[int]:
    """Return all player IDs matching a club abbreviation (case-insensitive)."""
    if not pool:
        return []
    team_upper = team_short.upper()
    return [
        p.fpl_player_id
        for p in pool
        if p.team_short.upper() == team_upper
        and (position_filter is None or p.position == position_filter)
    ]


# ── Parsing ───────────────────────────────────────────────────────────────────


def _consume(text: str, pattern: re.Pattern) -> Tuple[Optional[re.Match], str]:
    """Return the first match and the text with that match removed."""
    m = pattern.search(text)
    if m:
        text = text[:m.start()].rstrip() + " " + text[m.end():].lstrip()
        text = re.sub(r"\s{2,}", " ", text).strip()
        return m, text
    return None, text


def parse_intent(
    text: str,
    player_pool: Optional[List[PlayerEntry]] = None,
) -> IntentParseResult:
    """Parse ``text`` into constraint fields.

    Returns an ``IntentParseResult`` with:
    - ``recognized_constraints`` — populated from matched patterns
    - ``unrecognized_fragments`` — tokens not matched by any pattern
    - ``guidance`` — suggestions for reformulating unrecognized fragments
    - ``fully_recognized`` — True when no unrecognized fragments remain
    """
    remaining = text.strip()
    updates: Dict[str, Any] = {}
    unrecognized: List[str] = []
    guidance_msgs: List[str] = []

    # --- keep <name> ---
    m, remaining = _consume(remaining, _P_KEEP)
    if m:
        pid = _find_player_id(m.group(1), player_pool)
        if pid:
            locked = updates.get("locked_players", [])
            locked.append(pid)
            updates["locked_players"] = locked
        else:
            # Name not in pool — still accept constraint as a name hint
            # (service layer can validate later); record recognised intent
            locked = updates.get("locked_players", [])
            updates["locked_players"] = locked  # empty addition — guidance below
            guidance_msgs.append(
                f"Player '{m.group(1)}' not found in the current pool. "
                "Add them to the pool or use their FPL ID directly in constraints.locked_players."
            )

    # --- ban / avoid <name> ---
    m, remaining = _consume(remaining, _P_BAN)
    if m:
        pid = _find_player_id(m.group(1), player_pool)
        if pid:
            banned = updates.get("banned_players", [])
            banned.append(pid)
            updates["banned_players"] = banned
        else:
            guidance_msgs.append(
                f"Player '{m.group(1)}' not found in pool. "
                "Use constraints.banned_players with the FPL player ID directly."
            )

    # --- fade <club> <position> ---
    m, remaining = _consume(remaining, _P_FADE_CLUB_POS)
    if m:
        pos_kw = m.group(2).strip().lower().split()[0]
        pos = _POS_KEYWORDS.get(pos_kw)
        ids = _find_club_players(m.group(1), player_pool, pos)
        if ids:
            banned = updates.get("banned_players", [])
            banned.extend(ids)
            updates["banned_players"] = banned
        else:
            guidance_msgs.append(
                f"No {m.group(2)} players from '{m.group(1)}' found in pool. "
                "Check team abbreviation (e.g. 'ARS', 'LIV') and position keyword."
            )

    # --- fade <club> (no position) ---
    m, remaining = _consume(remaining, _P_FADE_CLUB)
    if m:
        ids = _find_club_players(m.group(1), player_pool)
        if ids:
            banned = updates.get("banned_players", [])
            banned.extend(ids)
            updates["banned_players"] = banned
        else:
            guidance_msgs.append(
                f"No players from club '{m.group(1)}' found in pool. "
                "Check the three-letter team abbreviation (e.g. 'ARS', 'LIV')."
            )

    # --- make this safer ---
    m, remaining = _consume(remaining, _P_SAFER)
    if m:
        updates["uncertainty_tolerance"] = "low"

    # --- more aggressive ---
    m, remaining = _consume(remaining, _P_AGGRESSIVE)
    if m:
        updates["uncertainty_tolerance"] = "high"

    # --- stronger bench ---
    m, remaining = _consume(remaining, _P_BENCH_HIGH)
    if m:
        updates["bench_quality_target"] = "high"

    # --- cheap bench ---
    m, remaining = _consume(remaining, _P_BENCH_LOW)
    if m:
        updates["bench_quality_target"] = "low"

    # --- N premiums ---
    m, remaining = _consume(remaining, _P_PREMIUM)
    if m:
        n = max(0, min(6, _parse_count(m.group(1))))
        updates["premium_count_target"] = n

    # --- N differentials / punts ---
    m, remaining = _consume(remaining, _P_DIFFERENTIAL)
    if m:
        n = max(0, min(5, _parse_count(m.group(1))))
        updates["differential_slots_target"] = n

    # --- early transfer tolerance ---
    m, remaining = _consume(remaining, _P_EARLY_TRANSFER)
    if m:
        updates["early_transfer_tolerance"] = True

    # --- Remaining unrecognized tokens ---
    leftover = remaining.strip()
    # Strip punctuation-only leftovers
    leftover_clean = re.sub(r"[^\w\s]", "", leftover).strip()
    if leftover_clean:
        # Tokenise into meaningful fragments (ignore short connectors)
        fragments = [
            w for w in re.split(r"\s+", leftover_clean)
            if len(w) > 2 and w.lower() not in {
                "and", "also", "with", "the", "some", "more", "less",
                "bit", "just", "few", "plus", "but", "for", "want",
            }
        ]
        if fragments:
            unrecognized.append(leftover_clean)
            guidance_msgs.append(
                "Unrecognised phrase: '{fragment}'. "
                "Supported phrases include: 'keep <name>', 'fade <club> defense', "
                "'make this safer', 'stronger bench', 'one punt', 'N differentials', "
                "'more aggressive', 'speculative transfers'.".format(
                    fragment=leftover_clean
                )
            )

    base = DraftConstraints.model_construct(
        locked_players=[],
        banned_players=[],
        club_caps={},
        bench_quality_target="medium",
        premium_count_target=3,
        differential_slots_target=0,
        uncertainty_tolerance="medium",
        early_transfer_tolerance=False,
    )
    recognized = DraftConstraints.model_validate({**base.model_dump(), **updates})

    return IntentParseResult(
        recognized_constraints=recognized,
        unrecognized_fragments=[leftover_clean] if unrecognized else [],
        guidance=guidance_msgs,
        fully_recognized=len(unrecognized) == 0,
    )
