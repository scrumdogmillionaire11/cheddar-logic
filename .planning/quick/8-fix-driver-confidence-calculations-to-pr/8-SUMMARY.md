---
phase: quick-8
plan: 01
subsystem: models
tags: [nhl, nba, driver-cards, confidence, inference]
dependency_graph:
  requires: []
  provides: [driver-confidence-signals]
  affects: [computeNHLDriverCards, computeNHLDrivers, getInference]
tech_stack:
  added: []
  patterns: [score-deviation-from-neutral, clamp-weighted-sum]
key_files:
  created: []
  modified:
    - apps/worker/src/models/index.js
    - apps/worker/src/jobs/__tests__/run_nhl_model.test.js
    - apps/worker/src/jobs/__tests__/run_nba_model.test.js
    - apps/worker/package-lock.json
decisions:
  - "shotEnvironment and emptyNet confidence use Math.abs(score - 0.5) deviation; totalFragility uses score directly since high score = meaningful signal"
  - "NHL composite confidence clamped to clamp(weightedSum, 0.50, 0.85) — no additive baseline offset"
  - "NHL prediction direction from weightedSum > 0.5 = HOME, not raw moneyline comparison"
  - "NBA getInference fallback uses highest-confidence driver card, not mockModels.NBA.confidence constant"
metrics:
  duration: "~15 minutes"
  completed: "2026-02-28"
  tasks_completed: 3
  files_modified: 4
---

# Quick Task 8: Fix Driver Confidence Calculations — Summary

**One-liner:** NHL/NBA driver confidence now derives from each driver's actual score deviation from neutral (0.5) using clamp expressions, eliminating hardcoded constants that made tier badges and play suggestions meaningless.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix per-driver hardcoded confidence in computeNHLDriverCards | a029567 | apps/worker/src/models/index.js |
| 2 | Fix NHL composite confidence baseline and prediction direction in computeNHLDrivers | 0edb8b6 | apps/worker/src/models/index.js |
| 3 | Fix getInference NBA fallback to use driver-derived confidence | 28be836 | apps/worker/src/models/index.js |

---

## Verification Results

**Task 1 — Per-driver confidence differentiation:**
```
shotEnvironment: strong=0.750 weak=0.630 differentiated=true
emptyNet:        strong=0.720 weak=0.590 differentiated=true
totalFragility:  strong=0.780 weak=0.680 differentiated=true
```

**Task 2 — NHL composite prediction direction:**
```
HOME snap prediction: HOME conf: 0.550
AWAY snap prediction: AWAY conf: 0.500
```
No `baselineConfidence` or `mockModels.NHL.confidence` reference remains in the composite calculation. Pattern confirmed: `clamp(weightedSum, 0.50, 0.85)` and `weightedSum > 0.5 ? 'HOME' : weightedSum < 0.5 ? 'AWAY' : 'NEUTRAL'`.

**Task 3 — NBA driver-derived confidence:**
```
NBA pred: HOME conf: 0.810 is_mock: true
confidence is not 0.62: true
```

**Regression tests — 12/12 passing:**
```
Test Suites: 2 passed, 2 total
Tests:       12 passed, 12 total
```

---

## Success Criteria

- [x] computeNHLDriverCards: shotEnvironment, emptyNet, totalFragility all produce different confidence values for different input deltas
- [x] computeNHLDrivers: confidence = clamp(weightedSum, 0.50, 0.85) with no mockModels.NHL.confidence reference in that calculation
- [x] computeNHLDrivers: prediction = weightedSum > 0.5 ? 'HOME' : 'AWAY' (not odds comparison)
- [x] getInference('NBA'): returns driver-derived confidence when NBA driver cards fire, not 0.62
- [x] All existing jest tests pass

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Jest global fail() removed in Jest 29 caused smoke test failures**
- **Found during:** Final verification step
- **Issue:** Both `run_nhl_model.test.js` and `run_nba_model.test.js` called `fail()` which was removed as a Jest global in v27+. With Jest 29 installed, both "job executes successfully with exit code 0" tests threw `ReferenceError: fail is not defined`.
- **Fix:** Replaced `fail(...)` with `throw new Error(...)` in both test files.
- **Files modified:** `apps/worker/src/jobs/__tests__/run_nhl_model.test.js`, `apps/worker/src/jobs/__tests__/run_nba_model.test.js`
- **Commit:** 841a92e

**2. [Rule 3 - Blocking] @cheddar-logic/models not installed in apps/worker node_modules**
- **Found during:** Final verification — job exited with code 1 citing `Cannot find module '@cheddar-logic/models'`
- **Issue:** `apps/worker/package.json` declared `@cheddar-logic/models` as a file: dependency but `npm install` had not been run after the package was added, so the symlink was absent.
- **Fix:** Ran `npm install` in `apps/worker/` to create the symlink. Added resulting `package-lock.json` to commit.
- **Files modified:** `apps/worker/package-lock.json` (created)
- **Commit:** 841a92e

---

## Self-Check

**Files verified exist:**
- `apps/worker/src/models/index.js` — exists, confirmed via source inspection
- `apps/worker/src/jobs/__tests__/run_nhl_model.test.js` — exists (committed)
- `apps/worker/src/jobs/__tests__/run_nba_model.test.js` — exists (committed)

**Commits verified:**
- a029567 — Task 1: replace hardcoded confidence in NHL per-driver cards
- 0edb8b6 — Task 2: derive NHL composite confidence and prediction from driver signals
- 28be836 — Task 3: NBA getInference fallback derives confidence from driver cards
- 841a92e — Deviation fixes: Jest fail() replacement + package-lock

## Self-Check: PASSED
