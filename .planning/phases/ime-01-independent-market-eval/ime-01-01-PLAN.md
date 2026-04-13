---
phase: ime-01-independent-market-eval
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/models/src/market-eval.js
  - packages/models/src/market-eval.test.js
  - packages/models/package.json
autonomous: true
requirements: [IME-CONTRACT-01]

must_haves:
  truths:
    - "evaluateSingleMarket(card, ctx) returns a MarketEvalResult with exactly one terminal status per call"
    - "finalizeGameMarketEvaluation() returns a GameMarketEvaluation with official_plays + leans + rejected + status"
    - "assertNoSilentMarketDrop() throws UNACCOUNTED_MARKET_RESULTS when market_results.length !== qualified+rejected"
    - "REASON_CODES object is the only source of rejection reason strings — no ad-hoc strings in logic"
    - "All four terminal status branches return objects matching MarketEvalResult shape"
  artifacts:
    - path: "packages/models/src/market-eval.js"
      provides: "evaluateSingleMarket, finalizeGameMarketEvaluation, assertNoSilentMarketDrop, REASON_CODES, logRejectedMarkets"
      exports: ["evaluateSingleMarket", "finalizeGameMarketEvaluation", "assertNoSilentMarketDrop", "REASON_CODES", "logRejectedMarkets"]
    - path: "packages/models/src/market-eval.test.js"
      provides: "7 unit tests covering all terminal states and invariant enforcement"
      min_lines: 80
  key_links:
    - from: "packages/models/src/market-eval.js"
      to: "packages/models/src/decision-pipeline-v2.js"
      via: "import WATCHDOG_REASONS, buildDecisionV2"
      pattern: "require.*decision-pipeline-v2"
---

<objective>
Create `packages/models/src/market-eval.js` — the shared independent market evaluation contract.

Purpose: The current pipeline uses winner-take-all selection. This module introduces the invariant: every generated market candidate must end in exactly one terminal status with explicit reasons. No market may disappear without accounting.

Output: New `market-eval.js` module exporting `evaluateSingleMarket`, `finalizeGameMarketEvaluation`, `assertNoSilentMarketDrop`, `REASON_CODES`, and `logRejectedMarkets`. New unit test file with ≥7 tests covering all terminal states and the drop invariant.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/ROADMAP.md
@packages/models/src/decision-pipeline-v2.js
</context>

<interfaces>
<!-- Key types and exports this module must honour -->
<!-- From packages/models/src/decision-pipeline-v2.js -->
```javascript
// WATCHDOG_REASONS constants used for rejection coding
const WATCHDOG_REASONS = {
  CONSISTENCY_MISSING: 'WATCHDOG_CONSISTENCY_MISSING',
  PARSE_FAILURE: 'WATCHDOG_PARSE_FAILURE',
  STALE_SNAPSHOT: 'WATCHDOG_STALE_SNAPSHOT',
  MARKET_UNAVAILABLE: 'WATCHDOG_MARKET_UNAVAILABLE',
  GOALIE_UNCONFIRMED: 'GOALIE_UNCONFIRMED',
  GOALIE_CONFLICTING: 'GOALIE_CONFLICTING',
};

// buildDecisionV2 export
module.exports = {
  WATCHDOG_REASONS,
  PRICE_REASONS,
  buildDecisionV2,
  buildPipelineState,
  collectDecisionReasonCodes,
  // ...
};
```

<!-- MarketEvalResult shape (canonical) -->
```typescript
type MarketEvalResult = {
  game_id: string;
  sport: 'MLB' | 'NHL';
  market_type: 'F5_ML' | 'F5_TOTAL' | 'FULL_GAME_ML' | 'FULL_GAME_TOTAL' | 'PUCKLINE' | 'SPREAD' | 'TOTAL';
  candidate_id: string;
  inputs_ok: boolean;
  consistency_ok: boolean;
  watchdog_ok: boolean;
  model_edge: number | null;
  fair_price: number | null;
  win_probability: number | null;
  official_tier: 'PLAY' | 'LEAN' | 'PASS';
  status:
    | 'QUALIFIED_OFFICIAL'
    | 'QUALIFIED_LEAN'
    | 'REJECTED_INPUTS'
    | 'REJECTED_CONSISTENCY'
    | 'REJECTED_WATCHDOG'
    | 'REJECTED_THRESHOLD'
    | 'REJECTED_SELECTOR'
    | 'REJECTED_DUPLICATE'
    | 'REJECTED_MARKET_POLICY';
  reason_codes: string[];
  notes: string[];
};

type GameMarketEvaluation = {
  game_id: string;
  sport: 'MLB' | 'NHL';
  market_results: MarketEvalResult[];
  official_plays: MarketEvalResult[];
  leans: MarketEvalResult[];
  rejected: MarketEvalResult[];
  status: 'HAS_OFFICIAL_PLAYS' | 'LEANS_ONLY' | 'SKIP_MARKET_NO_EDGE' | 'SKIP_GAME_INPUT_FAILURE';
};
```
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Create market-eval.js — core evaluation contract</name>
  <files>packages/models/src/market-eval.js</files>
  <behavior>
    - REASON_CODES exports: MISSING_MARKET_ODDS, MISSING_STARTING_PITCHER, MISSING_GOALIE_CONFIRMATION, MISSING_CONSISTENCY_FIELDS, WATCHDOG_UNSAFE_FOR_BASE, EDGE_BELOW_THRESHOLD, EV_BELOW_THRESHOLD, DUPLICATE_MARKET_SUPPRESSED, DISPLAY_RANKED_BELOW_PRIMARY
    - evaluateSingleMarket(card, ctx): returns MarketEvalResult; REJECTED_INPUTS when card.ev_threshold_passed == null and card.status === undefined; REJECTED_THRESHOLD when ev_threshold_passed === false; QUALIFIED_LEAN when ev_threshold_passed && classification === 'LEAN'; QUALIFIED_OFFICIAL when ev_threshold_passed && status === 'FIRE'
    - finalizeGameMarketEvaluation({game_id, sport, market_results}): partitions results into official_plays/leans/rejected; sets status to HAS_OFFICIAL_PLAYS / LEANS_ONLY / SKIP_MARKET_NO_EDGE based on counts; calls assertNoSilentMarketDrop
    - assertNoSilentMarketDrop(gameEval): throws Error('UNACCOUNTED_MARKET_RESULTS for {game_id}') if sums don't balance
    - logRejectedMarkets(rejected, logger): console.info('[MARKET_REJECTED] game={} market={} status={} reasons={}') for each rejected item
    - Each result must always have: candidate_id (non-empty string), status (one of the enum), reason_codes (Array)
  </behavior>
  <action>
    Create `packages/models/src/market-eval.js` with:

    1. REASON_CODES frozen object with 9 named codes listed above
    2. Helper buildResult(card, ctx, status, reasonCodes, extra) — builds MarketEvalResult from a driver card; candidate_id = `{ctx.game_id}::{card.market ?? 'unknown'}`
    3. evaluateSingleMarket(card, ctx): checks inputs → checks consistency → runs threshold; returns typed result
    4. finalizeGameMarketEvaluation({game_id, sport, market_results}): partition + assertNoSilentMarketDrop + compute status; SKIP_GAME_INPUT_FAILURE when ALL results are REJECTED_INPUTS (implies no usable market lines at all)
    5. assertNoSilentMarketDrop(gameEval): sum check; throw on mismatch
    6. logRejectedMarkets(rejected, logger = console): loop over rejected array

    evaluateSingleMarket logic:
    - If card is null/undefined → REJECTED_INPUTS + [REASON_CODES.MISSING_MARKET_ODDS]
    - If card.missing_inputs?.length > 0 → REJECTED_INPUTS + codes derived from missing_inputs names
    - If card.ev_threshold_passed === false → REJECTED_THRESHOLD + [REASON_CODES.EDGE_BELOW_THRESHOLD] + any card.reason_codes
    - If card.status === 'PASS' → REJECTED_THRESHOLD + [REASON_CODES.EV_BELOW_THRESHOLD] + card.pass_reason_code
    - If card.classification === 'LEAN' || card.status === 'WATCH' → QUALIFIED_LEAN
    - If card.ev_threshold_passed === true && (card.status === 'FIRE' || card.classification === 'BASE') → QUALIFIED_OFFICIAL
    - Default fallback: REJECTED_THRESHOLD + ['UNCLASSIFIED_MARKET_STATE']

    Market type mapping from card.market:
    - 'f5_ml' → 'F5_ML'
    - 'f5_total' → 'F5_TOTAL'
    - 'full_game_ml' → 'FULL_GAME_ML'
    - 'full_game_total' → 'FULL_GAME_TOTAL'
    - 'spread' → 'SPREAD'
    - 'puckline' → 'PUCKLINE'
    - 'total' → 'TOTAL'
    - fallback → String(card.market ?? 'UNKNOWN').toUpperCase()
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node -e "const m = require('./packages/models/src/market-eval'); console.log(Object.keys(m).join(','))"</automated>
  </verify>
  <done>Module exports evaluateSingleMarket, finalizeGameMarketEvaluation, assertNoSilentMarketDrop, REASON_CODES, logRejectedMarkets; node require succeeds with no errors</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Unit tests for market-eval.js — all terminal states and invariant</name>
  <files>packages/models/src/market-eval.test.js</files>
  <behavior>
    - Test 1: null card → REJECTED_INPUTS
    - Test 2: card with ev_threshold_passed=false → REJECTED_THRESHOLD + EDGE_BELOW_THRESHOLD
    - Test 3: card with status='WATCH', ev_threshold_passed=true → QUALIFIED_LEAN
    - Test 4: card with status='FIRE', ev_threshold_passed=true → QUALIFIED_OFFICIAL
    - Test 5: finalizeGameMarketEvaluation splits correctly into official/leans/rejected
    - Test 6: assertNoSilentMarketDrop throws when sums don't match (inject invalid state)
    - Test 7: game with all REJECTED_INPUTS cards → status='SKIP_GAME_INPUT_FAILURE'
  </behavior>
  <action>
    Write `packages/models/src/market-eval.test.js` using Jest (require, not import).
    Import { evaluateSingleMarket, finalizeGameMarketEvaluation, assertNoSilentMarketDrop, REASON_CODES } from './market-eval'.

    Create a minimal card fixture factory: buildCard({ market, status, classification, ev_threshold_passed, missing_inputs }) → driver card object matching the shape returned by computeMLBDriverCards / computeNHLDriverCards.

    Write 7 describe/test blocks as listed in behavior. Each test is independent (no shared mutable state).
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest packages/models/src/market-eval.test.js --no-coverage 2>&1 | tail -5</automated>
  </verify>
  <done>7 tests pass, 0 failures; jest output shows "Tests: 7 passed"</done>
</task>

</tasks>

<verification>
1. `node -e "require('./packages/models/src/market-eval')"` produces no error
2. All 7 unit tests pass
3. No existing tests broken: `npx jest packages/models/ --no-coverage 2>&1 | grep -E "failed|passed"`
</verification>

<success_criteria>
`packages/models/src/market-eval.js` exports the full evaluation contract. All 7 unit tests pass. The assertNoSilentMarketDrop invariant throws on unbalanced results.
</success_criteria>

<output>
After completion, create `.planning/phases/ime-01-independent-market-eval/ime-01-01-SUMMARY.md`
</output>
