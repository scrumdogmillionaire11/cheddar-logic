"""Integration tests for the decision receipts API (WI-0658).

Tests cover:
- POST /api/v1/decision-receipts returns 201 with receipt_id
- POST /api/v1/decision-receipts returns 201 with user_choice=None when omitted
- POST /api/v1/decision-receipts with outcome="followed" persists outcome
- POST /api/v1/decision-receipts with outcome="ignored" persists outcome
- POST /api/v1/decision-receipts with process_verdict="good_process" persists verdict
- GET /api/v1/decision-receipts/{id} returns 200 for created receipt
- GET /api/v1/decision-receipts/{id} returns 404 for unknown id
- GET /api/v1/decision-receipts/manager/{manager_id} returns list of receipts
- POST missing required field (manager_id) returns 422
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from fastapi.testclient import TestClient

from backend.main import app
from backend.services.weekly_review_service import weekly_review_service

client = TestClient(app)

API = "/api/v1/decision-receipts"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _create_receipt(
    manager_id="receipt-test-001",
    session_id="sess-001",
    decision_type="captain",
    rationale="Salah has best fixtures",
    **extra,
):
    payload = {
        "manager_id": manager_id,
        "session_id": session_id,
        "decision_type": decision_type,
        "rationale": rationale,
        **extra,
    }
    return client.post(API, json=payload)


# ── POST ──────────────────────────────────────────────────────────────────────


def test_post_receipt_returns_201():
    resp = _create_receipt(manager_id="rc-mgr-001")
    assert resp.status_code == 201, resp.text


def test_post_receipt_returns_receipt_id():
    resp = _create_receipt(manager_id="rc-mgr-002")
    data = resp.json()
    assert "receipt_id" in data
    assert isinstance(data["receipt_id"], str)
    assert len(data["receipt_id"]) > 0


def test_post_receipt_user_choice_none_when_omitted():
    resp = _create_receipt(manager_id="rc-mgr-003")
    data = resp.json()
    assert data.get("user_choice") is None


def test_post_receipt_persists_outcome_followed():
    resp = _create_receipt(manager_id="rc-mgr-004", outcome="followed")
    data = resp.json()
    assert data["outcome"] == "followed"


def test_post_receipt_persists_outcome_ignored():
    resp = _create_receipt(manager_id="rc-mgr-005", outcome="ignored")
    data = resp.json()
    assert data["outcome"] == "ignored"


def test_post_receipt_persists_process_verdict():
    resp = _create_receipt(manager_id="rc-mgr-006", process_verdict="good_process")
    data = resp.json()
    assert data["process_verdict"] == "good_process"


def test_post_receipt_persists_user_choice():
    user_choice = {"player": "Salah", "position": "captain"}
    resp = _create_receipt(manager_id="rc-mgr-007", user_choice=user_choice)
    data = resp.json()
    assert data["user_choice"] == user_choice


def test_post_receipt_missing_manager_id_422():
    resp = client.post(
        API,
        json={"session_id": "s1", "decision_type": "captain", "rationale": "x"},
    )
    assert resp.status_code == 422


# ── GET /{receipt_id} ─────────────────────────────────────────────────────────


def test_get_receipt_returns_200_for_created():
    create_resp = _create_receipt(manager_id="rc-mgr-008")
    receipt_id = create_resp.json()["receipt_id"]
    resp = client.get(f"{API}/{receipt_id}")
    assert resp.status_code == 200, resp.text
    assert resp.json()["receipt_id"] == receipt_id


def test_get_receipt_returns_404_for_unknown():
    resp = client.get(f"{API}/nonexistent-receipt-id-xyz")
    assert resp.status_code == 404


# ── GET /manager/{manager_id} ─────────────────────────────────────────────────


def test_get_receipts_by_manager_returns_list():
    mgr = "rc-list-mgr-001"
    _create_receipt(manager_id=mgr, decision_type="captain")
    _create_receipt(manager_id=mgr, decision_type="transfer")
    resp = client.get(f"{API}/manager/{mgr}")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) >= 2
    assert all(r["manager_id"] == mgr for r in data)


def test_weekly_review_persists_outcome_verdict_and_drift_flags_read_after_write():
    mgr = "rc-weekly-review-001"
    create_resp = _create_receipt(
        manager_id=mgr,
        decision_type="captain",
        payload={"recommended": "Salah"},
        user_choice={"selected": "Salah"},
    )
    assert create_resp.status_code == 201, create_resp.text
    receipt_id = create_resp.json()["receipt_id"]

    raw_results = {
        "raw_data": {
            "current_gameweek": 31,
            "my_team": {
                "current_gameweek": 31,
                "history_current": [
                    {"event": 30, "event_points": 62, "overall_rank": 1_200_000},
                    {"event": 31, "event_points": 68, "overall_rank": 1_150_000},
                ],
            },
        }
    }
    transformed_results = {"current_gw": 31}

    review = weekly_review_service.build_review(
        raw_results=raw_results,
        transformed_results=transformed_results,
        manager_id=mgr,
    )

    assert review["metrics"]["history_available"] is True
    assert review["metrics"]["process_verdict"] == "good_process"

    read_resp = client.get(f"{API}/{receipt_id}")
    assert read_resp.status_code == 200, read_resp.text
    persisted = read_resp.json()
    assert persisted["outcome"] == "followed"
    assert persisted["process_verdict"] == "good_process"
    assert persisted["drift_flags"] == []

    # Re-run service path and ensure values are stable (no silent drop/mutation).
    weekly_review_service.build_review(
        raw_results=raw_results,
        transformed_results=transformed_results,
        manager_id=mgr,
    )
    read_resp_again = client.get(f"{API}/{receipt_id}")
    persisted_again = read_resp_again.json()
    assert persisted_again["outcome"] == "followed"
    assert persisted_again["process_verdict"] == "good_process"
    assert persisted_again["drift_flags"] == []


def test_weekly_review_no_history_keeps_receipt_null_safe():
    mgr = "rc-weekly-review-002"
    create_resp = _create_receipt(
        manager_id=mgr,
        decision_type="transfer",
        payload={"recommended": "Player A"},
        user_choice={"selected": "Player B"},
    )
    assert create_resp.status_code == 201, create_resp.text
    receipt_id = create_resp.json()["receipt_id"]

    raw_results = {
        "raw_data": {
            "current_gameweek": 31,
            "my_team": {
                "current_gameweek": 31,
                "history_current": [],
            },
        }
    }

    review = weekly_review_service.build_review(
        raw_results=raw_results,
        transformed_results={"current_gw": 31},
        manager_id=mgr,
    )

    assert review["metrics"]["history_available"] is False
    assert review["metrics"]["process_verdict"] is None
    assert review["metrics"]["drift_flags"] == []

    read_resp = client.get(f"{API}/{receipt_id}")
    assert read_resp.status_code == 200, read_resp.text
    persisted = read_resp.json()
    assert persisted["outcome"] is None
    assert persisted["process_verdict"] is None
    assert persisted["drift_flags"] == []
