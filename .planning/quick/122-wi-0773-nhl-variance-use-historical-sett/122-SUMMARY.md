---
phase: quick-122
plan: 01
subsystem: nhl-model
tags: [nhl, sigma, calibration, edge-calculator, variance]
dependency_graph:
  requires: [computeSigmaFromHistory in packages/models/src/edge-calculator.js]
  provides: [NHL sigma calibrated from historical game results at job start]
  affects: [run_nhl_model.js, nhl-sigma-calibration.test.js]
tech_stack:
  added: []
  patterns: [computeSigmaFromHistory at job start, sigma_source annotation on card payloads]
key_files:
  created:
    - apps/worker/src/__tests__/nhl-sigma-calibration.test.js
  modified:
    - apps/worker/src/jobs/run_nhl_model.js
decisions:
  - "Use _computedSigma/_sigmaSource prefixed variables to avoid shadowing existing nhlBaseSigma"
  - "Annotate both driver card and market call card push sites in pendingCards loop"
  - "Handle absent raw_data on payloadData with fallback to fresh object"
  - "Test uses auditContext.paceResult on driver card to avoid invariant breach in test mode (NODE_ENV=test)"
metrics:
  duration: "18 minutes"
  completed: "2026-04-04"
  tasks_completed: 2
  files_modified: 2
---

# Phase quick-122 Plan 01: NHL Sigma Calibration via computeSigmaFromHistory Summary

**One-liner:** NHL pace model now self-calibrates outcome variance via computeSigmaFromHistory (same NBA pattern), falling back to getSigmaDefaults when fewer than 20 settled games exist, and annotates each card payload with raw_data.sigma_source = 'calibrated' | 'default'.

## What Was Built

Replaced the static `getSigmaDefaults('NHL')` call in `run_nhl_model.js` with `computeSigmaFromHistory({ sport: 'NHL', db: getDatabase() })` at job start (lines 1485-1498). The result branches:

- **`sigma_source === 'computed'`**: logs "[NHL] sigma calibrated from N samples: {...}" and uses calibrated margin/total as nhlBaseSigma
- **`sigma_source === 'fallback'`**: logs "[NHL] insufficient history for sigma calibration — using defaults" and falls back to `getSigmaDefaults('NHL')`

Both the driver card loop and the market call card loop now annotate `card.payloadData.raw_data.sigma_source` with `'calibrated'` or `'default'` before pushing to pendingCards.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Write failing tests for NHL sigma calibration (TDD RED) | 2d3385b | apps/worker/src/__tests__/nhl-sigma-calibration.test.js |
| 2 | Replace getSigmaDefaults with computeSigmaFromHistory | fbdba61 | apps/worker/src/jobs/run_nhl_model.js, nhl-sigma-calibration.test.js |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Driver card requires auditContext.paceResult to avoid invariant breach in test mode**

- **Found during:** Task 2 (GREEN phase)
- **Issue:** `emitNhlSnapshotInvariant` throws in `NODE_ENV=test` when `paceResult` is null for `nhl-pace-totals` cards. The test driver cards lacked `auditContext.paceResult`, causing `cardsFailed: 1` and `insertCardPayload` never being called.
- **Fix:** Added `MINIMAL_PACE_RESULT` and `auditContext: { paceResult }` to `buildFakeDriverCard` in the test file.
- **Files modified:** `apps/worker/src/__tests__/nhl-sigma-calibration.test.js`
- **Commit:** fbdba61

## Verification Results

```
# New tests pass
Tests: 10 passed, 10 total

# getSigmaDefaults only in fallback branch
1497: nhlBaseSigma = edgeCalculator.getSigmaDefaults('NHL');  (one result — fallback only)

# computeSigmaFromHistory present
1485-1486: const _computedSigma = edgeCalculator.computeSigmaFromHistory({...})

# sigma_source annotation present (4 sites in 2 card loops)
Lines 1773, 1777, 1781, 1866, 1870, 1874

# Stale comment removed
(zero results)

# Existing NHL tests unbroken
run-nhl-model.test.js: 5 passed
nhl-shot-quality.test.js: 9 passed
```

## Self-Check: PASSED

- FOUND: apps/worker/src/__tests__/nhl-sigma-calibration.test.js
- FOUND: apps/worker/src/jobs/run_nhl_model.js (modified)
- FOUND: commit 2d3385b (TDD RED)
- FOUND: commit fbdba61 (implementation GREEN)
