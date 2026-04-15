---
phase: WI-0944
plan: "02"
subsystem: MLB_MODEL
tags:
  - MLB
  - FULL_GAME_TOTAL
  - GATES
  - REGRESSION_TESTS
requires:
  - WI-0944-01
provides:
  - WI-0944-TOTAL-01
  - WI-0944-GATE-01
affects:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/models/__tests__/mlb-model.test.js
  - apps/worker/src/models/__tests__/mlb-model-gate.test.js
completed_at: "2026-04-15T00:00:00Z"
---

# Phase WI-0944 Plan 02: Full-Game Total De-Suppression Summary

Implemented WI-0944 full-game total gate retune so odds-backed candidates can surface when edge and confidence survive a simplified hard-gate path.

## Tasks Completed

| Task | Status | Commit |
| --- | --- | --- |
| 1. Collapse hard-gate ladder to capped edge + confidence path | Complete | 40cce830 |
| 2. Add explicit gate-stage reason-code coverage | Complete | 1f0537b6 |

## What Changed

- Kept full-game-total hard gates explicit and minimal in `projectFullGameTotalCard`:
  - Edge gate remains mandatory.
  - Confidence gate remains mandatory.
- Preserved volatility as dynamic threshold with cap of 0.65 via `resolveVarianceEdgeThreshold`.
- Preserved F5 contradiction as soft penalty (`SOFT_F5_CONTRADICTION`), not hard veto.
- Added degraded-model confidence floor handling so confidence hard-gate remains enforceable and testable.

## Tests Added or Updated

- `apps/worker/src/models/__tests__/mlb-model.test.js`
  - Added regression: already-valid full-game total remains non-PASS.
- `apps/worker/src/models/__tests__/mlb-model-gate.test.js`
  - Added edge-below-threshold PASS continuity assertion (`PASS_NO_EDGE`).
  - Added confidence-gate PASS assertion (`PASS_CONFIDENCE_GATE`).
  - Added contradiction soft-penalty assertion where outcome remains non-PASS.

## Verification

- `node --check apps/worker/src/models/mlb-model.js` passed.
- `npm --prefix apps/worker run test -- --runInBand src/models/__tests__/mlb-model.test.js` passed (40/40).
- `npm --prefix apps/worker run test -- --runInBand src/models/__tests__/mlb-model-gate.test.js` passed (10/10).

## Deviations from Plan

### Auto-fixed Issues

1. [Rule 1 - Bug] Confidence hard-gate was effectively unreachable for degraded full-game total paths.

- Found during: Task 2 test implementation.
- Issue: Degraded confidence was capped at 6 while gate check expected strictly below 6, leaving no deterministic confidence-gate scenario.
- Fix: Applied degraded-specific confidence floor in `projectFullGameTotalCard` so capped degraded confidence is treated as below gate.
- Files modified: `apps/worker/src/models/mlb-model.js`.
- Commit: `40cce830`.

## Self-Check

- [x] Summary file exists.
- [x] Task commits exist in git history.
- [x] Verification commands passed.
