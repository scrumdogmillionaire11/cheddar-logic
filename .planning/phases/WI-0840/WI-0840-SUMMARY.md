---
phase: WI-0840
verified: 2026-04-08T00:00:00Z
status: passed
score: 8/8 acceptance criteria verified
subsystem: mlb-model
tags: [mlb, league-constants, dynamic, pitcher-stats, db]
requires: []
provides: [computeMLBLeagueAverages, setLeagueConstants]
affects: [run_mlb_model, mlb-model]
tech-stack:
  added: []
  patterns: [module-level-mutable-setter, dynamic-fallback]
key-files:
  created:
    - packages/data/src/db/mlb-stats.js
    - packages/data/src/db/__tests__/mlb-stats.test.js
  modified:
    - packages/data/src/db/index.js
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/__tests__/run-mlb-model.dual-run.test.js
decisions:
  - Use module-level mutables + setter pattern (not sub-function signature change) to reach sub-functions
  - current year via new Date().getFullYear() (not hardcoded) so constant updates automatically each season
  - try/catch around db.prepare in case mlb_pitcher_stats table absent during early bootstrap
metrics:
  duration: ~15 min
  completed: 2026-04-08
---

# WI-0840 Summary: MLB Dynamic League Constants

**One-liner:** Replace hardcoded 2024 MLB league averages with nightly-computed values from `mlb_pitcher_stats`, falling back to statics when season sample < 50.

## Goal

Replace four hardcoded MLB constants (`LEAGUE_AVG_K_PCT`, `MLB_F5_DEFAULT_TEAM_K_PCT`, `MLB_F5_DEFAULT_XFIP`, `MLB_F5_DEFAULT_TEAM_BB_PCT`) with values computed nightly from current-season `mlb_pitcher_stats` rows, falling back to 2024 statics when fewer than 50 rows exist.

## Acceptance Criteria Verification

| # | Criterion | Status |
|---|-----------|--------|
| 1 | `computeMLBLeagueAverages(db)` in `packages/data/src/db/mlb-stats.js` | VERIFIED (lines 32–87) |
| 2 | Returns `static_2024` when n < 50 | VERIFIED (6 unit tests) |
| 3 | `run_mlb_model.js` calls once, passes to `setLeagueConstants` | VERIFIED (lines 1586–1592) |
| 4 | `setLeagueConstants` exported from `mlb-model.js` | VERIFIED (line 944–947, exports) |
| 5 | Both `LEAGUE_AVG_K_PCT` and `MLB_F5_DEFAULT_TEAM_K_PCT` replaced by `_leagueAvgKPct` | VERIFIED (5 call-sites) |
| 6 | `[MLB_LEAGUE_AVG] source=... n=...` log emitted | VERIFIED (lines 1588–1591) |
| 7 | Existing tests pass | VERIFIED (1265/1265 + 234/234) |
| 8 | New unit test mocks 60 rows, asserts `source='computed'`, `kPct` equals avg | VERIFIED (mlb-stats.test.js line 52) |

## Implementation Notes

### Pattern chosen: module-level mutables + setter

The WI spec prescribes this pattern because `LEAGUE_AVG_K_PCT` is consumed in sub-functions (`resolveOpponentPitcherKProfile`, `calculateProjectionK`) that are not called directly from `runMLBModel`. Shadow-consts inside `runMLBModel` would not reach them. The three mutables (`_leagueAvgKPct`, `_defaultXfip`, `_defaultBbPct`) are initialized to static fallbacks and replaced atomically at job-start via `setLeagueConstants`.

### Call sites replaced

| Site | File | Old | New |
|------|------|-----|-----|
| `resolveStarterSkillProfile` L112 | mlb-model.js | `MLB_F5_DEFAULT_TEAM_K_PCT` | `_leagueAvgKPct` |
| `resolveStarterLeashProfile` L217 | mlb-model.js | `MLB_F5_DEFAULT_TEAM_BB_PCT` (×2) | `_defaultBbPct` |
| `buildF5SyntheticFallbackProjection` L336/339 | mlb-model.js | `MLB_F5_DEFAULT_XFIP` (×2) | `_defaultXfip` |
| `resolveOpponentPitcherKProfile` L1075 | mlb-model.js | `LEAGUE_AVG_K_PCT` | `_leagueAvgKPct` |
| `calculateProjectionK` L1147/1154/1175 | mlb-model.js | `LEAGUE_AVG_K_PCT` (×3) | `_leagueAvgKPct` |
| `calculateProjectionK` L1162 | mlb-model.js | `MLB_F5_DEFAULT_TEAM_BB_PCT` (×2) | `_defaultBbPct` |

## Deviations from Plan

### [Rule 2 - Missing Critical] Mock update for dual-run tests

- **Found during:** Task 2 verification
- **Issue:** `run-mlb-model.dual-run.test.js` mock for `@cheddar-logic/data` did not include `computeMLBLeagueAverages`; mock for `../models/mlb-model` did not include `setLeagueConstants` or `projectF5ML`. This caused `result.success = false` for all 6 orchestration tests.
- **Fix:** Added `computeMLBLeagueAverages: jest.fn(...)` to the data mock and `setLeagueConstants: jest.fn()` + `projectF5ML: jest.fn()` to the mlb-model mock.
- **Files modified:** `apps/worker/src/__tests__/run-mlb-model.dual-run.test.js`
- **Commit:** included in 7705d40

## Test Results

- `packages/data` tests: **234/234** (including 6 new mlb-stats tests)
- `apps/worker` tests: **1265/1265** (0 regressions)

## Commits

- `8cf5c9a` feat(WI-0840): add computeMLBLeagueAverages to packages/data
- `7705d40` feat(WI-0840): wire dynamic league constants into mlb-model + run_mlb_model

## Manual Validation Required

After 3+ weeks of 2026 MLB season data accumulated, confirm `[MLB_LEAGUE_AVG] source=computed` in worker log. Expected n ≥ 50 by mid-April.
