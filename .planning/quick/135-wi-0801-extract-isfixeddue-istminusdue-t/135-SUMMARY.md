---
phase: quick
plan: 135
subsystem: worker/schedulers
tags: [refactor, scheduler, cleanup, deduplication]
dependency_graph:
  requires: []
  provides: [schedulers/utils.js with isTminusDue]
  affects: [apps/worker/src/schedulers/player-props.js, apps/worker/src/schedulers/utils.js]
tech_stack:
  added: []
  patterns: [shared-scheduler-utils, import-from-canonical-module]
key_files:
  created:
    - apps/worker/src/schedulers/utils.js
  modified:
    - apps/worker/src/schedulers/player-props.js
decisions:
  - isTminusDue goes into utils.js (not windows.js) — it has no dependency on windows.js constructs and is a pure time-math helper
  - isFixedDue stays in windows.js where it already has its canonical home and is safe to import without circular deps
metrics:
  duration: "~5 minutes"
  completed_date: "2026-04-05"
  tasks_completed: 3
  files_changed: 2
---

# Phase quick Plan 135: Extract isFixedDue/isTminusDue from player-props.js Summary

**One-liner:** Eliminate the manual-sync copy-paste hazard in player-props.js by importing isFixedDue from windows.js and moving isTminusDue into the new shared schedulers/utils.js.

## What Was Built

- `apps/worker/src/schedulers/utils.js` — new shared module exporting `isTminusDue` (T-60 window detector)
- `apps/worker/src/schedulers/player-props.js` — removed 51 lines of inline function definitions, replaced with two require statements

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create schedulers/utils.js with isTminusDue | e1251fb | apps/worker/src/schedulers/utils.js (created) |
| 2 | Update player-props.js to import from windows and utils | b74facd | apps/worker/src/schedulers/player-props.js (modified) |
| 3 | Run acceptance tests and verify guards | — (no file changes) | scheduler-windows.test.js, player-props.test.js verified |

## Verification

All guard checks passed:
- `grep "function isFixedDue" player-props.js` — empty
- `grep "function isTminusDue" player-props.js` — empty
- `grep "keep in sync manually" player-props.js` — empty
- `node -e "require('./apps/worker/src/schedulers/utils.js')"` — exits 0

All 31 tests pass:
- scheduler-windows: 10 tests pass
- player-props: 21 tests pass

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `apps/worker/src/schedulers/utils.js` — FOUND
- `apps/worker/src/schedulers/player-props.js` — FOUND (modified)
- Commit e1251fb — FOUND
- Commit b74facd — FOUND
