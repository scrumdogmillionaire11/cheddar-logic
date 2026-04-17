from copy import deepcopy

import pytest
from pydantic import ValidationError

from backend.models.api_models import AnalysisStatus, WeeklyAnalysisPayload


def _canonical_payload() -> dict:
    return {
        "weekly_review": {
            "version": "v1",
            "summary": "Small red arrow but process quality stayed strong.",
            "highlights": ["Captain blank was the only major miss"],
            "metrics": {"gw_points": 58, "rank_delta": -42000},
        },
        "squad_state": {
            "version": "v1",
            "summary": "Starting XI is stable with one flagged defender.",
            "highlights": ["Bank balance allows one premium move"],
            "metrics": {"injured": 1, "doubtful": 1},
        },
        "gameweek_plan": {
            "version": "v1",
            "summary": "Roll if no late injury update appears.",
            "highlights": ["Prioritize flexibility into next double"],
            "metrics": {"free_transfers": 1},
        },
        "transfer_recommendation": {
            "version": "v1",
            "summary": "Primary route upgrades third attacker slot.",
            "highlights": ["Net gain projects at +3.2 over 4 GWs"],
            "metrics": {"expected_gain_4gw": 3.2},
        },
        "captaincy": {
            "version": "v1",
            "summary": "Back the highest xMins + xGI profile this week.",
            "highlights": ["Vice remains safe-floor cover"],
            "metrics": {"captain_delta": 1.4},
        },
        "chip_strategy": {
            "version": "v1",
            "summary": "No chip this week; preserve optionality.",
            "highlights": ["Bench Boost window improves in two GWs"],
            "metrics": {"status": "PASS"},
        },
        "horizon_watch": {
            "version": "v1",
            "summary": "Two-week fixture swing favors current defensive core.",
            "highlights": ["Monitor one mid-price forward role"],
            "metrics": {"swing_gw": 35},
        },
        "decision_confidence": {
            "version": "v1",
            "confidence": "MEDIUM",
            "score": 72.5,
            "rationale": "Core assumptions are stable, but injury news pending.",
            "signals": ["fit_starters", "transfer_threshold_margin"],
        },
    }


def test_weekly_analysis_payload_accepts_canonical_shape() -> None:
    payload = WeeklyAnalysisPayload.model_validate(_canonical_payload())

    assert payload.weekly_review.summary.startswith("Small red arrow")
    assert payload.transfer_recommendation.metrics["expected_gain_4gw"] == 3.2
    assert payload.decision_confidence.score == pytest.approx(72.5)


def test_weekly_analysis_payload_requires_all_top_level_cards() -> None:
    payload = _canonical_payload()
    payload.pop("horizon_watch")

    with pytest.raises(ValidationError):
        WeeklyAnalysisPayload.model_validate(payload)


def test_weekly_analysis_payload_rejects_unknown_top_level_keys() -> None:
    payload = _canonical_payload()
    payload["legacy_summary"] = {"summary": "deprecated"}

    with pytest.raises(ValidationError):
        WeeklyAnalysisPayload.model_validate(payload)


def test_weekly_analysis_payload_rejects_unknown_nested_keys() -> None:
    payload = _canonical_payload()
    payload["weekly_review"]["unexpected"] = "not-allowed"

    with pytest.raises(ValidationError):
        WeeklyAnalysisPayload.model_validate(payload)


def test_weekly_analysis_payload_requires_card_level_required_fields() -> None:
    payload = _canonical_payload()
    payload["weekly_review"].pop("summary")

    with pytest.raises(ValidationError):
        WeeklyAnalysisPayload.model_validate(payload)

    payload = _canonical_payload()
    payload["decision_confidence"].pop("confidence")

    with pytest.raises(ValidationError):
        WeeklyAnalysisPayload.model_validate(payload)


def test_weekly_analysis_payload_supports_additive_aliases() -> None:
    payload = _canonical_payload()
    alias_payload = {
        "weeklyReview": payload["weekly_review"],
        "squadState": payload["squad_state"],
        "gameweekPlan": payload["gameweek_plan"],
        "transferRecommendation": payload["transfer_recommendation"],
        "captaincy": payload["captaincy"],
        "chipStrategy": payload["chip_strategy"],
        "horizonWatch": payload["horizon_watch"],
        "decisionConfidence": {
            "version": "v1",
            "confidence": "HIGH",
            "confidence_score": 88,
            "rationale": "Alias fixture should parse into canonical fields.",
            "signals": ["alias_path"],
        },
    }
    alias_payload["weeklyReview"] = deepcopy(alias_payload["weeklyReview"])
    alias_payload["weeklyReview"].pop("highlights")
    alias_payload["weeklyReview"]["key_points"] = ["Alias key maps to highlights"]

    parsed = WeeklyAnalysisPayload.model_validate(alias_payload)

    assert parsed.weekly_review.highlights == ["Alias key maps to highlights"]
    assert parsed.decision_confidence.score == pytest.approx(88)


def test_analysis_status_results_is_typed_payload() -> None:
    status = AnalysisStatus.model_validate(
        {
            "status": "complete",
            "results": _canonical_payload(),
        }
    )

    assert status.results is not None
    assert status.results.decision_confidence.confidence == "MEDIUM"
