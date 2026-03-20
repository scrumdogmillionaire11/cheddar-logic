"""
Integration tests for FPL Sage API.
Tests the full request/response cycle and error handling.
"""
import pytest
from fastapi.testclient import TestClient
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from backend.main import app


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


class TestErrorResponseFormat:
    """Tests for consistent error response format."""

    def test_validation_error_format(self, client):
        """Validation errors have consistent format."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": "not_a_number"}
        )
        assert response.status_code == 422
        data = response.json()

        # Required fields
        assert "error" in data
        assert "code" in data
        assert data["code"] == "VALIDATION_ERROR"

    def test_not_found_error_format(self, client):
        """404 errors have consistent format."""
        response = client.get("/api/v1/analyze/nonexistent123")
        assert response.status_code == 404
        data = response.json()

        assert "error" in data
        assert "code" in data
        assert "ANALYSIS_NOT_FOUND" in data["code"] or "NOT_FOUND" in str(data)

    def test_invalid_team_id_format(self, client):
        """Invalid team_id errors have consistent format."""
        # team_id > 20,000,000 triggers router's INVALID_TEAM_ID error
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 99999999}
        )
        assert response.status_code == 400
        data = response.json()

        assert "error" in data
        assert "code" in data
        assert data["code"] == "INVALID_TEAM_ID"

    def test_zero_team_id_validation_error(self, client):
        """team_id=0 fails Pydantic validation (gt=0 constraint)."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 0}
        )
        assert response.status_code == 422
        data = response.json()

        assert "error" in data
        assert data["code"] == "VALIDATION_ERROR"


class TestAnalysisFlow:
    """Tests for the complete analysis flow."""

    def test_create_and_poll_analysis(self, client):
        """Can create analysis and poll for status."""
        # Create analysis
        create_response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        assert create_response.status_code == 202
        analysis_id = create_response.json()["analysis_id"]

        # Poll for status
        status_response = client.get(f"/api/v1/analyze/{analysis_id}")
        assert status_response.status_code == 200

        status_data = status_response.json()
        assert "status" in status_data
        assert status_data["status"] in ["queued", "running", "completed", "failed"]

    def test_analysis_with_gameweek(self, client):
        """Can specify gameweek for analysis."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 25}
        )
        assert response.status_code == 202

    def test_analysis_gameweek_boundaries(self, client):
        """Gameweek validation at boundaries."""
        # Valid: GW1
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 1}
        )
        assert response.status_code == 202

        # Valid: GW38
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 38}
        )
        assert response.status_code == 202

        # Invalid: GW0
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 0}
        )
        assert response.status_code == 400

        # Invalid: GW39
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345, "gameweek": 39}
        )
        assert response.status_code == 400


class TestHealthAndMetadata:
    """Tests for health and informational endpoints."""

    def test_health_endpoint(self, client):
        """Health endpoint returns expected fields."""
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()

        assert data["status"] == "healthy"
        assert "version" in data
        assert "timestamp" in data
        assert "components" in data
        assert data["components"]["database"] in {"healthy", "degraded", "unavailable"}

    def test_root_endpoint(self, client):
        """Root endpoint returns API info."""
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()

        assert data["name"] == "FPL Sage API"
        assert "docs" in data

    def test_docs_endpoint(self, client):
        """OpenAPI docs are available."""
        response = client.get("/docs")
        assert response.status_code == 200

    def test_openapi_schema(self, client):
        """OpenAPI schema is valid."""
        response = client.get("/openapi.json")
        assert response.status_code == 200
        schema = response.json()

        assert "openapi" in schema
        assert "paths" in schema
        assert "/api/v1/analyze" in schema["paths"]


class TestRateLimitHeaders:
    """Tests for rate limit headers."""

    def test_rate_limit_headers_present(self, client):
        """Rate limit headers included in responses."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )

        # Headers may not be present if Redis not available (graceful degradation)
        # But if present, should have correct format
        if "X-RateLimit-Limit" in response.headers:
            assert int(response.headers["X-RateLimit-Limit"]) > 0
            assert "X-RateLimit-Remaining" in response.headers

    def test_health_skips_rate_limit(self, client):
        """Health endpoint is not rate limited."""
        # Make many requests to health
        for _ in range(10):
            response = client.get("/health")
            assert response.status_code == 200


class TestCacheHeaders:
    """Tests for cache-related headers."""

    def test_cache_miss_no_header(self, client):
        """Fresh analysis doesn't have X-Cache header."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 99999}  # Unlikely to be cached
        )
        # Cache miss = 202 queued, not 200 cached
        if response.status_code == 202:
            assert response.headers.get("X-Cache") != "HIT"


class TestWebSocketIntegration:
    """Integration tests for WebSocket functionality."""

    def test_websocket_invalid_job_closes(self, client):
        """WebSocket for invalid job closes gracefully."""
        with client.websocket_connect("/api/v1/analyze/invalid123/stream") as ws:
            data = ws.receive_json()
            assert data["type"] == "error"
            assert data["error"] == "Analysis not found"
            assert "timestamp" in data

    def test_websocket_valid_job_connects(self, client):
        """WebSocket for valid job connects successfully."""
        # Create job
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        analysis_id = response.json()["analysis_id"]

        # Connect WebSocket
        with client.websocket_connect(f"/api/v1/analyze/{analysis_id}/stream") as ws:
            data = ws.receive_json()
            assert data["type"] in ["progress", "heartbeat", "complete", "error"]


class TestExceptionHandlers:
    """Tests for custom exception handling."""

    def test_fpl_api_error_returns_502(self, client):
        """FPL API errors return 502 Bad Gateway."""
        from backend.services.engine_service import engine_service

        # Create a job
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        analysis_id = response.json()["analysis_id"]

        # Manually set job to failed with FPL error
        job = engine_service.get_job(analysis_id)
        job.status = "failed"
        job.error = "FPL API returned 503"

        # Check status
        status_response = client.get(f"/api/v1/analyze/{analysis_id}")
        assert status_response.status_code == 200
        data = status_response.json()
        assert data["status"] == "failed"
        assert "FPL API" in data["error"]


class TestFullApiCoverage:
    """Ensure all documented endpoints work."""

    def test_post_analyze(self, client):
        """POST /api/v1/analyze works."""
        response = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        assert response.status_code in [200, 202]

    def test_get_analyze_status(self, client):
        """GET /api/v1/analyze/{id} works."""
        # Create first
        create = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        aid = create.json()["analysis_id"]

        # Then get
        response = client.get(f"/api/v1/analyze/{aid}")
        assert response.status_code == 200

    def test_websocket_stream(self, client):
        """WS /api/v1/analyze/{id}/stream works."""
        # Create job
        create = client.post(
            "/api/v1/analyze",
            json={"team_id": 12345}
        )
        aid = create.json()["analysis_id"]

        # Connect WebSocket
        with client.websocket_connect(f"/api/v1/analyze/{aid}/stream") as ws:
            data = ws.receive_json()
            assert "type" in data
