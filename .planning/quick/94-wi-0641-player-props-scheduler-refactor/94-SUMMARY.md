---
phase: quick
plan: 94
subsystem: scheduler
tags: [scheduler, player-props, nhl, mlb, tdd, refactor]
dependency_graph:
  requires: []
  provides: [player-props-scheduler]
  affects: [schedulers/main.js, schedulers/player-props.js]
tech_stack:
  added: []
  patterns: [pure-function-scheduler, fpl.js-isolation-pattern]
key_files:
  created:
    - apps/worker/src/schedulers/player-props.js
    - apps/worker/src/schedulers/__tests__/player-props.test.js
  modified:
    - apps/worker/src/schedulers/main.js
decisions:
  - "Keep runMLBModel import in main.js — still required by SPORT_JOBS for full-game MLB models at T-minus windows; plan instruction to remove it was incorrect for that usage"
  - "BLK ingest uses a shared daily key (player_props|nhl_blk_ingest|daily|YYYY-MM-DD) with suffixes for pull and ingest sub-jobs to keep idempotency consistent"
metrics:
  duration: "~20 minutes"
  completed: "2026-03-28"
  tasks_completed: 3
  tests_added: 18
  files_changed: 3
---

# Quick Task 94: Player Props Scheduler Refactor Summary

**One-liner:** NHL SOG/BLK + MLB pitcher-K scheduling extracted from main.js into standalone player-props.js using the fpl.js isolation pattern, eliminating T-120/T-90/T-30 prop-job firing and wiring the unscheduled BLK ingest chain.

## What Was Built

### schedulers/player-props.js (new)

Pure function `computePlayerPropsDueJobs(nowEt, { games, dryRun })` following the fpl.js isolation pattern:

- **09:00 ET (heavy ingest):**
  - NHL: `sync_nhl_sog_player_ids` → BLK chain (`sync_nhl_blk_player_ids`, `pull_nhl_player_blk`, `ingest_nst_blk_rates`) → `pull_nhl_player_shots_props` + `run_nhl_player_shots_model`
  - MLB: `pull_mlb_pitcher_stats` + `pull_mlb_weather` → `pull_mlb_pitcher_strikeout_props` + `run_mlb_model`
- **18:00 ET (prop-refresh only):** NHL shots prop/model + MLB K prop/model — no heavy ingest
- **T-60 per game:** NHL shots prop/model or MLB K prop/model only
- **T-120, T-90, T-30:** Zero player-prop jobs (Odds API quota savings)

Feature flags:
- `ENABLE_PLAYER_PROPS_SCHEDULER=false` — disables entire scheduler
- `ENABLE_NHL_BLK_INGEST=false` — suppresses only the three BLK ingest jobs
- `PLAYER_PROPS_FIXED_TIMES_ET` — configurable fixed windows (default: `09:00,18:00`)

### schedulers/__tests__/player-props.test.js (new)

18 Jest tests covering:
- Feature flag disable (entire scheduler + BLK-only suppression)
- 09:00 heavy window job order (NHL + MLB)
- 18:00 light window (no heavy ingest)
- T-60 per game for NHL and MLB
- T-120, T-90, T-30 produce zero jobs
- All five idempotency key formats

### schedulers/main.js (cleaned)

- Added `require('./player-props')` + delegation at section 8
- Removed 7 job imports (sync_nhl_sog, pull_nhl_shots_props, run_nhl_shots_model, pull_mlb_pitcher_stats, pull_mlb_weather, pull_mlb_pitcher_strikeout_props)
- Removed 3 constants: `ENABLE_NHL_SOG_PLAYER_SYNC`, `ENABLE_NHL_SOG_PROP_PULL`, `ENABLE_MLB_PITCHER_K_PROP_PULL`
- Removed 4 inner helpers: `queueNhlShotsPropIngestBeforeModel`, `queueMlbPitcherStatsBeforeModel`, `queueMlbWeatherBeforeModel`, `queueMlbPitcherKPropIngestBeforeModel`
- Removed 04:00 ET NHL SOG player sync block (now owned by player-props.js 09:00 window)
- Removed `keyNhlSogPlayerSync` helper + export
- Updated startup log to show `ENABLE_PLAYER_PROPS_SCHEDULER` and `ENABLE_NHL_BLK_INGEST`
- Net change: 9 insertions, 101 deletions

## Commits

| Hash | Description |
|------|-------------|
| f442825 | feat(94): create schedulers/player-props.js with tests |
| eea2e0d | feat(94): clean main.js — delegate player-props to dedicated scheduler |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Retained runMLBModel import in main.js**
- **Found during:** Task 3
- **Issue:** The plan instructed removing `const { runMLBModel } = require('../jobs/run_mlb_model')` from main.js. However, `runMLBModel` is still referenced in `SPORT_JOBS.mlb.execute` for the full-game MLB model (spreads, totals, ML) that fires at T-120/T-90/T-60/T-30 per game. Removing it would break the full-game MLB betting pipeline.
- **Fix:** Kept `runMLBModel` import; only removed the prop-specific helper function imports
- **Files modified:** apps/worker/src/schedulers/main.js

## Test Results

- 18 new player-props.test.js tests: all pass
- 109 regression tests (run_nhl_player_shots_model + run_mlb_model): all pass
- main.js and player-props.js both load with `node -e "require(...)"` exit 0

## Self-Check: PASSED

- apps/worker/src/schedulers/player-props.js: FOUND
- apps/worker/src/schedulers/__tests__/player-props.test.js: FOUND
- Commit f442825: FOUND
- Commit eea2e0d: FOUND
- No references to removed helpers in main.js: CONFIRMED (0 matches)
