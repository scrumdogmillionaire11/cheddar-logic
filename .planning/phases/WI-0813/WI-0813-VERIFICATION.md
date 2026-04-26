---
phase: WI-0813
verified: 2026-04-08T13:30:00Z
status: passed
score: 6/6 must-haves verified
---

# WI-0813 Verification Report

**Status:** PASSED | **Score:** 6/6 | **Re-verification:** No

**Phase Goal:** Correct selectBestExecution so vig is removed using same-book two-sided prices, eliminating ~1-2.5% systematic edge inflation on every total and spread card.

## Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | selectTotalExecution: same_book_under_for_over from same book as best_price_over_book | VERIFIED | market_evaluator.js L242-258 |
| 2 | One-sided book yields null same_book_under_for_over; call sites fall back to total_price_under | VERIFIED | test: book with only over side; != null guards |
| 3 | selectSpreadExecution: same_book_away_for_home from same book as best_price_home_book; null when absent | VERIFIED | market_evaluator.js L210-227 |
| 4 | selectH2HExecution: same_book_away_for_home from same book as best_price_home_book; null when absent | VERIFIED | market_evaluator.js L268-281 |
| 5 | Two-book fixture Book A(-102/-120) Book B(-130/-108): same_book_under_for_over=-120 same_book_over_for_under=-130 | VERIFIED | market_evaluator.same-book.test.js; 18/18 |
| 6 | -110/-110 two-book: same-book devig within 0.001 of 0.500 each side | VERIFIED | test: same-book devig gives 0.500; PASS |

**Score: 6/6**

## Required Artifacts

| Artifact | Status | Details |
| --- | --- | --- |
| packages/odds/src/market_evaluator.js | VERIFIED WIRED | L210-281: all 3 selectors return same_book_* fields |
| packages/odds/src/normalize.js | VERIFIED WIRED | L190-230: 6 camelCase same-book fields threaded through normalizeGame |
| apps/worker/src/models/cross-market.js | VERIFIED WIRED | L505-506 L648-649 NHL; L996-997 L1098-1099 NBA |
| packages/models/src/decision-pipeline-v2.js | VERIFIED WIRED | L1280-1282 spread; L1323-1325 total |
| apps/worker/src/jobs/run_nhl_model.js | VERIFIED WIRED | parseSameBookPairs L92-104; 3 call sites |
| apps/worker/src/jobs/run_nba_model.js | VERIFIED WIRED | parseSameBookPairs L89-101; 2 call sites |
| apps/worker/src/jobs/run_mlb_model.js | VERIFIED WIRED | parseSameBookPairs L59-71; 1 call site |
| packages/odds/src/__tests__/market_evaluator.same-book.test.js | VERIFIED WIRED | 210 lines, 18 tests, 4 describe blocks |

## Key Links (all WIRED)

- computeTotalEdge NHL: nhlTotalExec.same_book_under_for_over via selectBestExecution(raw.totals) L505
- computeSpreadEdge NHL: nhlSpreadExec.same_book_away_for_home via selectBestExecution(raw.spreads) L648
- computeTotalEdge NBA: nbaTotalExec.same_book_under_for_over L996
- computeSpreadEdge NBA: nbaSpreadExec.same_book_away_for_home L1098
- computeTotalEdge decision-pipeline-v2: oddsCtx.total_same_book_under_for_over via parseSameBookPairs L1323
- computeSpreadEdge decision-pipeline-v2: oddsCtx.spread_same_book_away_for_home via parseSameBookPairs L1280
- parseSameBookPairs(run_nhl/nba/mlb): re-runs selectBestExecution on raw_data; spreads snake_case fields into odds_context

## Scope Hygiene

No out-of-scope files touched. edge-calculator.js unchanged. pull_odds_hourly.js unchanged. No DB schema changes. No new DB columns.

## Test Results

| Suite | Tests | Result |
| --- | --- | --- |
| packages/odds: market_evaluator.same-book | 18/18 | PASS |
| apps/worker: cross-market (2 suites) | 38/38 | PASS |
| packages/models: decision-pipeline-v2 (4 suites) | 25/25 | PASS |
| apps/worker: market-evaluator-consensus | 14/14 | PASS |

**Total: 95 tests, all pass.**

## Anti-Patterns

None in modified sections.

## Human Verification Required

1. p_implied >= 0.47 on live NBA totals
   Test: npm --prefix apps/worker run job:run-nba-model then query card_payloads p_implied.
   Expected: All p_implied >= 0.47 for -110/-110 markets (was ~0.46 pre-fix).
   Why human: Requires live prod DB and odds pipeline.

2. No PLAY cards flip to LEAN without legitimate edge reduction
   Test: Compare card outcomes on frozen snapshot before/after deployment.
   Expected: Grade changes traceable only to vig correction.
   Why human: Requires prod snapshot comparison.

---
_Verified: 2026-04-08_
_Verifier: Claude (pax-verifier)_
