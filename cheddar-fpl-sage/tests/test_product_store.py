"""Tests for WI-0652 durable product store.

Uses an isolated in-memory (tmp) store for every test to avoid disk
side effects and prevent cross-test interference.

Verifies:
- initialize() is idempotent and creates an empty-file store.
- CRUD for all six entity types (profiles, sessions, candidates, squads,
  audits, receipts).
- Deterministic ID/retrieval semantics.
- File round-trip: data survives serialize→deserialize.
- health() reports correct counts.
- Store is completely isolated from Redis/transient analysis-job state.
"""
import os
import pytest

from backend.models.product_models import (
    DecisionReceipt,
    DraftAudit,
    DraftCandidate,
    DraftSession,
    ManagerProfile,
    ParsedSquad,
    PRODUCT_SCHEMA_VERSION,
)
from backend.services.product_store import ProductStore


# ── Fixture: fresh isolated store per test ────────────────────────────────────


@pytest.fixture()
def store(tmp_path):
    """Return a fully initialized ProductStore backed by a temp file."""
    path = str(tmp_path / "test_product_store.json")
    s = ProductStore(store_path=path)
    s.initialize()
    return s


@pytest.fixture()
def profile(store) -> ManagerProfile:
    """Persist and return a test manager profile."""
    p = ManagerProfile(fpl_team_id=711511, team_name="Cheddar FC", player_name="Alex J")
    store.upsert_profile(p)
    return p


@pytest.fixture()
def session(store, profile) -> DraftSession:
    """Persist and return a test draft session."""
    s = DraftSession(manager_id=profile.manager_id, gameweek=30)
    store.create_session(s)
    return s


# ── initialize() ─────────────────────────────────────────────────────────────


def test_initialize_creates_file(tmp_path):
    path = str(tmp_path / "store.json")
    s = ProductStore(store_path=path)
    assert not os.path.exists(path)
    s.initialize()
    assert os.path.exists(path)


def test_initialize_is_idempotent(store):
    store.initialize()
    store.initialize()
    h = store.health()
    assert h["initialized"] is True


def test_initialize_loads_existing_data(tmp_path):
    path = str(tmp_path / "store.json")

    # Write first store
    s1 = ProductStore(store_path=path)
    s1.initialize()
    p = ManagerProfile(fpl_team_id=999, team_name="Replay FC", player_name="Reload")
    s1.upsert_profile(p)

    # Load fresh instance from same file
    s2 = ProductStore(store_path=path)
    s2.initialize()
    loaded = s2.get_profile(p.manager_id)
    assert loaded is not None
    assert loaded.fpl_team_id == 999
    assert loaded.team_name == "Replay FC"


# ── health() ─────────────────────────────────────────────────────────────────


def test_health_initialized_flag(store):
    h = store.health()
    assert h["initialized"] is True


def test_health_counts_reflect_inserts(store, profile, session):
    h = store.health()
    assert h["counts"]["manager_profiles"] == 1
    assert h["counts"]["draft_sessions"] == 1
    assert h["counts"]["draft_candidates"] == 0
    assert h["counts"]["parsed_squads"] == 0
    assert h["counts"]["draft_audits"] == 0
    assert h["counts"]["decision_receipts"] == 0


# ── Manager Profiles ──────────────────────────────────────────────────────────


def test_get_profile_returns_none_for_unknown(store):
    assert store.get_profile("nonexistent") is None


def test_get_profile_by_fpl_team_id(store, profile):
    found = store.get_profile_by_fpl_team_id(profile.fpl_team_id)
    assert found is not None
    assert found.manager_id == profile.manager_id


def test_get_profile_by_fpl_team_id_missing(store):
    assert store.get_profile_by_fpl_team_id(99999) is None


def test_list_profiles_empty(store):
    assert store.list_profiles() == []


def test_list_profiles_returns_all(store):
    for i in range(3):
        store.upsert_profile(ManagerProfile(fpl_team_id=i + 1, team_name=f"T{i}", player_name=f"P{i}"))
    assert len(store.list_profiles()) == 3


def test_upsert_profile_updates_existing(store, profile):
    profile.team_name = "Updated FC"
    store.upsert_profile(profile)
    reloaded = store.get_profile(profile.manager_id)
    assert reloaded is not None
    assert reloaded.team_name == "Updated FC"
    # Should still be only one entry
    assert len(store.list_profiles()) == 1


def test_profile_schema_version_preserved(store, profile):
    reloaded = store.get_profile(profile.manager_id)
    assert reloaded is not None
    assert reloaded.schema_version == PRODUCT_SCHEMA_VERSION


# ── Draft Sessions ────────────────────────────────────────────────────────────


def test_get_session_returns_none_for_unknown(store):
    assert store.get_session("nonexistent") is None


def test_list_sessions_filtered_by_manager(store, profile):
    other = ManagerProfile(fpl_team_id=2, team_name="Other FC", player_name="Other")
    store.upsert_profile(other)
    store.create_session(DraftSession(manager_id=profile.manager_id, gameweek=30))
    store.create_session(DraftSession(manager_id=profile.manager_id, gameweek=31))
    store.create_session(DraftSession(manager_id=other.manager_id, gameweek=30))
    mine = store.list_sessions(manager_id=profile.manager_id)
    assert len(mine) == 2
    assert all(s.manager_id == profile.manager_id for s in mine)


def test_update_session_status(store, session):
    session.status = "completed"
    store.update_session(session)
    reloaded = store.get_session(session.session_id)
    assert reloaded is not None
    assert reloaded.status == "completed"


def test_session_schema_version_preserved(store, session):
    reloaded = store.get_session(session.session_id)
    assert reloaded is not None
    assert reloaded.schema_version == PRODUCT_SCHEMA_VERSION


# ── Draft Candidates ──────────────────────────────────────────────────────────


def _candidate(session_id: str, **kwargs) -> DraftCandidate:
    defaults = dict(
        session_id=session_id,
        fpl_player_id=303,
        player_name="Salah",
        position="MID",
        team_short="LIV",
    )
    return DraftCandidate(**{**defaults, **kwargs})


def test_add_and_get_candidate(store, session):
    c = _candidate(session.session_id)
    store.add_candidate(c)
    loaded = store.get_candidate(c.candidate_id)
    assert loaded is not None
    assert loaded.player_name == "Salah"


def test_get_candidate_returns_none_for_unknown(store):
    assert store.get_candidate("nonexistent") is None


def test_list_candidates_filtered_by_session(store, profile):
    s1 = DraftSession(manager_id=profile.manager_id, gameweek=30)
    s2 = DraftSession(manager_id=profile.manager_id, gameweek=31)
    store.create_session(s1)
    store.create_session(s2)
    store.add_candidate(_candidate(s1.session_id, fpl_player_id=1))
    store.add_candidate(_candidate(s1.session_id, fpl_player_id=2))
    store.add_candidate(_candidate(s2.session_id, fpl_player_id=3))
    assert len(store.list_candidates(session_id=s1.session_id)) == 2
    assert len(store.list_candidates(session_id=s2.session_id)) == 1


def test_candidate_schema_version_preserved(store, session):
    c = _candidate(session.session_id)
    store.add_candidate(c)
    loaded = store.get_candidate(c.candidate_id)
    assert loaded is not None
    assert loaded.schema_version == PRODUCT_SCHEMA_VERSION


# ── Parsed Squads ─────────────────────────────────────────────────────────────


def test_save_and_get_squad(store, session):
    players = [{"fpl_player_id": 303, "position": "MID"}]
    sq = ParsedSquad(session_id=session.session_id, players=players)
    store.save_squad(sq)
    loaded = store.get_squad(sq.squad_id)
    assert loaded is not None
    assert len(loaded.players) == 1


def test_get_squad_returns_none_for_unknown(store):
    assert store.get_squad("nonexistent") is None


def test_list_squads_filtered_by_session(store, profile):
    s1 = DraftSession(manager_id=profile.manager_id, gameweek=30)
    s2 = DraftSession(manager_id=profile.manager_id, gameweek=31)
    store.create_session(s1)
    store.create_session(s2)
    store.save_squad(ParsedSquad(session_id=s1.session_id))
    store.save_squad(ParsedSquad(session_id=s2.session_id))
    assert len(store.list_squads(session_id=s1.session_id)) == 1
    assert len(store.list_squads(session_id=s2.session_id)) == 1


def test_squad_schema_version_preserved(store, session):
    sq = ParsedSquad(session_id=session.session_id)
    store.save_squad(sq)
    loaded = store.get_squad(sq.squad_id)
    assert loaded is not None
    assert loaded.schema_version == PRODUCT_SCHEMA_VERSION


# ── Draft Audits ──────────────────────────────────────────────────────────────


def test_append_and_list_audits(store, session):
    store.append_audit(DraftAudit(session_id=session.session_id, event_type="session_opened"))
    store.append_audit(DraftAudit(session_id=session.session_id, event_type="candidate_added", payload={"fpl_player_id": 303}))
    audits = store.list_audits(session_id=session.session_id)
    assert len(audits) == 2
    event_types = {a.event_type for a in audits}
    assert "session_opened" in event_types
    assert "candidate_added" in event_types


def test_audit_with_payload_round_trips(store, session):
    a = DraftAudit(session_id=session.session_id, event_type="square_parsed", payload={"player_count": 15})
    store.append_audit(a)
    loaded_list = store.list_audits(session_id=session.session_id)
    assert len(loaded_list) == 1
    assert loaded_list[0].payload["player_count"] == 15


def test_list_audits_unfiltered(store, profile):
    s1 = DraftSession(manager_id=profile.manager_id, gameweek=30)
    s2 = DraftSession(manager_id=profile.manager_id, gameweek=31)
    store.create_session(s1)
    store.create_session(s2)
    store.append_audit(DraftAudit(session_id=s1.session_id, event_type="e1"))
    store.append_audit(DraftAudit(session_id=s2.session_id, event_type="e2"))
    assert len(store.list_audits()) == 2


def test_audit_schema_version_preserved(store, session):
    a = DraftAudit(session_id=session.session_id, event_type="x")
    store.append_audit(a)
    loaded = store.list_audits(session_id=session.session_id)
    assert loaded[0].schema_version == PRODUCT_SCHEMA_VERSION


# ── Decision Receipts ─────────────────────────────────────────────────────────


def _receipt(session_id: str, manager_id: str, **kwargs) -> DecisionReceipt:
    defaults = dict(
        session_id=session_id,
        manager_id=manager_id,
        decision_type="captain",
        rationale="Best run-in",
    )
    return DecisionReceipt(**{**defaults, **kwargs})


def test_save_and_get_receipt(store, session, profile):
    r = _receipt(session.session_id, profile.manager_id)
    store.save_receipt(r)
    loaded = store.get_receipt(r.receipt_id)
    assert loaded is not None
    assert loaded.decision_type == "captain"
    assert loaded.rationale == "Best run-in"


def test_get_receipt_returns_none_for_unknown(store):
    assert store.get_receipt("nonexistent") is None


def test_list_receipts_by_session(store, session, profile):
    r1 = _receipt(session.session_id, profile.manager_id, decision_type="captain")
    r2 = _receipt(session.session_id, profile.manager_id, decision_type="transfer")
    store.save_receipt(r1)
    store.save_receipt(r2)
    receipts = store.list_receipts(session_id=session.session_id)
    assert len(receipts) == 2


def test_list_receipts_by_manager(store, profile):
    s1 = DraftSession(manager_id=profile.manager_id, gameweek=30)
    other = ManagerProfile(fpl_team_id=2, team_name="Other FC", player_name="Other")
    s2 = DraftSession(manager_id=other.manager_id, gameweek=30)
    store.upsert_profile(other)
    store.create_session(s1)
    store.create_session(s2)
    store.save_receipt(_receipt(s1.session_id, profile.manager_id))
    store.save_receipt(_receipt(s2.session_id, other.manager_id))
    mine = store.list_receipts(manager_id=profile.manager_id)
    assert len(mine) == 1
    assert mine[0].manager_id == profile.manager_id


def test_receipt_schema_version_preserved(store, session, profile):
    r = _receipt(session.session_id, profile.manager_id)
    store.save_receipt(r)
    loaded = store.get_receipt(r.receipt_id)
    assert loaded is not None
    assert loaded.schema_version == PRODUCT_SCHEMA_VERSION


# ── File round-trip ───────────────────────────────────────────────────────────


def test_file_roundtrip_all_entities(tmp_path):
    path = str(tmp_path / "roundtrip.json")
    s1 = ProductStore(store_path=path)
    s1.initialize()

    p = ManagerProfile(fpl_team_id=42, team_name="Round FC", player_name="Trip")
    sess = DraftSession(manager_id=p.manager_id, gameweek=25)
    cand = DraftCandidate(session_id=sess.session_id, fpl_player_id=100, player_name="X", position="FWD", team_short="ARS")
    squad = ParsedSquad(session_id=sess.session_id, players=[{"x": 1}])
    audit = DraftAudit(session_id=sess.session_id, event_type="test")
    receipt = DecisionReceipt(session_id=sess.session_id, manager_id=p.manager_id, decision_type="chip", rationale="Good chip window")

    s1.upsert_profile(p)
    s1.create_session(sess)
    s1.add_candidate(cand)
    s1.save_squad(squad)
    s1.append_audit(audit)
    s1.save_receipt(receipt)

    # Reload fresh
    s2 = ProductStore(store_path=path)
    s2.initialize()

    assert s2.get_profile(p.manager_id) is not None
    assert s2.get_session(sess.session_id) is not None
    assert s2.get_candidate(cand.candidate_id) is not None
    assert s2.get_squad(squad.squad_id) is not None
    assert len(s2.list_audits(session_id=sess.session_id)) == 1
    assert s2.get_receipt(receipt.receipt_id) is not None


# ── Isolation: store does not touch Redis or analysis-job state ───────────────


def test_store_has_no_redis_attribute(store):
    """ProductStore must not have a redis attribute (separation of concerns)."""
    assert not hasattr(store, "redis")


def test_store_has_no_cache_service_dependency(store):
    """ProductStore must be independent of cache_service."""
    import backend.services.product_store as ps_module
    import inspect
    source = inspect.getsource(ps_module)
    assert "cache_service" not in source
    assert "redis" not in source.lower()


def test_store_init_does_not_require_redis(tmp_path):
    """Store initializes cleanly with no Redis available."""
    path = str(tmp_path / "no_redis.json")
    s = ProductStore(store_path=path)
    s.initialize()
    assert s.health()["initialized"] is True
