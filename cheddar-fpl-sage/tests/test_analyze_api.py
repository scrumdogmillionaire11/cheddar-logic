from datetime import datetime, timezone
from types import SimpleNamespace

import backend.routers.analyze as analyze_router


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


def test_post_analyze_queues_job_without_usage_gate(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.cache_service, "get_cached_analysis", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(analyze_router.engine_service, "create_analysis", lambda *_args, **_kwargs: _job())

    async def _noop_task(*_args, **_kwargs):
        return None

    monkeypatch.setattr(analyze_router, "run_analysis_task", _noop_task)

    response = client.post("/api/v1/analyze", json={"team_id": 711511})

    assert response.status_code == 202
    body = response.json()
    assert body["analysis_id"] == "abcd1234"
    assert body["status"] == "queued"
    assert body["team_id"] == 711511
    assert body["estimated_duration_seconds"] > 0


def test_post_analyze_can_return_cached_result(client, monkeypatch) -> None:
    monkeypatch.setattr(
        analyze_router.cache_service,
        "get_cached_analysis",
        lambda *_args, **_kwargs: {"team_name": "Cached Team"},
    )

    response = client.post("/api/v1/analyze", json={"team_id": 711511})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["cached"] is True
    assert "analysis_id" in body


def test_post_analyze_rejects_invalid_team_id(client) -> None:
    response = client.post("/api/v1/analyze", json={"team_id": 0})
    assert response.status_code == 422


def test_get_analysis_status_not_found(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.engine_service, "get_job", lambda _analysis_id: None)

    response = client.get("/api/v1/analyze/missing123")
    assert response.status_code == 404
    assert response.json()["code"] == "ANALYSIS_NOT_FOUND"


def test_get_analysis_status_completed(client, monkeypatch) -> None:
    monkeypatch.setattr(
        analyze_router.engine_service,
        "get_job",
        lambda _analysis_id: _job(status="completed", progress=100.0, phase="completed", results={"ok": True}),
    )

    response = client.get("/api/v1/analyze/job12345")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert body["results"] == {"ok": True}


def test_post_interactive_analysis_accepts_overrides(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.engine_service, "create_analysis", lambda *_args, **_kwargs: _job())

    async def _noop_task(*_args, **_kwargs):
        return None

    monkeypatch.setattr(analyze_router, "run_analysis_task", _noop_task)

    payload = {
        "team_id": 711511,
        "free_transfers": 2,
        "risk_posture": "balanced",
        "injury_overrides": [{"player_name": "Haaland", "status": "DOUBTFUL", "chance": 50}],
    }
    response = client.post("/api/v1/analyze/interactive", json=payload)

    assert response.status_code == 202
    body = response.json()
    assert body["status"] == "queued"
    assert body["team_id"] == 711511
    assert body["estimated_duration_seconds"] > 0


def test_get_projections_returns_425_when_not_completed(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.engine_service, "get_job", lambda _analysis_id: _job(status="running"))

    response = client.get("/api/v1/analyze/job12345/projections")
    assert response.status_code == 425
    assert response.json()["code"] == "ANALYSIS_NOT_READY"


def test_get_projections_returns_completed_payload(client, monkeypatch) -> None:
    monkeypatch.setattr(
        analyze_router.engine_service,
        "get_job",
        lambda _analysis_id: _job(
            status="completed",
            results={
                "team_name": "FPL XI",
                "manager_name": "AJ",
                "current_gw": 25,
                "primary_decision": "HOLD",
                "confidence": "HIGH",
                "reasoning": "No transfer exceeds threshold",
                "transfer_recommendations": [],
                "starting_xi": [],
                "bench": [],
                "risk_scenarios": [],
                "available_chips": [],
            },
        ),
    )

    response = client.get("/api/v1/analyze/job12345/projections")
    assert response.status_code == 200
    body = response.json()
    assert body["team_name"] == "FPL XI"
    assert body["primary_decision"] == "HOLD"


def test_usage_endpoint_removed(client) -> None:
    response = client.get("/api/v1/usage/711511")
    assert response.status_code == 404


def test_analyze_no_usage_limit_rejection(client, monkeypatch) -> None:
    monkeypatch.setattr(analyze_router.cache_service, "get_cached_analysis", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(analyze_router.engine_service, "create_analysis", lambda *_args, **_kwargs: _job())

    async def _noop_task(*_args, **_kwargs):
        return None

    monkeypatch.setattr(analyze_router, "run_analysis_task", _noop_task)

    response = client.post("/api/v1/analyze", json={"team_id": 711511})
    assert response.status_code == 202
    assert "USAGE_LIMIT_REACHED" not in response.text
