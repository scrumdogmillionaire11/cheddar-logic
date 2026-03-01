# Testing Patterns

**Analysis Date:** 2026-01-23

## Test Framework

**Runner:**
- pytest
- Config: `pyproject.toml` with `[tool.pytest.ini_options]`
- Test paths: `["tests"]`
- Addopts: `-q` (quiet mode)

**Assertion Library:**
- pytest built-in assertions
- `pytest.raises()` for exception testing

**Run Commands:**
```bash
pytest tests/                          # Run all tests
pytest tests/tests_new/                # Run tests_new suite
pytest tests/tests_new/test_*.py -v   # Run specific test file with verbose
pytest --tb=short                      # Run with short traceback format
```

## Test File Organization

**Location:**
- `tests/` - Main test directory
- `tests/tests_new/` - Newer tests with updated naming/structure
- `tests_new/` prefix indicates Sprint 3+ refactoring

**Naming:**
- `test_*.py` for test modules
- `test_*.py` files contain one to three test functions focused on a specific component
- Test functions: `test_*_*_describes_behavior()` pattern (e.g., `test_blank_and_double_detection_and_ordering()`)

**Structure:**
```
tests/
├── tests_new/
│   ├── test_data_gate.py
│   ├── test_slate_builder.py
│   ├── test_identity_integrity.py
│   ├── test_summary_and_injury_filters.py
│   ├── test_orchestrator_smoke.py
│   └── ...
├── test_collection.py
├── test_manager_name.py
└── validate_acceptance_criteria.py
```

## Test Structure

**Suite Organization:**
```python
# From tests/tests_new/test_identity_integrity.py
def test_identity_mismatch_raises():
    canonical_players = [
        {"player_id": 1, "team_id": 100},
        {"player_id": 2, "team_id": 200},
    ]
    rendered_sections = [
        [{"player_id": 1, "team_id": 100}],
        [{"player_id": 2, "team_id": 999}],  # conflicting team_id
    ]

    with pytest.raises(ValueError) as exc:
        validate_player_identity(canonical_players, rendered_sections)

    assert "DATA_INTEGRITY" in str(exc.value)


def test_identity_ok_no_raise():
    canonical_players = [
        {"player_id": 1, "team_id": 100},
        {"player_id": 2, "team_id": 200},
    ]
    rendered_sections = [
        [{"player_id": 1, "team_id": 100}],
        [{"player_id": 2, "team_id": 200}],
    ]

    # Should not raise
    validate_player_identity(canonical_players, rendered_sections)
```

**Patterns:**
- Setup: Direct data construction in test body (no setUp methods)
- Assertion: Single assertion or multiple related assertions per test
- Teardown: Implicit (pytest tmpdir fixture handles cleanup)
- Test isolation: Each test is independent; no shared state

## Mocking

**Framework:** pytest's `monkeypatch` fixture

**Patterns:**
```python
# From tests/tests_new/test_orchestrator_smoke.py
def test_orchestrator_smoke_pass(monkeypatch, tmp_path):
    # ... setup ...

    # Monkeypatch bundle collector to avoid network
    async def fake_collect(team_id, target_gw, force_refresh=False, run_id=None):
        return bundle
    monkeypatch.setattr("cheddar_fpl_sage.analysis.fpl_sage_integration.collect_weekly_bundle", fake_collect)

    # Monkeypatch gate to always pass
    monkeypatch.setattr("cheddar_fpl_sage.analysis.fpl_sage_integration.validate_bundle",
                       lambda bp, tid, gw, freshness_max_minutes: GateResult(status="PASS"))

    # Monkeypatch class-level components
    class StubOutputBundleManager(OutputBundleManager):
        def _artifacts_exist(self, run_paths):
            return True
    monkeypatch.setattr("cheddar_fpl_sage.analysis.fpl_sage_integration.OutputBundleManager", StubOutputBundleManager)
```

**What to Mock:**
- External API calls (FPL API via `EnhancedFPLCollector`)
- File I/O operations when testing logic in isolation
- Long-running async operations

**What NOT to Mock:**
- Pure validation functions (e.g., `validate_player_identity()`)
- Data transformation/building functions (e.g., `build_slate()`)
- Model dataclasses and their methods

## Fixtures and Factories

**Test Data:**
```python
# From tests/tests_new/test_summary_and_injury_filters.py
def _make_projection(player_id: int, position: str, team: str, pts: float) -> CanonicalPlayerProjection:
    return CanonicalPlayerProjection(
        player_id=player_id,
        name=f"Player {player_id}",
        position=position,
        team=team,
        current_price=5.0,
        nextGW_pts=float(pts),
        next6_pts=float(pts) * 2,
        xMins_next=90.0,
        volatility_score=0.1,
        ceiling=float(pts) + 2,
        floor=max(0.0, float(pts) - 1),
        tags=[],
        confidence=0.9,
        ownership_pct=5.0,
    )

# From tests/tests_new/test_data_gate.py
def make_paths(tmp_path: Path, run_id: str = "run", team_id: int = 1) -> BundlePaths:
    data_dir = tmp_path / "data_collections"
    return BundlePaths(
        team_id=team_id,
        run_id=run_id,
        run_dir=tmp_path,
        bootstrap_static=data_dir / "bootstrap_static.json",
        # ... more paths ...
    )

def write_minimum_bundle(paths: BundlePaths, target_gw: int = 3, fresh_minutes: int = 10, include_picks: bool = True):
    now = datetime.now(timezone.utc)
    write_json_atomic(paths.bootstrap_static, {"teams": [{"id": 1}, {"id": 2}, {"id": 3}]})
    write_json_atomic(paths.fixtures, [
        {"id": 1, "event": target_gw, "team_h": 1, "team_a": 2, "kickoff_time": "2025-01-01T12:00:00Z"}
    ])
    # ... more setup ...
```

**Location:**
- Helper functions prefixed with `_` defined at module level in test files
- Fixtures using `tmp_path` (pytest's temporary directory fixture)
- Factory functions for creating complex test objects (projections, bundles)

## Coverage

**Requirements:** Not enforced via pytest config; coverage targets exist in broader strategy

**View Coverage:**
```bash
pytest --cov=src/cheddar_fpl_sage --cov-report=term-missing
```

## Test Types

**Unit Tests:**
- Scope: Single function or method
- Approach: Minimal setup, focused assertions
- Examples: `test_identity_mismatch_raises()`, `test_blank_and_double_detection_and_ordering()`
- Location: `tests/tests_new/` (newer convention)

**Integration Tests:**
- Scope: Multiple components interacting (e.g., data gate validation + orchestrator)
- Approach: Use realistic data bundles with mocked external calls
- Examples: `test_orchestrator_smoke_pass()`, `test_missing_fixtures_for_target_blocks()`
- Location: `tests/tests_new/` with `smoke` or full name descriptors

**E2E Tests:**
- Framework: Not explicitly separated; smoke tests serve as lightweight E2E
- Integration example: `tests/integration_example.py` (appears to be reference/example)

## Common Patterns

**Async Testing:**
```python
# From tests/tests_new/test_orchestrator_smoke.py
def test_orchestrator_smoke_pass(monkeypatch, tmp_path):
    # ... setup ...
    async def fake_collect(team_id, target_gw, force_refresh=False, run_id=None):
        return bundle
    monkeypatch.setattr("cheddar_fpl_sage.analysis.fpl_sage_integration.collect_weekly_bundle", fake_collect)

    # Test async code by mocking async functions and running via pytest
    # pytest handles asyncio detection automatically
```

**Error Testing:**
```python
# From tests/tests_new/test_identity_integrity.py
def test_identity_mismatch_raises():
    # ... setup with conflicting data ...

    with pytest.raises(ValueError) as exc:
        validate_player_identity(canonical_players, rendered_sections)

    assert "DATA_INTEGRITY" in str(exc.value)
```

**Parametric/Edge Case Testing:**
```python
# From tests/tests_new/test_data_gate.py
def test_missing_bootstrap_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths)
    paths.bootstrap_static.unlink()  # Remove required file
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.status == "HOLD"
    assert result.block_reason == "MISSING_BOOTSTRAP_STATIC"

def test_missing_fixtures_for_target_blocks(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths)
    write_json_atomic(paths.fixtures, [{"id": 1, "event": 2, "team_h": 1, "team_a": 2}])  # wrong GW
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.block_reason == "MISSING_FIXTURES_FOR_TARGET_GW"

def test_pass_when_all_present_and_fresh(tmp_path):
    paths = make_paths(tmp_path)
    write_minimum_bundle(paths, fresh_minutes=10)
    result = validate_bundle(paths, team_id=1, target_gw=3, freshness_max_minutes=60)
    assert result.status == "PASS"
    assert result.block_reason is None
```

**Positional/Conditional Testing:**
```python
# From tests/tests_new/test_slate_builder.py
def test_blank_and_double_detection_and_ordering():
    fixtures = [
        {"id": 2, "event": 3, "team_h": 1, "team_a": 2, "kickoff_time": "2025-01-02T12:00:00Z"},
        {"id": 1, "event": 3, "team_h": 1, "team_a": 3, "kickoff_time": "2025-01-01T12:00:00Z"},
        {"id": 5, "event": 4, "team_h": 5, "team_a": 6, "kickoff_time": "2025-01-03T12:00:00Z"},  # different GW
    ]
    teams_map = {i: {} for i in range(1, 7)}

    slate = build_slate(fixtures, teams_map, target_gw=3)

    assert slate["fixture_count"] == 2
    # Ordered by kickoff_time then fixture_id
    assert [fx["fixture_id"] for fx in slate["fixtures"]] == [1, 2]
    # Team 1 plays twice → double
    assert slate["double_teams"] == [1]
    # Teams 4, 5 and 6 missing from GW3 fixtures → blanks
    assert slate["blank_teams"] == [4, 5, 6]
```

---

*Testing analysis: 2026-01-23*
