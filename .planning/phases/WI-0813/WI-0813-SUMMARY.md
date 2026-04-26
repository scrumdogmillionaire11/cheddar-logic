---
phase: WI-0813
plan: WI-0813
subsystem: odds-normalization
tags: [vig-removal, market-evaluator, edge-calculator, same-book, cross-book-fix]
requires: []
provides: [same-book-vig-pairs, correct-p_implied]
affects: [WI-0814, WI-0839]
tech-stack:
  added: []
  patterns: [same-book-pairing, null-guard-fallback]
key-files:
  created:
    - packages/odds/src/__tests__/market_evaluator.same-book.test.js
  modified:
    - packages/odds/src/market_evaluator.js
    - packages/odds/src/normalize.js
    - apps/worker/src/models/cross-market.js
    - packages/models/src/decision-pipeline-v2.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/__tests__/market-evaluator-consensus.test.js
decisions:
  - Same-book pairs are re-derived at model execution time from raw_data (market entries already in DB); no new DB columns required
  - cross-market.js calls selectBestExecution(raw.totals,raw.spreads) at function top; decision-pipeline-v2 receives same-book pairs via odds_context spread from parseSameBookPairs()
  - Null guard pattern: both cross-market.js and decision-pipeline-v2 fall back to snapshot price when same-book field is null (book had only one side)
metrics:
  duration: "~45 minutes"
  completed: "2026-04-08"
---

# WI-0813 Summary

**One-liner:** Same-book vig removal — replace cross-book price cherry-picking with same-book two-sided pair in all selectTotalExecution/selectSpreadExecution/selectH2HExecution call sites; fixes ~1-2.5% systematic edge inflation.

## Objective

`selectBestExecution` was independently picking the best over-price from any book and the best under-price from any book. These cherry-picked cross-book prices have a combined implied probability ~1.96% lower than any single book's actual vig, making `edge = p_fair - p_implied` systematically inflated on every total and spread card. This fix makes vig removal same-book accurate.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add same-book pair fields to execution selectors | 27052b7 | market_evaluator.js, market_evaluator.same-book.test.js |
| 2 | Thread same-book fields through normalizeGame | d48485b | normalize.js |
| 3 | Use same-book fields at all edge call sites | da5ae06 | cross-market.js, decision-pipeline-v2.js, run_nhl_model.js, run_nba_model.js, run_mlb_model.js |
| 3b | Fix pre-existing test expectations for new fields | ac04868 | market-evaluator-consensus.test.js |

## Implementation Details

### Task 1 — market_evaluator.js

Three selectors updated:
- `selectTotalExecution`: adds `same_book_under_for_over` (same book as `best_price_over`) and `same_book_over_for_under` (same book as `best_price_under`)
- `selectSpreadExecution`: adds `same_book_away_for_home` and `same_book_home_for_away`
- `selectH2HExecution`: adds `same_book_away_for_home` and `same_book_home_for_away`

All fields are null when the associated book has only one side (null-guard fallback).

### Task 2 — normalize.js

Six new in-memory fields added to the `odds` object (no DB columns):
- `totalSameBookUnderForOver`, `totalSameBookOverForUnder`
- `spreadSameBookAwayForHome`, `spreadSameBookHomeForAway`
- `h2hSameBookAwayForHome`, `h2hSameBookHomeForAway`

### Task 3 — Edge call sites

**cross-market.js (NHL + NBA):**
- Added `selectBestExecution` import from market_evaluator
- At function top of `computeNHLMarketDecisions` and `computeNBAMarketDecisions`: re-derive execution from `raw.totals` / `raw.spreads` (the raw market entries already stored in `raw_data`)
- 4 call sites updated with null-guard pattern

**decision-pipeline-v2.js (MLB/NHL/NBA via pipeline):**
- `computeSpreadEdge` call: uses `oddsCtx.spread_same_book_away_for_home` when non-null
- `computeTotalEdge` call: uses `oddsCtx.total_same_book_under_for_over` when non-null (excludes FIRST_PERIOD path)

**Job files (NHL, NBA, MLB):**
- Added `parseSameBookPairs(rawData)` helper — re-derives same-book pairs from raw_data at runtime
- Added `...parseSameBookPairs(oddsSnapshot?.raw_data)` spread into all relevant `odds_context` blocks

## Deviations from Plan

### Auto-fixed Issues

**[Rule 1 - Bug] Updated pre-existing market-evaluator-consensus tests**

- **Found during:** Task 3 (full test run)
- **Issue:** 3 existing `.toEqual()` tests in `market-evaluator-consensus.test.js` failed because the execution selector objects now return additional `same_book_*` fields not included in the expected objects
- **Fix:** Added the new `same_book_*` fields (with their correct expected values) to the 3 test expectations
- **Files modified:** `apps/worker/src/__tests__/market-evaluator-consensus.test.js`
- **Commit:** ac04868

## Test Results

| Suite | Pass | Fail | Notes |
|-------|------|------|-------|
| packages/odds market_evaluator.same-book | 18 | 0 | New tests |
| apps/worker full suite | 1255 | 0 | (10 skipped — baseline) |
| packages/models full suite | 8 | 0 | |
| packages/odds config.season | — | 8 | Pre-existing failures (date-range test hardcoded, unrelated) |

## Acceptance Criteria Verification

- [x] `selectTotalExecution` returns `same_book_under_for_over` matching the same `book` key as `best_price_over_book` when that book has both sides
- [x] When a book has only one side, `same_book_under_for_over` is `null` and edge call falls back to existing `total_price_under`
- [x] `selectSpreadExecution` returns `same_book_away_for_home` from the same book as `best_price_home_book`; `null` when that book has no `away_price`
- [x] `selectH2HExecution` returns `same_book_away_for_home` from the same book as `best_price_home_book`; `null` when that book has no `away` price
- [x] Unit test: two-book fixture where Book A has over=-102, under=-120 and Book B has over=-130, under=-108. `best_price_over` = -102 (Book A). `same_book_under_for_over` = -120 (Book A). `best_price_under` = -108 (Book B). `same_book_over_for_under` = -130 (Book B). ✓
- [x] Edge computed on a standard -110/-110 two-book snapshot is within 0.001 of the correct single-book no-vig edge (0.500 each side). ✓
- [x] All existing market-evaluator and odds-normalization tests pass. ✓

## Human Verification Required

1. **Edge deflation check:** Run NBA/NHL model on a game with multi-book odds. Compare `p_implied` in pre-fix card vs post-fix — expect `p_implied` to be ~1-2.5% higher (closer to 0.48-0.50 for -110/-110 markets).
2. **Null fallback check:** Ingest a game snapshot where only one book has a total line (single-sided). Expect model to complete successfully with the same result as pre-fix (null guard kicks in, falls back to `total_price_under` from snapshot).

---
_Verified: 2026-04-08 | Executor: Claude (pax-executor) via Copilot_
