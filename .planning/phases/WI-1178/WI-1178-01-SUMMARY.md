---
phase: WI-1178
plan: WI-1178-01
subsystem: worker
tags: [potd, edge-calibration, nba, scoring, tests]

requires: []
provides:
  - Sigma-based NBA TOTAL edge calculation for POTD scoring
  - Positive-only edge component in POTD totalScore across scoring branches
  - NBA TOTAL noise floor default raised to 0.03
affects: [potd, signal-engine, model-edge-ranking]

tech-stack:
  added: []
  patterns:
    - Shared computeTotalScore helper using lineValue, marketConsensus, and normalized positive edge
    - NBA TOTAL model path uses @cheddar-logic/models computeTotalEdge with NBA sigma defaults

key-files:
  created: []
  modified:
    - apps/worker/src/jobs/potd/signal-engine.js
    - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
    - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js

key-decisions:
  - "NBA TOTAL edge no longer uses the uncalibrated /20 probability shortcut."
  - "totalScore now includes positive edge with weights: lineValue 0.45, marketConsensus 0.30, edgeComponent 0.25."
  - "edgeComponent is positive-only: negative and zero edges contribute 0."

patterns-established:
  - "Compute score from normalized edge through computeTotalScore() rather than branch-local formulas."
  - "Keep edgeSourceTag contracts unchanged while improving edge math behind MODEL candidates."

requirements-completed: [WI-1178-EDGE-01, WI-1178-SCORE-01, WI-1178-FLOOR-01]

duration: 35min
completed: 2026-04-25
---

# Phase WI-1178: POTD Edge Normalization Summary

POTD scoring now uses calibrated NBA TOTAL probabilities and gives real positive edge a first-class role in candidate ranking.

## Performance

- **Duration:** 35 min
- **Started:** 2026-04-25T16:43:00Z
- **Completed:** 2026-04-25T17:17:53Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Replaced NBA TOTAL `/20` probability shortcut with `computeTotalEdge()` using NBA sigma defaults.
- Added a positive-only normalized edge component to all POTD score branches.
- Raised NBA TOTAL noise floor default from `0.02` to `0.03`.
- Added regression coverage for sigma edge, edge clamp behavior, no zero-edge subsidy, cross-sport outranking, and the noise floor default.

## Task Commits

1. **Task 1: Add failing tests for sigma path, edgeComponent clamp, and noise floor** - `ab2da2a4` (test)
2. **Task 2: Implement sigma edge, edge-weighted totalScore, and noise floor** - `ce05197c` (fix)

## Files Created/Modified

- `apps/worker/src/jobs/potd/signal-engine.js` - Imports `computeTotalEdge()`/`getSigmaDefaults()`, computes NBA TOTAL model probability via sigma, adds shared score helpers, updates all score branches, and raises NBA TOTAL floor.
- `apps/worker/src/jobs/potd/__tests__/signal-engine.test.js` - Adds WI-1178 regression tests and updates legacy assertions to the new sigma/score contract.
- `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js` - Raises affected fixture edges/scores above the new NBA TOTAL noise floor so near-miss tests continue exercising suppression behavior.

## Decisions Made

- Used `getSigmaDefaults('NBA').total` rather than hardcoding `14` at the call site.
- Returned `null` for malformed NBA TOTAL model candidates when sigma edge calculation cannot produce finite `p_fair` and `edge`.
- Kept `EDGE_SOURCE_CONTRACT` and all `edgeSourceTag` behavior unchanged.

## Deviations from Plan

One legacy confidence-threshold fixture no longer produced an ELITE candidate because the new positive-edge score formula intentionally removed zero-edge subsidy. The test was updated to preserve threshold behavior coverage without depending on an obsolete market-only scoring artifact.

The broader POTD test suite exposed near-miss fixtures with NBA TOTAL edges below the new `0.03` floor. Those fixture values were raised above the floor so the tests still validate near-miss suppression/upsert behavior rather than the old eligibility threshold.

## Issues Encountered

Full signal-engine test run exposed legacy assertions for the old NBA `/20` model probability and old `0.02` NBA TOTAL noise floor. Those assertions were updated to the new WI-1178 contract.

## User Setup Required

None - no external service configuration required.

## Verification

- `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand -t "WI-1178"` - PASS
- `npm --prefix apps/worker run test -- src/jobs/potd/__tests__/signal-engine.test.js --runInBand` - PASS, 76 tests
- `npm --prefix apps/worker run test -- src/jobs/potd/ --runInBand --silent` - PASS, 156 tests

## Next Phase Readiness

WI-1178 is ready for verifier review. Follow-on work can analyze live POTD distribution after deployment and tune the edge cap or score weights with production samples if needed.

---
*Phase: WI-1178*
*Completed: 2026-04-25*
