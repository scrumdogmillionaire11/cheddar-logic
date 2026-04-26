---
phase: pass-reason-integrity
plan: "01"
type: tdd
wave: 1
depends_on: []
files_modified:
  - packages/models/src/market-eval.js
  - packages/models/src/market-eval.test.js
autonomous: true
requirements:
  - PRI-CONTRACT-01
  - PRI-CONTRACT-02
  - PRI-CONTRACT-03

must_haves:
  truths:
    - "buildResult() output includes inputs_status, evaluation_status, raw_edge_value, threshold_passed, block_reasons on every result"
    - "assertLegalPassNoEdge() throws when raw_edge_value > 0 is labeled PASS_NO_EDGE"
    - "assertLegalPassNoEdge() throws when evaluation_status is NO_EVALUATION but PASS_NO_EDGE is assigned"
    - "finalizeGameMarketEvaluation emits SKIP_GAME_MIXED_FAILURES when some candidates were never evaluated"
    - "assertNoSilentMarketDrop calls assertLegalPassNoEdge on each result"
  artifacts:
    - path: "packages/models/src/market-eval.js"
      provides: "Extended MarketEvalResult contract; assertLegalPassNoEdge export; SKIP_GAME_MIXED_FAILURES status"
      exports:
        - "assertLegalPassNoEdge"
        - "VALID_STATUSES (includes SKIP_GAME_MIXED_FAILURES)"
        - "buildResult (with 5 new fields)"
    - path: "packages/models/src/market-eval.test.js"
      provides: "Tests for scenarios F, G, K, L"
  key_links:
    - from: "assertNoSilentMarketDrop"
      to: "assertLegalPassNoEdge"
      via: "direct call on each result in gameEval.market_results"
      pattern: "assertLegalPassNoEdge\\(r\\)"
    - from: "buildResult"
      to: "inputs_status/evaluation_status/raw_edge_value"
      via: "extra param or derived from card fields"
      pattern: "inputs_status.*evaluation_status"
---

<objective>
Extend the `MarketEvalResult` contract in `market-eval.js` with five provenance fields that make `PASS_NO_EDGE` a _derived_ conclusion rather than an assigned label. Install `assertLegalPassNoEdge()` as a hard-throw enforcer called from `assertNoSilentMarketDrop`. Add `SKIP_GAME_MIXED_FAILURES` to VALID_STATUSES and wire it into `finalizeGameMarketEvaluation`.

Purpose: Every downstream consumer (health monitor, Discord, web API) must be able to distinguish "edge was computed and failed threshold" from "evaluation never ran." This is the contract layer — the model fixes in Plans 02–03 are only correct once this contract is enforced.

Output: Extended `buildResult()`, exported `assertLegalPassNoEdge()`, updated `finalizeGameMarketEvaluation`, green test suite for scenarios F/G/K/L.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md

<interfaces>
<!-- Current buildResult() signature — executor must ADD to, not replace, these fields -->
```javascript
// packages/models/src/market-eval.js — current buildResult output shape
{
  game_id: string,
  sport: string | null,
  market_type: string,       // normalised
  candidate_id: string,      // `${game_id}::${market}`
  inputs_ok: boolean,
  consistency_ok: boolean,
  watchdog_ok: boolean,
  model_edge: number | null, // card.edge
  fair_price: number | null,
  win_probability: number | null,
  official_tier: 'PLAY' | 'LEAN' | 'PASS',
  status: string,            // one of VALID_STATUSES
  reason_codes: string[],
  notes: string[],
}

// Current VALID_STATUSES (9 entries):
// 'QUALIFIED_OFFICIAL', 'QUALIFIED_LEAN', 'QUALIFIED_OFFICIAL_LOCKED',
// 'REJECTED_INPUTS', 'REJECTED_WATCHDOG', 'REJECTED_THRESHOLD',
// 'SKIP_MARKET_NO_EDGE', 'SKIP_GAME_INPUT_FAILURE', 'LEANS_ONLY'

// Current evaluateSingleMarket paths:
// null card           → REJECTED_INPUTS  (MISSING_MARKET_ODDS)
// malformed card      → REJECTED_INPUTS  (UNCLASSIFIED_MARKET_STATE)
// missing_inputs[]    → REJECTED_INPUTS
// watchdog reasons    → REJECTED_WATCHDOG
// ev_threshold_passed false → REJECTED_THRESHOLD  (EDGE_BELOW_THRESHOLD)
// card.status=PASS    → REJECTED_THRESHOLD  (EV_BELOW_THRESHOLD)
// card.status=WATCH   → QUALIFIED_LEAN
// card.status=FIRE    → QUALIFIED_OFFICIAL
// fallback            → REJECTED_THRESHOLD (UNCLASSIFIED_MARKET_STATE)
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Extend buildResult() with 5 provenance fields; populate per evaluation path</name>
  <files>packages/models/src/market-eval.js</files>
  <behavior>
    - `buildResult()` gains five new optional-extra fields: `inputs_status`, `evaluation_status`, `raw_edge_value`, `threshold_required`, `threshold_passed`, `block_reasons`
    - Default values when not supplied via `extra`: `inputs_status: 'COMPLETE'`, `evaluation_status: 'NO_EVALUATION'`, `raw_edge_value: null`, `threshold_required: null`, `threshold_passed: null`, `block_reasons: []`
    - `REJECTED_INPUTS` path: `inputs_status: 'MISSING'`, `evaluation_status: 'NO_EVALUATION'`, `threshold_passed: null`
    - `REJECTED_WATCHDOG` path: `inputs_status: 'PARTIAL'`, `evaluation_status: 'NO_EVALUATION'`, `threshold_passed: null`
    - `ev_threshold_passed === false` → `REJECTED_THRESHOLD`: `inputs_status: 'COMPLETE'`, `evaluation_status: 'EDGE_COMPUTED'`, `raw_edge_value: card.edge ?? null`, `threshold_passed: false`
    - `card.status === 'PASS'` → `REJECTED_THRESHOLD`: inspect `card.pass_reason_code`; if it is `'PASS_NO_EDGE'` → `evaluation_status: 'EDGE_COMPUTED'`, `inputs_status: 'COMPLETE'`, `raw_edge_value: card.edge ?? null`, `threshold_passed: false`; otherwise → `evaluation_status: 'NO_EVALUATION'`, `block_reasons: [card.pass_reason_code].filter(Boolean)`
    - `QUALIFIED_LEAN` / `QUALIFIED_OFFICIAL`: `inputs_status: 'COMPLETE'`, `evaluation_status: 'EDGE_COMPUTED'`, `threshold_passed: true`
    - Test F: a null card result has `evaluation_status === 'NO_EVALUATION'` and `inputs_status === 'MISSING'`
    - Test F2: a PASS-status card with `pass_reason_code: 'PASS_CONFIDENCE_GATE'` has `evaluation_status === 'NO_EVALUATION'` and `block_reasons: ['PASS_CONFIDENCE_GATE']`
    - Test F3: a PASS-status card with `pass_reason_code: 'PASS_NO_EDGE'` has `evaluation_status === 'EDGE_COMPUTED'` and `threshold_passed === false`
  </behavior>
  <action>
    In `buildResult(card, ctx, status, reasonCodes, extra = {})`:
    - Destructure from `extra`: `inputs_status`, `evaluation_status`, `raw_edge_value`, `threshold_required`, `threshold_passed`, `block_reasons`
    - Apply defaults as listed in behavior
    - Add all 6 fields to the returned object

    In `evaluateSingleMarket()`:
    - Each `buildResult()` call must pass the correct provenance fields via `extra`
    - For the `card.status === 'PASS'` REJECTED_THRESHOLD path (lines ~266–273 in current file), derive `evaluation_status` and `block_reasons` from `card.pass_reason_code` as specified
    - For `ev_threshold_passed === false` REJECTED_THRESHOLD path, pass `evaluation_status: 'EDGE_COMPUTED'`, `raw_edge_value: card.edge ?? null`, `threshold_passed: false`
    - For QUALIFIED paths, pass `evaluation_status: 'EDGE_COMPUTED'`, `threshold_passed: true`

    Do NOT change any existing fields or status values. This is purely additive.
  </action>
  <verify>
    <automated>npx jest --testPathPattern="market-eval" --no-coverage 2>&1 | tail -15</automated>
  </verify>
  <done>All 6 new fields present on every buildResult() output; existing tests still pass; F/F2/F3 test scenarios pass</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: assertLegalPassNoEdge() hard-throw enforcer + SKIP_GAME_MIXED_FAILURES</name>
  <files>packages/models/src/market-eval.js, packages/models/src/market-eval.test.js</files>
  <behavior>
    - `assertLegalPassNoEdge(result)` — exported function; mutates nothing; only throws
    - Throws `Error('ILLEGAL_PASS_NO_EDGE: positive edge labeled PASS_NO_EDGE ...')` with `candidate_id` and `raw_edge_value` in message when: `result.reason_codes` or `result.status`-adjacent `pass_reason_code` contains `'PASS_NO_EDGE'` AND any of: `result.raw_edge_value > 0`, `result.evaluation_status === 'NO_EVALUATION'`, `result.inputs_status === 'MISSING'`
    - Does NOT throw when `raw_edge_value <= 0` AND `evaluation_status === 'EDGE_COMPUTED'` AND `inputs_status === 'COMPLETE'` (true no-edge case — legal)
    - `assertNoSilentMarketDrop(gameEval)` calls `assertLegalPassNoEdge(r)` for each `r` in `gameEval.market_results`
    - VALID_STATUSES gains `'SKIP_GAME_MIXED_FAILURES'` as the 10th entry
    - `finalizeGameMarketEvaluation`: after computing `status`, add: if `status === 'SKIP_MARKET_NO_EDGE'` and any rejected result has `evaluation_status === 'NO_EVALUATION'`, set `status = 'SKIP_GAME_MIXED_FAILURES'`
    - Test G: result with `pass_reason_code: 'PASS_NO_EDGE'` and `raw_edge_value: 0.031` → `assertLegalPassNoEdge` throws with message containing 'ILLEGAL_PASS_NO_EDGE'
    - Test G2: result with `pass_reason_code: 'PASS_NO_EDGE'` and `evaluation_status: 'NO_EVALUATION'` → throws
    - Test G3: result with `pass_reason_code: 'PASS_NO_EDGE'`, `raw_edge_value: -0.01`, `evaluation_status: 'EDGE_COMPUTED'`, `inputs_status: 'COMPLETE'` → does NOT throw
    - Test K: `finalizeGameMarketEvaluation` with two REJECTED_THRESHOLD results where one has `evaluation_status: 'NO_EVALUATION'` → status is `SKIP_GAME_MIXED_FAILURES`
    - Test L: `finalizeGameMarketEvaluation` with two REJECTED_THRESHOLD results both having `evaluation_status: 'EDGE_COMPUTED'` → status remains `SKIP_MARKET_NO_EDGE`
  </behavior>
  <action>
    Add `assertLegalPassNoEdge(result)` function before `assertNoSilentMarketDrop`. Detection logic:
    ```javascript
    function assertLegalPassNoEdge(result) {
      const hasNoEdgeCode =
        (Array.isArray(result.reason_codes) && result.reason_codes.includes('PASS_NO_EDGE'));
      if (!hasNoEdgeCode) return;

      const positiveEdge = typeof result.raw_edge_value === 'number' && result.raw_edge_value > 0;
      const noEvaluation = result.evaluation_status === 'NO_EVALUATION';
      const missingInputs = result.inputs_status === 'MISSING';

      if (positiveEdge || noEvaluation || missingInputs) {
        throw new Error(
          `ILLEGAL_PASS_NO_EDGE: candidate=${result.candidate_id} raw_edge=${result.raw_edge_value} ` +
          `evaluation_status=${result.evaluation_status} inputs_status=${result.inputs_status}. ` +
          `PASS_NO_EDGE requires: EDGE_COMPUTED + COMPLETE inputs + non-positive edge.`
        );
      }
    }
    ```

    In `assertNoSilentMarketDrop(gameEval)`: add `gameEval.market_results.forEach(r => assertLegalPassNoEdge(r))` at the top before partition checks.

    Add `'SKIP_GAME_MIXED_FAILURES'` to VALID_STATUSES array.

    In `finalizeGameMarketEvaluation`, after the status assignment block:
    ```javascript
    if (status === 'SKIP_MARKET_NO_EDGE') {
      const anyNoEvaluation = rejected.some(r => r.evaluation_status === 'NO_EVALUATION');
      if (anyNoEvaluation) status = 'SKIP_GAME_MIXED_FAILURES';
    }
    ```

    Export `assertLegalPassNoEdge` alongside the other exports at the bottom.
  </action>
  <verify>
    <automated>npx jest --testPathPattern="market-eval" --no-coverage 2>&1 | tail -15</automated>
  </verify>
  <done>assertLegalPassNoEdge throws on positive-edge PASS_NO_EDGE; SKIP_GAME_MIXED_FAILURES wired; all 12 test scenarios G/G2/G3/K/L pass; pre-existing tests unbroken</done>
</task>

</tasks>

<verification>
```bash
npx jest --testPathPattern="market-eval" --no-coverage 2>&1 | grep -E "Tests:|PASS|FAIL"
```

All assertions:
- `buildResult()` output includes all 6 new fields on every code path
- `assertLegalPassNoEdge` is exported and callable
- `VALID_STATUSES` has 10 entries including `SKIP_GAME_MIXED_FAILURES`
- `assertNoSilentMarketDrop` calls `assertLegalPassNoEdge` (verify via test G)
- `finalizeGameMarketEvaluation` emits `SKIP_GAME_MIXED_FAILURES` when appropriate
</verification>

<success_criteria>
- `npx jest --testPathPattern="market-eval"` passes with 0 failures
- `assertLegalPassNoEdge` is exported from `market-eval.js`
- No existing test regressions
- `SKIP_GAME_MIXED_FAILURES` present in exported `VALID_STATUSES`
</success_criteria>

<output>
After completion, create `.planning/phases/pass-reason-integrity/pass-reason-integrity-01-SUMMARY.md`
</output>
