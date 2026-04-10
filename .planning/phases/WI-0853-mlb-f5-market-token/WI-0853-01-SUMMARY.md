---
phase: WI-0853-mlb-f5-market-token
plan: 01
subsystem: worker-mlb-market-token
tags: [mlb, market-type, backward-compat, calibration, settlement, audit]
status: complete

dependency-graph:
  requires: []
  provides:
    - run_mlb_model.js emits FIRST_5_INNINGS for all F5 cards
    - calibration-gate accepts both FIRST_5_INNINGS + FIRST_PERIOD
    - settle_pending_cards routes FIRST_5_INNINGS to correct F5 path
    - backfill_period_token detects FIRST_5_INNINGS
    - audit files display FIRST_5_INNINGS as F5
  affects:
    - WI-0853-02 (web layer reads token emitted here)

tech-stack:
  added: []
  patterns:
    - Additive OR dual-token acceptance (never remove FIRST_PERIOD for backward compat)

key-files:
  created: []
  modified:
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/calibration/calibration-gate.js
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/backfill_period_token.js
    - apps/worker/src/audit/audit_rules_config.js
    - apps/worker/src/audit/performance_drift_report.js
    - apps/worker/src/audit/projection_evaluator.js

decisions:
  - "Never remove FIRST_PERIOD from consumer OR-chains — old DB rows still carry that token"
  - "audit_rules_config maps FIRST_5_INNINGS -> 'F5' display, FIRST_PERIOD -> '1P' separately"

metrics:
  duration: ~15 min
  completed: 2026-04-10
---

# Phase WI-0853 Plan 01: MLB F5 Market Token Worker Layer Summary

**One liner:** Worker layer: run_mlb_model emits `FIRST_5_INNINGS`; 6 consumer files accept both tokens via additive OR dual-token acceptance for backward compat with existing DB rows.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Change run_mlb_model.js F5 emission | 2bfd1c3 | run_mlb_model.js |
| 2 | Add FIRST_5_INNINGS to calibration, settle, backfill | c1ed3f8 | calibration-gate.js, settle_pending_cards.js, backfill_period_token.js |
| 3 | Add FIRST_5_INNINGS to audit files + run tests | 259dba0 | audit_rules_config.js, performance_drift_report.js, projection_evaluator.js |

## Verification Results

- `run_mlb_model.js` line 2067: `FIRST_5_INNINGS` (no remaining `FIRST_PERIOD`)
- `calibration-gate.js`: 2 occurrences (normalizePeriod + resolveCalibrationMarketKey)
- `settle_pending_cards.js`: 4 occurrences across all period detection branches
- `backfill_period_token.js`: 2 occurrences
- `audit_rules_config.js`: 1 occurrence (FIRST_5_INNINGS → 'F5' display)
- `performance_drift_report.js`: 1 occurrence in normalizePeriodToken
- `projection_evaluator.js`: 1 occurrence in normalizePeriodToken
- `run_nhl_model.js`: FIRST_PERIOD still present (untouched — correct)
- Worker tests: 1327/1328 pass; 1 pre-existing failure (settlement-mirror, unrelated)

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

Ready for WI-0853-02 (web layer). Worker now emits FIRST_5_INNINGS for new F5 cards; old rows with FIRST_PERIOD still settle/calibrate correctly.
