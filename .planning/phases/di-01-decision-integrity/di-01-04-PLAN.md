---
phase: di-01-decision-integrity
plan: "04"
type: execute
wave: 2
depends_on: ["di-01-02", "di-01-03"]
files_modified:
  - apps/worker/src/utils/decision-publisher.js
  - apps/worker/src/jobs/execution-gate.js
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/jobs/settle_pending_cards.js
  - apps/worker/src/jobs/__tests__/execution-gate-decision-consistency.test.js
autonomous: true

must_haves:
  truths:
    - "applyDecisionVeto(decision, reason) function exists in decision-publisher.js and returns a canonical decision with official_status=PASS, action=PASS, is_settleable=false, and the veto reason in reason_codes"
    - "applyExecutionGateToNhlCard() calls applyDecisionVeto() when blocking — it no longer writes action/classification/status directly on the payload without also updating decision_v2.official_status"
    - "After execution gate blocks a card, the stored payload has decision_v2.official_status=PASS AND action=PASS — they agree"
    - "settle_pending_cards.js refuses to settle a card where action=PASS AND decision_v2.official_status=PLAY (logs INVARIANT_BREACH and skips)"
    - "A new test confirms: gate-blocked card has consistent PASS in both action and decision_v2.official_status"
  artifacts:
    - path: "apps/worker/src/utils/decision-publisher.js"
      provides: "applyDecisionVeto(decision, vetoReason) helper"
      exports: ["applyDecisionVeto"]
      contains: "is_settleable: false"
    - path: "apps/worker/src/jobs/execution-gate.js"
      provides: "uses applyDecisionVeto when evaluation result is blocked"
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "applyExecutionGateToNhlCard result updates decision_v2.official_status"
    - path: "apps/worker/src/jobs/settle_pending_cards.js"
      provides: "contradiction guard that skips cards with action=PASS but decision_v2.official_status=PLAY"
    - path: "apps/worker/src/jobs/__tests__/execution-gate-decision-consistency.test.js"
      provides: "test: blocked card has consistent state"
      min_lines: 55
  key_links:
    - from: "applyExecutionGateToNhlCard()"
      to: "applyDecisionVeto()"
      via: "call on blocked gate result"
      pattern: "applyDecisionVeto"
    - from: "settle_pending_cards.js"
      to: "contradiction guard"
      via: "action===PASS && decision_v2.official_status===PLAY → skip"
      pattern: "INVARIANT_BREACH|contradiction"
---

<objective>
Stop the execution gate from creating internally contradictory card payloads. The gate currently writes action=PASS but leaves decision_v2.official_status=PLAY. Settlement reads decision_v2.official_status and scores the card as an active bet that the user was never shown.

Introduce a single helper `applyDecisionVeto()` that atomically updates all decision fields together, and wire it into the execution gate path. Add a settlement guard that detects and skips any surviving contradictions.

Purpose: CF-002 from the hardening audit. Ghost bets are worse than missed bets.

Output:
- applyDecisionVeto() helper (exported from decision-publisher.js)
- Execution gate uses it
- Settlement guard against surviving contradictions
- Tests confirming consistent state after gate block
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@apps/worker/src/utils/decision-publisher.js
@apps/worker/src/jobs/execution-gate.js
@apps/worker/src/jobs/run_nhl_model.js
@apps/worker/src/jobs/settle_pending_cards.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add applyDecisionVeto() to decision-publisher.js and wire into execution gate</name>
  <files>apps/worker/src/utils/decision-publisher.js, apps/worker/src/jobs/execution-gate.js, apps/worker/src/jobs/run_nhl_model.js</files>
  <action>
**Step A — Add `applyDecisionVeto()` to decision-publisher.js:**

Add this function (near the top of the exports, after `deriveAction`):

```javascript
/**
 * CF-002: Atomically veto a canonical decision.
 * All decision fields are updated together so no payload can carry
 * decision_v2.official_status=PLAY alongside action=PASS.
 *
 * @param {object} cardOrDecision — the card payload (mutated in-place)
 * @param {string} vetoReason — e.g. 'EXECUTION_GATE_BLOCKED'
 * @returns {object} the same card reference (mutated)
 */
function applyDecisionVeto(cardOrDecision, vetoReason) {
  // Veto top-level legacy fields
  cardOrDecision.action = 'PASS';
  cardOrDecision.classification = 'PASS';
  cardOrDecision.status = 'PASS';
  cardOrDecision.ui_display_status = 'PASS';
  cardOrDecision.execution_status = 'VETOED';
  cardOrDecision.ev_passed = false;
  cardOrDecision.actionable = false;
  cardOrDecision.publish_ready = false;
  cardOrDecision.pass_reason_code = vetoReason;
  if (!Array.isArray(cardOrDecision.reason_codes)) cardOrDecision.reason_codes = [];
  if (!cardOrDecision.reason_codes.includes(vetoReason)) {
    cardOrDecision.reason_codes.push(vetoReason);
  }
  // Veto the canonical decision_v2 block — this is the critical fix for CF-002
  if (cardOrDecision.decision_v2) {
    cardOrDecision.decision_v2.official_status = 'PASS';
    cardOrDecision.decision_v2.is_settleable = false;
    cardOrDecision.decision_v2.veto_reason = vetoReason;
  }
  return cardOrDecision;
}
```

Export it: add `applyDecisionVeto` to the module.exports or named exports.

**Step B — Update `applyExecutionGateToNhlCard()` in run_nhl_model.js:**

Find the block at approximately lines 463-530 where the execution gate blocks a card (where `classification`, `action`, `status` are overwritten). Replace those field assignments with a single call:

```javascript
applyDecisionVeto(card, `EXECUTION_GATE: ${gateResult.blocked_by?.join(',') ?? 'BLOCKED'}`);
```

Import `applyDecisionVeto` at the top of run_nhl_model.js from decision-publisher if not already imported.

Do the same for the NBA execution gate equivalent if it exists in run_nba_model.js (search for `applyExecutionGateToNbaCard` or similar).

**Step C — Do not change the calling order** (gate still runs after publishDecisionForCard for now — the mutation fix via applyDecisionVeto ensures both fields agree). A future hardening may reorder; that is out of scope here.
  </action>
  <verify>
    grep -n "applyDecisionVeto" apps/worker/src/utils/decision-publisher.js apps/worker/src/jobs/run_nhl_model.js
    grep -n "is_settleable" apps/worker/src/utils/decision-publisher.js
    npm --prefix apps/worker test --no-coverage 2>&1 | tail -8
  </verify>
  <done>
    - applyDecisionVeto exported from decision-publisher.js
    - applyDecisionVeto called in run_nhl_model.js execution gate block
    - is_settleable=false written in veto helper
    - All existing tests pass
  </done>
</task>

<task type="auto">
  <name>Task 2: Add settlement contradiction guard + consistency test</name>
  <files>apps/worker/src/jobs/settle_pending_cards.js, apps/worker/src/jobs/__tests__/execution-gate-decision-consistency.test.js</files>
  <action>
**In `settle_pending_cards.js`:**

Find the query/loop that processes pending cards for settlement (approximately line 612 where `payloadData?.decision_v2?.official_status` is read). Before using the official_status value for settlement decision, add a contradiction guard:

```javascript
// CF-002: Contradiction guard — execution gate creates this state when it only
// partially vetoes a card. Such cards must never be settled as active bets.
const isContradiction = (
  payloadData?.action === 'PASS' &&
  payloadData?.decision_v2?.official_status === 'PLAY'
);
if (isContradiction) {
  console.error(
    `[INVARIANT_BREACH] card ${card.id ?? card.card_id} has ` +
    `action=PASS but decision_v2.official_status=PLAY — skipping settlement`
  );
  // Count it as a non-actionable card rather than a bet
  skippedCount = (skippedCount ?? 0) + 1;
  continue;  // or: return null depending on loop structure
}
```

If the loop structure does not use `continue` (e.g., it's a `.map()`), perform an early return or filter instead. Match the existing pattern in the function.

**Create `apps/worker/src/jobs/__tests__/execution-gate-decision-consistency.test.js`:**

```javascript
// Tests: CF-002 — execution gate must produce consistent canonical state
const { applyDecisionVeto } = require('../../utils/decision-publisher');

describe('applyDecisionVeto — canonical field consistency', () => {
  test('veto sets action=PASS and decision_v2.official_status=PASS together', () => {
    const card = {
      action: 'FIRE',
      classification: 'BASE',
      status: 'FIRE',
      decision_v2: { official_status: 'PLAY', edge_pct: 0.07, is_settleable: true },
    };
    applyDecisionVeto(card, 'EXECUTION_GATE: test');
    expect(card.action).toBe('PASS');
    expect(card.decision_v2.official_status).toBe('PASS');
    expect(card.decision_v2.is_settleable).toBe(false);
  });

  test('veto without pre-existing decision_v2 does not throw', () => {
    const card = { action: 'FIRE', classification: 'BASE', status: 'FIRE' };
    expect(() => applyDecisionVeto(card, 'EXECUTION_GATE: test')).not.toThrow();
    expect(card.action).toBe('PASS');
  });

  test('veto appends reason code to reason_codes array', () => {
    const card = {
      action: 'FIRE', reason_codes: ['PRIOR_REASON'],
      decision_v2: { official_status: 'PLAY' },
    };
    applyDecisionVeto(card, 'EXECUTION_GATE: LOW_EDGE');
    expect(card.reason_codes).toContain('EXECUTION_GATE: LOW_EDGE');
    expect(card.reason_codes).toContain('PRIOR_REASON');
  });
});
```

Run: `npm --prefix apps/worker test -- --testPathPattern=execution-gate-decision-consistency 2>&1 | tail -10`
  </action>
  <verify>
    grep -n "INVARIANT_BREACH\|isContradiction" apps/worker/src/jobs/settle_pending_cards.js | head -5
    npm --prefix apps/worker test -- --testPathPattern=execution-gate-decision-consistency 2>&1 | tail -10
  </verify>
  <done>Settlement contradiction guard exists in settle_pending_cards.js. 3 tests in consistency test file pass. All existing worker tests pass.</done>
</task>

</tasks>

<verification>
1. `grep -n "applyDecisionVeto\|is_settleable" apps/worker/src/utils/decision-publisher.js` — both present
2. `grep -n "applyDecisionVeto" apps/worker/src/jobs/run_nhl_model.js` — called in gate block
3. `grep -n "INVARIANT_BREACH" apps/worker/src/jobs/settle_pending_cards.js` — guard present
4. `npm --prefix apps/worker test --no-coverage` — all pass
5. Manual check: create a card with action=FIRE + decision_v2.official_status=PLAY, call `applyDecisionVeto`, verify both fields become PASS
</verification>

<success_criteria>
- applyDecisionVeto() atomically updates both legacy fields and decision_v2.official_status
- Execution gate uses applyDecisionVeto — no more split veto state
- Settlement guard detects and logs any surviving contradictions
- 3 tests confirm the veto helper contract
- Zero regressions
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-04-SUMMARY.md`
</output>
