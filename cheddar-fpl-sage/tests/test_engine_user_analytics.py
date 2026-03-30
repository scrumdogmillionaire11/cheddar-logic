"""Integration tests for engine user analytics endpoints (WI-0658).

Tests cover:
- GET /user/{id}/analytics returns 200 with adoption_rate field
- adoption_rate=0.0 when no receipts exist
- adoption_rate=1.0 when all receipts have outcome="followed"
- adoption_rate=0.5 when half of outcome-set receipts followed or partial
- captain_accuracy computed correctly from captain receipts
- missed_opportunity_count counts ignored captain+transfer receipts
- GET /user/{id}/analytics?season=2024-25 returns receipt_count=0 for non-matching season
- GET /user/{id}/memory returns 200 with bench_neglect field
- Existing GET /user/{id}/analyses returns 200 (backward compat)
- Existing GET /user/{id}/performance returns 200 (backward compat)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)

API_RECEIPTS = "/api/v1/decision-receipts"
API_USER = "/api/v1/user"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _post_receipt(manager_id: str, decision_type: str, outcome=None, process_verdict=None):
    payload = {
        "manager_id": manager_id,
        "session_id": "analytics-sess-001",
        "decision_type": decision_type,
        "rationale": "test rationale",
    }
    if outcome is not None:
        payload["outcome"] = outcome
    if process_verdict is not None:
        payload["process_verdict"] = process_verdict
    resp = client.post(API_RECEIPTS, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


# ── GET /user/{id}/analytics ──────────────────────────────────────────────────


def test_get_analytics_returns_200():
    resp = client.get(f"{API_USER}/analytics-empty-001/analytics")
    assert resp.status_code == 200, resp.text


def test_analytics_has_adoption_rate_field():
    resp = client.get(f"{API_USER}/analytics-field-001/analytics")
    data = resp.json()
    assert "adoption_rate" in data


def test_analytics_adoption_rate_zero_when_no_receipts():
    mgr = "analytics-zero-001"
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    assert data["adoption_rate"] == 0.0
    assert data["receipt_count"] == 0


def test_analytics_adoption_rate_one_when_all_followed():
    mgr = "analytics-followed-001"
    _post_receipt(mgr, "captain", outcome="followed")
    _post_receipt(mgr, "transfer", outcome="followed")
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    assert data["adoption_rate"] == 1.0


def test_analytics_adoption_rate_half_when_mixed():
    mgr = "analytics-half-001"
    _post_receipt(mgr, "captain", outcome="followed")
    _post_receipt(mgr, "transfer", outcome="ignored")
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    assert abs(data["adoption_rate"] - 0.5) < 0.01


def test_analytics_captain_accuracy_correct():
    mgr = "analytics-cap-001"
    _post_receipt(mgr, "captain", outcome="followed")
    _post_receipt(mgr, "captain", outcome="followed")
    _post_receipt(mgr, "captain", outcome="ignored")
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    # 2 followed out of 3 captain receipts with outcome set
    assert abs(data["captain_accuracy"] - 2 / 3) < 0.01


def test_analytics_missed_opportunity_count():
    mgr = "analytics-miss-001"
    _post_receipt(mgr, "captain", outcome="ignored")
    _post_receipt(mgr, "transfer", outcome="ignored")
    _post_receipt(mgr, "captain", outcome="followed")
    _post_receipt(mgr, "chip", outcome="ignored")  # chip doesn't count
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    # only captain+transfer ignored count
    assert data["missed_opportunity_count"] >= 2


def test_analytics_receipt_count():
    mgr = "analytics-count-001"
    _post_receipt(mgr, "captain", outcome="followed")
    _post_receipt(mgr, "transfer", outcome="ignored")
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    assert data["receipt_count"] >= 2


def test_analytics_season_filter_returns_zero_for_nonmatching():
    mgr = "analytics-season-001"
    _post_receipt(mgr, "captain", outcome="followed")
    # Season 2020-21 should not match receipts created now (2026)
    resp = client.get(f"{API_USER}/{mgr}/analytics?season=2020-21")
    data = resp.json()
    assert data["receipt_count"] == 0


def test_analytics_response_has_all_fields():
    mgr = "analytics-shape-001"
    resp = client.get(f"{API_USER}/{mgr}/analytics")
    data = resp.json()
    for field in ("manager_id", "adoption_rate", "transfer_quality",
                  "captain_accuracy", "missed_opportunity_count", "receipt_count"):
        assert field in data, f"missing field: {field}"


# ── GET /user/{id}/memory ─────────────────────────────────────────────────────


def test_get_memory_returns_200():
    resp = client.get(f"{API_USER}/analytics-mem-001/memory")
    assert resp.status_code == 200, resp.text


def test_get_memory_has_bench_neglect():
    resp = client.get(f"{API_USER}/analytics-mem-002/memory")
    data = resp.json()
    assert "bench_neglect" in data


# ── Backward compatibility ────────────────────────────────────────────────────


def test_existing_analyses_endpoint_still_200():
    resp = client.get(f"{API_USER}/any-user-999/analyses")
    assert resp.status_code == 200, resp.text


def test_existing_performance_endpoint_still_200():
    resp = client.get(f"{API_USER}/any-user-999/performance")
    assert resp.status_code == 200, resp.text
