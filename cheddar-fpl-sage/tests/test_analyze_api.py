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
    cached_payload = {
        "team_name": "Cached Team",
        "manager_name": "AJ",
        "manager_state": {
            "risk_posture": "BALANCED",
            "strategy_mode": "BALANCED",
            "free_transfers": 1,
        },
        "fixture_planner": {
            "gw_timeline": [],
            "squad_windows": [],
            "target_windows": [],
            "key_planning_notes": [],
        },
        "starting_xi": [{"name": "Starter", "price": 5.0}],
    }
    monkeypatch.setattr(
        analyze_router.cache_service,
        "get_cached_analysis",
        lambda *_args, **_kwargs: cached_payload,
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


def test_get_analysis_status_contract_uses_canonical_cards(client, monkeypatch) -> None:
    canonical_results = {
        "current_gw": 31,
        "gameweek_plan": {
            "version": "v1",
            "summary": "Roll transfer and maintain optionality.",
            "highlights": [],
            "metrics": {
                "primary_action": "ROLL",
                "justification": "No transfer clears threshold this week.",
                "gameweek": 31,
            },
        },
        "transfer_recommendation": {
            "version": "v1",
            "summary": "Primary move improves midfield slot.",
            "highlights": [],
            "metrics": {
                "transfer_plans": {
                    "primary": {
                        "out": "Player A",
                        "in": "Player B",
                        "hit_cost": 0,
                        "net_cost": 1.2,
                        "delta_pts_4gw": 3.4,
                        "reason": "Fixture swing",
                        "confidence": "HIGH",
                    }
                }
            },
        },
        "captaincy": {
            "version": "v1",
            "summary": "Captaincy setup stable.",
            "highlights": [],
            "metrics": {
                "captain": {"name": "Salah", "expected_pts": 8.2},
                "vice_captain": {"name": "Saka", "expected_pts": 6.8},
            },
        },
        "chip_strategy": {
            "version": "v1",
            "summary": "No chip this week.",
            "highlights": [],
            "metrics": {
                "verdict": "NONE",
                "status": "PASS",
                "explanation": "Hold for future doubles.",
                "available_chips": ["bench_boost", "free_hit"],
                "recommendation": {
                    "best_gw": 34,
                    "opportunity_cost": {
                        "current_value": 3.1,
                        "best_value": 6.0,
                        "delta": 2.9,
                    },
                },
            },
        },
        "squad_state": {
            "version": "v1",
            "summary": "Squad health is stable.",
            "highlights": [],
            "metrics": {
                "squad_health": {"injured": 0, "doubtful": 1, "health_pct": 93},
                "bench_warning": {"warning_message": "One weak bench slot"},
            },
        },
        "decision_confidence": {
            "version": "v1",
            "confidence": "MEDIUM",
            "score": 74,
            "rationale": "Baseline confidence.",
            "signals": ["fixture_swing"],
        },
    }
    monkeypatch.setattr(
        analyze_router.engine_service,
        "get_job",
        lambda _analysis_id: _job(status="complete", progress=100.0, phase="completed", results=canonical_results),
    )

    response = client.get("/api/v1/analyze/job-canonical-01")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "complete"
    assert body["gameweek"] == 31
    assert body["transfer_recommendations"]
    assert body["captain_recommendation"]["primary"]["player_name"] == "Salah"
    assert body["chip_strategy"]["bench_boost"]["available"] is True


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
