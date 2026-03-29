"""
Fixture difficulty helpers for late-season FPL run-in analysis.
"""

from __future__ import annotations

from typing import Any, Dict, List, Tuple

import aiohttp

FPL_API_BASE_URL = "https://fantasy.premierleague.com/api"
EASY_FDR_MAX = 2
HARD_FDR_MIN = 4
DEFAULT_WINDOW = 6


async def _fetch_json(session: aiohttp.ClientSession, endpoint: str) -> Any:
    url = f"{FPL_API_BASE_URL}{endpoint}"
    async with session.get(url) as response:
        response.raise_for_status()
        return await response.json()


def get_current_gw(bootstrap_data: Dict[str, Any]) -> int:
    """Return the current gameweek, falling back to the next scheduled event."""
    events = bootstrap_data.get("events") or []

    for event in events:
        if event.get("is_current"):
            return int(event.get("id") or 1)

    for event in events:
        if event.get("is_next"):
            return int(event.get("id") or 1)

    return 1


async def fetch_fixtures_and_bootstrap(
    session: aiohttp.ClientSession,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    """Fetch FPL fixtures and bootstrap payloads in a shared session."""
    fixtures = await _fetch_json(session, "/fixtures/")
    bootstrap = await _fetch_json(session, "/bootstrap-static/")
    return list(fixtures or []), dict(bootstrap or {})


def compute_run_in_fdr(
    player_id: int,
    team_id: int,
    fixtures: List[Dict[str, Any]],
    current_gw: int,
    window: int = DEFAULT_WINDOW,
) -> Dict[str, float | int]:
    """
    Compute easy/hard counts plus average FDR for the next N gameweeks.

    `player_id` is accepted for interface stability even though the current
    calculation is team-fixture based.
    """
    del player_id

    upper_gw = int(current_gw) + max(int(window or 0), 0)
    difficulties: List[float] = []

    for fixture in fixtures or []:
        event = fixture.get("event")
        if event is None:
            continue

        try:
            event_gw = int(event)
        except (TypeError, ValueError):
            continue

        if event_gw <= int(current_gw) or event_gw > upper_gw:
            continue

        if fixture.get("team_h") == team_id:
            raw_difficulty = fixture.get("team_h_difficulty")
        elif fixture.get("team_a") == team_id:
            raw_difficulty = fixture.get("team_a_difficulty")
        else:
            continue

        try:
            difficulties.append(float(raw_difficulty))
        except (TypeError, ValueError):
            continue

    easy_gws = sum(1 for difficulty in difficulties if difficulty <= EASY_FDR_MAX)
    hard_gws = sum(1 for difficulty in difficulties if difficulty >= HARD_FDR_MIN)
    avg_fdr = round(sum(difficulties) / len(difficulties), 2) if difficulties else 0.0

    return {
        "easy_gws": easy_gws,
        "hard_gws": hard_gws,
        "avg_fdr": avg_fdr,
    }
