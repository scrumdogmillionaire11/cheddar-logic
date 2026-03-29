import asyncio
from pathlib import Path
from datetime import datetime, timezone

from cheddar_fpl_sage.collectors.weekly_bundle_collector import BundlePaths
from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration
from cheddar_fpl_sage.validation.data_gate import GateResult
from cheddar_fpl_sage.utils.output_manager import OutputBundleManager, write_json_atomic


def _make_bundle(tmp_path: Path, target_gw: int = 1) -> BundlePaths:
    run_id = "test_run"
    data_dir = tmp_path / "data_collections"
    return BundlePaths(
        team_id=123,
        run_id=run_id,
        run_dir=tmp_path,
        bootstrap_static=data_dir / "bootstrap_static.json",
        fixtures=data_dir / "fixtures.json",
        events=data_dir / "events.json",
        team_picks=data_dir / "team_picks.json",
        slate=data_dir / f"slate_gw{target_gw}.json",
        collection_meta=data_dir / "collection_meta.json",
        entry_info=data_dir / "entry_info.json",
        injury_fpl=data_dir / "injury_fpl.json",
        injury_secondary=data_dir / "injury_secondary.json",
        injury_manual=data_dir / "injury_manual.json",
        injury_resolved=data_dir / "injury_resolved.json",
    )


def test_orchestrator_smoke_pass(monkeypatch, tmp_path):
    target_gw = 1
    bundle = _make_bundle(tmp_path, target_gw)
    now = datetime.now(timezone.utc).isoformat()
    monkeypatch.chdir(tmp_path)

    # Write bundle artifacts
    teams = [{"id": 1, "short_name": "AAA"}, {"id": 2, "short_name": "BBB"}]
    elements = []
    # 15 players
    for pid in range(1, 16):
        pos_code = (
            "GK" if pid <= 2 else
            "DEF" if pid <= 7 else
            "MID" if pid <= 12 else
            "FWD"
        )
        elements.append({
            "id": pid,
            "web_name": f"P{pid}",
            "team": 1 if pid <= 8 else 2,
            "element_type": (
                1 if pid <= 2 else
                2 if pid <= 7 else
                3 if pid <= 12 else
                4
            ),
            "position": pos_code,
            "now_cost": 50,
            "status": "a",
            "chance_of_playing_next_round": 100,
            "news": "",
        })
    write_json_atomic(bundle.bootstrap_static, {"teams": teams, "elements": elements})
    write_json_atomic(bundle.fixtures, [{"id": 1, "event": target_gw, "team_h": 1, "team_a": 2, "kickoff_time": "2025-01-01T12:00:00Z"}])
    write_json_atomic(bundle.events, [{"id": target_gw, "is_current": True, "deadline_time": "2025-01-01T10:00:00Z"}])
    write_json_atomic(bundle.slate, {"fixture_count": 1})
    write_json_atomic(bundle.collection_meta, {"collected_at": now, "target_gw": target_gw, "season": "2025-26"})
    picks = []
    for pos, pid in enumerate(range(1, 16), start=1):
        picks.append({"element": pid, "position": pos, "is_captain": pid == 1, "is_vice_captain": pid == 2})
    write_json_atomic(bundle.team_picks, {"picks": picks, "entry_history": {"bank": 0, "value": 1000}, "entry": 123})

    # Monkeypatch bundle collector to avoid network
    async def fake_collect(team_id, target_gw, force_refresh=False, run_id=None):
        return bundle
    run_globals = FPLSageIntegration.run_full_analysis.__globals__
    monkeypatch.setitem(run_globals, "collect_weekly_bundle", fake_collect)
    # Monkeypatch gate to always pass on the exact globals used by run_full_analysis
    monkeypatch.setitem(
        run_globals,
        "validate_bundle",
        lambda bp, tid, gw, freshness_max_minutes: GateResult(status="PASS"),
    )
    class StubOutputBundleManager(OutputBundleManager):
        def __init__(self, base_dir=tmp_path / "outputs"):
            super().__init__(base_dir=base_dir)

    # Use temp outputs dir
    monkeypatch.setitem(run_globals, "OutputBundleManager", StubOutputBundleManager)

    # Minimal config loader
    monkeypatch.setattr(FPLSageIntegration, "_load_config", lambda self: {"team_id": 123, "chip_policy": {}})

    integration = FPLSageIntegration(team_id=123)
    results = asyncio.run(integration.run_full_analysis(save_data=True))

    assert results["analysis"]["decision"].decision_status in {"PASS", "HOLD", "URGENT"}  # should not crash
    # Ensure outputs landed in temp outputs dir
    assert (tmp_path / "outputs" / "LATEST.json").exists()
