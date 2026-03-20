from pathlib import Path
from datetime import datetime, timedelta, timezone


from cheddar_fpl_sage.collectors.weekly_bundle_collector import BundlePaths
from cheddar_fpl_sage.validation.data_gate import validate_bundle
from cheddar_fpl_sage.utils.output_manager import write_json_atomic


def make_paths(tmp_path: Path, run_id: str = "run", team_id: int = 1) -> BundlePaths:
    data_dir = tmp_path / "data_collections"
    return BundlePaths(
        team_id=team_id,
        run_id=run_id,
        run_dir=tmp_path,
        bootstrap_static=data_dir / "bootstrap_static.json",
        fixtures=data_dir / "fixtures.json",
        events=data_dir / "events.json",
        team_picks=data_dir / "team_picks.json",
        slate=data_dir / "slate_gw3.json",
        collection_meta=data_dir / "collection_meta.json",
        entry_info=data_dir / "entry_info.json",
        injury_fpl=data_dir / "injury_fpl.json",
        injury_secondary=data_dir / "injury_secondary.json",
        injury_manual=data_dir / "injury_manual.json",
        injury_resolved=data_dir / "injury_resolved.json",
    )


def write_minimum_bundle(paths: BundlePaths, target_gw: int = 3, fresh_minutes: int = 10, include_picks: bool = True):
    now = datetime.now(timezone.utc)
    # Bootstrap with teams
    write_json_atomic(paths.bootstrap_static, {"teams": [{"id": 1}, {"id": 2}, {"id": 3}]})
    # Fixtures for gw
    write_json_atomic(paths.fixtures, [
        {"id": 1, "event": target_gw, "team_h": 1, "team_a": 2, "kickoff_time": "2025-01-01T12:00:00Z"}
    ])
    # Events with deadline
    write_json_atomic(paths.events, [{"id": target_gw, "deadline_time": "2025-01-01T10:00:00Z"}])
    # Slate
    write_json_atomic(paths.slate, {"fixture_count": 1})
    # Picks
    if include_picks:
        write_json_atomic(paths.team_picks, {"picks": [{"element": i} for i in range(15)]})
    # Meta
    write_json_atomic(paths.collection_meta, {
        "collected_at": (now - timedelta(minutes=fresh_minutes)).isoformat(),
        "target_gw": target_gw,
    })


def test_missing_bootstrap_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths)  # then remove bootstrap
    paths.bootstrap_static.unlink()
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.status == "HOLD"
    assert result.block_reason == "MISSING_BOOTSTRAP_STATIC"


def test_missing_fixtures_for_target_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths)
    write_json_atomic(paths.fixtures, [{"id": 1, "event": 2, "team_h": 1, "team_a": 2}])  # wrong GW
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.block_reason == "MISSING_FIXTURES_FOR_TARGET_GW"


def test_empty_slate_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths)
    write_json_atomic(paths.slate, {"fixture_count": 0})
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.block_reason == "EMPTY_SLATE"


def test_missing_team_picks_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths, include_picks=False)
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.block_reason == "MISSING_TEAM_PICKS"


def test_stale_collection_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths, fresh_minutes=120)
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.block_reason == "STALE_COLLECTION"


def test_pass_when_all_present_and_fresh(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths, fresh_minutes=10)
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.status == "PASS"
    assert result.block_reason is None
