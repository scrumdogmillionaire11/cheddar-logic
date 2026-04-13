---
phase: ime-01-independent-market-eval
plan: "04"
subsystem: nhl-market-evaluation
tags: [independent-market-eval, nhl, cross-market, ime]
requires:
  - ime-01-01
provides:
  - evaluateNHLGameMarkets
  - choosePrimaryDisplayMarket
  - nhl-ime-wiring
affects:
  - ime-01-05
tech-stack:
  added: []
  patterns: [adapter-pattern, independent-market-eval, game-eval-finalization]
key-files:
  created: []
  modified:
    - apps/worker/src/models/cross-market.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/models/index.js
    - apps/worker/src/models/__tests__/cross-market.test.js
    - apps/worker/src/jobs/__tests__/run_nhl_model.test.js
decisions:
  - evaluateNHLGameMarkets adapts computeNHLMarketDecisions output via adaptDecisionToCard; no changes to decision shapes
  - choosePrimaryDisplayMarket is pure ranking only — does NOT remove non-primary markets from gameEval
  - selectExpressionChoice preserved for backward compatibility; IME gate runs alongside it
  - gameEval gate falls back to old chosenCardType logic when gameEval is null (backward compat)
metrics:
  duration: "~35 minutes"
  completed: "2026-04-13"
  tasks_completed: 3
  files_changed: 5
---

# Phase ime-01 Plan 04: NHL Independent Market Evaluation Summary

**One-liner:** Add evaluateNHLGameMarkets() and choosePrimaryDisplayMarket() to cross-market.js and wire into run_nhl_model.js so all qualified NHL markets (TOTAL, SPREAD, ML) emit independently rather than only the selectExpressionChoice winner.

## Objective

NHL ML was only generated when selectExpressionChoice() picked it over TOTAL/SPREAD (audit DEFECT #3). This plan adds independent evaluation: TOTAL, SPREAD, and ML are each evaluated by evaluateSingleMarket(). All qualified markets now surface. selectExpressionChoice() is preserved but used only for display ranking.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add evaluateNHLGameMarkets() and choosePrimaryDisplayMarket() to cross-market.js | 8929891 | cross-market.js, models/index.js |
| 2 | Wire evaluateNHLGameMarkets into run_nhl_model.js | 8929891 | run_nhl_model.js |
| 3 | cross-market + NHL runner tests for independent evaluation | 8929891 | cross-market.test.js, run_nhl_model.test.js |

## Implementation Details

### cross-market.js additions

- `adaptDecisionToCard(decision, marketToken)`: Converts a computeNHLMarketDecisions result into the driver card shape expected by `evaluateSingleMarket`
- `evaluateNHLGameMarkets({ marketDecisions, game_id })`: Evaluates TOTAL, SPREAD, and ML independently via `evaluateSingleMarket`; calls `finalizeGameMarketEvaluation` and `logRejectedMarkets`
- `choosePrimaryDisplayMarket(gameEval)`: Sorts all qualified markets by tier (official > lean) then edge; returns top — does NOT remove others

### run_nhl_model.js wiring

Per-game loop now calls:
```js
const gameEval = evaluateNHLGameMarkets({ marketDecisions, game_id: gameId });
assertNoSilentMarketDrop(gameEval);
const primaryDisplayMarket = choosePrimaryDisplayMarket(gameEval);
```

Each market gate changed from `!chosenCardType || chosenCardType === 'nhl-X-call'` to check `gameEval.official_plays.concat(gameEval.leans).find(r => r.market_type === ...)` when `gameEval` is provided.

Each card payloadData gains `primary_display_market` and `is_primary_display` fields.

### Test coverage

| Suite | New Tests | Result |
|-------|-----------|--------|
| cross-market: evaluateNHLGameMarkets independent evaluation (IME-01-04) | 2 | PASS |
| generateNHLMarketCallCards independent evaluation (IME-01-04) | 2 | PASS |

4 pre-existing integration test failures confirmed unrelated (DB query on wrong test fixture).

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `evaluateNHLGameMarkets` and `choosePrimaryDisplayMarket` exist in cross-market.js (L1361, L1395)
- [x] Both exported from cross-market.js and models/index.js
- [x] `evaluateNHLGameMarkets` called in run_nhl_model.js (L2339)
- [x] `selectExpressionChoice` still present in run_nhl_model.js (L2336)
- [x] 4 new tests, all passing
- [x] Commit 8929891 exists

## Self-Check: PASSED
