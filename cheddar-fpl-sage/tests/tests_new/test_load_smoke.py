from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from backend.main import app


def _health_request_status() -> int:
    with TestClient(app) as client:
        return client.get("/health").status_code


def test_health_endpoint_handles_small_concurrent_burst():
    with ThreadPoolExecutor(max_workers=12) as pool:
        statuses = list(pool.map(lambda _i: _health_request_status(), range(48)))

    assert len(statuses) == 48
    assert all(code == 200 for code in statuses)
