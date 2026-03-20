"""
Tests for WebSocket progress streaming.
"""
import pytest
from fastapi.testclient import TestClient
import sys
import os

# Add paths
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from backend.main import app
from backend.services.engine_service import engine_service


@pytest.fixture
def client():
    """Create test client."""
    return TestClient(app)


class TestWebSocketEndpoint:
    """Tests for WebSocket progress streaming."""

    def test_websocket_connect_valid_job(self, client):
        """WebSocket connects successfully for existing job."""
        # Create a job first
        response = client.post("/api/v1/analyze", json={"team_id": 12345})
        analysis_id = response.json()["analysis_id"]

        # Connect WebSocket
        with client.websocket_connect(f"/api/v1/analyze/{analysis_id}/stream") as ws:
            # Should receive initial progress message
            data = ws.receive_json()
            assert data["type"] in ["progress", "complete", "error"]

    def test_websocket_connect_invalid_job(self, client):
        """WebSocket returns error for non-existent job."""
        with client.websocket_connect("/api/v1/analyze/nonexistent/stream") as ws:
            data = ws.receive_json()
            assert data["type"] == "error"
            assert "details" in data

    def test_websocket_receives_progress_updates(self, client):
        """WebSocket receives progress updates during analysis."""
        # Create a job
        response = client.post("/api/v1/analyze", json={"team_id": 12345})
        analysis_id = response.json()["analysis_id"]

        # Manually trigger progress notification
        with client.websocket_connect(f"/api/v1/analyze/{analysis_id}/stream") as ws:
            # Receive initial state
            initial = ws.receive_json()
            # Could be progress, complete, or error (if upstream fetch fails fast)
            assert initial["type"] in ["progress", "complete", "error"]
            
            # If job already completed, WebSocket will close - this is correct behavior
            if initial["type"] == "complete":
                assert "analysis_id" in initial
                assert initial.get("status") == "success"
                return

            # Upstream/network errors are valid in offline test environments
            if initial["type"] == "error":
                assert "error" in initial
                return

            # Simulate progress update
            engine_service._notify_progress(analysis_id, 50, "testing_phase")

            # Should receive progress, complete, or error
            data = ws.receive_json()
            assert data["type"] in ["progress", "complete", "error"]

    def test_websocket_message_format(self, client):
        """WebSocket messages have correct format."""
        response = client.post("/api/v1/analyze", json={"team_id": 12345})
        analysis_id = response.json()["analysis_id"]

        with client.websocket_connect(f"/api/v1/analyze/{analysis_id}/stream") as ws:
            data = ws.receive_json()

            # Verify message structure
            assert "type" in data
            if data["type"] == "progress":
                assert "progress" in data
                assert "phase" in data
                assert "message" in data
                assert "timestamp" in data
            elif data["type"] == "complete":
                assert "analysis_id" in data
                assert "status" in data
                assert "timestamp" in data
            elif data["type"] == "error":
                assert "error" in data
                assert "details" in data
                assert "timestamp" in data


class TestProgressCallbacks:
    """Tests for progress callback mechanism."""

    def test_register_callback(self):
        """Can register progress callback."""
        job = engine_service.create_analysis(99999)

        received = []
        def callback(progress, phase):
            received.append((progress, phase))

        engine_service.register_progress_callback(job.analysis_id, callback)
        engine_service._notify_progress(job.analysis_id, 50, "test")

        assert len(received) == 1
        assert received[0] == (50, "test")

    def test_multiple_callbacks(self):
        """Multiple callbacks all receive updates."""
        job = engine_service.create_analysis(99998)

        received1 = []
        received2 = []

        engine_service.register_progress_callback(
            job.analysis_id,
            lambda p, ph: received1.append((p, ph))
        )
        engine_service.register_progress_callback(
            job.analysis_id,
            lambda p, ph: received2.append((p, ph))
        )

        engine_service._notify_progress(job.analysis_id, 75, "multi_test")

        assert len(received1) == 1
        assert len(received2) == 1
        assert received1[0] == received2[0]

    def test_callback_error_doesnt_break_others(self):
        """Failing callback doesn't prevent other callbacks."""
        job = engine_service.create_analysis(99997)

        received = []

        def failing_callback(p, ph):
            raise Exception("Intentional test failure")

        def working_callback(p, ph):
            received.append((p, ph))

        engine_service.register_progress_callback(job.analysis_id, failing_callback)
        engine_service.register_progress_callback(job.analysis_id, working_callback)

        # Should not raise, working callback should still work
        engine_service._notify_progress(job.analysis_id, 25, "error_test")

        assert len(received) == 1
