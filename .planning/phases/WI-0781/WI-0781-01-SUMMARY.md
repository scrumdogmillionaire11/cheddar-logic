---
phase: WI-0781-createjob-wrapper
plan: 01
subsystem: job-runtime
tags: [job-lifecycle, dry-run, process-exit, createJob, cheddar-logic/data]
status: complete

dependency-graph:
  requires: []
  provides:
    - createJob API in packages/data/src/job-runtime.js
    - createJob re-exported from @cheddar-logic/data
    - check_odds_health converted (no inline process.exit)
    - sync_game_statuses converted (no inline process.exit)
    - pull_nhl_goalie_starters converted (no inline process.exit)
  affects:
    - WI-0781-02 (wave 2 pilot jobs depend on createJob being available)

tech-stack:
  added: []
  patterns:
    - createJob(name, run) lifecycle wrapper — DRY_RUN env + --dry-run arg, Starting/Complete/Fatal logs, exit 0/1

key-files:
  created: []
  modified:
    - packages/data/src/job-runtime.js
    - packages/data/index.js
    - apps/worker/src/jobs/check_odds_health.js
    - apps/worker/src/jobs/sync_game_statuses.js
    - apps/worker/src/jobs/pull_nhl_goalie_starters.js

decisions:
  - name: createJob does not call withDb
    why: Each job's run fn still calls withDb internally; createJob is purely lifecycle (Starting/Complete/Fatal + exit). Avoids unwanted DB lifecycle for non-DB jobs like check_odds_health.
  - name: result.ok===false exits 1; result.success===false throws
    why: check_odds_health returns { ok }, so createJob handles it natively. pull_nhl_goalie_starters returns { success }, so the wrapper throws to force exit 1 via createJob's catch path. Consistent exit contract without widening the createJob API.
  - name: process.exit(2) removed from check_odds_health entry block
    why: Code 2 differentiated error-vs-stale; createJob exits 1 for errors. The distinction is preserved in log output ([OddsHealth] STALE vs Fatal). Simplification acceptable.

metrics:
  duration: 161s
  completed: 2026-04-05
  tasks-completed: 2/2
  tests: 1174 pass, 10 skip, 0 fail
---

# Phase WI-0781 Plan 01: createJob API + 3 Pilot Jobs Summary

**One-liner:** Add `createJob(name, run)` lifecycle wrapper to job-runtime.js, re-export from `@cheddar-logic/data`, and convert three pilot jobs—eliminating per-job DRY_RUN parsing, Starting/Complete log boilerplate, and inline `process.exit`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add createJob to job-runtime.js + re-export from index.js | d767415 | packages/data/src/job-runtime.js, packages/data/index.js |
| 2 | Convert check_odds_health, sync_game_statuses, pull_nhl_goalie_starters | 16e0765 | 3 job files |

## Decisions Made

1. **`createJob` does not own DB lifecycle** — Each job's inner `run` fn still calls `withDb(...)` as before; `createJob` is purely lifecycle.
2. **`result.ok === false` → exit 1** built into `createJob`. `result.success === false` is handled by the job's wrapper throwing — no need to widen the `createJob` API.
3. **`process.exit(2)` removed** from `check_odds_health` — stale vs error distinction preserved in log output.

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

Plan 02 (wave 2) is unblocked:
- `createJob` is available from `@cheddar-logic/data`
- Pattern established and validated against three job shapes
- 1174 tests pass; no regressions
