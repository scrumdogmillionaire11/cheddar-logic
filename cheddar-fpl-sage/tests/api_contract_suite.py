from datetime import datetime, timezone
from types import SimpleNamespace
import importlib
import os
import sys
from pathlib import Path

import backend.routers.analyze as analyze_router
import backend.routers.user as user_router
import backend.services.result_transformer as result_transformer


def _load_result_transformer():
    """Reload if present, otherwise import a fresh module after test-side eviction."""
    module_name = "backend.services.result_transformer"
    module = sys.modules.get(module_name)
    if module is None:
        return importlib.import_module(module_name)
    return importlib.reload(module)


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


def test_analyze_skips_legacy_cached_payload_and_runs_fresh(client, monkeypatch) -> None:
    stale_cached_payload = {
        "team_name": "FPL XI",
        "manager_name": "Unknown Manager",
        "primary_decision": "HOLD",
        "starting_xi": [{"name": "A", "price": None}],
        # Missing manager_state + fixture_planner contract fields.
    }
    captured = {}

    def _create_analysis(team_id, gameweek=None, overrides=None):
        captured["team_id"] = team_id
        captured["gameweek"] = gameweek
        captured["overrides"] = overrides or {}
        return _job(status="queued")

    async def _noop_task(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        analyze_router.cache_service,
        "get_cached_analysis",
        lambda *_args, **_kwargs: stale_cached_payload,
    )
    monkeypatch.setattr(analyze_router.engine_service, "create_analysis", _create_analysis)
    monkeypatch.setattr(analyze_router, "run_analysis_task", _noop_task)

    response = client.post("/api/v1/analyze", json={"team_id": 711511})

    assert response.status_code == 202
    assert response.json()["status"] == "queued"
    assert captured["team_id"] == 711511


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


def test_projections_failed_analysis_returns_explicit_failed_error() -> None:
    analyze_source_path = Path(__file__).resolve().parents[1] / "backend" / "routers" / "analyze.py"
    analyze_source = analyze_source_path.read_text()
    assert 'if str(job.status).lower() == "failed":' in analyze_source
    assert "status_code=status.HTTP_500_INTERNAL_SERVER_ERROR" in analyze_source
    assert '"code": "ANALYSIS_FAILED"' in analyze_source
    assert '"error": "Analysis failed"' in analyze_source


def test_projections_accepts_player_rows_without_price(client, monkeypatch) -> None:
    results = {
        "team_name": "FPL XI",
        "manager_name": "AJ",
        "current_gw": 29,
        "overall_rank": 6448179,
        "overall_points": 1440,
        "primary_decision": "HOLD",
        "confidence": "MEDIUM",
        "reasoning": "Test payload",
        "starting_xi": [
            {
                "player_id": 628,
                "name": "Jose Sa",
                "team": "WOL",
                "position": "GK",
                "expected_pts": 4.5,
            }
        ],
        "bench": [
            {
                "player_id": 32,
                "name": "Martinez",
                "team": "AVL",
                "position": "GK",
                "expected_pts": 3.9,
            }
        ],
        "projected_xi": [
            {
                "player_id": 628,
                "name": "Jose Sa",
                "team": "WOL",
                "position": "GK",
                "expected_pts": 4.5,
            }
        ],
        "projected_bench": [
            {
                "player_id": 32,
                "name": "Martinez",
                "team": "AVL",
                "position": "GK",
                "expected_pts": 3.9,
            }
        ],
        "transfer_recommendations": [],
        "risk_scenarios": [],
        "available_chips": [],
    }
    monkeypatch.setattr(
        analyze_router.engine_service,
        "get_job",
        lambda _analysis_id: _job(status="complete", results=results),
    )

    response = client.get("/api/v1/analyze/job12345/projections")
    assert response.status_code == 200
    body = response.json()
    assert body["starting_xi_projections"][0]["name"] == "Jose Sa"
    assert body["starting_xi_projections"][0]["price"] is None


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


def test_analyze_forwards_risk_and_transfer_overrides(client, monkeypatch) -> None:
    captured = {}

    def _create_analysis(team_id, gameweek=None, overrides=None):
        captured["team_id"] = team_id
        captured["gameweek"] = gameweek
        captured["overrides"] = overrides or {}
        return _job(status="queued")

    async def _noop_task(*_args, **_kwargs):
        return None

    monkeypatch.setattr(analyze_router.cache_service, "get_cached_analysis", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(analyze_router.engine_service, "create_analysis", _create_analysis)
    monkeypatch.setattr(analyze_router, "run_analysis_task", _noop_task)

    response = client.post(
        "/api/v1/analyze",
        json={
            "team_id": 711511,
            "risk_posture": "aggressive",
            "free_transfers": 2,
        },
    )

    assert response.status_code == 202
    assert captured["team_id"] == 711511
    assert captured["overrides"]["risk_posture"] == "aggressive"
    assert captured["overrides"]["free_transfers"] == 2


def test_effective_context_resolution_prefers_api_overrides() -> None:
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
    for module_name in list(sys.modules):
        if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
            del sys.modules[module_name]

    from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration

    integration = FPLSageIntegration.__new__(FPLSageIntegration)
    integration.config = {"manual_overrides": {"free_transfers": 1}, "risk_posture": "CONSERVATIVE"}
    integration.config_manager = SimpleNamespace(get_risk_posture=lambda: "BALANCED")
    integration.decision_framework = SimpleNamespace(
        risk_posture="BALANCED",
        _transfer_advisor=SimpleNamespace(risk_posture="BALANCED"),
        _captain_selector=SimpleNamespace(risk_posture="BALANCED"),
        _chip_analyzer=SimpleNamespace(risk_posture="BALANCED"),
    )

    team_data = {"team_info": {"overall_rank": 6_448_179, "free_transfers": 0}}
    context = integration._resolve_effective_decision_context(
        team_data,
        overrides={"risk_posture": "aggressive", "free_transfers": 2},
    )

    assert context["risk_posture"] == "AGGRESSIVE"
    assert context["free_transfers"] == 2
    assert context["strategy_mode_hint"] == "RECOVERY"
    assert team_data["team_info"]["risk_posture"] == "AGGRESSIVE"
    assert team_data["team_info"]["free_transfers"] == 2


def test_transformer_backfills_manager_state_with_rank_aware_strategy() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "ROLL",
                "decision_status": "HOLD",
                "reasoning": "No transfer met threshold.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 6.0},
                },
                "risk_scenarios": [],
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 0,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 29,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(
        raw_results,
        overrides={"risk_posture": "aggressive", "free_transfers": 2},
    )

    assert transformed["risk_posture"] == "AGGRESSIVE"
    assert transformed["manager_state"]["risk_posture"] == "AGGRESSIVE"
    assert transformed["manager_state"]["free_transfers"] == 2
    assert transformed["manager_state"]["rank_bucket"] == "recovery"
    assert transformed["manager_state"]["strategy_mode"] == "RECOVERY"


def test_transformer_rewrites_no_free_transfer_reason_when_ft_override_positive() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No free transfers and no chip passes the strategic windows/risk gates.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 6.0},
                },
                "risk_scenarios": [],
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 0,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 29,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(
        raw_results,
        overrides={"risk_posture": "aggressive", "free_transfers": 2},
    )

    assert transformed["primary_decision"] == "NO_CHIP_ACTION"
    assert transformed["free_transfers"] == 2
    assert transformed["manager_state"]["free_transfers"] == 2
    assert "No free transfers" not in transformed["reasoning"]
    assert "2 free transfers available" in transformed["reasoning"]
    assert "No free transfers" not in transformed["transfer_plans"]["no_transfer_reason"]


def test_transformer_rebuilds_fixture_planner_from_fixture_horizon_context() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No chip passes strategic windows this gameweek.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.6},
                },
                "risk_scenarios": [],
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 29,
                "fixture_horizon_context": {
                    "start_gw": 29,
                    "horizon_gws": 8,
                    "gw_timeline": [
                        {
                            "gw": 29,
                            "dgw_teams": ["MCI"],
                            "bgw_teams": [],
                            "fixture_count_total": 10,
                        }
                    ],
                    "squad_player_windows": [
                        {
                            "name": "Salah",
                            "team": "LIV",
                            "summary": {
                                "dgw_count": 1,
                                "bgw_count": 0,
                                "next_dgw_gw": 29,
                                "weighted_fixture_score": 3.2,
                            },
                            "upcoming": [],
                        }
                    ],
                    "candidate_player_windows": [
                        {
                            "name": "Haaland",
                            "team": "MCI",
                            "summary": {
                                "dgw_count": 1,
                                "bgw_count": 0,
                                "next_dgw_gw": 29,
                                "weighted_fixture_score": 3.5,
                            },
                            "upcoming": [],
                        }
                    ],
                    "key_planning_notes": ["Target DGW attackers in GW29."],
                },
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})

    planner = transformed["fixture_planner"]
    assert planner is not None
    assert planner["start_gw"] == 29
    assert planner["horizon_gws"] == 8
    assert planner["gw_timeline"][0]["gw"] == 29
    assert planner["squad_windows"][0]["name"] == "Salah"
    assert planner["target_windows"][0]["name"] == "Haaland"
    assert planner["key_planning_notes"][0] == "Target DGW attackers in GW29."


def test_transformer_emits_deterministic_minimal_fixture_planner_when_sparse() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No chip passes strategic windows this gameweek.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.6},
                },
                "risk_scenarios": [],
                "fixture_planner": {},
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 31,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})

    planner = transformed["fixture_planner"]
    assert planner is not None
    assert planner["horizon_gws"] == 8
    assert planner["start_gw"] == 31
    assert planner["gw_timeline"] == []
    assert planner["squad_windows"] == []
    assert planner["target_windows"] == []
    assert planner["key_planning_notes"] == []


def test_transformer_surfaces_section_specific_reason_fields_when_empty() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No chip passes strategic windows this gameweek.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.6},
                },
                "risk_scenarios": [],
                "near_threshold_moves": [],
                "near_threshold_reason": "No near-threshold moves: no viable alternatives this week.",
                "strategy_paths": {},
                "strategy_paths_reason": "Strategy paths unavailable: no viable transfer alternatives across starting XI.",
                "fixture_planner": {},
                "fixture_planner_reason": "Fixture planner limited: missing fixtures, teams, players.",
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 31,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            },
            "fixtures": [],
            "teams": [],
            "players": [],
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})

    assert transformed["near_threshold_reason"] == "No near-threshold moves: no viable alternatives this week."
    assert transformed["strategy_paths_reason"] == (
        "Strategy paths unavailable: no viable transfer alternatives across starting XI."
    )
    assert transformed["fixture_planner_reason"] == "Fixture planner limited: missing fixtures, teams, players."


def test_transformer_clears_reason_fields_when_section_has_content() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No chip passes strategic windows this gameweek.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.6},
                },
                "risk_scenarios": [],
                "near_threshold_moves": [{"out": "A", "in": "B"}],
                "near_threshold_reason": "should be cleared",
                "strategy_paths": {"safe": {"out": "C", "in": "D"}},
                "strategy_paths_reason": "should be cleared",
                "fixture_planner_reason": "should be cleared",
                "fixture_planner": {
                    "horizon_gws": 8,
                    "start_gw": 31,
                    "gw_timeline": [{"gw": 31, "dgw_teams": [], "bgw_teams": [], "fixture_count_total": 10}],
                    "squad_windows": [],
                    "target_windows": [],
                    "key_planning_notes": [],
                },
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 31,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            },
            "fixtures": [{"id": 1, "event": 31, "team_h": 1, "team_a": 2}],
            "teams": [{"id": 1, "short_name": "AAA"}, {"id": 2, "short_name": "BBB"}],
            "players": [{"id": 101, "web_name": "Alpha", "team": 1}],
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})

    assert transformed["near_threshold_reason"] is None
    assert transformed["strategy_paths_reason"] is None
    assert transformed["fixture_planner_reason"] is None


def test_transformer_strategy_sanitizer_is_id_first_for_duplicate_names() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No chip passes strategic windows this gameweek.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.6},
                },
                "risk_scenarios": [],
                "strategy_paths": {
                    "safe": {
                        "out": "Starter One",
                        "in": "Alex",
                        "out_player_id": 201,
                        "in_player_id": 900,
                        "delta_pts_4gw": 5.2,
                    }
                },
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 31,
                "current_squad": [
                    {"player_id": 201, "name": "Starter One"},
                    {"player_id": 101, "name": "Alex"},
                ],
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})
    safe_path = transformed["strategy_paths"]["safe"]

    assert safe_path is not None
    assert safe_path["in"] == "Alex"
    assert safe_path["in_player_id"] == 900


def test_transformer_normalizes_malformed_planner_payload_to_numeric_safe_shape() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "NO_CHIP_ACTION",
                "decision_status": "PASS",
                "reasoning": "No chip passes strategic windows this gameweek.",
                "transfer_recommendations": [],
                "captaincy": {
                    "captain": {"name": "Player A", "expected_pts": 6.0},
                    "vice_captain": {"name": "Player B", "expected_pts": 5.6},
                },
                "risk_scenarios": [],
                "fixture_planner": {
                    "horizon_gws": "8",
                    "start_gw": "31",
                    "gw_timeline": [
                        {
                            "gw": "31",
                            "dgw_teams": "MCI",
                            "bgw_teams": None,
                            "fixture_count_total": "bad",
                        }
                    ],
                    "squad_windows": [
                        {
                            "player_id": "oops",
                            "name": "Salah",
                            "team": "LIV",
                            "summary": {
                                "dgw_count": "x",
                                "bgw_count": None,
                                "next_dgw_gw": "NaN",
                                "next_bgw_gw": "",
                                "weighted_fixture_score": "nan",
                            },
                            "upcoming": [
                                {
                                    "gw": "32",
                                    "fixture_count": "two",
                                    "is_blank": "yes",
                                    "is_double": "no",
                                    "opponents": "ARS",
                                    "avg_difficulty": "nan",
                                }
                            ],
                        }
                    ],
                    "target_windows": [
                        {
                            "name": "Haaland",
                            "team": "MCI",
                            "summary": None,
                            "upcoming": None,
                        }
                    ],
                    "key_planning_notes": [None, 123],
                },
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 31,
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})
    planner = transformed["fixture_planner"]

    assert planner["start_gw"] == 31
    assert planner["horizon_gws"] == 8
    assert isinstance(planner["gw_timeline"], list) and len(planner["gw_timeline"]) == 1
    assert planner["gw_timeline"][0]["dgw_teams"] == []
    assert planner["gw_timeline"][0]["bgw_teams"] == []
    assert planner["gw_timeline"][0]["fixture_count_total"] == 0

    assert isinstance(planner["squad_windows"], list) and len(planner["squad_windows"]) == 1
    squad_window = planner["squad_windows"][0]
    assert squad_window["player_id"] is None
    assert squad_window["summary"]["dgw_count"] == 0
    assert squad_window["summary"]["bgw_count"] == 0
    assert squad_window["summary"]["next_dgw_gw"] is None
    assert squad_window["summary"]["weighted_fixture_score"] == 0.0
    assert isinstance(squad_window["upcoming"], list) and len(squad_window["upcoming"]) == 1
    assert squad_window["upcoming"][0]["fixture_count"] == 0
    assert squad_window["upcoming"][0]["is_blank"] is True
    assert squad_window["upcoming"][0]["is_double"] is False
    assert squad_window["upcoming"][0]["opponents"] == []
    assert squad_window["upcoming"][0]["avg_difficulty"] == 0.0

    assert isinstance(planner["target_windows"], list) and len(planner["target_windows"]) == 1
    target_window = planner["target_windows"][0]
    assert target_window["summary"]["weighted_fixture_score"] == 0.0
    assert target_window["upcoming"] == []


def test_projections_accepts_null_expected_points_and_lineup_contract_fields(client, monkeypatch) -> None:
    results = {
        "team_name": "FPL XI",
        "manager_name": "AJ",
        "current_gw": 29,
        "overall_rank": 6448179,
        "overall_points": 1440,
        "primary_decision": "HOLD",
        "confidence": "MEDIUM",
        "reasoning": "Test payload",
        "starting_xi": [
            {
                "player_id": 628,
                "name": "Jose Sa",
                "team": "WOL",
                "position": "GK",
                "expected_pts": None,
            }
        ],
        "bench": [
            {
                "player_id": 32,
                "name": "Martinez",
                "team": "AVL",
                "position": "GK",
                "expected_pts": None,
            }
        ],
        "lineup_decision": {
            "formation": "3-4-3",
            "risk_profile": "BALANCED",
            "lineup_confidence": "MEDIUM",
            "formation_reason": "Best expected points aggregate.",
            "notes": [],
            "starters": [],
            "bench": [],
            "captain_player_id": None,
            "vice_captain_player_id": None,
        },
        "projected_xi": [],
        "projected_bench": [],
        "transfer_recommendations": [],
        "risk_scenarios": [],
        "available_chips": [],
    }
    monkeypatch.setattr(
        analyze_router.engine_service,
        "get_job",
        lambda _analysis_id: _job(status="complete", results=results),
    )

    response = client.get("/api/v1/analyze/job12345/projections")
    assert response.status_code == 200
    body = response.json()
    assert body["starting_xi_projections"][0]["expected_pts"] is None
    assert body["lineup_decision"]["captain_player_id"] is None


def test_transformer_lineup_decision_preserves_price_and_ownership_from_squad_meta() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "risk_posture": "BALANCED",
                "primary_decision": "HOLD",
                "decision_status": "HOLD",
                "reasoning": "Hold for now.",
                "transfer_recommendations": [],
                "captaincy": {},
                "risk_scenarios": [],
                "lineup_decision": {
                    "formation": "3-4-3",
                    "risk_profile": "BALANCED",
                    "lineup_confidence": "MEDIUM",
                    "formation_reason": "Best projected points.",
                    "starters": [
                        {
                            "player_id": 2001,
                            "name": "Trevoh Chalobah",
                            "team": "CHE",
                            "position": "DEF",
                            "projected_points": 4.8,
                        }
                    ],
                    "bench": [],
                },
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 2,
                },
                "current_gameweek": 29,
                "current_squad": [
                    {
                        "player_id": 2001,
                        "name": "Trevoh Chalobah",
                        "team": "CHE",
                        "current_price": 4.6,
                        "ownership_pct": 8.7,
                    }
                ],
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": False,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"free_transfers": 2})
    starter = transformed["starting_xi"][0]

    assert starter["name"] == "Trevoh Chalobah"
    assert starter["price"] == 4.6
    assert starter["ownership"] == 8.7


def test_transformer_preserves_critical_recovery_fields_and_never_invents_captaincy() -> None:
    raw_results = {
        "analysis": {
            "decision": {
                "primary_decision": "FREE_HIT",
                "decision_status": "BLOCKED",
                "decision_state": "CRITICAL_SQUAD_FAILURE",
                "critical_failure_reason": "6 blank players, XI infeasible",
                "chip_instruction": "FREE_HIT",
                "recovery_plan": {
                    "mode": "FREE_HIT",
                    "posture": "AGGRESSIVE",
                    "hit_cap": 12,
                    "playable_before": 8,
                    "playable_after": 11,
                    "blanks_before": 6,
                    "blanks_after": 0,
                    "survival_score": 1123.4,
                },
                "structural_weakness_summary": {
                    "overall_weak": 3,
                    "tier3_or_tier4_count": 5,
                },
                "reasoning": "🚨 CRITICAL SQUAD FAILURE DETECTED\nReason: 6 blank players, XI infeasible",
                "transfer_recommendations": [],
                "captaincy": {},
                "risk_scenarios": [],
            }
        },
        "raw_data": {
            "my_team": {
                "team_info": {
                    "team_name": "FPL XI",
                    "player_first_name": "AJ",
                    "player_last_name": "Manager",
                    "overall_rank": 6_448_179,
                    "total_points": 1234,
                    "free_transfers": 1,
                },
                "manager_context": {"manager_name": "AJ", "team_name": "FPL XI"},
                "current_gameweek": 29,
                "current_squad": [
                    {"player_id": 1, "name": "Starter A", "is_starter": True, "expected_pts": 2.0},
                    {"player_id": 2, "name": "Starter B", "is_starter": True, "expected_pts": 1.8},
                ],
                "chip_status": {
                    "bench_boost": False,
                    "triple_captain": False,
                    "free_hit": True,
                    "wildcard": True,
                },
            }
        },
    }

    module = _load_result_transformer()
    transformed = module.transform_analysis_results(raw_results, overrides={"risk_posture": "aggressive"})

    assert transformed["decision_state"] == "CRITICAL_SQUAD_FAILURE"
    assert transformed["critical_failure_reason"] == "6 blank players, XI infeasible"
    assert transformed["chip_instruction"] == "FREE_HIT"
    assert transformed["recovery_plan"]["playable_after"] == 11
    assert transformed["structural_weakness_summary"]["overall_weak"] == 3
    assert transformed.get("captain") is None
    assert transformed.get("vice_captain") is None
    assert "Fallback captaincy derived from highest projected starter" not in str(transformed)


def test_projections_endpoint_includes_critical_recovery_fields(client, monkeypatch) -> None:
    results = {
        "team_name": "FPL XI",
        "manager_name": "AJ",
        "current_gw": 29,
        "overall_rank": 6448179,
        "overall_points": 1440,
        "primary_decision": "FREE_HIT",
        "decision_status": "BLOCKED",
        "decision_state": "CRITICAL_SQUAD_FAILURE",
        "critical_failure_reason": "6 blank players, XI infeasible",
        "chip_instruction": "FREE_HIT",
        "recovery_plan": {
            "mode": "FREE_HIT",
            "posture": "AGGRESSIVE",
            "hit_cap": 12,
            "playable_before": 8,
            "playable_after": 11,
            "blanks_before": 6,
            "blanks_after": 0,
            "survival_score": 1123.4,
        },
        "structural_weakness_summary": {
            "overall_weak": 3,
            "tier3_or_tier4_count": 5,
        },
        "confidence": "High",
        "reasoning": "🚨 CRITICAL SQUAD FAILURE DETECTED\nReason: 6 blank players, XI infeasible",
        "starting_xi": [],
        "bench": [],
        "projected_xi": [],
        "projected_bench": [],
        "transfer_recommendations": [],
        "risk_scenarios": [],
        "available_chips": ["free_hit", "wildcard"],
    }
    monkeypatch.setattr(
        analyze_router.engine_service,
        "get_job",
        lambda _analysis_id: _job(status="complete", results=results),
    )

    response = client.get("/api/v1/analyze/job12345/projections")
    assert response.status_code == 200
    body = response.json()
    assert body["decision_state"] == "CRITICAL_SQUAD_FAILURE"
    assert body["critical_failure_reason"] == "6 blank players, XI infeasible"
    assert body["chip_instruction"] == "FREE_HIT"
    assert body["recovery_plan"]["blanks_after"] == 0
    assert body["structural_weakness_summary"]["tier3_or_tier4_count"] == 5
