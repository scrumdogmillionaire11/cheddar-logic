from datetime import datetime, timedelta, timezone

from cheddar_fpl_sage.injury.processing import build_manual_injury_reports, resolve_injury_payloads
from cheddar_fpl_sage.models.injury_report import MANUAL_EXPIRY_HOURS


def _build_primary_payload(player_id: int, status: str, chance: int) -> dict:
    return {
        "schema_version": "1.0.0",
        "reports": [
            {
                "player_id": player_id,
                "status": status,
                "chance": chance,
                "source": "PRIMARY_FPL",
            }
        ],
    }


def test_manual_override_overrides_fpl_status():
    squad = [{"player_id": 100, "name": "Haaland"}]
    overrides = {
        "haaland": {
            "status_flag": "FIT",
            "chance_of_playing_next_round": 90,
        }
    }
    manual_reports = build_manual_injury_reports(overrides, squad, datetime.now(timezone.utc).isoformat())
    fpl_payload = _build_primary_payload(100, "OUT", 0)
    resolved, traces = resolve_injury_payloads(fpl_payload, {"reports": []}, manual_reports, expected_player_ids=[100])

    assert resolved[0]["status"] == "FIT"
    assert resolved[0]["source"] == "MANUAL_CONFIRMED"
    assert resolved[0]["confidence"] == "HIGH"
    assert traces[100], "Trace data should exist for resolved player"
    assert traces[100][0].startswith("MANUAL_CONFIRMED chosen")


def test_manual_override_confidence_degrades_after_expiry():
    squad = [{"player_id": 101, "name": "Salah"}]
    expired_time = (datetime.now(timezone.utc) - timedelta(hours=MANUAL_EXPIRY_HOURS + 1)).isoformat()
    overrides = {
        "salah": {
            "status_flag": "FIT",
            "chance_of_playing_next_round": 95,
            "asof_utc": expired_time,
        }
    }
    manual_reports = build_manual_injury_reports(overrides, squad, expired_time)
    fpl_payload = _build_primary_payload(101, "DOUBT", 40)
    resolved, _ = resolve_injury_payloads(fpl_payload, {"reports": []}, manual_reports, expected_player_ids=[101])

    assert resolved[0]["status"] == "FIT"
    assert resolved[0]["confidence"] == "LOW"


def test_unknown_when_no_sources_and_expected_ids_added():
    resolved, traces = resolve_injury_payloads({"reports": []}, {"reports": []}, [], expected_player_ids=[200])
    assert len(resolved) == 1
    assert resolved[0]["status"] == "UNKNOWN"
    assert resolved[0]["player_id"] == 200
    assert traces[200][0].startswith("UNKNOWN fallback")


def test_manual_reports_resolve_with_multiple_players():
    squad = [
        {"player_id": 300, "name": "Player A"},
        {"player_id": 301, "name": "Player B"},
    ]
    overrides = {
        "player a": {"status_flag": "OUT"},
        "player b": {"status_flag": "DOUBTFUL"},
    }
    manual_reports = build_manual_injury_reports(overrides, squad, datetime.now(timezone.utc).isoformat())
    payload = {"reports": []}
    resolved, _ = resolve_injury_payloads(payload, payload, manual_reports, expected_player_ids=[300, 301])

    assert resolved[0]["status"] == "OUT"
    assert resolved[1]["status"] == "DOUBTFUL"
