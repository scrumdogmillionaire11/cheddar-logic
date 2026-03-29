---
phase: quick-97
plan: 97
subsystem: fpl-sage
tags: [fixture-difficulty, fdr, captain-selector, fastapi, fpl]
dependency_graph:
  requires: []
  provides: [fixture_difficulty_module, advisor_endpoint]
  affects: [captain_selector, backend_main]
tech_stack:
  added: [aiohttp async context manager pattern]
  patterns: [TDD red-green, pure functions for computation / async for I/O separation]
key_files:
  created:
    - /Users/ajcolubiale/projects/cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/fixture_difficulty.py
    - /Users/ajcolubiale/projects/cheddar-fpl-sage/backend/routers/advisor.py
    - /Users/ajcolubiale/projects/cheddar-fpl-sage/tests/test_fixture_difficulty.py
  modified:
    - /Users/ajcolubiale/projects/cheddar-fpl-sage/src/cheddar_fpl_sage/analysis/decision_framework/captain_selector.py
    - /Users/ajcolubiale/projects/cheddar-fpl-sage/backend/routers/__init__.py
    - /Users/ajcolubiale/projects/cheddar-fpl-sage/backend/main.py
decisions:
  - "fetch_fixtures_and_bootstrap returns (fixtures, bootstrap) to avoid double bootstrap fetch in advisor endpoint"
  - "advisor registered with prefix=/api (not /api/v1) per acceptance criteria — resolves to /api/advisor"
  - "test file force-added with git add -f because .gitignore has test_*.py pattern; other test_*.py files in tests/ were previously force-added too"
  - "_fdr_flag is a module-level function (not method) so it works from both dict-based and object-based call sites"
metrics:
  duration: "~12 minutes"
  completed: "2026-03-29"
  tasks_completed: 2
  files_changed: 6
---

# Quick Task 97: WI-0649 FPL Fixture Difficulty Tracking Summary

One-liner: FDR run-in module with async FPL fetch, easy/hard/avg scoring, EASY_RUN/HARD_RUN captain flags, and /api/advisor endpoint.

## What Was Built

**fixture_difficulty.py** — New analysis module at `src/cheddar_fpl_sage/analysis/fixture_difficulty.py`:
- `compute_run_in_fdr(player_id, team_id, fixtures, current_gw, window=6)` — pure synchronous function; filters fixtures for the player's team in GW window, computes `easy_gws` (FDR <= 2), `hard_gws` (FDR >= 4), `avg_fdr` (mean, 0.0 if no fixtures)
- `fetch_fixtures_and_bootstrap(session)` — async; fetches `/fixtures/` and `/bootstrap-static/` via aiohttp; returns `(fixtures_list, bootstrap_data)`
- `get_current_gw(bootstrap_data)` — reads `is_current` then `is_next` fallback from events list
- Module constants: `EASY_FDR_MAX=2`, `HARD_FDR_MIN=4`, `DEFAULT_WINDOW=6`

**captain_selector.py** — Added `_fdr_flag(player)` module-level helper that handles both dict and object players; appended to rationale strings in `recommend_captaincy()` and `recommend_captaincy_from_xi()`.

**backend/routers/advisor.py** — New FastAPI router; `GET /advisor?player_id=X&team_id=Y&window=N`; uses `fetch_fixtures_and_bootstrap` to fetch both endpoints in one aiohttp session; returns `{player_id, team_id, current_gw, window, run_in_fdr}`.

**Registration** — `backend/routers/__init__.py` exports `advisor_router`; `backend/main.py` registers it with `prefix="/api"` so route resolves to `/api/advisor`.

## Test Results

- `pytest tests/test_fixture_difficulty.py` — 8/8 passing, all mocked (no network)
- `pytest tests/ --ignore=tests/integration` — 232 passed, 5 skipped, 1 pre-existing failure (`test_analyze_api.py::test_post_analyze_can_return_cached_result` — pre-existing Redis mock issue unrelated to this work)
- Baseline before this task: 215 passed (+17 net, 8 new fixture_difficulty tests + pre-existing test_fixture_difficulty.py was a script, replaced)

## Commits

| Hash | Message |
|------|---------|
| d3f4953 | feat(quick-97): fixture_difficulty.py — compute_run_in_fdr, fetch_fixtures_and_bootstrap, get_current_gw |
| 193b580 | feat(quick-97): captain_selector FDR flags + /api/advisor endpoint |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed async mock pattern for fetch_fixtures_and_bootstrap test**
- **Found during:** Task 1 GREEN run
- **Issue:** Plan's `AsyncMock` pattern with `mock_session.get.return_value.__aenter__` produced a coroutine instead of a context manager when `session.get(url)` was called — `TypeError: 'coroutine' object does not support the asynchronous context manager protocol`
- **Fix:** Changed test to use `MagicMock` for session with `side_effect=[make_cm(FIXTURE_DATA), make_cm(BOOTSTRAP_DATA)]` where each `make_cm()` creates a proper async context manager (`__aenter__`/`__aexit__` on a `MagicMock`)
- **Files modified:** `tests/test_fixture_difficulty.py`
- **Commit:** d3f4953

**2. [Rule 3 - Blocking] Force-add test file past gitignore**
- **Found during:** Task 1 commit
- **Issue:** `.gitignore` has `test_*.py` pattern that blocked `git add tests/test_fixture_difficulty.py`
- **Fix:** Used `git add -f` — consistent with how other `test_*.py` files in `tests/` were previously tracked
- **Commit:** d3f4953

## Self-Check: PASSED

- fixture_difficulty.py: FOUND
- advisor.py: FOUND
- test_fixture_difficulty.py: FOUND
- commit d3f4953: FOUND
- commit 193b580: FOUND
