"""
Tests for FPL Sage API endpoints.
Uses FastAPI TestClient for synchronous testing.
"""
import pytest
from fastapi.testclient import TestClient
import sys
import os

# Add backend to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from backend.main import app


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
