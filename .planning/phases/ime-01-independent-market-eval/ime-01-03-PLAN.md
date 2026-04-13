---
phase: ime-01-independent-market-eval
plan: "03"
type: execute
wave: 2
depends_on: ["ime-01-01", "ime-01-02"]
files_modified:
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/jobs/__tests__/run_mlb_model.test.js
autonomous: true
requirements: [IME-MLB-03, IME-MLB-04]

must_haves:
  truths:
    - "run_mlb_model.js no longer calls selectMlbGameMarket()"
    - "run_mlb_model.js calls evaluateMlbGameMarkets(gameDriverCards, {game_id}) instead"
    - "All official_plays are inserted as card_payloads in the same per-game transaction"
    - "All leans are inserted as card_payloads marked with classification='LEAN'"
    - "rejected markets are logged via logRejectedMarkets — not silently dropped"
    - "assertNoSilentMarketDrop is called after game evaluation, before transaction"
    - "When gameEval.status === 'SKIP_MARKET_NO_EDGE' or 'SKIP_GAME_INPUT_FAILURE', the game logs a skip with explicit reason and zero cards are inserted"
  artifacts:
    - path: "apps/worker/src/jobs/run_mlb_model.js"
      provides: "Per-game evaluation loop using evaluateMlbGameMarkets; all markets persisted or explicitly rejected"
      contains: "evaluateMlbGameMarkets"
    - path: "apps/worker/src/jobs/__tests__/run_mlb_model.test.js"
      provides: "2 integration-style tests for multi-market insertion and empty-game skip"
      min_lines: 2
  key_links:
    - from: "apps/worker/src/jobs/run_mlb_model.js"
      to: "evaluateMlbGameMarkets"
      via: "require('../models/mlb-model')"
      pattern: "evaluateMlbGameMarkets"
    - from: "run_mlb_model.js main loop"
      to: "assertNoSilentMarketDrop"
      via: "called after evaluateMlbGameMarkets, before runPerGameWriteTransaction"
      pattern: "assertNoSilentMarketDrop"
---

<objective>
Wire `evaluateMlbGameMarkets()` into `run_mlb_model.js`, replacing the old selectedGameDriver single-market flow.

Purpose: The old insertion loop uses `selectedGameDriver = gameSelection.selected_driver` (single market). This plan removes that path and replaces it with a loop over `gameEval.official_plays` + `gameEval.leans`. Rejected markets are logged. The assertNoSilentMarketDrop invariant is checked before any DB writes.

Output: Updated run_mlb_model.js with multi-market insertion. 2 tests verifying correct insertion and skip-game behavior.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@apps/worker/src/jobs/run_mlb_model.js
@apps/worker/src/models/mlb-model.js
@packages/models/src/market-eval.js
</context>

<interfaces>
<!-- From evaluateMlbGameMarkets (Plan 02) -->
```javascript
// Return shape used in this plan:
const gameEval = evaluateMlbGameMarkets(gameDriverCards, { game_id: gameId });
// gameEval.official_plays: MarketEvalResult[]  — FIRE tier
// gameEval.leans: MarketEvalResult[]           — LEAN tier
// gameEval.rejected: MarketEvalResult[]        — PASS / input failure
// gameEval.status: 'HAS_OFFICIAL_PLAYS' | 'LEANS_ONLY' | 'SKIP_MARKET_NO_EDGE' | 'SKIP_GAME_INPUT_FAILURE'

// Each MarketEvalResult has:
// .market_type    — 'F5_ML' | 'F5_TOTAL' | 'FULL_GAME_ML' | ...
// .candidate_id   — string
// .reason_codes   — string[]
// .model_edge     — number | null

// The original driver card lives at:
// result._sourceCard  (attach in evaluateSingleMarket if needed for card building)
// OR: keep parallel arrays: [driverCard, evalResult] from .map()
```

<!-- From market-eval.js (Plan 01) -->
```javascript
const { assertNoSilentMarketDrop, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');
```

<!-- NOTES on card type derivation (from existing run_mlb_model.js) -->
```javascript
// Keep existing cardType derivation per driver:
const isF5 = driver.market === 'f5_total';
const isF5ML = driver.market === 'f5_ml';
const isFullGameTotal = driver.market === 'full_game_total';
const isFullGameML = driver.market === 'full_game_ml';
const isPitcherK = driver.market?.startsWith('pitcher_k_');
const cardType = isF5 ? 'mlb-f5'
  : isF5ML ? 'mlb-f5-ml'
  : isFullGameTotal ? 'mlb-full-game'
  : isFullGameML ? 'mlb-full-game-ml'
  : isPitcherK ? 'mlb-pitcher-k'
  : 'mlb-strikeout';
```
</interfaces>

<tasks>

<task type="auto">
  <name>Task 1: Replace single-driver loop with multi-market evaluation in run_mlb_model.js</name>
  <files>apps/worker/src/jobs/run_mlb_model.js</files>
  <action>
    1. Add to imports at top of file:
       `const { evaluateMlbGameMarkets } = require('../models/mlb-model');`
       `const { assertNoSilentMarketDrop, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');`
       Remove the import of `selectMlbGameMarket` from `'../models/mlb-model'`.

    2. Find the call site: `const gameSelection = selectMlbGameMarket(gameId, gameOddsSnapshot, gameDriverCards);` (line ~2044)

       Replace the block from `const gameSelection = ...` through `const selectedGameDriver = gameSelection.selected_driver;` with:

       ```javascript
       const gameEval = evaluateMlbGameMarkets(gameDriverCards, { game_id: gameId });
       assertNoSilentMarketDrop(gameEval);
       logRejectedMarkets(gameEval.rejected);

       // Short-circuit: no qualified markets for this game
       if (
         gameEval.status === 'SKIP_MARKET_NO_EDGE' ||
         gameEval.status === 'SKIP_GAME_INPUT_FAILURE'
       ) {
         console.log(
           `  ⏭️  ${gameId}: ${gameEval.status} — ${gameEval.rejected
             .flatMap((r) => r.reason_codes)
             .filter((v, i, a) => a.indexOf(v) === i)
             .join(', ') || 'no reason codes'}`,
         );
         gamePipelineStates[gameId] = buildMlbPipelineState({
           oddsSnapshot: gameOddsSnapshot,
           marketAvailability,
           projectionReady: gameEval.status !== 'SKIP_GAME_INPUT_FAILURE',
           driversReady: false,
           pricingReady: false,
           cardReady: false,
           executionEnvelopes: [],
         });
         continue;
       }

       // Combine official plays and leans for insertion
       // Attach the source driver card via _sourceCard (set by evaluateSingleMarket)
       const qualifiedDrivers = [
         ...gameEval.official_plays,
         ...gameEval.leans,
       ].map((evalResult) => evalResult._sourceCard).filter(Boolean);
       ```

    3. Find where `qualified` is built (the `candidateDrivers` / `qualified` filter loop).
       Replace the usage of `selectedGameDriver` (from old gameSelection) with `qualifiedDrivers`.
       - `const selectedGameDriver = gameSelection.selected_driver;` is deleted (replaced in step 2)
       - Where `selectedGameDriver` was added to `candidateDrivers`: replace with spreading `qualifiedDrivers` into the candidate list

       Maintain all existing card building logic (pitcherK drivers, f5MlDriverCard, projectionFloorDriver) — only the game-level market driver injection changes.

    NOTE: For `evaluateSingleMarket` to return `_sourceCard`, the evaluateSingleMarket helper in market-eval.js must attach `_sourceCard: card` on the returned result. Update Plan 01 implementation as needed OR attach it here after calling evaluateMlbGameMarkets by correlating market_type back to the original card array.

    SAFEST APPROACH (no market-eval.js changes): After `evaluateMlbGameMarkets`:
    ```javascript
    const qualifiedDrivers = [
      ...gameEval.official_plays,
      ...gameEval.leans,
    ].map((evalResult) => {
      // Recover original driver card by matching candidate_id
      return gameDriverCards.find(
        (c) => `${gameId}::${c.market ?? 'unknown'}` === evalResult.candidate_id,
      );
    }).filter(Boolean);
    ```

    4. After building `qualifiedDrivers`, update the existing `qualified.length === 0` guard to use it:
       `if (qualifiedDrivers.length === 0) { ... continue; }`

    5. In `prepareModelAndCardWrite` calls (line ~2250), add:
       Do not introduce new MLB card-type strings. Keep the existing accepted validator/runtime types:
       `prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-full-game', { runId: jobRunId });`
       `prepareModelAndCardWrite(gameId, 'mlb-model-v1', 'mlb-full-game-ml', { runId: jobRunId });`

    6. In the card-type derivation block (line ~2280):
       Add the two new card type cases:
       `const isFullGameML = driver.market === 'full_game_ml';`
       `const isFullGameTotal = driver.market === 'full_game_total';`
       Update `cardType` ternary to include them using the existing names `mlb-full-game` and `mlb-full-game-ml` (before the final `'mlb-strikeout'` fallback).

    7. In the market_type assignment in payloadData (~line 2300):
       ```javascript
       market_type:
         (isF5 || isF5ML) ? 'FIRST_5_INNINGS'
         : isFullGameML ? 'FULL_GAME'
         : isFullGameTotal ? 'FULL_GAME'
         : 'PROP',
       ```

    8. In the odds_context block for full_game_ml cards, add a similar branch to the existing isF5 / isF5ML branches with:
       `recommended_bet_type: 'moneyline',`
       `odds_context: { h2h_home: gameOddsSnapshot?.h2h_home, h2h_away: gameOddsSnapshot?.h2h_away, captured_at: gameOddsSnapshot?.captured_at }`
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node -e "require('./apps/worker/src/jobs/run_mlb_model')" 2>&1 | head -5</automated>
  </verify>
  <done>Module loads with no syntax errors; selectMlbGameMarket is no longer referenced; evaluateMlbGameMarkets call present</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: 2 integration tests for multi-market insertion and skip-game path</name>
  <files>apps/worker/src/jobs/__tests__/run_mlb_model.test.js</files>
  <behavior>
    - Test 1: game snapshot with h2h odds present + two qualifying driver cards → 2 card_payloads inserted (not 1)
    - Test 2: game snapshot with no qualifying drive cards → cardsGenerated remains 0, SKIP_MARKET_NO_EDGE logged
  </behavior>
  <action>
    Append a new describe block `describe('multi-market insertion (IME-01-03)', () => { ... })` to the existing test file.

    Test 1: Use existing test harness patterns (mock insertCardPayload or spy). Build a mock gameDriverCards array with both a qualifying f5_total and a qualifying full_game_ml. Assert insertCardPayload is called twice for the game.

    Test 2: Build a gameDriverCards array where both cards have ev_threshold_passed=false. Assert insertCardPayload is NOT called and a console.log call includes 'SKIP_MARKET_NO_EDGE'.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/jobs/__tests__/run_mlb_model.test.js --no-coverage -t "multi-market insertion" 2>&1 | tail -5</automated>
  </verify>
  <done>2 new tests pass; existing run_mlb_model tests not broken</done>
</task>

</tasks>

<verification>
1. `grep -n "selectMlbGameMarket" apps/worker/src/jobs/run_mlb_model.js` returns 0
2. `grep -n "evaluateMlbGameMarkets\|assertNoSilentMarketDrop" apps/worker/src/jobs/run_mlb_model.js` returns ≥2 hits
3. `npx jest apps/worker/src/jobs/__tests__/run_mlb_model.test.js --no-coverage` — all pass
</verification>

<success_criteria>
run_mlb_model.js inserts all qualifying markets per game, not just F5. Rejected markets are logged. The SKIP path exits cleanly with explicit reason codes. All existing and new tests pass.
</success_criteria>

<output>
After completion, create `.planning/phases/ime-01-independent-market-eval/ime-01-03-SUMMARY.md`
</output>
