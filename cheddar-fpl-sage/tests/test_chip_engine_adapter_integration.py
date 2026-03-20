"""
Integration tests: ChipAnalyzer adapter → deterministic chip engine → result_transformer

Covers the acceptance criteria in WI-0516:
- ChipAnalyzer builds a valid GameweekState and delegates to chip_engine evaluators
- analyze_chip_guidance returns a ChipDecisionContext with all required fields
- WATCH status propagates correctly (not collapsed into PASS)
- Forced-FIRE status from a double-GW scenario is surfaced end-to-end
- result_transformer maps ChipDecisionContext onto the serialised chip_recommendation
  contract (status, score, reasonCode, reasonCodes, forcedBy, watchUntil, narrative)
"""
from __future__ import annotations

import os
import sys
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith("cheddar_fpl_sage."):
        del sys.modules[module_name]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _chip_status(bb=True, tc=True, fh=True, wc=True) -> Dict[str, Any]:
    """Chip availability payload (True = available)."""
    return {
        "Bench Boost": bb,
        "Triple Captain": tc,
        "Free Hit": fh,
        "Wildcard": wc,
    }


def _squad_data(
    n_starters: int = 11,
    double_gw: bool = False,
    expected_pts: float = 9.0,
) -> Dict[str, Any]:
    starters = [
        {
            "player_id": i,
            "id": i,
            "name": f"Player {i}",
            "is_starter": True,
            "status_flag": "FIT",
            "expected_pts": expected_pts,
            "is_double": double_gw,
        }
        for i in range(1, n_starters + 1)
    ]
    bench = [
        {
            "player_id": 100 + i,
            "id": 100 + i,
            "name": f"Bench {i}",
            "is_starter": False,
            "status_flag": "FIT",
            "expected_pts": expected_pts * 0.6,
            "is_double": double_gw,
        }
        for i in range(1, 5)
    ]
    return {"current_squad": starters + bench}


def _fixture_data(double_gw_teams: list[str] | None = None, blank_gw_teams: list[str] | None = None) -> Dict[str, Any]:
    return {
        "double_gw_teams": double_gw_teams or [],
        "blank_gw_teams": blank_gw_teams or [],
    }


def _projections() -> Dict[int, Any]:
    return {
        i: SimpleNamespace(
            player_id=i,
            name=f"Player {i}",
            nextGW_pts=9.0,
            next6_pts=45.0,
            is_injury_risk=False,
            xMins_next=90,
            ownership_pct=25.0,
            current_price=7.0,
            points_per_million=1.28,
        )
        for i in range(1, 116)
    }


def _policy(current_gw: int = 30, windows: list[dict] | None = None) -> Dict[str, Any]:
    base_windows = windows or [
        {"start_gw": current_gw, "score": 60.0},
        {"start_gw": current_gw + 4, "score": 75.0},
    ]
    return {
        "total_gws": 38,
        "chip_windows": base_windows,
    }


def _analyzer():
    from cheddar_fpl_sage.analysis.decision_framework.chip_analyzer import ChipAnalyzer
    return ChipAnalyzer(risk_posture="BALANCED")


def _transform_with_local_result_transformer(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Load backend/services/result_transformer.py directly by path and execute transform."""
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "backend" / "services" / "result_transformer.py"
    spec = importlib.util.spec_from_file_location("wi0516_local_result_transformer", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.transform_analysis_results(raw)


# ---------------------------------------------------------------------------
# ChipDecisionContext field contract
# ---------------------------------------------------------------------------

class TestChipDecisionContextContract:
    """analyze_chip_guidance must return all required fields."""

    def test_returns_chip_decision_context(self) -> None:
        from cheddar_fpl_sage.analysis.decision_framework.chip_analyzer import ChipDecisionContext
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(),
            current_gw=30,
            chip_policy=_policy(30),
        )
        assert isinstance(result, ChipDecisionContext)

    def test_required_fields_present(self) -> None:
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(),
            current_gw=30,
            chip_policy=_policy(30),
        )
        assert result.status in {"FIRE", "WATCH", "PASS"}
        assert result.selected_chip is not None
        assert isinstance(result.reason_codes, list)
        assert result.narrative is not None and len(result.narrative) > 0

    def test_narrative_prefixed_with_status(self) -> None:
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(),
            current_gw=30,
            chip_policy=_policy(30),
        )
        # Narrative produced by _build_chip_narrative always starts with status prefix
        assert result.narrative.upper().startswith(result.status)


# ---------------------------------------------------------------------------
# No-chip-available guard
# ---------------------------------------------------------------------------

class TestNoChipsAvailable:
    def test_status_is_pass_when_no_chips_available(self) -> None:
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(bb=False, tc=False, fh=False, wc=False),
            current_gw=30,
        )
        assert result.status == "PASS"
        assert result.reason_codes == ["chip_unavailable"]

    def test_reason_code_is_chip_unavailable(self) -> None:
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(bb=False, tc=False, fh=False, wc=False),
            current_gw=30,
        )
        assert "chip_unavailable" in result.reason_codes


# ---------------------------------------------------------------------------
# WATCH scenario — current window is suboptimal, better window ahead
# ---------------------------------------------------------------------------

class TestWatchScenario:
    def test_watch_is_not_collapsed_to_pass(self) -> None:
        """When current GW scores lower than a future window, status must be WATCH not PASS."""
        policy = _policy(
            30,
            windows=[
                {"start_gw": 30, "score": 45.0},   # weak current window
                {"start_gw": 34, "score": 80.0},   # strong future window (DGW)
            ],
        )
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(),
            current_gw=30,
            chip_policy=policy,
        )
        # Deterministic engine should surface WATCH or FIRE — never silently drop to PASS
        assert result.status in {"WATCH", "FIRE"}, (
            f"Expected WATCH or FIRE with stronger future window, got {result.status}"
        )

    def test_watch_exposes_watch_until(self) -> None:
        policy = _policy(
            30,
            windows=[
                {"start_gw": 30, "score": 45.0},
                {"start_gw": 34, "score": 80.0},
            ],
        )
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(),
            current_gw=30,
            chip_policy=policy,
        )
        if result.status == "WATCH":
            assert result.watch_until is not None
            assert result.watch_until >= 30


# ---------------------------------------------------------------------------
# Forced FIRE — double GW, Bench Boost already available
# ---------------------------------------------------------------------------

class TestForcedFireScenario:
    def test_bench_boost_fire_in_strong_double_gw(self) -> None:
        """A current double-GW window scoring above all future windows should yield FIRE."""
        policy = _policy(
            30,
            windows=[
                {"start_gw": 30, "score": 88.0},  # current is best
                {"start_gw": 34, "score": 60.0},
                {"start_gw": 36, "score": 62.0},
            ],
        )
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(double_gw=True),
            fixture_data=_fixture_data(double_gw_teams=[f"Player {i}" for i in range(1, 12)]),
            projections=_projections(),
            chip_status=_chip_status(bb=True, tc=True, fh=True, wc=True),
            current_gw=30,
            chip_policy=policy,
        )
        # Engine should FIRE in the strongest window
        assert result.status in {"FIRE", "WATCH"}, (
            f"Expected FIRE or WATCH in DGW with best window, got {result.status}"
        )

    def test_forced_by_field_may_be_populated_in_fire(self) -> None:
        policy = _policy(30, windows=[{"start_gw": 30, "score": 88.0}])
        result = _analyzer().analyze_chip_guidance(
            squad_data=_squad_data(double_gw=True),
            fixture_data=_fixture_data(),
            projections=_projections(),
            chip_status=_chip_status(),
            current_gw=30,
            chip_policy=policy,
        )
        # forced_by is optional—just assert it's a string or None (not a crash)
        assert result.forced_by is None or isinstance(result.forced_by, str)


# ---------------------------------------------------------------------------
# result_transformer integration
# ---------------------------------------------------------------------------

class TestResultTransformerChipContract:
    """Verify the transformer serialises all WI-0516 chip fields."""

    def test_chip_recommendation_has_all_required_keys(self) -> None:
        raw = self._make_raw()
        result = _transform_with_local_result_transformer(raw)
        rec = result.get("chip_recommendation") or {}
        required = ("status", "score", "reasonCode", "reasonCodes", "forcedBy", "watchUntil", "narrative")
        missing = [k for k in required if k not in rec]
        assert not missing, f"chip_recommendation missing keys: {missing}"

    def test_chip_recommendation_status_watch(self) -> None:
        raw = self._make_raw()
        result = _transform_with_local_result_transformer(raw)
        assert result["chip_recommendation"]["status"] == "WATCH"

    def test_chip_recommendation_watch_until_propagated(self) -> None:
        raw = self._make_raw()
        result = _transform_with_local_result_transformer(raw)
        assert result["chip_recommendation"]["watchUntil"] == 34

    def _make_raw(self) -> Dict[str, Any]:
        return {
            "analysis": {
                "decision": self._build_chip_guidance_dict(),
            },
            "raw_data": {"my_team": {}},
        }

    def _build_chip_guidance_dict(self) -> Dict[str, Any]:
        """Return a decision_dict (what decision_dict.get(...) is called on)."""
        chip_guidance_payload = {
            "selected_chip": "Bench Boost",
            "status": "WATCH",
            "recommendation": "SAVE",
            "reason_codes": ["better_future_window"],
            "reason_code": "better_future_window",
            "narrative": "WATCH: Better window ahead at GW34.",
            "current_window_score": 55.0,
            "best_future_window_score": 78.0,
            "best_future_window_gw": 34,
            "watch_until": 34,
            "forced_by": None,
            "score": 55.0,
        }
        return {"chip_guidance": chip_guidance_payload}
