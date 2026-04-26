---
phase: pass-reason-integrity
plan: "03"
type: tdd
wave: 2
depends_on:
  - pass-reason-integrity-01
  - pass-reason-integrity-02
files_modified:
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/jobs/post_discord_cards.js
  - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
autonomous: true
requirements:
  - PRI-RUNNER-01
  - PRI-RUNNER-02
  - PRI-DISPLAY-01

must_haves:
  truths:
    - "full_game_ml card payload carries pass_reason_code from projectFullGameML, not re-derived from ev_threshold_passed"
    - "projection-floor synthetic fallback driver has no PASS_NO_EDGE in reason_codes"
    - "post_discord_cards decisionReason() returns null when no pass_reason_code is found, never invents PASS_NO_EDGE"
    - "run_mlb_model.js line 2979 synthetic-line driver PASS_NO_EDGE is documented as legal invariant"
  artifacts:
    - path: "apps/worker/src/jobs/run_mlb_model.js"
      provides: "Propagated pass_reason_code; scrubbed projection-floor reason_codes; invariant comment"
      contains: "mlResult.pass_reason_code"
    - path: "apps/worker/src/jobs/post_discord_cards.js"
      provides: "Honest decisionReason() — null fallback not PASS_NO_EDGE"
    - path: "apps/worker/src/jobs/__tests__/post_discord_cards.test.js"
      provides: "Test J — display layer default is null"
  key_links:
    - from: "computeMLBDriverCards full_game_ml card builder (~line 2214)"
      to: "mlResult.pass_reason_code"
      via: "direct propagation from projectFullGameML return value"
      pattern: "mlResult\\.pass_reason_code"
    - from: "decisionReason() in post_discord_cards.js"
      to: "payload.pass_reason_code"
      via: "direct read; fallback is null"
      pattern: "return null"
---

<objective>
Wire the fixes from Plans 01 and 02 into the two consumer layers: `run_mlb_model.js` (card builder propagation) and `post_discord_cards.js` (display layer cleanup). Fix the projection-floor driver which incorrectly carries `PASS_NO_EDGE` despite never evaluating an edge. Document the one legal `PASS_NO_EDGE` assignment in the synthetic-line driver.

Purpose: After Plans 01+02, the model layer emits correct reason codes. Plan 03 ensures those codes survive into card payloads and the display layer never fabricates them.

Output: Three targeted fixes across two files; green tests H/I/J.
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
<!-- Bug 3 — card builder re-derives from ev_threshold_passed instead of propagating (run_mlb_model.js ~line 2214) -->
```javascript
// CURRENT (wrong):
pass_reason_code: !mlResult.ev_threshold_passed ? 'PASS_NO_EDGE' : null,

// FIX: propagate from model (Plan 02 adds pass_reason_code to projectFullGameML return)
pass_reason_code: !mlResult.ev_threshold_passed
  ? (mlResult.pass_reason_code ?? 'PASS_NO_EDGE')
  : null,
```

<!-- Bug 4 — projection floor driver carries PASS_NO_EDGE (run_mlb_model.js line 3969) -->
```javascript
// CURRENT (wrong — inputs were never present, edge was never computed):
reason_codes: ['PASS_SYNTHETIC_FALLBACK', 'PASS_NO_EDGE'],
pass_reason_code: 'PASS_SYNTHETIC_FALLBACK',

// FIX: remove PASS_NO_EDGE — PASS_SYNTHETIC_FALLBACK is the only correct code
reason_codes: ['PASS_SYNTHETIC_FALLBACK'],
pass_reason_code: 'PASS_SYNTHETIC_FALLBACK',
```

<!-- Legal invariant that must NOT be changed — line 2979 in run_mlb_model.js -->
```javascript
// computeSyntheticLineF5Driver — PASS_NO_EDGE is LEGAL here:
// At this code path, status='PASS' only when edge was computed against the
// synthetic line and failed MLB_F5_SYNTHETIC_EDGE_THRESHOLD. Inputs were
// present; evaluation ran; edge was real but below threshold.
...(status === 'PASS' ? { pass_reason_code: 'PASS_NO_EDGE' } : {}),
// Add comment above this line. Do NOT change the value.
```

<!-- Bug 5 — display layer fabricates PASS_NO_EDGE (post_discord_cards.js line 777) -->
```javascript
// CURRENT (wrong):
function decisionReason(card) {
  const payload = card?.payloadData || {};
  const direct = payload?.pass_reason_code || payload?.pass_reason;
  if (direct) return normalizeToken(direct);
  const reasonCode = Array.isArray(payload?.reason_codes) ? payload.reason_codes[0] : null;
  if (reasonCode) return normalizeToken(reasonCode);
  if (payload?.blocked_reason_code) return normalizeToken(payload.blocked_reason_code);
  return 'PASS_NO_EDGE';  // ← fabricates reason when none found
}

// FIX:
  return null;  // callers already handle null
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: run_mlb_model.js — propagate pass_reason_code; scrub projection-floor; add invariant comment</name>
  <files>apps/worker/src/jobs/run_mlb_model.js</files>
  <behavior>
    - Line ~2214: change `!mlResult.ev_threshold_passed ? 'PASS_NO_EDGE' : null` to `!mlResult.ev_threshold_passed ? (mlResult.pass_reason_code ?? 'PASS_NO_EDGE') : null`
    - Line 3969: change `reason_codes: ['PASS_SYNTHETIC_FALLBACK', 'PASS_NO_EDGE']` to `reason_codes: ['PASS_SYNTHETIC_FALLBACK']`
    - Line 2979 (`computeSyntheticLineF5Driver`): add a comment above the PASS_NO_EDGE assignment explaining the legal invariant — do NOT change the value
    - Test H: mock `projectFullGameML` to return `{ ev_threshold_passed: false, pass_reason_code: 'PASS_CONFIDENCE_GATE', ... }` → the card built from `computeMLBDriverCards` must have `pass_reason_code: 'PASS_CONFIDENCE_GATE'`, not `'PASS_NO_EDGE'`
    - Test I: the projection-floor fallback driver object must have `reason_codes` array that does NOT contain `'PASS_NO_EDGE'`
  </behavior>
  <action>
    Three surgical edits only:

    1. Find the `pass_reason_code: !mlResult.ev_threshold_passed ? 'PASS_NO_EDGE' : null` line in `computeMLBDriverCards` (the full_game_ml card builder section, around line 2214). Replace the hardcoded `'PASS_NO_EDGE'` with `(mlResult.pass_reason_code ?? 'PASS_NO_EDGE')`.

    2. Find `reason_codes: ['PASS_SYNTHETIC_FALLBACK', 'PASS_NO_EDGE']` in the projection-floor driver builder (around line 3969). Remove `'PASS_NO_EDGE'` from the array. Do NOT change `pass_reason_code: 'PASS_SYNTHETIC_FALLBACK'` on the next line.

    3. Find the `...(status === 'PASS' ? { pass_reason_code: 'PASS_NO_EDGE' } : {})` line in `computeSyntheticLineF5Driver` (around line 2979). Add a single-line comment immediately above it:
    `// INVARIANT: PASS_NO_EDGE is legal here — edge was computed against synthetic line and failed MLB_F5_SYNTHETIC_EDGE_THRESHOLD. Inputs were present.`

    No other changes to this file.
  </action>
  <verify>
    <automated>npx jest --testPathPattern="run.mlb.model|mlb-model.market-calls|mlb-driver" --no-coverage 2>&1 | tail -15</automated>
  </verify>
  <done>pass_reason_code is propagated from mlResult; PASS_NO_EDGE absent from projection-floor reason_codes; invariant comment present at line ~2979; existing tests pass</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: post_discord_cards.js — remove fabricated PASS_NO_EDGE default; add test J</name>
  <files>apps/worker/src/jobs/post_discord_cards.js, apps/worker/src/jobs/__tests__/post_discord_cards.test.js</files>
  <behavior>
    - In `decisionReason(card)`: change the final `return 'PASS_NO_EDGE'` to `return null`
    - Callers of `decisionReason()` in the same file already handle `null` return (they use `||` chains or conditional rendering) — verify by grepping for `decisionReason(` usages before editing
    - Test J: call `decisionReason({ payloadData: {} })` (no pass_reason_code, no reason_codes, no blocked_reason_code) → must return `null`, not `'PASS_NO_EDGE'`
    - Test J2: call `decisionReason({ payloadData: { pass_reason_code: 'PASS_CONFIDENCE_GATE' } })` → returns `normalizeToken('PASS_CONFIDENCE_GATE')` (existing behavior preserved)
  </behavior>
  <action>
    Single-character edit in `post_discord_cards.js`: find `return 'PASS_NO_EDGE';` at the end of `decisionReason()` (line 777) and change to `return null;`.

    Before editing, run:
    ```
    grep -n "decisionReason(" apps/worker/src/jobs/post_discord_cards.js
    ```
    to confirm all callers tolerate null (they typically feed into template strings or conditional display — null coerces to empty string there).

    Add test J to the existing `post_discord_cards.test.js` describe block for `decisionReason` (or create one if missing).
  </action>
  <verify>
    <automated>npx jest --testPathPattern="post_discord_cards" --no-coverage 2>&1 | tail -15</automated>
  </verify>
  <done>decisionReason() returns null when no reason found; test J passes; existing post_discord_cards tests unbroken</done>
</task>

</tasks>

<verification>
```bash
npx jest --testPathPattern="post_discord_cards|run.mlb.model|mlb-driver" --no-coverage 2>&1 | grep -E "Tests:|PASS|FAIL"
grep -n "pass_reason_code.*PASS_NO_EDGE\|'PASS_NO_EDGE'" apps/worker/src/jobs/run_mlb_model.js | grep -v "INVARIANT\|2979"
```

The second command must return zero results (or only the documented invariant line).
</verification>

<success_criteria>
- `npx jest --testPathPattern="post_discord_cards"` passes
- `decisionReason()` never returns the string `'PASS_NO_EDGE'` as a fabricated default
- `reason_codes` for projection-floor driver contains only `['PASS_SYNTHETIC_FALLBACK']`
- Full-game ML card builder propagates `mlResult.pass_reason_code` rather than hardcoding `'PASS_NO_EDGE'`
- No new test failures across all three test files
</success_criteria>

<output>
After completion, create `.planning/phases/pass-reason-integrity/pass-reason-integrity-03-SUMMARY.md`
</output>
