"""Tests for WI-0652 versioned product contract models.

Verifies:
- All six contract types instantiate with expected defaults.
- schema_version is always PRODUCT_SCHEMA_VERSION.
- Primary-key IDs are UUIDs (auto-generated and unique).
- Timestamps are UTC-aware datetimes.
- Literal field constraints are enforced.
"""
import re
import pytest

from backend.models.product_models import (
    PRODUCT_SCHEMA_VERSION,
    DecisionReceipt,
    DraftAudit,
    DraftCandidate,
    DraftSession,
    ManagerProfile,
    ParsedSquad,
)

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# ── Helpers ───────────────────────────────────────────────────────────────────


def _make_profile(**kwargs) -> ManagerProfile:
    defaults = dict(fpl_team_id=711511, team_name="Cheddar FC", player_name="Alex J")
    return ManagerProfile(**{**defaults, **kwargs})


def _make_session(manager_id: str, **kwargs) -> DraftSession:
    defaults = dict(manager_id=manager_id, gameweek=30)
    return DraftSession(**{**defaults, **kwargs})


# ── PRODUCT_SCHEMA_VERSION ─────────────────────────────────────────────────


def test_schema_version_is_string():
    assert isinstance(PRODUCT_SCHEMA_VERSION, str)
    assert len(PRODUCT_SCHEMA_VERSION) > 0


# ── ManagerProfile ────────────────────────────────────────────────────────────


def test_manager_profile_defaults():
    p = _make_profile()
    assert UUID_RE.match(p.manager_id), f"manager_id not UUID: {p.manager_id}"
    assert p.schema_version == PRODUCT_SCHEMA_VERSION
    assert p.registered_at.tzinfo is not None
    assert p.updated_at.tzinfo is not None
    assert p.fpl_team_id == 711511
    assert p.team_name == "Cheddar FC"
    assert p.player_name == "Alex J"


def test_manager_profile_ids_are_unique():
    ids = {_make_profile().manager_id for _ in range(50)}
    assert len(ids) == 50


def test_manager_profile_custom_id():
    custom = "my-custom-id"
    p = _make_profile(manager_id=custom)
    assert p.manager_id == custom


# ── DraftSession ──────────────────────────────────────────────────────────────


def test_draft_session_defaults():
    p = _make_profile()
    s = _make_session(p.manager_id)
    assert UUID_RE.match(s.session_id)
    assert s.manager_id == p.manager_id
    assert s.gameweek == 30
    assert s.status == "open"
    assert s.completed_at is None
    assert s.schema_version == PRODUCT_SCHEMA_VERSION
    assert s.started_at.tzinfo is not None


def test_draft_session_status_literals():
    p = _make_profile()
    for status in ("open", "completed", "abandoned"):
        s = _make_session(p.manager_id, status=status)
        assert s.status == status


def test_draft_session_invalid_status_raises():
    p = _make_profile()
    with pytest.raises(Exception):  # pydantic ValidationError
        _make_session(p.manager_id, status="in_progress")  # type: ignore


def test_draft_session_gameweek_bounds():
    p = _make_profile()
    with pytest.raises(Exception):
        _make_session(p.manager_id, gameweek=0)
    with pytest.raises(Exception):
        _make_session(p.manager_id, gameweek=39)


# ── DraftCandidate ────────────────────────────────────────────────────────────


def _make_candidate(session_id: str, **kwargs) -> DraftCandidate:
    defaults = dict(
        session_id=session_id,
        fpl_player_id=303,
        player_name="Mohamed Salah",
        position="MID",
        team_short="LIV",
    )
    return DraftCandidate(**{**defaults, **kwargs})


def test_draft_candidate_defaults():
    p = _make_profile()
    s = _make_session(p.manager_id)
    c = _make_candidate(s.session_id)
    assert UUID_RE.match(c.candidate_id)
    assert c.session_id == s.session_id
    assert c.recommended is False
    assert c.score is None
    assert c.rationale is None
    assert c.schema_version == PRODUCT_SCHEMA_VERSION


def test_draft_candidate_position_literals():
    p = _make_profile()
    s = _make_session(p.manager_id)
    for pos in ("GKP", "DEF", "MID", "FWD"):
        c = _make_candidate(s.session_id, position=pos)
        assert c.position == pos


def test_draft_candidate_invalid_position_raises():
    p = _make_profile()
    s = _make_session(p.manager_id)
    with pytest.raises(Exception):
        _make_candidate(s.session_id, position="ATT")  # type: ignore


def test_draft_candidate_with_score_and_rationale():
    p = _make_profile()
    s = _make_session(p.manager_id)
    c = _make_candidate(s.session_id, recommended=True, score=8.4, rationale="Great run-in")
    assert c.recommended is True
    assert c.score == pytest.approx(8.4)
    assert c.rationale is not None and "run-in" in c.rationale


# ── ParsedSquad ───────────────────────────────────────────────────────────────


def test_parsed_squad_defaults():
    p = _make_profile()
    s = _make_session(p.manager_id)
    sq = ParsedSquad(session_id=s.session_id)
    assert UUID_RE.match(sq.squad_id)
    assert sq.source_type == "api"
    assert sq.players == []
    assert sq.raw_input is None
    assert sq.parsed_at.tzinfo is not None
    assert sq.schema_version == PRODUCT_SCHEMA_VERSION


def test_parsed_squad_source_types():
    p = _make_profile()
    s = _make_session(p.manager_id)
    for src in ("screenshot", "manual", "api"):
        sq = ParsedSquad(session_id=s.session_id, source_type=src)
        assert sq.source_type == src


def test_parsed_squad_with_players():
    p = _make_profile()
    s = _make_session(p.manager_id)
    players = [{"fpl_player_id": 303, "name": "Salah", "position": "MID"}]
    sq = ParsedSquad(session_id=s.session_id, players=players, raw_input="GW30 squad")
    assert len(sq.players) == 1
    assert sq.raw_input == "GW30 squad"


# ── DraftAudit ────────────────────────────────────────────────────────────────


def test_draft_audit_defaults():
    p = _make_profile()
    s = _make_session(p.manager_id)
    a = DraftAudit(session_id=s.session_id, event_type="session_opened")
    assert UUID_RE.match(a.audit_id)
    assert a.event_type == "session_opened"
    assert a.payload == {}
    assert a.occurred_at.tzinfo is not None
    assert a.schema_version == PRODUCT_SCHEMA_VERSION


def test_draft_audit_with_payload():
    p = _make_profile()
    s = _make_session(p.manager_id)
    a = DraftAudit(
        session_id=s.session_id,
        event_type="candidate_added",
        payload={"fpl_player_id": 303, "player_name": "Salah"},
    )
    assert a.payload["fpl_player_id"] == 303


def test_draft_audit_ids_are_unique():
    p = _make_profile()
    s = _make_session(p.manager_id)
    ids = {DraftAudit(session_id=s.session_id, event_type="x").audit_id for _ in range(20)}
    assert len(ids) == 20


# ── DecisionReceipt ───────────────────────────────────────────────────────────


def _make_receipt(session_id: str, manager_id: str, **kwargs) -> DecisionReceipt:
    defaults = dict(
        session_id=session_id,
        manager_id=manager_id,
        decision_type="captain",
        rationale="Best run-in for GW30",
    )
    return DecisionReceipt(**{**defaults, **kwargs})


def test_decision_receipt_defaults():
    p = _make_profile()
    s = _make_session(p.manager_id)
    r = _make_receipt(s.session_id, p.manager_id)
    assert UUID_RE.match(r.receipt_id)
    assert r.decision_type == "captain"
    assert r.payload == {}
    assert r.issued_at.tzinfo is not None
    assert r.schema_version == PRODUCT_SCHEMA_VERSION


def test_decision_receipt_with_payload():
    p = _make_profile()
    s = _make_session(p.manager_id)
    r = _make_receipt(
        s.session_id,
        p.manager_id,
        decision_type="transfer",
        payload={"player_out": 303, "player_in": 328},
    )
    assert r.decision_type == "transfer"
    assert r.payload["player_in"] == 328


def test_decision_receipt_ids_unique():
    p = _make_profile()
    s = _make_session(p.manager_id)
    ids = {_make_receipt(s.session_id, p.manager_id).receipt_id for _ in range(20)}
    assert len(ids) == 20


# ── Cross-contract: schema_version consistency ────────────────────────────────


def test_all_contracts_carry_schema_version():
    p = _make_profile()
    s = _make_session(p.manager_id)
    c = _make_candidate(s.session_id)
    sq = ParsedSquad(session_id=s.session_id)
    a = DraftAudit(session_id=s.session_id, event_type="e")
    r = _make_receipt(s.session_id, p.manager_id)

    for obj in (p, s, c, sq, a, r):
        assert obj.schema_version == PRODUCT_SCHEMA_VERSION, (
            f"{type(obj).__name__}.schema_version mismatch"
        )
