from datetime import datetime, timezone
from types import SimpleNamespace

import backend.routers.analyze as analyze_router
import backend.routers.user as user_router


def _job(
    analysis_id: str = "abcd1234",
    status: str = "queued",
    progress: float = 0.0,
    phase: str | None = "queued",
    results: dict | None = None,
    error: str | None = None,
):
    return SimpleNamespace(
        analysis_id=analysis_id,
        status=status,
        progress=progress,
        phase=phase,
        results=results,
        error=error,
        created_at=datetime.now(timezone.utc),
    )


def test_analyze_queues_without_usage_gate(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.cache_service, "get_cached_analysis", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(analyze_router.engine_service, "create_analysis", lambda *_args, **_kwargs: _job())

    async def _noop_task(*_args, **_kwargs):
        return None

    monkeypatch.setattr(analyze_router, "run_analysis_task", _noop_task)

    response = client.post("/api/v1/analyze", json={"team_id": 711511})
    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert "USAGE_LIMIT_REACHED" not in response.text


def test_usage_endpoint_removed(client) -> None:
    response = client.get("/api/v1/usage/711511")
    assert response.status_code == 404


def test_analyze_status_not_found(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.engine_service, "get_job", lambda _analysis_id: None)
    response = client.get("/api/v1/analyze/missing123")
    assert response.status_code == 404
    assert response.json()["code"] == "ANALYSIS_NOT_FOUND"


def test_projections_not_ready(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.engine_service, "get_job", lambda _analysis_id: _job(status="running"))
    response = client.get("/api/v1/analyze/job12345/projections")
    assert response.status_code == 425
    assert response.json()["code"] == "ANALYSIS_NOT_READY"


def test_auth_validate_token_contract_removed_by_design(client) -> None:
    response = client.post(
        "/api/v1/auth/validate-token",
        json={"clerk_token": "test_token", "discord_user_id": "123456789"},
    )
    assert response.status_code == 404


def test_planned_user_analysis_history_contract(client, monkeypatch) -> None:
    monkeypatch_data = {
        "user_id": "user_123",
        "total": 1,
        "analyses": [
            {
                "analysis_id": "analysis_1",
                "gameweek": 25,
                "created_at": "2026-02-24T10:30:00+00:00",
                "team_id": 711511,
                "recommendation_summary": "2 transfers recommended, 1 urgent",
                "captain": "Salah (9.4 pts)",
                "status": "complete",
            }
        ],
    }
    monkeypatch.setattr(
        user_router.engine_service,
        "list_user_analyses",
        lambda **_kwargs: monkeypatch_data,
    )
    response = client.get("/api/v1/user/user_123/analyses")
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "user_123"
    assert isinstance(body["analyses"], list)


def test_planned_user_performance_contract(client, monkeypatch) -> None:
    monkeypatch_data = {
        "user_id": "user_123",
        "season": "2025-26",
        "analyses_completed": 3,
        "total_points_from_recommendations": 18.5,
        "average_points_per_analysis": 6.17,
        "captain_accuracy": {"correct_predictions": 1, "total_predictions": 3, "accuracy_pct": 33.3},
        "transfer_quality": {
            "avg_points_gained_per_transfer": 1.54,
            "recommended_transfers": 12,
            "acted_on_transfers": 6,
            "adoption_rate_pct": 50.0,
        },
        "chip_strategy": {
            "benchboost_used": 1,
            "benchboost_avg_gain": 8.2,
            "triple_captain_used": 0,
            "triple_captain_avg_gain": 0.0,
        },
        "vs_average_team": {"your_avg_gw_points": 6.17, "fpl_average_gw_points": 0.0, "outperformance_pct": 0.0},
    }
    monkeypatch.setattr(
        user_router.engine_service,
        "get_user_performance",
        lambda **_kwargs: monkeypatch_data,
    )
    response = client.get("/api/v1/user/user_123/performance")
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "user_123"
    assert "transfer_quality" in body
