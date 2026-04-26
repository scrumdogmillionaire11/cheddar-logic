---
phase: S5-model-advanced-architecture
plan: "02"
subsystem: model-calibration
tags: [isotonic-regression, calibration, fair-prob, PAV, kelly-correction]

requires:
  - phase: S5-01
    provides: score-engine.js additive z-score aggregation

provides:
  - PAV isotonic calibration utility (fitIsotonic + applyCalibration)
  - calibration_models DB table (migration 071)
  - fit_calibration_models daily job
  - Calibrated fair_prob in card payloads (all 3 sport job files)

affects: [S5-03, calibration-monitoring, kelly-fractions, net_edge]

tech-stack:
  added: []
  patterns:
    - Pool Adjacent Violators (PAV) isotonic regression in pure JS
    - Graceful fallback when calibration_models table not ready
    - Per-card calibration source annotation via raw_data.calibration_source

key-files:
  created:
    - packages/data/db/migrations/071_calibration_models.sql
    - apps/worker/src/utils/calibration.js
    - apps/worker/src/utils/__tests__/calibration.test.js
    - apps/worker/src/jobs/fit_calibration_models.js
  modified:
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/schedulers/main.js

key-decisions:
  - "market_type key in calibration_models uses THRESHOLDS token format (NHL_TOTAL, NBA_TOTAL, MLB_F5_TOTAL) to align with calibration-utils.js"
  - "applyCalibration injected BEFORE Kelly so kelly_fraction reflects calibrated probability"
  - "NHL 1P uses NHL_TOTAL key (no separate 1P model yet; falls back gracefully if not present)"
  - "fit job uses getDatabase() fallback pattern matching runClvSnapshot() convention"

patterns-established:
  - "Calibration injection pattern: try/catch db.prepare → applyCalibration → pd.p_fair = calibratedProb → pd.raw_data.calibration_source"

duration: 35min
completed: 2025-07-25
---

# Phase S5 Plan 02: Isotonic Calibration Layer Summary

**PAV isotonic regression calibration wired into all three sport job card write paths, correcting systematic fair_prob overestimation that inflated Kelly fractions by ~40%.**

## Performance

- **Duration:** ~35 min
- **Tasks:** 2/2
- **Files modified:** 8
- **Tests:** 116 suites / 1452 tests passing

## Accomplishments

- Created `calibration.js` with `fitIsotonic` (PAV) and `applyCalibration` (linear interp, [0.01,0.99] clamp) — no external dependencies
- Created migration `071_calibration_models.sql` with `(sport, market_type)` primary key
- Created `fit_calibration_models.js` daily job: reads `calibration_predictions`, fits per-market isotonic regression, upserts breakpoints as JSON
- All three sport job files (`run_mlb_model.js`, `run_nba_model.js`, `run_nhl_model.js`) now apply calibration before Kelly stake computation
- Graceful try/catch fallback when `calibration_models` table doesn't exist (new deploy safety)
- Scheduler `main.js` registers `fit_calibration_models` at 06:00 ET daily
- 13 unit tests for calibration utility: PAV correctness, Brier improvement, interpolation, clamping, fallback

## Deviations from Plan

### Auto-fixed Issues

**[Rule 2 - Missing Critical] fit_calibration_models needed getDatabase() fallback**

- **Found during:** Task 2 scheduler wiring
- **Issue:** Plan specified `run(db)` taking explicit db; scheduler convention uses `() => job()` with `getDatabase()` inside
- **Fix:** Added `const { getDatabase } = require('@cheddar-logic/data')` + `const db = dbOverride || getDatabase()` matching `runClvSnapshot` pattern
- **Files modified:** `apps/worker/src/jobs/fit_calibration_models.js`

## Decisions Made

| Decision | Rationale |
| --- | --- |
| market_type keys use THRESHOLDS token format | Aligns with calibration_predictions.market field; no separate mapping needed |
| applyCalibration before Kelly | Kelly fraction should use corrected probability (WI-0831 intent) |
| NHL 1P maps to NHL_TOTAL key | No separate 1P calibration model yet; graceful fallback preserves operation |

## Next Phase Readiness

- S5-03 (residual projection) can proceed: `fair_prob` on card payloads is now calibrated
- `fairLine` is exposed in NHL and NBA model returns (added in S5-01 Task 2)
- No blockers identified
