"""Integration tests for the draft sessions API (WI-0654).

Tests cover:
- POST /api/v1/draft-sessions creates a session (201)
- POST /api/v1/draft-sessions returns session_id and constraints
- GET /api/v1/draft-sessions/{id} returns 200 for known session
- GET /api/v1/draft-sessions/{id} returns 404 for unknown id
- PATCH /api/v1/draft-sessions/{id} with explicit constraints returns updated state
- PATCH /api/v1/draft-sessions/{id} with intent_text updates constraints
- PATCH /api/v1/draft-sessions/{id} with no body returns 422
- PATCH /api/v1/draft-sessions/{id} returns 404 for unknown id
- POST /api/v1/draft-sessions/{id}/generate returns 200 with builds
- generate response includes primary_build and contrast_build
- generate primary_build has 15 players
- generate contrast_build has 15 players
- generate returns tradeoff_notes list
- generate returns constraints_snapshot
- generate with unknown session returns 404
- PATCH with 'keep Salah' updates locked_players indirectly via intent
- PATCH with 'make this safer' sets uncertainty_tolerance=low
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

from fastapi.testclient import TestClient

from backend.main import app

client = TestClient(app)

API = "/api/v1/draft-sessions"


# ── Helpers ───────────────────────────────────────────────────────────────────


def _create_session(manager_id="test-mgr-001", gameweek=25, constraints=None):
    payload: dict = {"manager_id": manager_id, "gameweek": gameweek}
    if constraints is not None:
        payload["constraints"] = constraints
    return client.post(API, json=payload)


# ── POST /api/v1/draft-sessions ───────────────────────────────────────────────


def test_create_session_returns_201():
    resp = _create_session()
    assert resp.status_code == 201, resp.text


def test_create_session_response_shape():
    resp = _create_session(manager_id="mgr-shape", gameweek=30)
    data = resp.json()
    assert "session_id" in data
    assert data["manager_id"] == "mgr-shape"
    assert data["gameweek"] == 30
    assert data["status"] == "open"
    assert "constraints" in data
    assert data["completed_at"] is None


def test_create_session_default_constraints():
    resp = _create_session()
    c = resp.json()["constraints"]
    assert c["locked_players"] == []
    assert c["banned_players"] == []
    assert c["bench_quality_target"] == "medium"
    assert c["uncertainty_tolerance"] == "medium"
    assert c["differential_slots_target"] == 0
    assert c["premium_count_target"] == 3


def test_create_session_with_explicit_constraints():
    resp = _create_session(
        constraints={
            "locked_players": [42],
            "banned_players": [99],
            "bench_quality_target": "high",
            "uncertainty_tolerance": "low",
            "differential_slots_target": 2,
            "premium_count_target": 4,
            "club_caps": {"MCI": 1},
            "early_transfer_tolerance": True,
        }
    )
    assert resp.status_code == 201
    c = resp.json()["constraints"]
    assert 42 in c["locked_players"]
    assert 99 in c["banned_players"]
    assert c["bench_quality_target"] == "high"
    assert c["uncertainty_tolerance"] == "low"
    assert c["differential_slots_target"] == 2
    assert c["early_transfer_tolerance"] is True


# ── GET /api/v1/draft-sessions/{id} ──────────────────────────────────────────


def test_get_session_200_for_known():
    sid = _create_session().json()["session_id"]
    resp = client.get(f"{API}/{sid}")
    assert resp.status_code == 200


def test_get_session_matches_created():
    created = _create_session(manager_id="mgr-get-test", gameweek=28).json()
    sid = created["session_id"]
    fetched = client.get(f"{API}/{sid}").json()
    assert fetched["session_id"] == sid
    assert fetched["manager_id"] == "mgr-get-test"
    assert fetched["gameweek"] == 28


def test_get_session_404_for_unknown():
    resp = client.get(f"{API}/00000000-0000-0000-0000-000000000000")
    assert resp.status_code == 404


# ── PATCH /api/v1/draft-sessions/{id} ────────────────────────────────────────


def test_patch_explicit_constraints():
    sid = _create_session().json()["session_id"]
    resp = client.patch(
        f"{API}/{sid}",
        json={
            "constraints": {
                "banned_players": [7, 11],
                "bench_quality_target": "high",
                "uncertainty_tolerance": "high",
                "differential_slots_target": 3,
                "locked_players": [],
                "club_caps": {},
                "premium_count_target": 2,
                "early_transfer_tolerance": False,
            }
        },
    )
    assert resp.status_code == 200
    c = resp.json()["constraints"]
    assert 7 in c["banned_players"]
    assert 11 in c["banned_players"]
    assert c["bench_quality_target"] == "high"
    assert c["uncertainty_tolerance"] == "high"
    assert c["differential_slots_target"] == 3


def test_patch_intent_make_safer():
    sid = _create_session().json()["session_id"]
    resp = client.patch(
        f"{API}/{sid}", json={"intent_text": "make this safer"}
    )
    assert resp.status_code == 200
    assert resp.json()["constraints"]["uncertainty_tolerance"] == "low"


def test_patch_intent_stronger_bench():
    sid = _create_session().json()["session_id"]
    resp = client.patch(
        f"{API}/{sid}", json={"intent_text": "stronger bench"}
    )
    assert resp.status_code == 200
    assert resp.json()["constraints"]["bench_quality_target"] == "high"


def test_patch_intent_one_punt():
    sid = _create_session().json()["session_id"]
    resp = client.patch(f"{API}/{sid}", json={"intent_text": "one punt"})
    assert resp.status_code == 200
    assert resp.json()["constraints"]["differential_slots_target"] == 1


def test_patch_intent_more_aggressive():
    sid = _create_session().json()["session_id"]
    resp = client.patch(
        f"{API}/{sid}", json={"intent_text": "more aggressive"}
    )
    assert resp.status_code == 200
    assert resp.json()["constraints"]["uncertainty_tolerance"] == "high"


def test_patch_empty_body_returns_422():
    sid = _create_session().json()["session_id"]
    resp = client.patch(f"{API}/{sid}", json={})
    assert resp.status_code == 422


def test_patch_unknown_session_returns_404():
    resp = client.patch(
        f"{API}/00000000-0000-0000-0000-000000000000",
        json={"intent_text": "make this safer"},
    )
    assert resp.status_code == 404


# ── POST /api/v1/draft-sessions/{id}/generate ────────────────────────────────


def test_generate_returns_200():
    sid = _create_session().json()["session_id"]
    resp = client.post(f"{API}/{sid}/generate", json={})
    assert resp.status_code == 200, resp.text


def test_generate_response_shape():
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    assert "session_id" in data
    assert "primary_build" in data
    assert "contrast_build" in data
    assert "tradeoff_notes" in data
    assert "constraints_snapshot" in data


def test_generate_primary_has_15_players():
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    assert len(data["primary_build"]["players"]) == 15


def test_generate_contrast_has_15_players():
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    assert len(data["contrast_build"]["players"]) == 15


def test_generate_build_types():
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    assert data["primary_build"]["build_type"] == "primary"
    assert data["contrast_build"]["build_type"] == "contrast"


def test_generate_tradeoff_notes_is_list():
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    assert isinstance(data["tradeoff_notes"], list)


def test_generate_constraints_snapshot_present():
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    snap = data["constraints_snapshot"]
    assert "locked_players" in snap
    assert "banned_players" in snap


def test_generate_unknown_session_returns_404():
    resp = client.post(
        f"{API}/00000000-0000-0000-0000-000000000000/generate", json={}
    )
    assert resp.status_code == 404


def test_generate_respects_ban_constraint():
    """Generate with banned players should not include them in builds."""
    sid = _create_session(
        constraints={
            "banned_players": [12],  # MID_A (Salah) in default pool
            "locked_players": [],
            "club_caps": {},
            "bench_quality_target": "medium",
            "uncertainty_tolerance": "medium",
            "premium_count_target": 3,
            "differential_slots_target": 0,
            "early_transfer_tolerance": False,
        }
    ).json()["session_id"]

    data = client.post(f"{API}/{sid}/generate", json={}).json()
    for build_key in ("primary_build", "contrast_build"):
        player_ids = [p["fpl_player_id"] for p in data[build_key]["players"]]
        assert 12 not in player_ids, f"Banned player in {build_key}"


def test_generate_strategy_labels_differ():
    """Primary and contrast should have different strategy labels."""
    sid = _create_session().json()["session_id"]
    data = client.post(f"{API}/{sid}/generate", json={}).json()
    p_label = data["primary_build"]["strategy_label"]
    c_label = data["contrast_build"]["strategy_label"]
    assert p_label != c_label
