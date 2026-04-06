---
phase: quick-140
plan: 01
subsystem: worker/models
tags: [devig, nhl-shots, card-model, dead-code-removal]
dependency_graph:
  requires: [WI-0805, quick-139]
  provides: [WI-0810]
  affects: [run_nhl_player_shots_model.js, card-model.js, mlb-model.js]
tech_stack:
  added: []
  patterns: [twoSidedFairProb null-safe fallback pattern]
key_files:
  modified:
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - packages/models/src/card-model.js
    - apps/worker/src/models/mlb-model.js
decisions:
  - Used null-safe fallback pattern (twoSidedFairProb ?? americanToImplied) to handle single-sided markets gracefully
metrics:
  duration: ~5 minutes
  completed: "2026-04-06"
  tasks_completed: 2
  files_modified: 3
---

# Phase quick-140 Plan 01: Fix Remaining Raw Implied Probability Residuals Summary

**One-liner:** Replace 5 raw `americanToImplied` BLK call sites with two-sided devigged `twoSidedFairProb`, delete dead `calculateMoneylineEdge`/`oddsToProbability` from card-model.js, and correct misleading `mlToImplied` comment in mlb-model.js.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix BLK multi-line loop devig in run_nhl_player_shots_model.js | 738d5a9 | apps/worker/src/jobs/run_nhl_player_shots_model.js |
| 2 | Delete calculateMoneylineEdge from card-model.js + fix mlb-model.js comment | 16eb2df | packages/models/src/card-model.js, apps/worker/src/models/mlb-model.js |

## What Was Done

### Task 1

Added `twoSidedFairProb` import from `@cheddar-logic/models.edgeCalculator` and replaced all 5 raw `americanToImplied` BLK call sites:

- Primary BLK card payload: `impliedOverProb` and `impliedUnderProb` (2 sites)
- Extra-line loop edge computation: `implOvr` and `implUnd` local variables (2 sites)
- Extra-line payload fields: `impliedOverProb` and `impliedUnderProb` (2 sites — counted as 1 logical unit per loop body)

Each replacement uses the null-safe fallback pattern: `twoSidedFairProb(price, opposite) ?? americanToImplied(price)` so single-sided markets (where opposite price is null) degrade gracefully.

### Task 2

- Deleted `oddsToProbability` function (lines 57-65 of original) and `calculateMoneylineEdge` function (lines 67-87) from `packages/models/src/card-model.js`. Zero external callers confirmed pre-deletion.
- Removed both from `module.exports`.
- Updated `mlToImplied` comment in `apps/worker/src/models/mlb-model.js` from "American odds → implied probability (includes vig)" to "Raw implied probability — intermediate only; normalized via two-sided devig below".

## Verification Results

- `grep -n "americanToImplied" apps/worker/src/jobs/run_nhl_player_shots_model.js` — only line 65 (function definition) plus null-safe fallback usages. No standalone BLK call sites.
- `grep -n "calculateMoneylineEdge|oddsToProbability" packages/models/src/card-model.js` — no matches.
- `mlToImplied` comment updated as specified.
- Worker tests: 92 passed, 3 skipped (no new failures).
- Models tests: 5 passed, 2 pre-existing failures (edge-calculator.test.js and sharp-divergence-annotation.test.js use console.log pattern not Jest test() calls — confirmed pre-existing before these changes).

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `apps/worker/src/jobs/run_nhl_player_shots_model.js` — modified, committed 738d5a9
- [x] `packages/models/src/card-model.js` — modified, committed 16eb2df
- [x] `apps/worker/src/models/mlb-model.js` — modified, committed 16eb2df
- [x] Both commits exist in git log
