import asyncio
import json
import sys
from pathlib import Path

PROJECT_SRC = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(PROJECT_SRC))
for module_name in list(sys.modules):
    if module_name == "cheddar_fpl_sage" or module_name.startswith(
        "cheddar_fpl_sage.",
    ):
        del sys.modules[module_name]

from cheddar_fpl_sage.collectors import weekly_bundle_collector


class _FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self._payload = payload

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def json(self):
        return self._payload


class _FakeClientSession:
    def __init__(self, payloads):
        self._payloads = payloads

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def get(self, url):
        if "bootstrap-static" in url:
            return _FakeResponse(200, self._payloads["bootstrap"])
        if "fixtures" in url:
            return _FakeResponse(200, self._payloads["fixtures"])
        if "events" in url:
            return _FakeResponse(200, self._payloads["events"])
        raise AssertionError(f"Unexpected URL fetched in test: {url}")


def test_collect_weekly_bundle_handles_deadline_time_formatted_without_datetime_unbound(
    monkeypatch,
    tmp_path,
):
    payloads = {
        "bootstrap": {"teams": [], "elements": []},
        "fixtures": [],
        "events": [
            {
                "id": 30,
                "is_current": True,
                "deadline_time_formatted": "Fri 14 Mar 2025-26",
            }
        ],
    }

    real_manager = weekly_bundle_collector.OutputBundleManager
    monkeypatch.setattr(
        weekly_bundle_collector,
        "OutputBundleManager",
        lambda: real_manager(base_dir=tmp_path / "outputs"),
    )
    monkeypatch.setattr(
        weekly_bundle_collector.aiohttp,
        "ClientSession",
        lambda: _FakeClientSession(payloads),
    )
    monkeypatch.setattr(
        weekly_bundle_collector,
        "load_secondary_injury_payload",
        lambda fallback_path=None: {"reports": []},
    )
    monkeypatch.setattr(
        weekly_bundle_collector,
        "build_fpl_injury_reports",
        lambda elements: [],
    )
    monkeypatch.setattr(
        weekly_bundle_collector,
        "build_injury_artifact_payload",
        lambda reports, run_id, label: {
            "run_id": run_id,
            "label": label,
            "reports": reports,
        },
    )

    paths = asyncio.run(
        weekly_bundle_collector.collect_weekly_bundle(
            team_id=None,
            target_gw=30,
            force_refresh=True,
            run_id="wi-0451-datetime-shadow-test",
        )
    )

    assert paths.collection_meta.exists()
    collection_meta = json.loads(paths.collection_meta.read_text())
    assert isinstance(collection_meta.get("collected_at"), str)
    assert collection_meta["collected_at"]
