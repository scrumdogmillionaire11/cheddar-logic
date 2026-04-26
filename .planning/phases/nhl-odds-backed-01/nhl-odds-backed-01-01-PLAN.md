---
phase: nhl-odds-backed-01
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js
autonomous: true
requirements: [NHR-TOTALS-01, NHR-TOTALS-02]

must_haves:
  truths:
    - "nhl-totals-call cards from games with unconfirmed goalies have execution_status = 'EXECUTABLE' (not PROJECTION_ONLY) after worker post-processing"
    - "Totals cards with unconfirmed goalies are downgraded to LEAN classification but are NOT dropped by gamelines"
    - "nhl-totals-call is no longer a member of NHL_SNAPSHOT_CARD_TYPES"
    - "applyCanonicalNhlTotalsStatus passes 'EXECUTABLE' to syncCanonicalDecisionEnvelope when official_status != 'PASS'"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "Fixed goalie guard + fixed applyCanonicalNhlTotalsStatus execution_status pass-through"
      contains: "NHL_SNAPSHOT_CARD_TYPES"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js"
      provides: "Regression test for totals execution_status with unconfirmed goalie"
  key_links:
    - from: "NHL_SNAPSHOT_CARD_TYPES"
      to: "applyNhlGoalieExecutionStatusGuard"
      via: "isNhlSnapshotCard()"
      pattern: "NHL_SNAPSHOT_CARD_TYPES\\.has"
    - from: "applyCanonicalNhlTotalsStatus"
      to: "syncCanonicalDecisionEnvelope"
      via: "execution_status: payload.execution_status || 'EXECUTABLE'"
      pattern: "payload\\.execution_status.*EXECUTABLE"
---

<objective>
Fix the primary known blocker for nhl-totals-call cards: the goalie execution guard stamps `execution_status = 'PROJECTION_ONLY'` on totals market-call cards when a goalie is unconfirmed, then `applyCanonicalNhlTotalsStatus` incorrectly preserves that PROJECTION_ONLY stamp instead of overwriting it with EXECUTABLE.

Purpose: nhl-totals-call cards from games with unconfirmed goalies are silently dropped by the gamelines API because they carry PROJECTION_ONLY execution_status even though they have live odds and a valid LEAN/SLIGHT EDGE totals status. These cards should surface as LEAN plays.

Output:
- `nhl-totals-call` removed from `NHL_SNAPSHOT_CARD_TYPES` (the goalie guard is redundant for market-call cards; goalie uncertainty is already handled by `applyCanonicalNhlTotalsStatus` → `classifyNhlTotalsStatus` via `CAP_GOALIES_UNCONFIRMED`)
- `applyCanonicalNhlTotalsStatus` updated to always pass `'EXECUTABLE'` (not `payload.execution_status`) when `mapped.officialStatus !== 'PASS'`
- Tests verifying a totals card with unconfirmed goalie → LEAN/EXECUTABLE
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/ime-01-independent-market-eval/ime-01-04-SUMMARY.md
</context>

<interfaces>
<!-- Key code contracts the executor needs. No codebase exploration required. -->

From apps/worker/src/jobs/run_nhl_model.js:

```js
// Line 291 — BUG TARGET #1: Remove 'nhl-totals-call' from this set
const NHL_SNAPSHOT_CARD_TYPES = new Set([
  'nhl-pace-totals',
  'nhl-pace-1p',
  'nhl-totals-call',   // ← REMOVE THIS ENTRY
]);

// Line 902
function isNhlSnapshotCard(card) {
  return NHL_SNAPSHOT_CARD_TYPES.has(card?.cardType);
}

// Line 1106 — Only fires when isNhlSnapshotCard returns true
function applyNhlGoalieExecutionStatusGuard(card, paceResult) {
  if (!isNhlSnapshotCard(card) || !card?.payloadData || !paceResult) return;
  if (!hasUnknownGoalie(paceResult)) return;
  card.payloadData.execution_status = 'PROJECTION_ONLY';
}

// Line 1037 — BUG TARGET #2: execution_status pass-through in syncCanonicalDecisionEnvelope call
function applyCanonicalNhlTotalsStatus(card, context = {}) {
  if (String(card?.cardType || '').toLowerCase() !== 'nhl-totals-call') {
    return null;
  }
  // ... classifyNhlTotalsStatus → mapped ...
  // mapped.officialStatus = 'PLAY' | 'LEAN' | 'PASS'
  syncCanonicalDecisionEnvelope(payload, {
    official_status: mapped.officialStatus,
    primary_reason_code: ...,
    execution_status:
      mapped.officialStatus === 'PASS' ? 'BLOCKED' : payload.execution_status || 'EXECUTABLE',
    //                                                ^^^^^^^^^^^^^^^^^^^^^^^^
    //                                                BUG: preserves 'PROJECTION_ONLY' from goalie guard
    //                                                FIX: replace with just 'EXECUTABLE'
    publish_ready: mapped.officialStatus !== 'PASS',
  });
  return result;
}
```

After the fix, the call at the end of `applyCanonicalNhlTotalsStatus` must be:
```js
syncCanonicalDecisionEnvelope(payload, {
  official_status: mapped.officialStatus,
  primary_reason_code: result.reasonCodes[0] || payload.decision_v2?.primary_reason_code || null,
  execution_status: mapped.officialStatus === 'PASS' ? 'BLOCKED' : 'EXECUTABLE',
  publish_ready: mapped.officialStatus !== 'PASS',
});
```
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Remove nhl-totals-call from NHL_SNAPSHOT_CARD_TYPES and fix applyCanonicalNhlTotalsStatus</name>
  <files>apps/worker/src/jobs/run_nhl_model.js</files>
  <behavior>
    - Test 1: A pure-pace card (nhl-pace-totals) with unknown goalie → applyNhlGoalieExecutionStatusGuard stamps PROJECTION_ONLY (guard still fires for pace cards)
    - Test 2: A nhl-totals-call card with unknown goalie + live odds → applyNhlGoalieExecutionStatusGuard does NOT fire (nhl-totals-call no longer in NHL_SNAPSHOT_CARD_TYPES)
    - Test 3: A nhl-totals-call card that went through the full post-processing chain (including withoutOddsMode=false, goalie UNKNOWN) → execution_status = 'EXECUTABLE', classification = 'LEAN'
    - Test 4: A nhl-totals-call card where classifyNhlTotalsStatus returns 'PASS' → execution_status = 'BLOCKED' (not PROJECTION_ONLY)
  </behavior>
  <action>
    Make exactly two edits to `apps/worker/src/jobs/run_nhl_model.js`:

    **Edit 1** — In `NHL_SNAPSHOT_CARD_TYPES` (line ~291), remove `'nhl-totals-call'` from the Set:
    ```js
    // BEFORE:
    const NHL_SNAPSHOT_CARD_TYPES = new Set([
      'nhl-pace-totals',
      'nhl-pace-1p',
      'nhl-totals-call',
    ]);

    // AFTER:
    const NHL_SNAPSHOT_CARD_TYPES = new Set([
      'nhl-pace-totals',
      'nhl-pace-1p',
    ]);
    ```
    Rationale: `applyCanonicalNhlTotalsStatus` already handles goalie-based degradation (via `classifyNhlTotalsStatus` + `CAP_GOALIES_UNCONFIRMED` reason code). The goalie guard stamping PROJECTION_ONLY on totals-call is redundant and contradicts the canonical totals status function.

    **Edit 2** — In `applyCanonicalNhlTotalsStatus` (line ~1094), change the `syncCanonicalDecisionEnvelope` call to stop preserving PROJECTION_ONLY:
    ```js
    // BEFORE:
    syncCanonicalDecisionEnvelope(payload, {
      official_status: mapped.officialStatus,
      primary_reason_code:
        result.reasonCodes[0] || payload.decision_v2?.primary_reason_code || null,
      execution_status:
        mapped.officialStatus === 'PASS' ? 'BLOCKED' : payload.execution_status || 'EXECUTABLE',
      publish_ready: mapped.officialStatus !== 'PASS',
    });

    // AFTER:
    syncCanonicalDecisionEnvelope(payload, {
      official_status: mapped.officialStatus,
      primary_reason_code:
        result.reasonCodes[0] || payload.decision_v2?.primary_reason_code || null,
      execution_status: mapped.officialStatus === 'PASS' ? 'BLOCKED' : 'EXECUTABLE',
      publish_ready: mapped.officialStatus !== 'PASS',
    });
    ```
    Rationale: When `mapped.officialStatus` is PLAY or LEAN, the card IS executable (live odds are present). The downstream gamelines filter `isProjectionOnlyPlayPayload` would drop PROJECTION_ONLY but not BLOCKED/EXECUTABLE. The goalie uncertainty is already reflected in `official_status = 'LEAN'` and reason codes — no need to also stamp PROJECTION_ONLY.

    Do NOT change any other code. Do not touch `applyNhlGoalieExecutionStatusGuard` logic itself.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.market-calls.test.js 2>&1 | tail -20</automated>
  </verify>
  <done>
    All existing market-calls tests pass. `NHL_SNAPSHOT_CARD_TYPES` has 2 elements (pace-totals, pace-1p). `applyCanonicalNhlTotalsStatus` no longer passes `payload.execution_status` to `syncCanonicalDecisionEnvelope`; it passes `'EXECUTABLE'` when not PASS.
  </done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Add regression test — totals card with unconfirmed goalie surfaces as LEAN/EXECUTABLE</name>
  <files>apps/worker/src/jobs/__tests__/run_nhl_model.market-calls.test.js</files>
  <behavior>
    - Test: After running full market-call post-processing chain on a totals card with `homeGoalieState.starter_state = 'PROJECTED'` (not CONFIRMED), the resulting card has `execution_status = 'EXECUTABLE'` and `payloadData.classification = 'LEAN'`
    - Test: The same card does NOT have `execution_status = 'PROJECTION_ONLY'`
    - Test: nhl-pace-totals card with unknown goalie still gets PROJECTION_ONLY from `applyNhlGoalieExecutionStatusGuard` (guard still applies to pace cards)
  </behavior>
  <action>
    Add a new `describe` block in `run_nhl_model.market-calls.test.js` after the existing tests:

    ```js
    describe('nhl-totals-call goalie uncertainty — execution_status not contaminated (NHR-TOTALS-01)', () => {
      test('totals-call card with unconfirmed home goalie exits post-processing as LEAN/EXECUTABLE', () => {
        const oddsSnapshot = buildBaseOddsSnapshot();
        const marketDecisions = buildBaseDecisions();
        const cards = generateNHLMarketCallCards(
          'nhl-goalie-test',
          marketDecisions,
          oddsSnapshot,
          { withoutOddsMode: false },
        );
        const totalsCard = cards.find((c) => c.cardType === 'nhl-totals-call');
        expect(totalsCard).toBeDefined();

        // Simulate applyNhlGoalieExecutionStatusGuard — should NOT stamp totals-call
        const mockPaceResult = { homeGoalieCertainty: 'UNKNOWN', awayGoalieCertainty: 'EXPECTED' };
        applyNhlGoalieExecutionStatusGuard(totalsCard, mockPaceResult);
        expect(totalsCard.payloadData.execution_status).not.toBe('PROJECTION_ONLY');

        // Simulate applyCanonicalNhlTotalsStatus normally
        applyCanonicalNhlTotalsStatus(totalsCard, {
          homeGoalieState: { starter_state: 'PROJECTED' },
          awayGoalieState: { starter_state: 'CONFIRMED' },
          uncertaintyHoldReasonCodes: [],
        });

        expect(totalsCard.payloadData.execution_status).toBe('EXECUTABLE');
        expect(['LEAN', 'BASE']).toContain(totalsCard.payloadData.classification);
      });

      test('pace-totals card with unknown goalie still gets PROJECTION_ONLY from goalie guard', () => {
        // Guard still applies to pace/snapshot cards
        const paceCard = {
          cardType: 'nhl-pace-totals',
          payloadData: { execution_status: 'EXECUTABLE' },
        };
        const mockPaceResult = { homeGoalieCertainty: 'UNKNOWN', awayGoalieCertainty: 'CONFIRMED' };
        applyNhlGoalieExecutionStatusGuard(paceCard, mockPaceResult);
        expect(paceCard.payloadData.execution_status).toBe('PROJECTION_ONLY');
      });
    });
    ```

    Imports needed: check existing test file imports for `applyNhlGoalieExecutionStatusGuard`, `applyCanonicalNhlTotalsStatus` — they may already be destructured from the module under test. If not, add them to the existing destructure block at the top of the test file.
  </action>
  <verify>
    <automated>npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.market-calls.test.js 2>&1 | tail -25</automated>
  </verify>
  <done>
    New describe block passes. A totals card with unconfirmed goalie exits with execution_status = 'EXECUTABLE'. Pace-totals goalie guard still fires. All pre-existing tests continue to pass.
  </done>
</task>

</tasks>

<verification>
```bash
npm --prefix apps/worker run test -- --runInBand src/jobs/__tests__/run_nhl_model.market-calls.test.js
```

Expected: All tests pass including the two new cases.

Manual check: grep for the old pattern to confirm the fix:
```bash
grep -n "payload\.execution_status.*EXECUTABLE" apps/worker/src/jobs/run_nhl_model.js
```
Should return no matches (the pattern was the bug).

```bash
grep -n "NHL_SNAPSHOT_CARD_TYPES" apps/worker/src/jobs/run_nhl_model.js | head -5
```
Should show 2-element Set (pace-totals, pace-1p only).
</verification>

<success_criteria>
1. `NHL_SNAPSHOT_CARD_TYPES` no longer contains `'nhl-totals-call'`
2. `applyCanonicalNhlTotalsStatus` passes `'EXECUTABLE'` (not `payload.execution_status`) when `official_status !== 'PASS'`
3. Tests pass: totals card + unconfirmed goalie → LEAN/EXECUTABLE
4. Tests still pass: pace-totals + unknown goalie → PROJECTION_ONLY
5. No other tests regress
</success_criteria>

<output>
After completion, create `.planning/phases/nhl-odds-backed-01/nhl-odds-backed-01-01-SUMMARY.md`
</output>
