---
phase: ime-01-independent-market-eval
plan: "05"
type: execute
wave: 3
depends_on: ["ime-01-01", "ime-01-02", "ime-01-03", "ime-01-04"]
files_modified:
  - docs/market_evaluation_contract.md
  - packages/models/src/market-eval.js
autonomous: true
requirements: [IME-CONTRACT-02]

must_haves:
  truths:
    - "docs/market_evaluation_contract.md exists and documents: MarketEvalResult shape, GameMarketEvaluation shape, all REASON_CODES, assertNoSilentMarketDrop contract, forbidden cross-market behaviors"
    - "The doc includes smoke test scenarios from the spec: MLB multi-qualify, NHL TOTAL+ML, empty-edge game"
    - "packages/models/src/market-eval.js is updated to export VALID_STATUSES and VALID_MARKET_TYPES as frozen arrays for consumer validation"
  artifacts:
    - path: "docs/market_evaluation_contract.md"
      provides: "Canonical contract doc for MarketEvalResult, GameMarketEvaluation, REASON_CODES, forbidden behaviors"
      contains: "UNACCOUNTED_MARKET_RESULTS"
    - path: "packages/models/src/market-eval.js"
      provides: "Added VALID_STATUSES and VALID_MARKET_TYPES exports"
      exports: ["VALID_STATUSES", "VALID_MARKET_TYPES"]
  key_links:
    - from: "docs/market_evaluation_contract.md"
      to: "packages/models/src/market-eval.js"
      via: "references the module path for REASON_CODES and evaluateSingleMarket"
      pattern: "market-eval"
---

<objective>
Write the spec doc `docs/market_evaluation_contract.md` and finalize the market-eval module with exported validation constants.

Purpose: The audit identified that silent drops are invisible to operators because there are no canonical names or contracts for "why a market was rejected." This plan locks the contract in writing and exports typed validation arrays so downstream code can verify compliance.

Output: `docs/market_evaluation_contract.md` with full contract. `VALID_STATUSES` and `VALID_MARKET_TYPES` exported from market-eval.js.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@packages/models/src/market-eval.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Write docs/market_evaluation_contract.md</name>
  <files>docs/market_evaluation_contract.md</files>
  <action>
    Create `docs/market_evaluation_contract.md` with the following sections:

    ## Overview
    Brief description: every market candidate (F5_TOTAL, F5_ML, FULL_GAME_ML, FULL_GAME_TOTAL, TOTAL, SPREAD, ML) must end in exactly one of the terminal statuses below. No market may disappear without a status and reason_codes. This contract applies to both MLB and NHL game market evaluation.

    ## MarketEvalResult Shape
    Document all fields:
    - game_id, sport, market_type, candidate_id
    - inputs_ok, consistency_ok, watchdog_ok
    - model_edge, fair_price, win_probability
    - official_tier: PLAY | LEAN | PASS
    - status: one of 9 terminal states
    - reason_codes: string[] (must be non-empty when status starts with REJECTED_)
    - notes: string[]

    ## GameMarketEvaluation Shape
    - game_id, sport
    - market_results: MarketEvalResult[] — ALL evaluated, never omitted
    - official_plays: results with status QUALIFIED_OFFICIAL
    - leans: results with status QUALIFIED_LEAN
    - rejected: results with status REJECTED_*
    - status: HAS_OFFICIAL_PLAYS | LEANS_ONLY | SKIP_MARKET_NO_EDGE | SKIP_GAME_INPUT_FAILURE

    ## REASON_CODES
    Table with all 9 codes and when each fires:

    | Code | When Used |
    |------|-----------|
    | MISSING_MARKET_ODDS | card is null or missing h2h/total odds |
    | MISSING_STARTING_PITCHER | MLB card missing pitcher inputs |
    | MISSING_GOALIE_CONFIRMATION | NHL card with UNKNOWN goalie certainty |
    | MISSING_CONSISTENCY_FIELDS | pace_tier/event_env/total_bias absent |
    | WATCHDOG_UNSAFE_FOR_BASE | watchdog blocked execution |
    | EDGE_BELOW_THRESHOLD | ev_threshold_passed=false |
    | EV_BELOW_THRESHOLD | positive edge but below lean minimum |
    | DUPLICATE_MARKET_SUPPRESSED | identical candidate already evaluated |
    | DISPLAY_RANKED_BELOW_PRIMARY | show-only: ranked below primary in display layer |

    ## Invariants
    1. terminal-state invariant: every market_result has status in VALID_STATUSES
    2. count invariant: official_plays + leans + rejected = market_results (enforced by assertNoSilentMarketDrop)
    3. reason-required invariant: status starting with REJECTED_ must have reason_codes.length >= 1

    ## assertNoSilentMarketDrop Contract
    - Exported from packages/models/src/market-eval.js
    - Throws `Error('UNACCOUNTED_MARKET_RESULTS for {game_id}')` when count invariant violated
    - Called before DB writes in run_mlb_model.js and run_nhl_model.js

    ## Forbidden Cross-Market Behaviors
    - Cross-market logic MAY: rank markets by score, choose primary display, apply exposure caps, deduplicate correlated angles with DUPLICATE_MARKET_SUPPRESSED
    - Cross-market logic MUST NOT: delete a qualified market, convert a QUALIFIED_OFFICIAL to not-emitted, treat empty output as clean success without explicit status

    ## Smoke Test Scenarios
    Document the 3 spec scenarios:
    1. MLB game: F5 qualifies + ML qualifies + full-game total fails → 2 insertions + 1 rejection log
    2. NHL game: TOTAL=PLAY + ML=LEAN + SPREAD=PASS → total official, ML lean, spread rejected
    3. Empty-edge game: all markets PASS → official_plays=[], status=SKIP_MARKET_NO_EDGE, explicit notes

    ## Module Location
    `packages/models/src/market-eval.js`
    Exported symbols: evaluateSingleMarket, finalizeGameMarketEvaluation, assertNoSilentMarketDrop, REASON_CODES, VALID_STATUSES, VALID_MARKET_TYPES, logRejectedMarkets
  </action>
  <verify>
    <automated>test -f /Users/ajcolubiale/projects/cheddar-logic/docs/market_evaluation_contract.md && echo "EXISTS"</automated>
  </verify>
  <done>File exists and contains UNACCOUNTED_MARKET_RESULTS and DUPLICATE_MARKET_SUPPRESSED strings</done>
</task>

<task type="auto">
  <name>Task 2: Export VALID_STATUSES and VALID_MARKET_TYPES from market-eval.js</name>
  <files>packages/models/src/market-eval.js</files>
  <action>
    Add to packages/models/src/market-eval.js before module.exports:

    ```javascript
    const VALID_STATUSES = Object.freeze([
      'QUALIFIED_OFFICIAL',
      'QUALIFIED_LEAN',
      'REJECTED_INPUTS',
      'REJECTED_CONSISTENCY',
      'REJECTED_WATCHDOG',
      'REJECTED_THRESHOLD',
      'REJECTED_SELECTOR',
      'REJECTED_DUPLICATE',
      'REJECTED_MARKET_POLICY',
    ]);

    const VALID_MARKET_TYPES = Object.freeze([
      'F5_ML',
      'F5_TOTAL',
      'FULL_GAME_ML',
      'FULL_GAME_TOTAL',
      'PUCKLINE',
      'SPREAD',
      'TOTAL',
      'MONEYLINE',  // NHL canonical name for ML market
      'FIRST_PERIOD',
      'UNKNOWN',    // fallback
    ]);
    ```

    Add to assertNoSilentMarketDrop — extend to also check terminal state validity:
    ```javascript
    for (const r of gameEval.market_results) {
      if (!r.status || !VALID_STATUSES.includes(r.status)) {
        throw new Error(`MISSING_MARKET_TERMINAL_STATUS for ${r.candidate_id ?? 'unknown'}: got ${r.status}`);
      }
      if (!Array.isArray(r.reason_codes)) {
        throw new Error(`MISSING_REASON_CODES_ARRAY for ${r.candidate_id ?? 'unknown'}`);
      }
    }
    ```

    Add VALID_STATUSES and VALID_MARKET_TYPES to module.exports.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node -e "const m = require('./packages/models/src/market-eval'); console.log(Array.isArray(m.VALID_STATUSES), m.VALID_STATUSES.length)"</automated>
  </verify>
  <done>VALID_STATUSES is a frozen array of 9 strings; VALID_MARKET_TYPES is a frozen array; assertNoSilentMarketDrop includes status validation</done>
</task>

</tasks>

<verification>
1. `test -f docs/market_evaluation_contract.md && grep -q "UNACCOUNTED_MARKET_RESULTS" docs/market_evaluation_contract.md && echo "OK"`
2. `node -e "const m = require('./packages/models/src/market-eval'); console.log(m.VALID_STATUSES.length, m.VALID_MARKET_TYPES.length)"` — prints `9 10`
3. `npx jest packages/models/src/market-eval.test.js --no-coverage` — all 7 tests still pass (no regression from additions)
</verification>

<success_criteria>
Contract document exists and covers all shapes, codes, invariants, and forbidden behaviors. market-eval.js exports the validation arrays. assertNoSilentMarketDrop validates both count and terminal-state type.
</success_criteria>

<output>
After completion, create `.planning/phases/ime-01-independent-market-eval/ime-01-05-SUMMARY.md`
</output>
