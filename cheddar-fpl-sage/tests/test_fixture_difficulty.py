from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.routers import advisor as advisor_router_module
from backend.services.result_transformer import _transform_projection
from cheddar_fpl_sage.analysis.decision_framework.captain_selector import CaptainSelector
from cheddar_fpl_sage.analysis.fixture_difficulty import (
    DEFAULT_WINDOW,
    compute_run_in_fdr,
    fetch_fixtures_and_bootstrap,
    get_current_gw,
)
from cheddar_fpl_sage.models.canonical_projections import CanonicalPlayerProjection


FIXTURE_DATA = [
    {"id": 1, "event": 30, "team_h": 99, "team_a": 1, "team_h_difficulty": 2, "team_a_difficulty": 4},
    {"id": 2, "event": 31, "team_h": 1, "team_a": 3, "team_h_difficulty": 2, "team_a_difficulty": 4},
    {"id": 3, "event": 32, "team_h": 4, "team_a": 1, "team_h_difficulty": 3, "team_a_difficulty": 2},
    {"id": 4, "event": 33, "team_h": 1, "team_a": 5, "team_h_difficulty": 4, "team_a_difficulty": 2},
    {"id": 5, "event": 34, "team_h": 6, "team_a": 1, "team_h_difficulty": 2, "team_a_difficulty": 4},
    {"id": 6, "event": 38, "team_h": 1, "team_a": 7, "team_h_difficulty": 1, "team_a_difficulty": 5},
    {"id": 7, "event": None, "team_h": 1, "team_a": 8, "team_h_difficulty": 2, "team_a_difficulty": 4},
]

BOOTSTRAP_DATA = {
    "events": [
        {"id": 29, "is_current": False, "is_next": False},
        {"id": 30, "is_current": True, "is_next": False},
        {"id": 31, "is_current": False, "is_next": True},
    ]
}


def _projection(player_id: int, name: str, run_in_fdr: dict | None = None):
    data = {
        "player_id": player_id,
        "name": name,
        "position": "MID",
        "team": "LIV",
        "nextGW_pts": 8.5,
        "ownership_pct": 20.0,
        "xMins_next": 90.0,
        "floor": 6.0,
        "ceiling": 11.0,
    }
    if run_in_fdr is not None:
        data["run_in_fdr"] = run_in_fdr
    return SimpleNamespace(**data)


def test_compute_run_in_fdr_counts_easy_hard_and_average() -> None:
    result = compute_run_in_fdr(
        player_id=101,
        team_id=1,
        fixtures=FIXTURE_DATA,
        current_gw=30,
        window=6,
    )

    assert result == {"easy_gws": 2, "hard_gws": 2, "avg_fdr": 3.0}


def test_compute_run_in_fdr_respects_window_and_missing_fixtures() -> None:
    short_window = compute_run_in_fdr(
        player_id=101,
        team_id=1,
        fixtures=FIXTURE_DATA,
        current_gw=30,
        window=3,
    )
    no_fixtures = compute_run_in_fdr(
        player_id=101,
        team_id=42,
        fixtures=FIXTURE_DATA,
        current_gw=30,
        window=DEFAULT_WINDOW,
    )

    assert short_window == {"easy_gws": 2, "hard_gws": 1, "avg_fdr": 2.67}
    assert no_fixtures == {"easy_gws": 0, "hard_gws": 0, "avg_fdr": 0.0}


def test_get_current_gw_prefers_current_then_next() -> None:
    assert get_current_gw(BOOTSTRAP_DATA) == 30
    assert get_current_gw({"events": [{"id": 31, "is_current": False, "is_next": True}]}) == 31
    assert get_current_gw({"events": []}) == 1


@pytest.mark.asyncio
async def test_fetch_fixtures_and_bootstrap_returns_both_payloads() -> None:
    def make_cm(payload):
        response = MagicMock()
        response.raise_for_status = MagicMock()
        response.json = AsyncMock(return_value=payload)

        context_manager = MagicMock()
        context_manager.__aenter__ = AsyncMock(return_value=response)
        context_manager.__aexit__ = AsyncMock(return_value=False)
        return context_manager

    session = MagicMock()
    session.get.side_effect = [make_cm(FIXTURE_DATA), make_cm(BOOTSTRAP_DATA)]

    fixtures, bootstrap = await fetch_fixtures_and_bootstrap(session)

    assert fixtures == FIXTURE_DATA
    assert bootstrap == BOOTSTRAP_DATA


def test_transform_projection_preserves_fixture_difficulty() -> None:
    projection = CanonicalPlayerProjection(
        player_id=1,
        name="Salah",
        position="MID",
        team="Liverpool",
        current_price=13.5,
        nextGW_pts=9.2,
        next6_pts=55.0,
        xMins_next=88.0,
        volatility_score=0.3,
        ceiling=14.0,
        floor=5.0,
        tags=["favorable_fixture"],
        confidence=0.85,
        ownership_pct=45.3,
        captaincy_rate=12.5,
        fixture_difficulty=2,
    )

    transformed = _transform_projection(projection)

    assert transformed["fixture_difficulty"] == 2


def test_captain_selector_appends_run_in_flags_for_dict_players() -> None:
    selector = CaptainSelector()
    team_data = {
        "current_squad": [
            {
                "name": "Salah",
                "team": "LIV",
                "position": "MID",
                "total_points": 12.0,
                "ownership": 55.0,
                "is_starter": True,
                "status_flag": "FIT",
                "run_in_fdr": {"avg_fdr": 2.1},
            },
            {
                "name": "Palmer",
                "team": "CHE",
                "position": "MID",
                "total_points": 11.0,
                "ownership": 25.0,
                "is_starter": True,
                "status_flag": "FIT",
                "run_in_fdr": {"avg_fdr": 3.9},
            },
        ]
    }

    result = selector.recommend_captaincy(team_data, fixture_data={})

    assert "EASY_RUN" in result["captain"]["rationale"]
    assert "HARD_RUN" in result["vice_captain"]["rationale"]


def test_captain_selector_appends_run_in_flags_for_object_players() -> None:
    selector = CaptainSelector()
    selector.strategy_mode = "BALANCED"
    optimized_xi = SimpleNamespace(
        get_captain_options=lambda: [
            _projection(10, "Salah", {"avg_fdr": 2.0}),
            _projection(11, "Palmer", {"avg_fdr": 3.8}),
        ]
    )

    result = selector.recommend_captaincy_from_xi(optimized_xi, fixture_data={})

    assert "EASY_RUN" in result["captain"]["rationale"]
    assert "HARD_RUN" in result["vice_captain"]["rationale"]


def test_advisor_endpoint_returns_run_in_fdr(client, monkeypatch) -> None:
    class DummySession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    async def fake_fetch(_session):
        return FIXTURE_DATA, BOOTSTRAP_DATA

    monkeypatch.setattr(advisor_router_module, "fetch_fixtures_and_bootstrap", fake_fetch)
    monkeypatch.setattr(advisor_router_module.aiohttp, "ClientSession", DummySession)

    response = client.get("/api/advisor", params={"player_id": 101, "team_id": 1, "window": 6})

    assert response.status_code == 200
    assert response.json() == {
        "player_id": 101,
        "team_id": 1,
        "current_gw": 30,
        "window": 6,
        "run_in_fdr": {"easy_gws": 2, "hard_gws": 2, "avg_fdr": 3.0},
    }
