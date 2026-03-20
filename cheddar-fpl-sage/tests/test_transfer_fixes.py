"""
Optional smoke test for transfer recommendation deduplication behavior.

This test runs full analysis and is intentionally opt-in because it depends on
local team config and full pipeline execution.
"""

import json
import os
import sys
from pathlib import Path

import pytest


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_REAL_API_TESTS") != "1",
    reason="Real analysis smoke test. Set RUN_REAL_API_TESTS=1 to run.",
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))


def test_transfer_fixes_smoke():
    """Run full analysis and validate transfer summary structure."""
    from cheddar_fpl_sage import fpl_sage

    team_config_path = PROJECT_ROOT / "team_config.json"
    if not team_config_path.exists():
        pytest.skip("team_config.json not found for real analysis smoke test")

    with open(team_config_path, encoding="utf-8") as handle:
        team_config = json.load(handle)

    assert team_config.get("team_id"), "team_config.json missing team_id"

    result = fpl_sage.main()
    assert result, "Analysis execution failed"

    latest_file = PROJECT_ROOT / "outputs" / "LATEST.json"
    assert latest_file.exists(), "No analysis output found at outputs/LATEST.json"

    with open(latest_file, encoding="utf-8") as handle:
        data = json.load(handle)

    decision_summary = data.get("enhanced_decision_summary", "")
    assert isinstance(decision_summary, str)
    assert decision_summary

    transfer_plan_count = decision_summary.count("Transfer Plan")
    transfer_actions_count = decision_summary.count("Transfer Actions (Priority Order)")
    detailed_strategy_count = decision_summary.count("Detailed Upgrade Strategy")
    chase_inferred_count = decision_summary.count("CHASE (inferred)")

    assert transfer_plan_count <= 1
    assert transfer_actions_count == 0
    assert detailed_strategy_count == 0
    assert chase_inferred_count == 0
