---
phase: ime-01-independent-market-eval
plan: "04"
type: execute
wave: 2
depends_on: ["ime-01-01"]
files_modified:
  - apps/worker/src/models/cross-market.js
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/models/__tests__/cross-market.test.js
  - apps/worker/src/jobs/__tests__/run_nhl_model.test.js
autonomous: true
requirements: [IME-NHL-01, IME-NHL-02, IME-NHL-03]

must_haves:
  truths:
    - "cross-market.js exports evaluateNHLGameMarkets() in addition to existing computeNHLMarketDecisions()"
    - "evaluateNHLGameMarkets() evaluates TOTAL, SPREAD, and ML as independent markets — none suppressed by rank"
    - "run_nhl_model.js still emits nhl-moneyline-call cards when ML qualifies regardless of TOTAL/SPREAD status"
    - "choosePrimaryDisplayMarket() is a pure ranking function — it does NOT delete non-primary plays"
    - "rejected NHL markets are logged via logRejectedMarkets"
    - "selectExpressionChoice() is preserved AS-IS for backward compatibility (display ranking only)"
  artifacts:
    - path: "apps/worker/src/models/cross-market.js"
      provides: "evaluateNHLGameMarkets() using evaluateSingleMarket for each of TOTAL/SPREAD/ML independently; choosePrimaryDisplayMarket() for UI ranking"
      exports: ["evaluateNHLGameMarkets", "choosePrimaryDisplayMarket", "computeNHLMarketDecisions", "selectExpressionChoice"]
      contains: "evaluateNHLGameMarkets"
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "Card generation driven by gameEval.official_plays + gameEval.leans; choosePrimaryDisplayMarket for single display field"
      contains: "evaluateNHLGameMarkets"
    - path: "apps/worker/src/models/__tests__/cross-market.test.js"
      provides: "2 tests: ML emitted independently when qualified; cross-market ranks but doesn't delete"
      min_lines: 2
    - path: "apps/worker/src/jobs/__tests__/run_nhl_model.test.js"
      provides: "2 tests: ML emitted when qualified even if TOTAL ranks higher; leans-only output preserves leans"
      min_lines: 2
  key_links:
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "evaluateNHLGameMarkets"
      via: "require('../models/cross-market')"
      pattern: "evaluateNHLGameMarkets"
    - from: "evaluateNHLGameMarkets"
      to: "evaluateSingleMarket"
      via: "each of TOTAL/SPREAD/ML decisions mapped through evaluateSingleMarket"
      pattern: "evaluateSingleMarket"
    - from: "cross-market.js: choosePrimaryDisplayMarket"
      to: "gameEval.official_plays + gameEval.leans"
      via: "sort by tier then edge then confidence; return [0] or null"
      pattern: "choosePrimaryDisplayMarket"
---

<objective>
Add `evaluateNHLGameMarkets()` and `choosePrimaryDisplayMarket()` to cross-market.js, then wire them into run_nhl_model.js.

Purpose: Currently NHL ML is only generated when selectExpressionChoice() picks it over TOTAL/SPREAD (audit DEFECT #3). This plan adds independent evaluation: TOTAL, SPREAD, and ML are each evaluated by evaluateSingleMarket(). All qualified markets surface. selectExpressionChoice() is preserved but renamed to a display-only ranking role.

Output: evaluateNHLGameMarkets() in cross-market.js. run_nhl_model.js emitting all qualified NHL markets (not just the chosen one). choosePrimaryDisplayMarket() for downstream UI to pick a single tile.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@apps/worker/src/models/cross-market.js
@apps/worker/src/jobs/run_nhl_model.js
@packages/models/src/market-eval.js
</context>

<interfaces>
<!-- From computeNHLMarketDecisions() — existing function unchanged -->
```javascript
// Returns marketDecisions object:
// marketDecisions.TOTAL → { status, score, edge, p_fair, p_implied, best_candidate, ... }
// marketDecisions.SPREAD → { same shape }
// marketDecisions.ML → { same shape }
// Each decision already has status: 'FIRE' | 'WATCH' | 'PASS'; ev_threshold_passed not present — infer from status
```

<!-- From evaluateSingleMarket (Plan 01) -->
```javascript
const { evaluateSingleMarket, finalizeGameMarketEvaluation, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');

// evaluateSingleMarket expects a card with shape:
// { market, status, classification, ev_threshold_passed, missing_inputs, reason_codes }
// For NHL decisions, we must adapter-map the decision object:
// decision.status === 'FIRE' || decision.status === 'WATCH' → ev_threshold_passed = true for lean/play check
// decision.status === 'PASS' → ev_threshold_passed = false
```

<!-- Market name mapping for NHL -->
```javascript
// Market.TOTAL  → card.market = 'total'
// Market.SPREAD → card.market = 'spread'  (maps to 'SPREAD' or 'PUCKLINE')
// Market.ML     → card.market = 'h2h' or 'moneyline'
```
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add evaluateNHLGameMarkets() and choosePrimaryDisplayMarket() to cross-market.js</name>
  <files>apps/worker/src/models/cross-market.js</files>
  <behavior>
    - evaluateNHLGameMarkets({marketDecisions, game_id, oddsSnapshot}) calls evaluateSingleMarket on each active market decision
    - When ML has status=FIRE and TOTAL has status=WATCH → both appear in evaluation; ML in official_plays, TOTAL in leans
    - choosePrimaryDisplayMarket(gameEval) returns the single best result by tier→edge→confidence — does NOT remove the others from gameEval
    - When no markets qualify → status='SKIP_MARKET_NO_EDGE'; choosePrimaryDisplayMarket returns null
  </behavior>
  <action>
    1. Add require at top of cross-market.js:
       `const { evaluateSingleMarket, finalizeGameMarketEvaluation, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');`

    2. Add after selectExpressionChoice():

    ```javascript
    /**
     * Adapter: convert a market decision object (from computeNHLMarketDecisions) to
     * the driver card shape expected by evaluateSingleMarket.
     */
    function adaptDecisionToCard(decision, marketToken) {
      if (!decision) return null;
      const status = String(decision.status || 'PASS').toUpperCase();
      const evThresholdPassed = status === 'FIRE' || status === 'WATCH';
      return {
        market: marketToken.toLowerCase(),
        status,
        classification: status === 'FIRE' ? 'BASE' : status === 'WATCH' ? 'LEAN' : 'PASS',
        ev_threshold_passed: evThresholdPassed,
        missing_inputs: [],
        reason_codes: Array.isArray(decision.reason_codes) ? decision.reason_codes : [],
        confidence: typeof decision.score === 'number' ? decision.score : null,
        edge: decision.edge ?? null,
        p_fair: decision.p_fair ?? null,
        p_implied: decision.p_implied ?? null,
        _decision: decision,  // preserve original for card building
      };
    }

    /**
     * Evaluate all NHL game markets independently.
     * Returns a GameMarketEvaluation — every market in official_plays, leans, or rejected.
     *
     * @param {{ marketDecisions: object, game_id: string }} params
     * @returns {GameMarketEvaluation}
     */
    function evaluateNHLGameMarkets({ marketDecisions, game_id }) {
      const markets = [
        { token: 'TOTAL', key: Market.TOTAL },
        { token: 'SPREAD', key: Market.SPREAD },
        { token: 'ML',     key: Market.ML },
      ];

      const cards = markets
        .map(({ token, key }) => adaptDecisionToCard(marketDecisions?.[key], token))
        .filter(Boolean);

      const evalCtx = { game_id, sport: 'NHL' };
      const market_results = cards.map((card) => {
        const result = evaluateSingleMarket(card, evalCtx);
        result._sourceDecision = card._decision;
        return result;
      });

      const gameEval = finalizeGameMarketEvaluation({
        game_id,
        sport: 'NHL',
        market_results,
      });
      logRejectedMarkets(gameEval.rejected);
      return gameEval;
    }

    /**
     * Choose a primary display market from a GameMarketEvaluation for single-tile UIs.
     * Pure ranking — does NOT remove other qualified markets.
     *
     * @param {GameMarketEvaluation} gameEval
     * @returns {MarketEvalResult | null}
     */
    function choosePrimaryDisplayMarket(gameEval) {
      const candidates = [...gameEval.official_plays, ...gameEval.leans];
      if (candidates.length === 0) return null;

      return candidates.sort((a, b) => {
        // Primary: official > lean
        const tierA = a.status === 'QUALIFIED_OFFICIAL' ? 2 : 1;
        const tierB = b.status === 'QUALIFIED_OFFICIAL' ? 2 : 1;
        if (tierB !== tierA) return tierB - tierA;
        // Secondary: edge
        const edgeA = a.model_edge ?? -Infinity;
        const edgeB = b.model_edge ?? -Infinity;
        if (edgeB !== edgeA) return edgeB - edgeA;
        return 0;
      })[0];
    }
    ```

    3. Add to module.exports:
       `evaluateNHLGameMarkets,`
       `choosePrimaryDisplayMarket,`
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node -e "const m = require('./apps/worker/src/models/cross-market'); console.log(typeof m.evaluateNHLGameMarkets, typeof m.choosePrimaryDisplayMarket)"</automated>
  </verify>
  <done>Both functions exported as 'function'; module loads cleanly</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire evaluateNHLGameMarkets into run_nhl_model.js</name>
  <files>apps/worker/src/jobs/run_nhl_model.js</files>
  <behavior>
    - evaluateNHLGameMarkets call replaces the selectExpressionChoice-driven card-type gating
    - All official_plays generate cards (nhl-moneyline-call, nhl-totals-call, nhl-spread-call — one per qualified market)
    - All leans generate cards marked as LEAN
    - chosenCardType = null when orchestration is off — this existing branch is preserved (no regression)
    - choosePrimaryDisplayMarket result is stored as primary_display_market on each card's payloadData
    - assertNoSilentMarketDrop is called after gameEval before any card writes
  </behavior>
  <action>
    1. Add imports:
       `const { evaluateNHLGameMarkets, choosePrimaryDisplayMarket } = require('../models/cross-market');`
       `const { assertNoSilentMarketDrop, logRejectedMarkets } = require('@cheddar-logic/models/src/market-eval');`

    2. Locate the per-game card generation block (around line 2280-2460 where expressionChoice is computed).

       After `const expressionChoice = selectExpressionChoice(marketDecisions);` add:

    ```javascript
    // Independent market evaluation (IME-01-04)
    const gameEval = evaluateNHLGameMarkets({ marketDecisions, game_id: gameId });
    assertNoSilentMarketDrop(gameEval);
    const primaryDisplayMarket = choosePrimaryDisplayMarket(gameEval);
    ```

    3. In the existing card-generation triple (totals / spread / moneyline), change the gate from:
       ```
       if (totalDecision && (!chosenCardType || chosenCardType === 'nhl-totals-call') && ...)
       ```
       to:
       ```
       // IME: use independent evaluation result for this market
       const totalQualified = gameEval.official_plays.concat(gameEval.leans)
         .find(r => r.market_type === 'TOTAL');
       if (totalDecision && totalQualified && ...)
       ```
       Same pattern for spread (market_type === 'SPREAD' || market_type === 'PUCKLINE') and ML (market_type === 'TOTAL' won't match — use 'MONEYLINE').

    IMPORTANT: Do not remove the existing shape of the generated payloadData objects. Only change the CONDITION that gates generation — the card contents (payload fields) stay the same.

    BACKWARD COMPATIBILITY: The existing `withoutOddsMode` branches already generate cards — do not touch those. They are a separate code path and are unaffected by this change.

    4. On each generated payloadData, add:
       `primary_display_market: primaryDisplayMarket?.market_type ?? null,`
       `is_primary_display: primaryDisplayMarket?.candidate_id === \`\${gameId}::\${payloadData.market_type?.toLowerCase()}\`,`
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node -e "require('./apps/worker/src/jobs/run_nhl_model')" 2>&1 | head -3</automated>
  </verify>
  <done>Module loads cleanly; grep shows evaluateNHLGameMarkets call; no syntax errors</done>
</task>

<task type="auto" tdd="true">
  <name>Task 3: cross-market + NHL runner tests for independent evaluation</name>
  <files>apps/worker/src/models/__tests__/cross-market.test.js, apps/worker/src/jobs/__tests__/run_nhl_model.test.js</files>
  <behavior>
    - cross-market Test 1: evaluateNHLGameMarkets with ML=FIRE + TOTAL=WATCH → both in gameEval; ML in official_plays, TOTAL in leans
    - cross-market Test 2: choosePrimaryDisplayMarket returns ML (higher tier) without removing TOTAL from gameEval
    - nhl_model Test 1: NHL ML card emitted when moneyline qualifies even if total ranks higher as primary
    - nhl_model Test 2: leans-only scenario → no official plays, leans preserved with SKIP_MARKET_NO_EDGE... wait, LEANS_ONLY status, not SKIP — fix: leans exist → status=LEANS_ONLY; cards are still generated for leans
  </behavior>
  <action>
    For cross-market.test.js (create if missing, append if exists):
    Add `describe('evaluateNHLGameMarkets independent evaluation (IME-01-04)', () => { ... })`

    Build marketDecisions fixture with TOTAL={status:'WATCH'}, SPREAD={status:'PASS'}, ML={status:'FIRE'}.

    Test 1: gameEval.official_plays has 1 result where market_type includes 'ML'; gameEval.leans has 1 result where market_type includes 'TOTAL'
    Test 2: choosePrimaryDisplayMarket(gameEval).market_type includes 'ML'; gameEval.official_plays.length is still 1; gameEval.leans.length is still 1

    For run_nhl_model.test.js, append describe block:
    Test 3: When marketDecisions.ML.status = 'FIRE' and marketDecisions.TOTAL.status = 'WATCH', both nhl-moneyline-call and nhl-totals-call cards are generated
    Test 4: When all markets are PASS, log shows SKIP_MARKET_NO_EDGE or LEANS_ONLY, 0 cards inserted
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest --no-coverage -t "independent evaluation" 2>&1 | tail -8</automated>
  </verify>
  <done>4 new tests pass; existing cross-market and nhl_model tests not broken</done>
</task>

</tasks>

<verification>
1. `grep -n "evaluateNHLGameMarkets\|choosePrimaryDisplayMarket" apps/worker/src/models/cross-market.js` — ≥2 hits
2. `grep -n "evaluateNHLGameMarkets" apps/worker/src/jobs/run_nhl_model.js` — ≥1 hit
3. `grep -n "selectExpressionChoice" apps/worker/src/jobs/run_nhl_model.js` — still present (backward compat)
4. `npx jest apps/worker/src/models/__tests__/cross-market.test.js apps/worker/src/jobs/__tests__/run_nhl_model.test.js --no-coverage` — all pass
</verification>

<success_criteria>
NHL moneyline is now independently evaluated and emits regardless of TOTAL/SPREAD rank. choosePrimaryDisplayMarket() ranks for UI without suppressing other plays. All new and existing tests pass. Audit DEFECT #3 is closed.
</success_criteria>

<output>
After completion, create `.planning/phases/ime-01-independent-market-eval/ime-01-04-SUMMARY.md`
</output>
