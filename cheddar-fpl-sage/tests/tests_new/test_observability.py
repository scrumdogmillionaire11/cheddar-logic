import importlib
import logging
import sys

import backend.main as main_module


def _load_main_module():
    module_name = "backend.main"
    module = sys.modules.get(module_name)
    if module is None:
        return importlib.import_module(module_name)
    return module


def test_request_observability_headers_are_present(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert "X-Request-ID" in response.headers
    assert "X-Process-Time-Ms" in response.headers
    assert float(response.headers["X-Process-Time-Ms"]) >= 0.0


def test_request_id_is_propagated_from_inbound_header(client):
    response = client.get("/health", headers={"X-Request-ID": "req-123"})
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "req-123"


def test_structured_request_log_emitted(client, caplog):
    caplog.set_level(logging.INFO, logger="backend.observability")

    response = client.get("/health")
    assert response.status_code == 200

    entries = [record.getMessage() for record in caplog.records if "request_completed" in record.getMessage()]
    assert entries
    assert any("path=/health" in msg for msg in entries)
    assert any("status=200" in msg for msg in entries)


def test_health_probe_marks_degraded_when_upstream_unavailable(client, monkeypatch):
    health_route = next(route for route in client.app.routes if getattr(route, "path", None) == "/health")
    health_globals = health_route.endpoint.__globals__
    monkeypatch.setattr(health_globals["settings"], "FPL_API_HEALTHCHECK_ENABLED", True)
    monkeypatch.setitem(health_globals, "check_http_health", lambda *_args, **_kwargs: ("unavailable", "timeout"))

    response = client.get("/health")
    body = response.json()
    assert response.status_code == 503
    assert body["status"] == "degraded"
    assert body["components"]["fpl_api"] == "unavailable"
    assert "message" in body
