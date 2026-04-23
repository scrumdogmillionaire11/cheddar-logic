"""
Tests for FPL Sage API endpoints.
Uses FastAPI TestClient for synchronous testing.
"""
import pytest
from fastapi.testclient import TestClient
import sys
import os
from datetime import datetime, timezone
from types import SimpleNamespace

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from backend.main import app
import backend.routers.analyze as analyze_router
import backend.routers.dashboard as dashboard_router


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


class TestHealthEndpoint:
    """Tests for /health endpoint."""

    def test_health_check_returns_200(self, client):
        """Health endpoint returns 200 with status healthy."""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "healthy"
        assert data["version"] == app.version
        assert "timestamp" in data

    def test_root_endpoint(self, client):
        """Root endpoint returns API info."""
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "FPL Sage API"


class TestAnalyzeEndpoint:
    """Tests for /api/v1/analyze endpoints."""

    def test_trigger_analysis_returns_202(self, client):
        """POST /analyze returns 202 with analysis_id."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        assert response.status_code == 202
        data = response.json()
        assert "analysis_id" in data
        assert data["status"] == "queued"
        assert "created_at" in data

    def test_trigger_analysis_with_gameweek(self, client):
        """POST /analyze accepts optional gameweek."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 25}
        )
        assert response.status_code == 202

    def test_invalid_team_id_zero(self, client):
        """POST /analyze rejects team_id of 0 (Pydantic validation)."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 0}
        )
        # Pydantic Field(gt=0) returns 422, not 400
        assert response.status_code == 422
        data = response.json()
        assert "validation_error" in str(data).lower() or "greater than 0" in str(data).lower()

    def test_invalid_team_id_negative(self, client):
        """POST /analyze rejects negative team_id (Pydantic validation)."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": -1}
        )
        # Pydantic Field(gt=0) returns 422, not 400
        assert response.status_code == 422

    def test_invalid_team_id_too_large(self, client):
        """POST /analyze rejects team_id > 20M."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 25_000_000}
        )
        assert response.status_code == 400

    def test_invalid_gameweek_zero(self, client):
        """POST /analyze rejects gameweek of 0."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 0}
        )
        assert response.status_code == 400
        data = response.json()
        assert "INVALID_GAMEWEEK" in str(data)

    def test_invalid_gameweek_too_large(self, client):
        """POST /analyze rejects gameweek > 38."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 40}
        )
        assert response.status_code == 400

    def test_get_analysis_status(self, client):
        """GET /analyze/{id} returns status for existing job."""
        # First create an analysis
        create_response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        analysis_id = create_response.json()["analysis_id"]

        # Then get its status
        response = client.get(f"/api/v1/analyze/{analysis_id}")
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert data["status"] in ["queued", "analyzing", "complete", "failed"]

    def test_get_analysis_not_found(self, client):
        """GET /analyze/{id} returns 404 for unknown job."""
        response = client.get("/api/v1/analyze/nonexistent123")
        assert response.status_code == 404
        data = response.json()
        assert "ANALYSIS_NOT_FOUND" in str(data)

    def test_missing_team_id(self, client):
        """POST /analyze requires team_id."""
        response = client.post(
            "/api/v1/analyze",
            json={}
        )
        assert response.status_code == 422  # Pydantic validation error

    def test_projections_endpoint_serializes_critical_recovery_fields(self, client, monkeypatch):
        critical_results = {
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
            lambda _analysis_id: SimpleNamespace(
                analysis_id="critical-001",
                status="complete",
                progress=100.0,
                phase="completed",
                results=critical_results,
                error=None,
                created_at=datetime.now(timezone.utc),
            ),
        )

        response = client.get("/api/v1/analyze/critical-001/projections")
        assert response.status_code == 200
        body = response.json()
        assert body["decision_state"] == "CRITICAL_SQUAD_FAILURE"
        assert body["critical_failure_reason"] == "6 blank players, XI infeasible"
        assert body["chip_instruction"] == "FREE_HIT"
        assert body["recovery_plan"]["playable_after"] == 11
        assert body["structural_weakness_summary"]["overall_weak"] == 3


def _dashboard_job(status: str = "complete", results: dict | None = None):
    return SimpleNamespace(
        analysis_id="dash-001",
        status=status,
        progress=100.0,
        phase="completed",
        results=results or {},
        error=None,
        created_at=datetime.now(timezone.utc),
    )


class TestDashboardEndpoint:
    def test_dashboard_endpoint_uses_canonical_cards(self, client, monkeypatch):
        canonical_results = {
            "current_gw": 33,
            "gameweek_plan": {
                "version": "v1",
                "summary": "Take one proactive transfer.",
                "highlights": [],
                "metrics": {
                    "primary_action": "TRANSFER",
                    "justification": "One route clears threshold.",
                    "gameweek": 33,
                    "generated_at": "2026-04-17T12:00:00Z",
                    "free_transfers": 1,
                },
            },
            "transfer_recommendation": {
                "version": "v1",
                "summary": "Upgrade midfield slot.",
                "highlights": [],
                "metrics": {
                    "transfer_plans": {
                        "primary": {
                            "out": "Mid A",
                            "in": "Mid B",
                            "hit_cost": 0,
                            "net_cost": 0.8,
                            "delta_pts_4gw": 3.6,
                            "reason": "Fixture upgrade",
                            "confidence": "HIGH",
                        }
                    }
                },
            },
            "captaincy": {
                "version": "v1",
                "summary": "Captaincy clear this week.",
                "highlights": [],
                "metrics": {
                    "captain": {"name": "Haaland", "team": "MCI", "position": "FWD", "expected_pts": 9.1},
                    "vice_captain": {"name": "Saka", "team": "ARS", "position": "MID", "expected_pts": 7.1},
                },
            },
            "chip_strategy": {
                "version": "v1",
                "summary": "No chip this week.",
                "highlights": [],
                "metrics": {
                    "verdict": "NONE",
                    "status": "PASS",
                    "explanation": "Save chips for doubles.",
                    "recommendation": {"best_gw": 36},
                },
            },
            "squad_state": {
                "version": "v1",
                "summary": "Squad healthy.",
                "highlights": [],
                "metrics": {
                    "starting_xi": [{"name": "P1"}],
                    "bench": [{"name": "B1"}],
                    "squad_health": {"injured": 0, "doubtful": 0, "health_pct": 100},
                },
            },
            "decision_confidence": {
                "version": "v1",
                "confidence": "HIGH",
                "score": 84,
                "rationale": "Strong signal set.",
                "signals": ["form"],
            },
            "weekly_review": {
                "version": "v1",
                "summary": "Prior week process held.",
                "highlights": [],
                "metrics": {"drift_flags": []},
            },
        }
        monkeypatch.setattr(
            dashboard_router.engine_service,
            "get_job",
            lambda _analysis_id: _dashboard_job(status="complete", results=canonical_results),
        )

        response = client.get("/api/v1/dashboard/dash-001")
        assert response.status_code == 200
        body = response.json()
        assert body["gameweek"]["current"] == 33
        assert body["decision_summary"]["decision"] == "TRANSFER"
        assert body["captain_advice"]["captain"]["name"] == "Haaland"
        assert len(body["transfer_targets"]) >= 1

    def test_dashboard_endpoint_returns_202_when_running(self, client, monkeypatch):
        monkeypatch.setattr(
            dashboard_router.engine_service,
            "get_job",
            lambda _analysis_id: _dashboard_job(status="running", results={}),
        )

        response = client.get("/api/v1/dashboard/dash-002")
        assert response.status_code == 202
