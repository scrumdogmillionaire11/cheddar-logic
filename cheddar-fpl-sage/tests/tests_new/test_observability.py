import logging

import backend.main as main_module


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
    monkeypatch.setattr(main_module.settings, "FPL_API_HEALTHCHECK_ENABLED", True)
    monkeypatch.setattr(main_module, "check_http_health", lambda *_args, **_kwargs: ("unavailable", "timeout"))

    response = client.get("/health")
    body = response.json()
    assert response.status_code == 503
    assert body["status"] == "degraded"
    assert body["components"]["fpl_api"] == "unavailable"
    assert "message" in body
