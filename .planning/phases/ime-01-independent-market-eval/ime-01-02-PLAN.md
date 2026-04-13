---
phase: ime-01-independent-market-eval
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/models/__tests__/mlb-model.test.js
autonomous: true
requirements: [IME-MLB-01, IME-MLB-02]

must_haves:
  truths:
    - "selectMlbGameMarket() is deleted from mlb-model.js"
    - "evaluateMlbGameMarkets(driverCards, ctx) returns a GameMarketEvaluation with official_plays + leans + rejected"
    - "A full_game_ml card with ev_threshold_passed=true appears in official_plays when F5 has no edge"
    - "A full_game_ml card with ev_threshold_passed=true appears in official_plays ALONGSIDE an F5 card when both qualify"
    - "No MLB market card is ever silently dropped — all appear in official_plays, leans, or rejected"
    - "computeMLBDriverCards() return shape is unchanged (still returns array of driver cards)"
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "evaluateMlbGameMarkets() replaces selectMlbGameMarket(); updated exports list"
      exports: ["evaluateMlbGameMarkets", "computeMLBDriverCards", "projectFullGameML", "projectF5ML"]
      contains: "evaluateMlbGameMarkets"
    - path: "apps/worker/src/models/__tests__/mlb-model.test.js"
      provides: "3 new tests for multi-market evaluation"
      min_lines: 3
  key_links:
    - from: "apps/worker/src/models/mlb-model.js"
      to: "packages/models/src/market-eval.js"
      via: "require('@cheddar-logic/models/src/market-eval')"
      pattern: "market-eval"
    - from: "evaluateMlbGameMarkets"
      to: "evaluateSingleMarket"
      via: "driverCards.map(card => evaluateSingleMarket(card, ctx))"
      pattern: "evaluateSingleMarket"
---

<objective>
Replace `selectMlbGameMarket()` with `evaluateMlbGameMarkets()` in `mlb-model.js`.

Purpose: The hardcoded F5-only selector silently drops full_game_ml and full_game_total cards even when they have qualifying edges (audit DEFECT #1). This plan deletes the selector and replaces it with independent evaluation — every generated market goes through evaluateSingleMarket; all results land in official_plays, leans, or rejected with explicit reason codes.

Output: `evaluateMlbGameMarkets(driverCards, ctx)` returning a GameMarketEvaluation. Old `selectMlbGameMarket` deleted from both implementation and exports. 3 new unit tests.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@apps/worker/src/models/mlb-model.js
@apps/worker/src/models/__tests__/mlb-model.test.js
@packages/models/src/market-eval.js
</context>

<interfaces>
<!-- From packages/models/src/market-eval.js (created in Plan 01) -->
```javascript
const {
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
  assertNoSilentMarketDrop,
  REASON_CODES,
  logRejectedMarkets,
} = require('@cheddar-logic/models/src/market-eval');

// ctx shape expected by evaluateSingleMarket:
// { game_id: string, sport: 'MLB' }

// GameMarketEvaluation shape:
// { game_id, sport, market_results[], official_plays[], leans[], rejected[], status }
```

<!-- Current mlb-model.js exports (line ~3050) -->
```javascript
// CURRENTLY EXPORTED — selectMlbGameMarket will be removed:
module.exports = {
  computeMLBDriverCards,
  selectMlbGameMarket,    // ← DELETE THIS
  projectFullGameML,
  projectF5ML,
  projectF5TotalCard,
  projectFullGameTotal,
  setLeagueConstants,
  // ...
};
```
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Replace selectMlbGameMarket with evaluateMlbGameMarkets in mlb-model.js</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <behavior>
    - evaluateMlbGameMarkets(driverCards, ctx) calls evaluateSingleMarket on every card, returns GameMarketEvaluation
    - When driverCards = [{market:'f5_total', ev_threshold_passed:false}, {market:'full_game_ml', ev_threshold_passed:true, status:'FIRE'}] → official_plays has full_game_ml, rejected has f5_total
    - When both f5_total and full_game_ml qualify → official_plays has both
    - When driverCards = [] → status = 'SKIP_MARKET_NO_EDGE', official_plays = [], rejected = []
    - selectMlbGameMarket is completely removed (no dead code)
  </behavior>
  <action>
    1. At the top of mlb-model.js, add require for market-eval:
       `const { evaluateSingleMarket, finalizeGameMarketEvaluation, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');`

    2. Find `function selectMlbGameMarket(...)` (line ~1343) and REPLACE the entire function with:

    ```javascript
    /**
     * Evaluate all MLB game market driver cards independently.
     * Replaces the old winner-take-all selectMlbGameMarket().
     *
     * @param {Array} driverCards - cards from computeMLBDriverCards()
     * @param {{ game_id: string }} ctx
     * @returns {GameMarketEvaluation}
     */
    function evaluateMlbGameMarkets(driverCards, ctx) {
      const evalCtx = { game_id: ctx.game_id, sport: 'MLB' };
      const market_results = (Array.isArray(driverCards) ? driverCards : []).map(
        (card) => evaluateSingleMarket(card, evalCtx),
      );
      const gameEval = finalizeGameMarketEvaluation({
        game_id: ctx.game_id,
        sport: 'MLB',
        market_results,
      });
      logRejectedMarkets(gameEval.rejected);
      return gameEval;
    }
    ```

    3. In module.exports at the bottom of mlb-model.js:
       - Remove `selectMlbGameMarket,`
       - Add `evaluateMlbGameMarkets,`
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node -e "const m = require('./apps/worker/src/models/mlb-model'); console.log(typeof m.evaluateMlbGameMarkets, typeof m.selectMlbGameMarket)"</automated>
  </verify>
  <done>evaluateMlbGameMarkets is 'function'; selectMlbGameMarket is 'undefined'; no require error</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: 3 new unit tests for evaluateMlbGameMarkets</name>
  <files>apps/worker/src/models/__tests__/mlb-model.test.js</files>
  <behavior>
    - Test A: 'evaluates all generated MLB game markets and returns multiple qualified results' — F5 passes, ML passes → 2 official_plays
    - Test B: 'returns FULL_GAME_ML as official when F5_TOTAL exists but only ML qualifies' — F5 fails, ML passes → ML in official_plays, F5 in rejected
    - Test C: 'marks non-qualified MLB markets as REJECTED_THRESHOLD with reason codes' — ev_threshold_passed=false card → REJECTED_THRESHOLD + EDGE_BELOW_THRESHOLD reason
  </behavior>
  <action>
    Append to the existing mlb-model.test.js file a new describe block:
    `describe('evaluateMlbGameMarkets (IME-01)', () => { ... })`

    Import evaluateMlbGameMarkets from '../mlb-model' alongside existing imports.

    Build minimal driver card fixtures using the shape returned by computeMLBDriverCards:
    ```javascript
    const passCard = { market: 'f5_total', ev_threshold_passed: false, status: 'PASS', classification: 'PASS', reason_codes: [], missing_inputs: [] };
    const fireCard = { market: 'full_game_ml', ev_threshold_passed: true, status: 'FIRE', classification: 'BASE', reason_codes: [], missing_inputs: [], confidence: 0.7 };
    ```

    Test A: evaluateMlbGameMarkets([fireCard, {...fireCard, market:'f5_total'}], {game_id:'g1'}).official_plays.length === 2
    Test B: evaluateMlbGameMarkets([passCard, fireCard], {game_id:'g1'}).official_plays[0].market_type === 'FULL_GAME_ML'
    Test C: result.rejected[0].status === 'REJECTED_THRESHOLD' && result.rejected[0].reason_codes.includes('EDGE_BELOW_THRESHOLD')
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/models/__tests__/mlb-model.test.js --no-coverage -t "evaluateMlbGameMarkets" 2>&1 | tail -5</automated>
  </verify>
  <done>3 new tests pass; existing MLB model test suite still green (no regressions)</done>
</task>

</tasks>

<verification>
1. `node -e "require('./apps/worker/src/models/mlb-model').evaluateMlbGameMarkets"` prints `[Function: evaluateMlbGameMarkets]`
2. `require('./apps/worker/src/models/mlb-model').selectMlbGameMarket === undefined` is true
3. `npx jest apps/worker/src/models/__tests__/mlb-model.test.js --no-coverage` — all tests pass
</verification>

<success_criteria>
selectMlbGameMarket is deleted. evaluateMlbGameMarkets is wired and exported. All MLB model tests pass. The audit DEFECT #1 (MLB ML silent drop) is structurally eliminated.
</success_criteria>

<output>
After completion, create `.planning/phases/ime-01-independent-market-eval/ime-01-02-SUMMARY.md`
</output>
