import asyncio
import os

import pytest

from cheddar_fpl_sage.collectors.enhanced_fpl_collector import EnhancedFPLCollector


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_REAL_API_TESTS") != "1",
    reason="Real FPL API smoke test. Set RUN_REAL_API_TESTS=1 to run.",
)


async def _run_manager_name_smoke() -> None:
    async with EnhancedFPLCollector(team_id=711511) as collector:
        team_data = await collector.get_team_data(team_id=711511)
    assert "team_info" in team_data
    assert team_data["team_info"].get("manager_name")


def test_manager_name_smoke() -> None:
    asyncio.run(_run_manager_name_smoke())
