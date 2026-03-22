---
phase: 64-wi-0550
plan: "01"
subsystem: nba-model
tags: [nba, spread, edge-gate, settlement, tdd]
dependency_graph:
  requires: []
  provides: [SPREAD_EDGE_MIN gate, generateNBAMarketCallCards export]
  affects: [apps/worker/src/jobs/run_nba_model.js]
tech_stack:
  added: []
  patterns: [edge gate guard, tdd red-green]
key_files:
  created:
    - apps/worker/src/jobs/__tests__/run_nba_model.market-calls.test.js
    - WORK_QUEUE/COMPLETE/WI-0550.md
  modified:
    - apps/worker/src/jobs/run_nba_model.js
decisions:
  - "Null edge is pass-through (not filtered) — preserves behavior for edge-less decisions"
  - "Legacy 82% void rate is a data artifact (pre-market-locking null market_key), no code fix required"
  - "SPREAD_EDGE_MIN = 0.02 placed as const before the if block per plan spec"
metrics:
  duration_minutes: 5
  completed_date: "2026-03-22"
  tasks_completed: 2
  files_changed: 2
---

# Phase 64 Plan 01: WI-0550 NBA Spread Edge Gate Summary

**One-liner:** Edge gate `SPREAD_EDGE_MIN = 0.02` blocks negative-EV nba-spread-call cards; settlement 82% void rate diagnosed as legacy null market_key artifact with no code fix needed.

## What Was Built

### Task 1: Edge gate + export (feat)

Modified `apps/worker/src/jobs/run_nba_model.js`:

- Added `const SPREAD_EDGE_MIN = 0.02` before the spread card emission if-block
- Condition changed to: `spreadDecision.edge == null || spreadDecision.edge > SPREAD_EDGE_MIN`
- Null edge is a pass-through (preserved behavior for edge-less decisions)
- Exported `generateNBAMarketCallCards` in `module.exports` for unit testing

### Task 2: Unit tests + settlement diagnosis (test)

Created `apps/worker/src/jobs/__tests__/run_nba_model.market-calls.test.js` with 4 tests:

| Test | Edge | Expected |
|------|------|----------|
| RED: negative edge | -0.25 | 0 spread cards (blocked) |
| RED: threshold exactly | 0.02 | 0 spread cards (blocked — not strictly greater) |
| GREEN: positive edge | 0.08 | 1 spread card (passes gate) |
| GREEN: null edge | null | 1 spread card (null is pass-through) |

Updated WI-0550.md with settlement void rate diagnosis section:
- Root cause: legacy cards pre-dating market-locking have `market_key = NULL`
- `autoCloseNonActionableFinalPendingRows` auto-voids these as `MISSING_MARKET_KEY`
- New cards generated after market-locking migration settle correctly
- No settlement code change required

Moved `WORK_QUEUE/WI-0550.md` to `WORK_QUEUE/COMPLETE/WI-0550.md`.

## Verification

```
npx jest apps/worker/src/jobs/__tests__/run_nba_model --no-coverage
  Test Suites: 2 passed, 2 total
  Tests:       10 passed, 10 total

grep "SPREAD_EDGE_MIN" apps/worker/src/jobs/run_nba_model.js
  497:  const SPREAD_EDGE_MIN = 0.02;
  501:    (spreadDecision.edge == null || spreadDecision.edge > SPREAD_EDGE_MIN)

grep "generateNBAMarketCallCards" ... module.exports
  1020:module.exports = { runNBAModel, generateNBAMarketCallCards };
```

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| Task 1 | 6fd0c9f | feat(64-wi-0550): add SPREAD_EDGE_MIN gate + export generateNBAMarketCallCards |
| Task 2 | 94868af | test(64-wi-0550): unit tests for spread edge gate + settlement void rate diagnosis |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `apps/worker/src/jobs/run_nba_model.js` modified with gate + export
- [x] `apps/worker/src/jobs/__tests__/run_nba_model.market-calls.test.js` created (4 tests, all pass)
- [x] `WORK_QUEUE/COMPLETE/WI-0550.md` contains settlement diagnosis section
- [x] commit 6fd0c9f exists (feat: edge gate)
- [x] commit 94868af exists (test: unit tests)
- [x] All 10 run_nba_model tests pass
