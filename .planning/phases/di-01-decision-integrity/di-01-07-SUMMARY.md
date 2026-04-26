---
phase: di-01-decision-integrity
plan: "07"
subsystem: model-core
completed: 2026-04-11
---

# di-01-07 Summary

Stale-input and flip-threshold calibration is now configurable and enforced with production-failing mutation checks.

- Moved stale watchdog blocking to `WATCHDOG_STALE_THRESHOLD_MINUTES` with default `30` and floor `15`.
- Recalibrated `EDGE_UPGRADE_MIN` to `0.04` and fixed the float-boundary comparison in `shouldFlip()`.
- Changed `assertNoDecisionMutation()` to throw unconditionally and added flip/stale tests.

Verification:
- `npm --prefix packages/models test -- --runInBand --testPathPattern='(decision-gate.flip-threshold|decision-pipeline-v2-stale-odds)'`
- `npm --prefix apps/worker test -- --runInBand --testPathPattern=decision-publisher`
