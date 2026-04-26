# IME-01-03 Summary

## Outcome

`apps/worker/src/jobs/run_mlb_model.js` now uses `evaluateMlbGameMarkets()` instead of `selectMlbGameMarket()`. The runner evaluates all MLB game-market candidates per game, asserts the no-silent-drop invariant before writes, logs rejected markets, skips cleanly on `SKIP_MARKET_NO_EDGE` and `SKIP_GAME_INPUT_FAILURE`, and inserts every qualified official play or lean in the same per-game transaction.

## Key Changes

- Replaced the old single-market `gameSelection.selected_driver` flow with `gameEval = evaluateMlbGameMarkets(gameDriverCards, { game_id })`.
- Added `assertNoSilentMarketDrop(gameEval)` and `logRejectedMarkets(gameEval.rejected)` before any per-game DB writes.
- Recovered `qualifiedDrivers` from `gameEval.official_plays` and `gameEval.leans`, then fed those drivers into the existing card-building pipeline.
- Added `mlb-full-game` and `mlb-full-game-ml` transaction preparation so full-game markets are cleared and rewritten alongside existing MLB card types.
- Updated payload construction so full-game total and full-game ML cards get the correct `cardType`, `market_type`, and odds context.

## Verification

- `node -e "require('./apps/worker/src/jobs/run_mlb_model')"`
- `rg -n "selectMlbGameMarket" apps/worker/src/jobs/run_mlb_model.js` → no hits
- `rg -n "evaluateMlbGameMarkets|assertNoSilentMarketDrop" apps/worker/src/jobs/run_mlb_model.js`
- `npx jest apps/worker/src/jobs/__tests__/run_mlb_model.test.js --no-coverage -t "multi-market insertion"`
- `npx jest apps/worker/src/jobs/__tests__/run_mlb_model.test.js --no-coverage`

## Test Coverage Added

- Runner-level multi-market insertion test: one official play plus one lean leads to two inserted card payloads, with the lean preserved as `classification='LEAN'`.
- Runner-level skip test: all rejected game markets produce `SKIP_MARKET_NO_EDGE`, log the explicit skip, and insert zero cards.
