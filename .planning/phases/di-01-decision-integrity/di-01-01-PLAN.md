---
phase: di-01-decision-integrity
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/lib/game-card/transform/index.ts
  - web/src/lib/play-decision/decision-logic.ts
  - web/src/lib/types/canonical-play.ts
  - web/src/__tests__/game-card-decision-authority.test.ts
autonomous: true

must_haves:
  truths:
    - "A card stored with decision_v2.official_status=PASS and edge=0.04 renders as PASS in UI transform — not FIRE"
    - "A card stored with decision_v2.official_status=LEAN renders as LEAN — web does not promote it to PLAY"
    - "A card missing decision_v2 renders using fallback logic tagged NON_CANONICAL_RENDER_FALLBACK"
    - "web/src/lib/types/canonical-play.ts THRESHOLDS block is marked @deprecated with a comment that backend is authoritative"
    - "No code path in the web transform calls derivePlayDecision() and feeds the result as the card's live action when decision_v2.official_status is present"
  artifacts:
    - path: "web/src/lib/game-card/transform/index.ts"
      provides: "guard at the derivePlayDecision() call site (line ~1929) that skips re-derivation when decision_v2.official_status is present"
      contains: "NON_CANONICAL_RENDER_FALLBACK"
    - path: "web/src/lib/play-decision/decision-logic.ts"
      provides: "derivePlayDecision() — unchanged logic but its callers are guarded"
    - path: "web/src/lib/types/canonical-play.ts"
      provides: "@deprecated comment on THRESHOLDS block"
    - path: "web/src/__tests__/game-card-decision-authority.test.ts"
      provides: "3 unit tests for the three cases: stored PASS, stored LEAN, missing decision_v2"
      min_lines: 60
  key_links:
    - from: "web/src/lib/game-card/transform/index.ts (line ~1929)"
      to: "payload.decision_v2.official_status"
      via: "guard: if present, use stored status; else call derivePlayDecision()"
      pattern: "decision_v2.*official_status"
    - from: "test file"
      to: "transform pipeline"
      via: "import transformGameCard or the relevant transform function"
      pattern: "NON_CANONICAL_RENDER_FALLBACK"
---

<objective>
Kill web-layer decision reclassification. The web transform must read decision_v2.official_status as authoritative and never re-derive classification from raw edge thresholds when a backend decision already exists.

Purpose: CF-001 from the hardening audit. A backend PASS card (edge 3-4%) was reachable as FIRE on the web because derivePlayDecision() uses THRESHOLDS.TOTAL.base_edge_threshold=0.02 while the backend enforces 5-6.2%. This is a direct user-facing lie.

Output:
- Guard in transform/index.ts blocking re-derivation when decision_v2 is present
- @deprecated marker on THRESHOLDS in canonical-play.ts
- 3-case test suite confirming the guard works
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@web/src/lib/game-card/transform/index.ts
@web/src/lib/play-decision/decision-logic.ts
@web/src/lib/types/canonical-play.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Guard derivePlayDecision() call site against decision_v2-present cards</name>
  <files>web/src/lib/game-card/transform/index.ts</files>
  <action>
Locate the call to `derivePlayDecision(playForDecision, marketContext, { sport })` at approximately line 1929.

Replace it with a guarded version:

```typescript
// Backend decision_v2 is authoritative. Only call derivePlayDecision() as a
// rendering fallback when no canonical backend decision exists.
const decision = (() => {
  const storedStatus = payload?.decision_v2?.official_status;
  if (storedStatus) {
    // Use backend canonical decision directly — do NOT recompute.
    const classificationMap: Record<string, string> = {
      PLAY: 'BASE',
      LEAN: 'LEAN',
      PASS: 'PASS',
    };
    const actionMap: Record<string, string> = {
      PLAY: 'FIRE',
      LEAN: 'HOLD',
      PASS: 'PASS',
    };
    return {
      official_status: storedStatus,
      classification: classificationMap[storedStatus] ?? 'PASS',
      action: actionMap[storedStatus] ?? 'PASS',
      reason_source: 'canonical',
    };
  }
  // No backend decision present — render-layer fallback only.
  const fallbackDecision = derivePlayDecision(playForDecision, marketContext, { sport });
  return {
    ...fallbackDecision,
    reason_source: 'NON_CANONICAL_RENDER_FALLBACK',
  };
})();
```

Make sure:
- The existing variable that was assigned the result of `derivePlayDecision()` is now assigned `decision` from the above block.
- The `classificationMap` / `actionMap` are typed correctly to prevent TS errors.
- No change to any other logic around this code block.
  </action>
  <verify>
    cd web && npx tsc --noEmit 2>&1 | head -20
    grep -n "NON_CANONICAL_RENDER_FALLBACK\|reason_source" web/src/lib/game-card/transform/index.ts | head -5
  </verify>
  <done>TypeScript compiles clean. Transform file contains `NON_CANONICAL_RENDER_FALLBACK` and `reason_source`. The guard checks `payload?.decision_v2?.official_status` before calling derivePlayDecision().</done>
</task>

<task type="auto">
  <name>Task 2: Deprecate THRESHOLDS in canonical-play.ts + add tests</name>
  <files>web/src/lib/types/canonical-play.ts, web/src/__tests__/game-card-decision-authority.test.ts</files>
  <action>
**In `web/src/lib/types/canonical-play.ts`:**

Above the `THRESHOLDS` constant definition, add this block comment:

```typescript
/**
 * @deprecated These web-side thresholds are NOT used for decision-making.
 * The backend model (decision-pipeline-v2.js) is the sole authority on
 * whether a card is PLAY/LEAN/PASS. Backend thresholds are 5-6.2% for PLAY.
 *
 * These values exist only for legacy fallback rendering when decision_v2
 * is absent from a stored card payload. Any new code must read
 * `payload.decision_v2.official_status` instead of computing from
 * these thresholds.
 *
 * See: docs/decisions/ADR-XXXX.md (decision authority contract)
 * See: web/src/lib/game-card/transform/index.ts NON_CANONICAL_RENDER_FALLBACK
 */
```

**Create `web/src/__tests__/game-card-decision-authority.test.ts`:**

Write a test file with exactly 3 `it()` blocks (use Jest/vitest — match whatever the web package already uses):

1. **Stored PASS with 4% edge must not become FIRE**:
   - Build a mock payload with `decision_v2: { official_status: 'PASS' }` and `model: { edge: 0.04 }`.
   - Run the payload through the relevant transform function (import from `web/src/lib/game-card/transform/index.ts`).
   - Assert the transformed card's `action` (or equivalent decision field) equals `'PASS'`, not `'FIRE'` or `'HOLD'`.

2. **Stored LEAN must not become PLAY/FIRE**:
   - Mock payload with `decision_v2: { official_status: 'LEAN' }` and `model: { edge: 0.07 }`.
   - Assert transformed card action is `'HOLD'`, classification is `'LEAN'`.

3. **Missing decision_v2 renders fallback with NON_CANONICAL_RENDER_FALLBACK tag**:
   - Mock payload with no `decision_v2` field, `model: { edge: 0.06, confidence: 0.72 }`.
   - Assert transformed card has `reason_source === 'NON_CANONICAL_RENDER_FALLBACK'`.

Import the transform function at the top. If the transform function cannot be easily unit-imported (it may have DB dependencies), mock those dependencies or test via the decision guard logic directly from decision-logic.ts + the guard wrapper. Use the simplest import path that exercises the actual guard you wrote in Task 1.

Run: `cd web && npm test -- --testPathPattern=game-card-decision-authority 2>&1 | tail -15`
  </action>
  <verify>
    grep -n "@deprecated" web/src/lib/types/canonical-play.ts | head -3
    cd web && npm test -- --testPathPattern=game-card-decision-authority 2>&1 | tail -10
  </verify>
  <done>@deprecated comment exists in canonical-play.ts above THRESHOLDS. All 3 tests pass. Test file has at least 60 lines.</done>
</task>

</tasks>

<verification>
1. `cd web && npx tsc --noEmit` — zero TypeScript errors
2. `cd web && npm test -- --testPathPattern=game-card-decision-authority` — 3 passing tests
3. `grep -n "NON_CANONICAL_RENDER_FALLBACK" web/src/lib/game-card/transform/index.ts` — present
4. Manual: Load a card payload from DB with `decision_v2.official_status=PASS` through the transform and confirm the output action is PASS.
</verification>

<success_criteria>
- `decision_v2.official_status` presence short-circuits `derivePlayDecision()` in the web transform
- Cards with stored PASS remain PASS; LEAN remains LEAN; PLAY remains PLAY in UI
- THRESHOLDS block in canonical-play.ts is marked deprecated with authoritative comment
- 3 test cases pass covering all three guard scenarios
- TypeScript compiles clean
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-01-SUMMARY.md`
</output>
