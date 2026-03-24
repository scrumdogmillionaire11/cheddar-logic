---
phase: quick
plan: 78
subsystem: ncaam-model, web-decision-layer
tags: [ncaam, matchup-style, suppression, regression-test, play-producer]
dependency_graph:
  requires: []
  provides: [ncaam-matchup-style suppressed from actionable cards]
  affects: [apps/worker/src/models/index.js, web/src/lib/game-card/transform.ts, web/src/app/api/games/route.ts]
tech_stack:
  added: []
  patterns: [TDD red-green, belt-and-suspenders suppression]
key_files:
  created:
    - apps/worker/src/models/__tests__/ncaam-drivers.test.js (extended with 2 new tests)
  modified:
    - apps/worker/src/models/index.js
    - web/src/lib/game-card/transform.ts
    - web/src/app/api/games/route.ts
decisions:
  - Deleted the Matchup Style Driver block entirely from computeNCAAMDriverCards (0-5 record, pipeline integrity problem)
  - Retained NCAAM_DRIVER_WEIGHTS.matchupStyle in run_ncaam_model.js for backward compat with persisted payloads
  - Moved ncaam-matchup-style to evidenceOnlyCardTypes in both web files so historical DB rows cannot enroll as PLAY/LEAN
metrics:
  duration: 118s
  completed: "2026-03-24T13:27:02Z"
  tasks_completed: 2
  files_modified: 4
---

# Quick Task 78: WI-0587 — Remove ncaam-matchup-style as actionable card source

**One-liner:** Suppressed ncaam-matchup-style driver block in worker + quarantined it to evidenceOnlyCardTypes in both web files, backed by a TDD regression test proving it can never be emitted.

## What Was Done

### Task 1: Remove matchup-style driver from computeNCAAMDriverCards + regression tests

The entire "Matchup Style Driver" block (~40 lines) was deleted from `computeNCAAMDriverCards` in `apps/worker/src/models/index.js`. This block built and pushed a `ncaam-matchup-style` descriptor whenever an efficiency gap >= 5 existed. With a 0-5 production record, it was a pipeline-integrity problem.

A suppression comment was left in its place noting that `NCAAM_DRIVER_WEIGHTS.matchupStyle` is retained in `run_ncaam_model.js` for backward compatibility with persisted payloads only.

Two new tests added to `ncaam-drivers.test.js`:
- **Test A** (RED/GREEN): "never emits ncaam-matchup-style even with large efficiency gap" — uses home avgPoints=90/avgPointsAllowed=65, away avgPoints=70/avgPointsAllowed=80 (efficiencyGap=35, well above >=5 threshold). Confirmed FAIL before fix, PASS after.
- **Test B**: "still emits ncaam-base-projection when team metrics are present" — same snapshot, asserts base-projection still fires (remained GREEN throughout).

### Task 2: Quarantine ncaam-matchup-style in web playProducerCardTypes

In both `web/src/lib/game-card/transform.ts` and `web/src/app/api/games/route.ts`:
- Removed `'ncaam-matchup-style'` from `playProducerCardTypes`
- Added `'ncaam-matchup-style'` to `evidenceOnlyCardTypes` (changed `new Set([])` to `new Set(['ncaam-matchup-style'])`)

Confirmed `driver-scoring.ts` line 51 already has `'ncaam-matchup-style': 'CONTEXT'` — no change needed.

## Verification Results

| Command | Result |
|---|---|
| `npx jest ncaam-drivers` (worker) | 8/8 PASS |
| `npm run test:card-decision` (web) | PASS |
| `npm run test:decision:canonical` (web) | 32/32 PASS |

## Commits

| Hash | Message |
|---|---|
| ee5e19d | feat(quick-78): remove ncaam-matchup-style driver + regression tests |
| 2cbe3a6 | feat(quick-78): quarantine ncaam-matchup-style in web playProducerCardTypes |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `apps/worker/src/models/index.js` — matchup-style block removed, suppression comment present
- `apps/worker/src/models/__tests__/ncaam-drivers.test.js` — 2 new tests passing
- `web/src/lib/game-card/transform.ts` — ncaam-matchup-style in evidenceOnlyCardTypes
- `web/src/app/api/games/route.ts` — ncaam-matchup-style in evidenceOnlyCardTypes
- Commits ee5e19d and 2cbe3a6 exist on working-branch
