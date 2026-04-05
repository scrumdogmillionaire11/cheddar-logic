---
phase: quick-131
plan: 01
subsystem: mlb-pipeline
tags: [mlb, statcast, scheduler, documentation, test]
dependency_graph:
  requires: []
  provides: [WI-0799]
  affects: [mlb-k-pipeline, player-props-scheduler]
tech_stack:
  added: []
  patterns: [TDD-verify-existing, scheduler-window-testing]
key_files:
  modified:
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/__tests__/scheduler-windows.test.js
decisions:
  - "No scheduler reordering needed — pull_mlb_statcast was already correctly registered in player-props.js lines 333-340 before this task"
  - "New test uses inline require() calls consistent with existing scheduler-windows test patterns"
metrics:
  duration: "~5 minutes"
  completed: "2026-04-05T18:02:40Z"
  tasks_completed: 2
  files_modified: 2
---

# Phase quick-131 Plan 01: Verify MLB Statcast Scheduling Chain Summary

One-liner: Verified pull_mlb_statcast fires in the 09:00 ET heavy window between pitcher_stats and weather; cleaned stale "null until added" comment in run_mlb_model.js and added scheduler-windows assertion for WI-0799.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Update stale comment in run_mlb_model.js | 4f95623 | apps/worker/src/jobs/run_mlb_model.js |
| 2 | Add MLB 09:00 job sequence assertion to scheduler-windows test | c1c24b2 | apps/worker/src/__tests__/scheduler-windows.test.js |

## Decisions Made

- No scheduler reordering needed — `pull_mlb_statcast` was already correctly registered in `player-props.js` lines 333-340 (after `pull_mlb_pitcher_stats`, before `pull_mlb_weather`) prior to this task.
- New test uses inline `require()` calls within the test body, consistent with existing scheduler-windows test patterns (no top-level imports added).

## Deviations from Plan

None — plan executed exactly as written.

## Test Results

Both suites pass:
- `mlb-k-statcast`: 26 tests passed
- `scheduler-windows`: 9 tests passed (includes new MLB sequence assertion)

## Self-Check: PASSED

- apps/worker/src/jobs/run_mlb_model.js: FOUND
- apps/worker/src/__tests__/scheduler-windows.test.js: FOUND
- Commit 4f95623: FOUND
- Commit c1c24b2: FOUND
