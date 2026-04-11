---
phase: di-01-decision-integrity
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/jobs/__tests__/run_nhl_model.no-bet.test.js
autonomous: true

must_haves:
  truths:
    - "When computeNHLMarketDecisions() returns {status:'NO_BET', reason_detail:'DOUBLE_UNKNOWN_GOALIE'}, run_nhl_model.js logs the skip and calls continue before selectExpressionChoice or generateNHLMarketCallCards"
    - "gamePipelineStates[gameId] is written with blockingReasonCodes containing 'DOUBLE_UNKNOWN_GOALIE' for skipped games"
    - "noBetCount is incremented for each skipped game"
    - "A new test file produces a passing test: DOUBLE_UNKNOWN_GOALIE produces zero cards plus pipeline state with NO_BET reason"
    - "No downstream code (selectExpressionChoice, generateNHLMarketCallCards) is called with a {status:'NO_BET'} object"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "NO_BET guard after computeNHLMarketDecisions() call"
      contains: "marketDecisions?.status === 'NO_BET'"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_model.no-bet.test.js"
      provides: "unit test for DOUBLE_UNKNOWN_GOALIE guard"
      min_lines: 50
  key_links:
    - from: "run_nhl_model.js (after computeNHLMarketDecisions call)"
      to: "gamePipelineStates[gameId].blockingReasonCodes"
      via: "NO_BET guard + buildGamePipelineState or equivalent state-setter"
      pattern: "status.*NO_BET|NO_BET.*status"
---

<objective>
Make NHL NO_BET an explicit, observable skip state. The current code falls through DOUBLE_UNKNOWN_GOALIE silently, producing zero cards and a misleading driversReady=false pipeline state indistinguishable from an ESPN data failure.

Purpose: CF-004 from the hardening audit. Silence is not a valid control-flow result. Every skipped game must write a reason code that monitoring can act on.

Output:
- Explicit NO_BET guard in run_nhl_model.js
- blockingReasonCodes written to pipeline state
- 1 new test file with a test covering the DOUBLE_UNKNOWN_GOALIE path
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@apps/worker/src/jobs/run_nhl_model.js
@apps/worker/src/models/cross-market.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add explicit NO_BET guard after computeNHLMarketDecisions()</name>
  <files>apps/worker/src/jobs/run_nhl_model.js</files>
  <action>
Find the line that calls `computeNHLMarketDecisions(enrichedSnapshot)` (approximately line 2239 based on audit). The code immediately after currently calls `selectExpressionChoice(marketDecisions)` without any status check.

Add a NO_BET guard immediately after the assignment:

```javascript
const marketDecisions = computeNHLMarketDecisions(enrichedSnapshot);

// CF-004: NO_BET must be surfaced explicitly — never fall through silently.
if (marketDecisions?.status === 'NO_BET') {
  const reason = marketDecisions.reason_detail ?? marketDecisions.reason ?? 'NO_BET';
  console.log(`  [NO_BET] ${gameId}: ${reason}`);
  // Write explicit pipeline state so monitoring can distinguish NO_BET from data failure
  if (typeof gamePipelineStates !== 'undefined' && gameId) {
    gamePipelineStates[gameId] = {
      ...(gamePipelineStates[gameId] ?? {}),
      projectionReady: false,
      driversReady: false,
      pricingReady: false,
      cardReady: false,
      blockingReasonCodes: [reason],
      no_bet: true,
    };
  }
  if (typeof noBetCount !== 'undefined') noBetCount++;
  continue;  // skip to next game in the loop
}
```

Notes:
- `gamePipelineStates` and `noBetCount` names must match what's actually used in the loop. Read the surrounding loop code to verify variable names before inserting.
- If `buildGamePipelineState(...)` is a helper already used in the file, prefer calling it with `blockingReasonCodes: [reason]` instead of the inline object.
- Do NOT modify the loop structure — only insert the guard block after the `computeNHLMarketDecisions` assignment.
  </action>
  <verify>
    grep -n "NO_BET\|status.*NO_BET\|blockingReasonCodes" apps/worker/src/jobs/run_nhl_model.js | head -10
    npm --prefix apps/worker test --no-coverage 2>&1 | tail -8
  </verify>
  <done>
    - `marketDecisions?.status === 'NO_BET'` guard exists in run_nhl_model.js
    - `blockingReasonCodes` is written to pipeline state on NO_BET
    - All existing worker tests still pass
  </done>
</task>

<task type="auto">
  <name>Task 2: Add NO_BET unit test</name>
  <files>apps/worker/src/jobs/__tests__/run_nhl_model.no-bet.test.js</files>
  <action>
Create a new test file `apps/worker/src/jobs/__tests__/run_nhl_model.no-bet.test.js`.

The test should:
1. Mock `computeNHLMarketDecisions` to return `{ status: 'NO_BET', reason_detail: 'DOUBLE_UNKNOWN_GOALIE', reason: 'NO_BET' }`.
2. Run the NHL model processing loop for a single fake game.
3. Assert:
   - Zero cards are emitted (insertCardPayload is not called, or card array is empty).
   - The pipeline state for the game includes `blockingReasonCodes` containing `'DOUBLE_UNKNOWN_GOALIE'`.
   - `noBetCount` incremented by 1.

Use the existing test file structure in `apps/worker/src/jobs/__tests__/` as a reference for how to set up mocks. Look at `run_nhl_model.test.js` for the module mock pattern.

Since run_nhl_model.js is a job script (not a library with clean exports), the test may need to use Jest module mocking (`jest.mock('../../../models/cross-market', () => ...)`) to override `computeNHLMarketDecisions`. The simplest approach:

```javascript
// run_nhl_model.no-bet.test.js
jest.mock('../../../models/cross-market', () => ({
  ...jest.requireActual('../../../models/cross-market'),
  computeNHLMarketDecisions: jest.fn().mockReturnValue({
    status: 'NO_BET',
    reason_detail: 'DOUBLE_UNKNOWN_GOALIE',
    reason: 'NO_BET',
  }),
}));
```

Then drive the relevant function or a re-exported helper (if one exists) with a minimal enrichedSnapshot.

If run_nhl_model.js does not export any testable unit, scope the test to unit-testing the guard logic in isolation: write a small helper `function applyNoBetGuard(marketDecisions, gameId, state)` in the job file that encapsulates the guard, export it, and test it directly. This is preferable to trying to drive the full job.

Regardless of approach, the test must have at least 50 lines and cover:
- DOUBLE_UNKNOWN_GOALIE → pipeline state contains NO_BET reason
- Normal marketDecisions (no status field) → guard does NOT fire
  </action>
  <verify>
    npm --prefix apps/worker test -- --testPathPattern=run_nhl_model.no-bet 2>&1 | tail -10
  </verify>
  <done>New test file exists, at least 50 lines, 2+ tests pass. All prior worker tests unaffected.</done>
</task>

</tasks>

<verification>
1. `grep -n "status.*NO_BET\|NO_BET.*status" apps/worker/src/jobs/run_nhl_model.js` — guard present
2. `grep -n "blockingReasonCodes" apps/worker/src/jobs/run_nhl_model.js` — written on NO_BET
3. `npm --prefix apps/worker test --no-coverage` — all existing tests pass
4. `npm --prefix apps/worker test -- --testPathPattern=no-bet` — new tests pass
</verification>

<success_criteria>
- NO_BET guard in run_nhl_model.js fires before any downstream market card generation
- gamePipelineStates captures blockingReasonCodes with the specific reason (DOUBLE_UNKNOWN_GOALIE)
- Monitoring can now distinguish NO_BET from ESPN data failure in game pipeline state
- New test confirms the guard behavior
- Zero regressions in existing NHL runner tests
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-02-SUMMARY.md`
</output>
