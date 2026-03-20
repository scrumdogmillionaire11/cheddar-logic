import asyncio
import os

import pytest

from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration
from backend.services.result_transformer import transform_analysis_results


pytestmark = pytest.mark.skipif(
    os.getenv("RUN_REAL_API_TESTS") != "1",
    reason="Real FPL API smoke test. Set RUN_REAL_API_TESTS=1 to run.",
)


async def _run_transformer_smoke() -> None:
    sage = FPLSageIntegration(team_id=9137648)
    results = await sage.run_full_analysis(save_data=False)
    transformed = transform_analysis_results(results)
    assert isinstance(transformed, dict)
    assert transformed


def test_result_transformer_smoke() -> None:
    asyncio.run(_run_transformer_smoke())
