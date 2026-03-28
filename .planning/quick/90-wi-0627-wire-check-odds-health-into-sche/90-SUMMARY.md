---
phase: quick-90
plan: "01"
subsystem: worker-scheduler
tags: [scheduler, health-watchdog, odds, tdd]
dependency_graph:
  requires: []
  provides: [check_odds_health scheduled on 30-min cadence]
  affects: [apps/worker/src/schedulers/main.js]
tech_stack:
  added: []
  patterns: [30-min slot key via minuteOfDay % 30, default-on env flag pattern]
key_files:
  created:
    - apps/worker/src/__tests__/scheduler-odds-health.test.js
  modified:
    - apps/worker/src/schedulers/main.js
decisions:
  - "Used ENABLE_ODDS_HEALTH_WATCHDOG !== 'false' (default ON) consistent with always-on health checks; contrasts with ENABLE_PIPELINE_HEALTH_WATCHDOG which is opt-in"
  - "30-min slot key: health|odds|YYYY-MM-DD|sNNN ensures idempotency via existing shouldRunJobKey layer"
metrics:
  duration: "~10 minutes"
  completed: "2026-03-28"
  tasks_completed: 2
  files_changed: 2
---

# Phase quick-90 Plan 01: Wire check_odds_health into scheduler Summary

**One-liner:** `checkOddsHealth` imported and dispatched in `schedulers/main.js` on 30-min cadence with deterministic slot-based jobKey for idempotency.

## What Was Built

`getOddsHealthJobs(nowUtc)` added to `schedulers/main.js`:
- Returns `[]` for any non-30-minute boundary (minuteOfDay % 30 !== 0)
- Returns 1-element array with `check_odds_health` job at minute 0 and minute 30 of each hour
- JobKey format: `health|odds|YYYY-MM-DD|sNNN` (slot = floor(minuteOfDay/30), zero-padded to 3 digits)
- Dispatched in `computeDueJobs` behind `ENABLE_ODDS_HEALTH_WATCHDOG !== 'false'` (default ON)
- Exported from module.exports

`checkOddsHealth` import added immediately after `checkPipelineHealth` import (line 64).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add getOddsHealthJobs + wire into computeDueJobs | c6210c3 | apps/worker/src/schedulers/main.js |
| 2 | Add scheduler-odds-health test + pass full test suite | c6210c3 | apps/worker/src/__tests__/scheduler-odds-health.test.js |

## Verification Results

- `DRY_RUN=true node apps/worker/src/schedulers/main.js` — starts without error
- `npm --prefix apps/worker test` — 7/7 new tests pass; no regressions (8 pre-existing failures confirmed to pre-date this work)
- All four touchpoints confirmed via grep: import (line 64), function (line 366), dispatch (line 1184), export (line 1406)

## Deviations from Plan

None — plan executed exactly as written. Pre-existing test failures (8) in `scheduler-windows.test.js`, `decision-publisher.v2.test.js`, `run-mlb-model.dual-run.test.js`, and `run_nhl_model.market-calls.test.js` were confirmed to exist before this work via `git stash` verification.

## Self-Check: PASSED

- [x] `apps/worker/src/schedulers/main.js` — modified, changes verified via grep
- [x] `apps/worker/src/__tests__/scheduler-odds-health.test.js` — created, 7 tests pass
- [x] `WORK_QUEUE/COMPLETE/WI-0627.md` — moved from WORK_QUEUE/
- [x] Commit c6210c3 contains both files
