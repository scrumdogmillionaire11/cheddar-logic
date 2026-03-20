from datetime import datetime, timezone
from pathlib import Path

from cheddar_fpl_sage.collectors.weekly_bundle_collector import BundlePaths
from cheddar_fpl_sage.validation.data_gate import validate_bundle
from cheddar_fpl_sage.utils.output_manager import (
    OutputBundleManager,
    write_json_atomic,
    write_text_atomic,
    generate_run_id,
)


def _make_bundle(tmp_path: Path, target_gw: int = 3, team_id: int = 1) -> BundlePaths:
    run_id = generate_run_id(target_gw)
    team_dir = tmp_path / "outputs" / "runs" / f"team_{team_id}" / run_id
    data_dir = team_dir / "data_collections"
    proc_dir = team_dir / "processed_data"
    return BundlePaths(
        team_id=team_id,
        run_id=run_id,
        run_dir=team_dir,
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
    ), proc_dir


def test_pipeline_pass_and_hold_paths(tmp_path):
    bundle_paths, proc_dir = _make_bundle(tmp_path)

    # Write minimal valid bundle
    now = datetime.now(timezone.utc).isoformat()
    write_json_atomic(bundle_paths.bootstrap_static, {"teams": [{"id": 1}, {"id": 2}]})
    write_json_atomic(bundle_paths.fixtures, [{"id": 1, "event": 3, "team_h": 1, "team_a": 2, "kickoff_time": "2025-01-01T12:00:00Z"}])
    write_json_atomic(bundle_paths.events, [{"id": 3, "deadline_time": "2025-01-01T10:00:00Z"}])
    write_json_atomic(bundle_paths.team_picks, {"picks": [{"element": i} for i in range(15)]})
    write_json_atomic(bundle_paths.slate, {"fixture_count": 1})
    write_json_atomic(bundle_paths.collection_meta, {"collected_at": now, "target_gw": 3})

    gate = validate_bundle(bundle_paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert gate.status == "PASS"

    # Write outputs similar to orchestrator
    run_paths_manager = OutputBundleManager(base_dir=tmp_path / "outputs")
    run_paths = run_paths_manager.paths_for_run(bundle_paths.run_id, team_id=bundle_paths.team_id)
    write_json_atomic(run_paths.data_collection, {"schema_version": "1.0.0", "run_id": bundle_paths.run_id, "gameweek": 3, "season": "test", "generated_at": now})
    write_json_atomic(run_paths.model_inputs, {"schema_version": "1.0.0", "run_id": bundle_paths.run_id, "gameweek": 3, "season": "test", "generated_at": now})
    write_json_atomic(run_paths.analysis, {"schema_version": "1.0.0", "run_id": bundle_paths.run_id, "gameweek": 3, "season": "test", "generated_at": now, "decision": {"decision_status": "PASS"}})
    write_text_atomic(run_paths.report, "# Summary\n\nPASS")

    # Pointer updates should succeed
    run_paths_manager.update_latest_pointer(run_paths)
    assert run_paths_manager.latest_pointer.exists()

    # HOLD path: remove events and expect block
    bundle_paths.events.unlink()
    gate_hold = validate_bundle(bundle_paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert gate_hold.status == "HOLD"
    assert gate_hold.block_reason == "MISSING_EVENTS"
