---
phase: WI-0944
plan: "01"
subsystem: RUNNER_INSTRUMENTATION
tags:
  - OBSERVABILITY
  - FUNNEL_ACCOUNTING
  - TEST_COVERAGE
  - MLB
duration:
  started: "2026-04-15T00:00:00Z"
  completed: "2026-04-15T00:30:00Z"
  elapsed_minutes: 30
decision_count: 0
one_liner: Full-game funnel instrumentation + deterministic operator reporting + runner-level test coverage
---

# Phase WI-0944 Plan 01: MLB Full-Game Funnel Instrumentation Summary

**Plan:** WI-0944-01-PLAN.md
**Status:** ✅ COMPLETE
**All tasks:** 2/2 passed

## Overview

Installed deterministic observability layer for MLB full-game market suppression before retuning thresholds. The runner now exports operator-facing funnel reports that show exactly where full-game candidates die, enabling threshold changes to be data-driven and regressions to stay visible.

## Tasks Completed

### Task 1: Finish and normalize the MLB full-game funnel contract in the runner (TDD)

**Status:** ✅ COMPLETE
**Commits:** `test(WI-0944-01): add MLB full-game suppression funnel test coverage`

**What was done:**

- Exported funnel functions from run_mlb_model.js:
  - `buildMlbFullGameSuppressionFunnelReport`
  - `evaluateMlbFullGameFunnelCandidate`
  - `getMlbFullGameMarketKey`
  - `normalizeReasonCodeSet`
  - `MLB_FULL_GAME_FUNNEL_WINDOW` (constant = 50)

- Added 5 comprehensive unit tests with 100% pass rate:

  1. **Test 1:** Deterministic funnel stage keys and counts for mixed full-game candidates
     - 20 mixed candidates (10 full_game_total, 5 PASS_NO_EDGE, 3 PASS_PROBABILITY_EDGE_WEAK, 2 low-confidence)
     - Verified exact counts match expected stage progressions
     - Confirmed no candidates disappear without accounting

  2. **Test 2:** Reproducible stage percentages and consistent suppressor ordering
     - 50 candidates with varied suppressors
     - Ran report twice, verified percentages and suppressors are identical
     - Confirmed sample_size respects window limit
     - Verified all stage keys exist with valid percentage values

  3. **Test 3:** Top suppressors derived from actual drop buckets
     - 36 candidates with clear suppressor distribution (20 PASS_NO_EDGE, 8 low-confidence, 4 PASS_PROBABILITY_EDGE_WEAK)
     - Verified exactly 2 suppressors in top_suppressors
     - Confirmed ordering by count (first >= second)
     - Verified suppressors from allowed set (not hardcoded)
     - Confirmed top-2 impact > 50% (meaningful representation)

  4. **Test 4:** getMlbFullGameMarketKey returns correct identifiers
     - full_game_total → "FULL_GAME_TOTAL"
     - full_game_ml → "FULL_GAME_ML"
     - Other markets → null

  5. **Test 5:** Funnel window respects 50-sample limit
     - 100 samples input → sample_size = 50
     - Uses last 50 samples only
     - Counts identical to last-50-only report

**Verification:**

- All 118 existing tests continue to pass (no regressions)
- Funnel tests added to `src/jobs/__tests__/run_mlb_model.test.js` (lines 2654-2949)
- Each test validates independent aspect of funnel (stage accounting, reproducibility, suppressor derivation)

### Task 2: Lock the funnel output format to the WI-0944 operator contract

**Status:** ✅ COMPLETE
**Commits:** `chore(WI-0944-01): lock MLB suppression funnel output contract with JSDoc`

**What was done:**

- Added comprehensive JSDoc documentation to `buildMlbFullGameSuppressionFunnelReport` function
- Documented exact output shape with 4 required fields:
  - `sample_size`: N (max 50)
  - `counts`: 8 stage counters (total_candidates through final_official_plays)
  - `drop_pct`: 7 stage percentages showing drop from previous stage
  - `top_suppressors`: Top 2 suppressors with condition, count, impact_pct
- Added operator guidance section explaining:
  - High drop_pct at a stage indicates investigate that gate
  - top_suppressors provides common suppressors without parsing payloads
  - Reproducible output enables before/after threshold testing
- Contract locked for WI-0944 and later plans

**Verification:**

- Node syntax check passes (no errors or warnings)
- Logging already in place at run_mlb_model.js lines 3050-3054
- Output emitted as: `[MLB_SUPPRESSION_FUNNEL] {JSON.stringify(suppressionFunnel)}`

## Key Metrics

| Metric | Value |
| --- | --- |
| Functions exported | 5 |
| New test cases | 5 |
| Test pass rate | 100% (5/5) |
| Total test coverage (suite) | 118/118 passing |
| Files modified | 2 (run_mlb_model.js, test file) |
| Lines of tests | 296+ |
| Completion | No regressions, all done criteria met |

## Deviations from Plan

None — plan executed exactly as written.

## Known Issues / Deferred

None identified. Funnel is deterministic, reproducible, and ready for Wave 2 (threshold retuning).

## What This Enables

1. **Wave 2 (MLB full-game total de-suppression):** Can now compare suppression funnel before/after threshold changes to prove retuning improves surfacing
2. **Operator reporting:** Operators can read `[MLB_SUPPRESSION_FUNNEL]` logs to diagnose why specific games have no full-game cards emitted
3. **Per-run accountability:** Every full-game candidate is tracked; none can disappear without a suppressor reason code

## Next Steps

→ Execute **WI-0944-02-PLAN.md** (Wave 2): Full-game total de-suppression retune with capped volatility threshold + gate regression tests

## Files Modified

| File | Changes | Lines |
| --- | --- | --- |
| apps/worker/src/jobs/run_mlb_model.js | Export funnel functions + JSDoc contract lock | +44 exports/docs |
| apps/worker/src/jobs/__tests__/run_mlb_model.test.js | Add 5 comprehensive funnel tests | +296 lines of tests |

## Commits

1. `test(WI-0944-01): add MLB full-game suppression funnel test coverage`
   - Export functions
   - Add 5 tests
   - Verify all pass (118/118)

2. `chore(WI-0944-01): lock MLB suppression funnel output contract with JSDoc`
   - Document output shape
   - Add operator guidance
   - Lock contract for later plans

## Self-Check

- ✅ Files modified exist and contain expected changes
- ✅ All commits present and referenced in SUMMARY
- ✅ Test suite passes (118/118)
- ✅ Funnel functions exported and testable
- ✅ Output format documented and locked
- ✅ No regressions introduced
