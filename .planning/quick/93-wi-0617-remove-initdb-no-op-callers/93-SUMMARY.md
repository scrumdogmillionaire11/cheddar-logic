---
phase: quick-93
plan: "01"
subsystem: data
tags: [cleanup, db, no-op-removal, closure]
dependency_graph:
  requires: []
  provides: [WI-0617-closed]
  affects: [packages/data/src/db.js]
tech_stack:
  added: []
  patterns: []
key_files:
  created: []
  modified:
    - WORK_QUEUE/COMPLETE/WI-0617.md
decisions:
  - "No code changes needed — initDb was already removed in qt-47/WI-0456 (sql.js → better-sqlite3 migration)"
metrics:
  duration: "3 minutes"
  completed_date: "2026-03-28"
  tasks_completed: 2
  files_changed: 1
---

# Phase quick-93 Plan 01: Remove initDb No-Op Callers Summary

**One-liner:** `initDb` symbol confirmed absent from all source files — removed during qt-47 sql.js→better-sqlite3 migration; WI-0617 closed with zero code changes.

## What Was Confirmed

`initDb()` was already fully removed from the codebase during quick task 47 (WI-0456), which migrated the DB layer from sql.js to better-sqlite3. That migration eliminated the async initialization pattern entirely — better-sqlite3 is synchronous and requires no initDb call.

A grep across all `.js`, `.ts`, and `.tsx` files in `apps/`, `packages/`, `web/src/`, and `scripts/` returned zero matches.

## Acceptance Check Results

| Check | Command | Result |
|---|---|---|
| No initDb references | `grep -rn "initDb" --include="*.{js,ts,tsx}" apps/ packages/ web/src/ scripts/` | Zero hits |
| Worker entry point starts | `node apps/worker/src/jobs/pull_odds_hourly.js --dry-run` | Exit 0, job completed normally |
| Worker test suite | `npm --prefix apps/worker test` | 866 passed / 6 failed (all failures pre-existing, unrelated to initDb) |

The 6 test failures span 3 suites (`run-mlb-model.dual-run`, `run_nhl_model.market-calls`, `scheduler-windows`) and are pre-existing issues not caused by or related to initDb removal.

## Files Touched

- `WORK_QUEUE/COMPLETE/WI-0617.md` — moved from `WORK_QUEUE/` with Status: COMPLETE and closure note added

## Deviations from Plan

None — plan executed exactly as written. No code changes were required.

## Self-Check: PASSED

- `WORK_QUEUE/COMPLETE/WI-0617.md` exists
- Commit `4b1b437` confirmed in git log
- Zero initDb grep hits confirmed
