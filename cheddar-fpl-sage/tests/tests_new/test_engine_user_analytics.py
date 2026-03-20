from datetime import datetime, timedelta, timezone

from backend.services.engine_service import AnalysisJob, EngineService


def _job(
    analysis_id: str,
    user_id: str,
    *,
    team_id: int = 711511,
    gameweek: int | None = None,
    created_at: datetime | None = None,
    status: str = "complete",
    season: str = "2025-26",
    points: float = 0.0,
    transfer_count: int = 0,
):
    job = AnalysisJob(analysis_id=analysis_id, team_id=team_id, gameweek=gameweek, overrides={"user_id": user_id})
    job.status = status
    job.created_at = created_at or datetime.now(timezone.utc)
    job.results = {
        "season": season,
        "summary": {"expected_team_points_improvement": points},
        "transfer_recommendations": [{} for _ in range(transfer_count)],
        "captain_recommendation": {
            "primary": {"player_name": "Salah", "expected_points": 9.4},
            "metrics": {"correct": True},
        },
        "chip_strategy": {
            "bench_boost": {"recommended": True, "expected_boost": 8.0},
            "triple_captain": {"recommended": True, "expected_boost": 6.0},
        },
    }
    return job


def test_list_user_analyses_filters_and_sorts():
    service = EngineService()
    base = datetime(2026, 2, 25, tzinfo=timezone.utc)

    job_old = _job("a1", "user_123", gameweek=24, created_at=base - timedelta(days=2))
    job_new = _job("a2", "user_123", gameweek=25, created_at=base - timedelta(days=1))
    job_other_user = _job("a3", "other_user", gameweek=26, created_at=base)

    service._jobs = {j.analysis_id: j for j in [job_old, job_new, job_other_user]}

    history = service.list_user_analyses("user_123", sort_by="created_at")
    assert history["user_id"] == "user_123"
    assert history["total"] == 2
    assert [item["analysis_id"] for item in history["analyses"]] == ["a2", "a1"]

    by_gw = service.list_user_analyses("user_123", sort_by="gameweek")
    assert [item["analysis_id"] for item in by_gw["analyses"]] == ["a2", "a1"]


def test_get_user_performance_aggregates_completed_analyses():
    service = EngineService()
    base = datetime(2026, 2, 25, tzinfo=timezone.utc)

    job_one = _job("a1", "user_123", gameweek=24, created_at=base - timedelta(days=2), points=5.0, transfer_count=2)
    job_two = _job("a2", "user_123", gameweek=25, created_at=base - timedelta(days=1), points=7.0, transfer_count=3)
    job_failed = _job("a3", "user_123", status="failed", points=99.0, transfer_count=9)
    job_other = _job("a4", "other_user", points=10.0, transfer_count=1)

    service._jobs = {j.analysis_id: j for j in [job_one, job_two, job_failed, job_other]}

    perf = service.get_user_performance("user_123", season="2025-26", include_details=True)
    assert perf["user_id"] == "user_123"
    assert perf["analyses_completed"] == 2
    assert perf["total_points_from_recommendations"] == 12.0
    assert perf["average_points_per_analysis"] == 6.0
    assert perf["transfer_quality"]["recommended_transfers"] == 5
    assert perf["captain_accuracy"]["total_predictions"] == 2
    assert "details" in perf
    assert len(perf["details"]) == 2


def test_get_user_performance_uses_real_vs_average_metrics_when_available():
    service = EngineService()
    now = datetime(2026, 2, 25, tzinfo=timezone.utc)

    job = _job("a1", "user_123", gameweek=25, created_at=now, points=6.0, transfer_count=1)
    job.results["current_points"] = 64
    job.results["average_entry_score"] = 52

    service._jobs = {job.analysis_id: job}

    perf = service.get_user_performance("user_123")
    assert perf["vs_average_team"]["your_avg_gw_points"] == 64.0
    assert perf["vs_average_team"]["fpl_average_gw_points"] == 52.0
    assert perf["vs_average_team"]["outperformance_pct"] == 23.1
