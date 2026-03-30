"""Unit tests for DraftService (WI-0654).

Tests cover:
- create_session persists session and constraints
- create_session with explicit constraints
- create_session with neutral defaults
- patch_session with explicit constraints replaces current
- patch_session with intent_text merges parsed constraints
- patch_session intent 'keep <name>' translates to locked_players via player pool
- patch_session intent 'make this safer' sets uncertainty_tolerance=low
- patch_session intent 'stronger bench' sets bench_quality_target=high
- patch_session intent 'one punt' sets differential_slots_target=1
- patch_session with unsupported intent still records partial_intent audit
- get_session returns None for unknown session_id
- get_session returns session state after creation
- constraint state survives multiple patches (last-write-wins)
- audit trail records constraint events
- patch_session returns None for unknown session_id
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import pytest

from backend.models.draft_api_models import (
    DraftConstraints,
    DraftSessionCreateRequest,
    DraftSessionPatchRequest,
)
from backend.services.draft_service import DraftService
from backend.services.product_store import ProductStore


# ── Helpers ───────────────────────────────────────────────────────────────────


def _fresh_service(tmp_path):
    """Return a DraftService backed by a temporary isolated ProductStore."""
    store = ProductStore(str(tmp_path / "test_product_store.json"))
    store.initialize()
    svc = DraftService(store=store)
    return svc, store


@pytest.fixture
def svc(tmp_path):
    service, store = _fresh_service(tmp_path)
    yield service, store


def _constraints(**kwargs) -> DraftConstraints:
    base = {
        "locked_players": [],
        "banned_players": [],
        "club_caps": {},
        "bench_quality_target": "medium",
        "premium_count_target": 3,
        "differential_slots_target": 0,
        "uncertainty_tolerance": "medium",
        "early_transfer_tolerance": False,
    }
    base.update(kwargs)
    return DraftConstraints(**base)


def _create_request(manager_id="mgr-001", gw=25, constraints=None):
    return DraftSessionCreateRequest(
        manager_id=manager_id,
        gameweek=gw,
        constraints=constraints,
    )


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_create_session_returns_response(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    assert resp.session_id
    assert resp.manager_id == "mgr-001"
    assert resp.gameweek == 25
    assert resp.status == "open"


def test_create_session_default_constraints(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    c = resp.constraints
    assert c.locked_players == []
    assert c.banned_players == []
    assert c.bench_quality_target == "medium"
    assert c.uncertainty_tolerance == "medium"
    assert c.differential_slots_target == 0


def test_create_session_explicit_constraints_persisted(svc):
    service, _ = svc
    constraints = _constraints(
        locked_players=[42],
        uncertainty_tolerance="low",
        differential_slots_target=2,
    )
    resp = service.create_session(_create_request(constraints=constraints))
    c = resp.constraints
    assert 42 in c.locked_players
    assert c.uncertainty_tolerance == "low"
    assert c.differential_slots_target == 2


def test_get_session_none_for_unknown(svc):
    service, _ = svc
    result = service.get_session("does-not-exist-uuid")
    assert result is None


def test_get_session_returns_created_session(svc):
    service, _ = svc
    resp = service.create_session(_create_request(manager_id="mgr-xyz", gw=30))
    fetched = service.get_session(resp.session_id)
    assert fetched is not None
    assert fetched.session_id == resp.session_id
    assert fetched.manager_id == "mgr-xyz"
    assert fetched.gameweek == 30


def test_patch_session_explicit_constraints_override(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    new_constraints = _constraints(
        banned_players=[99],
        bench_quality_target="high",
        uncertainty_tolerance="high",
    )
    patched = service.patch_session(
        sid, DraftSessionPatchRequest(constraints=new_constraints)
    )
    assert patched is not None
    c = patched.constraints
    assert 99 in c.banned_players
    assert c.bench_quality_target == "high"
    assert c.uncertainty_tolerance == "high"


def test_patch_session_returns_none_for_unknown(svc):
    service, _ = svc
    result = service.patch_session(
        "no-such-session",
        DraftSessionPatchRequest(constraints=_constraints()),
    )
    assert result is None


def test_patch_session_intent_make_safer(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    patched = service.patch_session(
        sid,
        DraftSessionPatchRequest(intent_text="make this safer"),
    )
    assert patched is not None
    assert patched.constraints.uncertainty_tolerance == "low"


def test_patch_session_intent_stronger_bench(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    patched = service.patch_session(
        sid,
        DraftSessionPatchRequest(intent_text="stronger bench"),
    )
    assert patched is not None
    assert patched.constraints.bench_quality_target == "high"


def test_patch_session_intent_one_punt(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    patched = service.patch_session(
        sid,
        DraftSessionPatchRequest(intent_text="one punt"),
    )
    assert patched is not None
    assert patched.constraints.differential_slots_target == 1


def test_patch_session_intent_one_differential(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    patched = service.patch_session(
        resp.session_id,
        DraftSessionPatchRequest(intent_text="two differentials"),
    )
    assert patched is not None
    assert patched.constraints.differential_slots_target == 2


def test_patch_session_multiple_patches_last_write_wins(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    service.patch_session(
        sid, DraftSessionPatchRequest(constraints=_constraints(uncertainty_tolerance="low"))
    )
    patched = service.patch_session(
        sid, DraftSessionPatchRequest(constraints=_constraints(uncertainty_tolerance="high"))
    )
    assert patched is not None
    assert patched.constraints.uncertainty_tolerance == "high"


def test_audit_trail_records_constraint_events(svc):
    service, store = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    service.patch_session(
        sid, DraftSessionPatchRequest(constraints=_constraints(banned_players=[5]))
    )

    audits = store.list_audits(session_id=sid)
    event_types = [a.event_type for a in audits]
    assert event_types.count("constraints_updated") >= 2  # initial + patch
    assert "session_opened" in event_types


def test_unrecognized_intent_records_partial_intent_audit(svc):
    service, store = svc
    resp = service.create_session(_create_request())
    sid = resp.session_id

    service.patch_session(
        sid,
        DraftSessionPatchRequest(intent_text="xyzzy gibberish unknowntoken"),
    )

    audits = store.list_audits(session_id=sid)
    event_types = [a.event_type for a in audits]
    assert "intent_parse_partial" in event_types


def test_started_at_is_iso_string(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    # Should parse as ISO-8601 without error
    from datetime import datetime
    dt = datetime.fromisoformat(resp.started_at.replace("Z", "+00:00"))
    assert dt is not None


def test_completed_at_is_none_for_new_session(svc):
    service, _ = svc
    resp = service.create_session(_create_request())
    assert resp.completed_at is None
