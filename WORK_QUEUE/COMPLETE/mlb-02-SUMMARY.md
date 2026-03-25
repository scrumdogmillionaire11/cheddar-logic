---
phase: mlb-model-port
plan: 02
subsystem: models
tags: [mlb, strikeouts, f5-total, pitcher-props, pure-arithmetic, driver-cards]

# Dependency graph
requires:
  - phase: mlb-model-port
    provides: "mlb-01 plan context and mlb data shape in oddsSnapshot.raw_data.mlb"
provides:
  - "projectStrikeouts — weighted K/9 strikeout prop projection with 5 overlays and low-line guard"
  - "projectF5Total — ERA-based F5 total projection with WHIP and K/9 overlays"
  - "projectF5TotalCard — F5 card with OVER/UNDER/PASS thresholds and normalized confidence"
  - "computeMLBDriverCards — driver card array from oddsSnapshot matching NBA card shape"
affects: [mlb-03, mlb-scheduler, worker-pipeline]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Pure arithmetic model module — no require() calls, testable with node -e inline"
    - "Confidence normalized to 0-1 in card output (internal 1-10 scale ÷ 10)"
    - "Null-safe stat access with ?? fallback defaults throughout"

key-files:
  created:
    - apps/worker/src/models/mlb-model.js
  modified: []

key-decisions:
  - "Low-line guard fires at K line < 5.0, returns PASS with CAUTION reasoning rather than hard null"
  - "Strikeout thresholds: OVER edge>=1.0 AND conf>=8; UNDER edge<=-1.0 AND conf>=8 (backtest-validated)"
  - "F5 thresholds: OVER edge>=+0.5 AND conf>=8; UNDER edge<=-0.7 AND conf>=8"
  - "Plan verify command inputs (K9=10, line=6.5) produce edge ~0.37 which correctly falls below OVER threshold — formula is correct, plan's expected OVER output required stronger inputs"

patterns-established:
  - "MLB driver card shape: { market, prediction, confidence (0-1), ev_threshold_passed, reasoning, drivers: [{type, edge, projected}] }"
  - "parseRawMlb helper handles both string and object raw_data transparently"

requirements-completed: []

# Metrics
duration: 3min
completed: 2026-03-24
---

# Phase mlb-model-port Plan 02: MLB Model JS Port Summary

**Pure-arithmetic MLB pitcher model with strikeout props (weighted K/9 + 5 overlays) and F5 totals (ERA-based + WHIP/K9 overlays), producing NBA-shaped driver cards from oddsSnapshot.raw_data.mlb**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-03-24T19:21:14Z
- **Completed:** 2026-03-24T19:24:17Z
- **Tasks:** 3
- **Files modified:** 1

## Accomplishments
- `projectStrikeouts` with 70/30 weighted K/9, 5 active overlays (umpire, trend, wind, temp, opponent), confidence 1-10, and low-line guard
- `projectF5Total` and `projectF5TotalCard` with ERA-based formula, WHIP/K9 overlays, and validated OVER/UNDER thresholds
- `computeMLBDriverCards` producing up to 3 cards (home K, away K, F5) matching NBA driver card shape with confidence normalized to 0-1
- Zero `require()` calls — fully pure arithmetic, no DB or network dependencies

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement projectStrikeouts** - `97b5fa0` (feat) — all three functions implemented in single file creation

_Note: Tasks 2 and 3 verified post-commit as the file was created in a single pass. See Deviations section._

## Files Created/Modified
- `apps/worker/src/models/mlb-model.js` - Pure arithmetic MLB model with 4 exported functions

## Decisions Made
- All three functions were implemented in a single file creation pass (one commit) rather than incrementally, since each function depends on the others (computeMLBDriverCards calls both projectStrikeouts and projectF5TotalCard, projectF5TotalCard calls projectF5Total). This is cleaner than fragmenting an interdependent module.
- Confidence normalized ÷10 in driver card output to match NBA driver card shape (internal scale stays 1-10 for threshold logic clarity)
- Low-line guard returns structured PASS object rather than null, preserving reasoning metadata for downstream consumers

## Deviations from Plan

### Auto-noted Issues

**1. [Plan Verify] Plan verify command for Task 1 expected OVER but produces PASS**
- **Found during:** Task 1 verification
- **Issue:** Plan verify command uses `{k_per_9:10, recent_k_per_9:11, recent_ip:6}` vs line 6.5. Math: k9=10.3, base=6.87, edge=+0.37. Edge < 1.0 threshold → PASS is correct. Plan's `<done>` note said "OVER" but the formula + threshold spec are correct.
- **Fix:** No code change needed. The implementation is correct per spec. Used stronger inputs (K9=12, recentK9=13, line=5.5) to confirm OVER signal works: result is `OVER, ev_threshold_passed=true, edge=2.70`.
- **Files modified:** None
- **Verification:** `projectStrikeouts({k_per_9:12,recent_k_per_9:13,recent_ip:6},5.5)` → OVER true

---

**Total deviations:** 0 code changes (1 plan verify input mismatch noted, no code fix required)
**Impact on plan:** Formula and thresholds are exactly as spec'd. Verify command expected output was aspirational rather than mathematically consistent with inputs provided.

## Issues Encountered
- Plan verify command (Task 1) expected OVER with K9=10/line=6.5 but edge is only +0.37 — below the 1.0 threshold. The implementation is correct; the test vector was mismatched to the expected output. Confirmed OVER fires correctly with stronger inputs (K9=12, line=5.5 → edge +2.70).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `apps/worker/src/models/mlb-model.js` is ready for import into mlb-03 (scheduler wiring)
- All 4 exports verified: `projectStrikeouts`, `projectF5Total`, `projectF5TotalCard`, `computeMLBDriverCards`
- No external dependencies — drop-in import with `require('./mlb-model')`

---
*Phase: mlb-model-port*
*Completed: 2026-03-24*

## Self-Check: PASSED
- `apps/worker/src/models/mlb-model.js` — FOUND
- `.planning/phases/mlb-model-port/mlb-02-SUMMARY.md` — FOUND
- commit `97b5fa0` — FOUND
