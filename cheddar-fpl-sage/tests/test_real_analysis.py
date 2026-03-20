import asyncio
import os

import pytest

from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_REAL_API_TESTS") != "1",
    reason="Real FPL API smoke test. Set RUN_REAL_API_TESTS=1 to run.",
)


async def _run_real_analysis_smoke(team_id: int = 9137648) -> None:
    sage = FPLSageIntegration(team_id=team_id)
    results = await sage.run_full_analysis(save_data=False)
    assert isinstance(results, dict)
    assert results


def test_real_analysis_smoke() -> None:
    asyncio.run(_run_real_analysis_smoke())
