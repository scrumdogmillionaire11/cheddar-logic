"""Unit tests for decision memory / drift flag logic (WI-0658).

Tests cover:
- get_memory returns DecisionMemorySummary for manager with no receipts (all flags False)
- bench_neglect=True when >40% chip receipts are ignored
- bench_neglect=False when <=40% chip receipts are ignored
- overreaction=True when >30% transfer receipts have process_verdict="bad_process"
- overreaction=False when <=30% transfer receipts have process_verdict="bad_process"
- overpunting=True when >25% transfer receipts ignored
- overpunting=False when <=25% transfer receipts ignored
- evidence dict contains correct counts
- drift_flags are deterministic (same input produces same output on repeated calls)
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
        "session_id": "mem-sess-001",
        "decision_type": decision_type,
        "rationale": "test",
    }
    if outcome is not None:
        payload["outcome"] = outcome
    if process_verdict is not None:
        payload["process_verdict"] = process_verdict
    return client.post(API_RECEIPTS, json=payload)


# ── No receipts base case ─────────────────────────────────────────────────────


def test_memory_empty_manager_all_flags_false():
    mgr = "mem-empty-001"
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["bench_neglect"] is False
    assert data["overreaction"] is False
    assert data["excessive_templating"] is False
    assert data["overpunting"] is False
    assert data["receipt_count"] == 0


def test_memory_has_manager_id():
    mgr = "mem-id-001"
    resp = client.get(f"{API_USER}/{mgr}/memory")
    data = resp.json()
    assert data["manager_id"] == mgr


# ── bench_neglect ─────────────────────────────────────────────────────────────


def test_bench_neglect_true_when_over_40_pct_chip_ignored():
    mgr = "mem-bn-true-001"
    # 3 ignored, 2 not => 60% > 40%
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="followed")
    _post_receipt(mgr, "chip", outcome="followed")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.json()["bench_neglect"] is True


def test_bench_neglect_false_when_at_or_below_40_pct_chip_ignored():
    mgr = "mem-bn-false-001"
    # 2 ignored, 3 not => 40% = threshold, expect False (strictly >)
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="followed")
    _post_receipt(mgr, "chip", outcome="followed")
    _post_receipt(mgr, "chip", outcome="partial")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.json()["bench_neglect"] is False


# ── overreaction ──────────────────────────────────────────────────────────────


def test_overreaction_true_when_over_30_pct_transfer_bad_process():
    mgr = "mem-or-true-001"
    # 2 bad, 3 total => 66% > 30%
    _post_receipt(mgr, "transfer", process_verdict="bad_process")
    _post_receipt(mgr, "transfer", process_verdict="bad_process")
    _post_receipt(mgr, "transfer", process_verdict="good_process")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.json()["overreaction"] is True


def test_overreaction_false_when_at_or_below_30_pct_transfer_bad_process():
    mgr = "mem-or-false-001"
    # 3 bad, 10 total => 30% = threshold, expect False (strictly >)
    for _ in range(3):
        _post_receipt(mgr, "transfer", process_verdict="bad_process")
    for _ in range(7):
        _post_receipt(mgr, "transfer", process_verdict="good_process")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.json()["overreaction"] is False


# ── overpunting ───────────────────────────────────────────────────────────────


def test_overpunting_true_when_over_25_pct_transfer_ignored():
    mgr = "mem-op-true-001"
    # 2 ignored, 3 total => 66% > 25%
    _post_receipt(mgr, "transfer", outcome="ignored")
    _post_receipt(mgr, "transfer", outcome="ignored")
    _post_receipt(mgr, "transfer", outcome="followed")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.json()["overpunting"] is True


def test_overpunting_false_when_at_or_below_25_pct_transfer_ignored():
    mgr = "mem-op-false-001"
    # 1 ignored, 4 total => 25% = threshold, expect False (strictly >)
    _post_receipt(mgr, "transfer", outcome="ignored")
    for _ in range(3):
        _post_receipt(mgr, "transfer", outcome="followed")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    assert resp.json()["overpunting"] is False


# ── evidence dict ─────────────────────────────────────────────────────────────


def test_evidence_contains_counts():
    mgr = "mem-ev-001"
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "transfer", process_verdict="bad_process")
    resp = client.get(f"{API_USER}/{mgr}/memory")
    data = resp.json()
    assert "evidence" in data
    assert isinstance(data["evidence"], dict)
    # must have at least chip_ignored
    assert data["evidence"].get("chip_ignored", 0) >= 1


# ── determinism ───────────────────────────────────────────────────────────────


def test_memory_is_deterministic():
    mgr = "mem-det-001"
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="ignored")
    _post_receipt(mgr, "chip", outcome="followed")
    resp1 = client.get(f"{API_USER}/{mgr}/memory")
    resp2 = client.get(f"{API_USER}/{mgr}/memory")
    assert resp1.json() == resp2.json()
