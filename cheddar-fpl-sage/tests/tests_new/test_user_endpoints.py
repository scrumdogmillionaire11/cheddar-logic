import backend.routers.user as user_router


def test_user_analyses_endpoint_forwards_query_params(client, monkeypatch):
    captured = {}

    def _fake_list_user_analyses(**kwargs):
        captured.update(kwargs)
        return {"user_id": "user_123", "total": 0, "analyses": []}

    monkeypatch.setattr(user_router.engine_service, "list_user_analyses", _fake_list_user_analyses)

    response = client.get(
        "/api/v1/user/user_123/analyses?limit=10&offset=5&season=2025-26&sort_by=gameweek"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "user_123"
    assert body["analyses"] == []
    assert captured == {
        "user_id": "user_123",
        "limit": 10,
        "offset": 5,
        "season": "2025-26",
        "sort_by": "gameweek",
    }


def test_user_analyses_limit_validation(client):
    response = client.get("/api/v1/user/user_123/analyses?limit=101")
    assert response.status_code == 422


def test_user_performance_endpoint_include_details(client, monkeypatch):
    captured = {}

    def _fake_get_user_performance(**kwargs):
        captured.update(kwargs)
        return {
            "user_id": "user_123",
            "season": "2025-26",
            "analyses_completed": 0,
            "total_points_from_recommendations": 0.0,
            "average_points_per_analysis": 0.0,
            "captain_accuracy": {"correct_predictions": 0, "total_predictions": 0, "accuracy_pct": 0.0},
            "transfer_quality": {
                "avg_points_gained_per_transfer": 0.0,
                "recommended_transfers": 0,
                "acted_on_transfers": 0,
                "adoption_rate_pct": 0.0,
            },
            "chip_strategy": {
                "benchboost_used": 0,
                "benchboost_avg_gain": 0.0,
                "triple_captain_used": 0,
                "triple_captain_avg_gain": 0.0,
            },
            "vs_average_team": {
                "your_avg_gw_points": 0.0,
                "fpl_average_gw_points": 0.0,
                "outperformance_pct": 0.0,
            },
            "details": [],
        }

    monkeypatch.setattr(user_router.engine_service, "get_user_performance", _fake_get_user_performance)

    response = client.get("/api/v1/user/user_123/performance?season=2025-26&include_details=true")
    assert response.status_code == 200
    body = response.json()
    assert body["user_id"] == "user_123"
    assert "details" in body
    assert captured == {
        "user_id": "user_123",
        "season": "2025-26",
        "include_details": True,
    }
