---
phase: di-01-decision-integrity
plan: "03"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/utils/decision-publisher.js
  - apps/worker/src/utils/__tests__/decision-publisher.tier-vocab.test.js
  - web/src/lib/game-card/transform/index.ts
  - web/src/lib/types/game-card.ts
autonomous: true

must_haves:
  truths:
    - "deriveAction({ tier: 'GOOD' }) returns 'HOLD' — not 'PASS'"
    - "deriveAction({ tier: 'OK' }) returns 'PASS' — explicit, not fallthrough"
    - "deriveAction({ tier: 'BAD' }) returns 'PASS' — explicit, not fallthrough"
    - "deriveAction({ tier: 'SUPER' }) still returns 'FIRE' — unchanged"
    - "deriveAction({ tier: 'BEST' }) still returns 'HOLD' — unchanged"
    - "deriveAction({ tier: 'WATCH' }) still returns 'HOLD' — unchanged"
    - "TIER_SCORE in web transform includes numeric weights for GOOD, OK, BAD"
    - "A new test file covers all 6 tier values with explicit assertions"
  artifacts:
    - path: "apps/worker/src/utils/decision-publisher.js"
      provides: "deriveAction() with GOOD/OK/BAD mapped explicitly"
      contains: "case 'GOOD'"
    - path: "apps/worker/src/utils/__tests__/decision-publisher.tier-vocab.test.js"
      provides: "6-case test for all tier values"
      min_lines: 40
    - path: "web/src/lib/game-card/transform/index.ts"
      provides: "TIER_SCORE object with GOOD/OK/BAD entries"
      contains: "GOOD"
  key_links:
    - from: "deriveAction()"
      to: "canonical action string (FIRE/HOLD/PASS)"
      via: "switch/if on tier value — no fallthrough gap"
      pattern: "case.*GOOD|GOOD.*HOLD"
---

<objective>
Unify tier vocabulary so both decision-pipeline-v2 tier strings (BEST/GOOD/OK/BAD) and the legacy cross-market tier strings (SUPER/BEST/WATCH/null) produce deterministic action mappings with zero silent fallthrough.

Purpose: CF-005 from the hardening audit. Cards with play_tier=GOOD silently became PASS because deriveAction() only knew about SUPER/BEST/WATCH. A GOOD-tier card above threshold was suppressed without a log entry.

Output:
- deriveAction() covers all 6 tier values explicitly
- TIER_SCORE in web transform extended with GOOD/OK/BAD weights
- 6-case unit test
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@apps/worker/src/utils/decision-publisher.js
@apps/worker/src/models/index.js
@web/src/lib/game-card/transform/index.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extend deriveAction() to cover GOOD/OK/BAD tier strings</name>
  <files>apps/worker/src/utils/decision-publisher.js</files>
  <action>
Find the `deriveAction({ tier })` function (approximately line 29-36). The current implementation maps:
```
SUPER → FIRE
BEST → HOLD
WATCH → HOLD
else → PASS (silent fallthrough)
```

Extend it to explicitly cover the decision-pipeline-v2 vocabulary:
```javascript
function deriveAction({ tier } = {}) {
  const t = tier ?? null;
  if (t === 'SUPER') return 'FIRE';
  if (t === 'BEST') return 'HOLD';
  if (t === 'GOOD') return 'HOLD';  // decision-pipeline-v2 vocabulary: above threshold, non-elite
  if (t === 'WATCH') return 'HOLD';
  if (t === 'OK') return 'PASS';    // below threshold but not errored
  if (t === 'BAD') return 'PASS';   // clearly below threshold
  // null / unknown → explicit PASS, not silent fallthrough
  return 'PASS';
}
```

Do NOT change any other part of the function body. Do NOT change callers. This is a pure extension of the mapping table.

After the change: `deriveAction({ tier: 'GOOD' })` must return `'HOLD'`.
  </action>
  <verify>
    node -e "const {deriveAction} = require('./apps/worker/src/utils/decision-publisher.js'); console.log(JSON.stringify({SUPER:deriveAction({tier:'SUPER'}),BEST:deriveAction({tier:'BEST'}),GOOD:deriveAction({tier:'GOOD'}),WATCH:deriveAction({tier:'WATCH'}),OK:deriveAction({tier:'OK'}),BAD:deriveAction({tier:'BAD'}),null_:deriveAction({})}))"
  </verify>
  <done>All 6 tier values plus null produce expected mappings: SUPER→FIRE, BEST→HOLD, GOOD→HOLD, WATCH→HOLD, OK→PASS, BAD→PASS, null→PASS.</done>
</task>

<task type="auto">
  <name>Task 2: Extend TIER_SCORE in web transform + write tier vocabulary test</name>
  <files>web/src/lib/types/game-card.ts, web/src/lib/game-card/transform/index.ts, apps/worker/src/utils/__tests__/decision-publisher.tier-vocab.test.js</files>
  <action>
**Step 1 — Expand `DriverTier` in `web/src/lib/types/game-card.ts` (REQUIRED FIRST):**

Find approximately line 33: `export type DriverTier = 'BEST' | 'SUPER' | 'WATCH';`

Replace with:
```typescript
export type DriverTier = 'BEST' | 'SUPER' | 'WATCH' | 'GOOD' | 'OK' | 'BAD';
```

This MUST be done before touching `TIER_SCORE`. The constant is typed
`Record<DriverTier, number>` — adding keys not in the union is a TypeScript
compile error until the union is expanded first.

**Step 2 — Extend `TIER_SCORE` in `web/src/lib/game-card/transform/index.ts`:**

Find the `TIER_SCORE` constant (approximately line 88-95). It has entries for `BEST`, `SUPER`, `WATCH`. Add the three new keys:

```typescript
const TIER_SCORE: Record<DriverTier, number> = {
  SUPER: 0.72,
  BEST: 1.0,
  GOOD: 0.60,   // ADD: decision-pipeline-v2 vocabulary
  WATCH: 0.52,
  OK: 0.30,     // ADD: below threshold
  BAD: 0.10,    // ADD: clearly below threshold
};
```

Do NOT change the existing values for SUPER/BEST/WATCH. Only add the three new entries.
Run `cd web && npx tsc --noEmit` after both changes to confirm zero errors before writing the test.

**Create `apps/worker/src/utils/__tests__/decision-publisher.tier-vocab.test.js`:**

Write a Jest test file that tests `deriveAction()` for all 6 tier values:

```javascript
const { deriveAction } = require('../../utils/decision-publisher');

describe('deriveAction() — tier vocabulary coverage', () => {
  // Legacy cross-market vocabulary
  test('SUPER → FIRE', () => expect(deriveAction({ tier: 'SUPER' })).toBe('FIRE'));
  test('BEST → HOLD', () => expect(deriveAction({ tier: 'BEST' })).toBe('HOLD'));
  test('WATCH → HOLD', () => expect(deriveAction({ tier: 'WATCH' })).toBe('HOLD'));

  // decision-pipeline-v2 vocabulary (CF-005 fix)
  test('GOOD → HOLD (not PASS)', () => expect(deriveAction({ tier: 'GOOD' })).toBe('HOLD'));
  test('OK → PASS', () => expect(deriveAction({ tier: 'OK' })).toBe('PASS'));
  test('BAD → PASS', () => expect(deriveAction({ tier: 'BAD' })).toBe('PASS'));

  // Null/undefined — explicitly PASS, not silent undefined
  test('null tier → PASS', () => expect(deriveAction({ tier: null })).toBe('PASS'));
  test('undefined tier → PASS', () => expect(deriveAction({})).toBe('PASS'));
  test('unknown string → PASS', () => expect(deriveAction({ tier: 'UNKNOWN_XYZ' })).toBe('PASS'));
});
```

Run: `npm --prefix apps/worker test -- --testPathPattern=decision-publisher.tier-vocab 2>&1 | tail -10`
  </action>
  <verify>
    grep -n "GOOD\|OK.*0\.\|BAD.*0\." web/src/lib/game-card/transform/index.ts | head -5
    npm --prefix apps/worker test -- --testPathPattern=tier-vocab 2>&1 | tail -10
  </verify>
  <done>TIER_SCORE in transform contains GOOD, OK, BAD keys. 9 tests in new test file all pass. TypeScript compiles clean.</done>
</task>

</tasks>

<verification>
1. `node -e "const {deriveAction}=require('./apps/worker/src/utils/decision-publisher.js'); console.log(deriveAction({tier:'GOOD'}))"` → `HOLD`
2. `npm --prefix apps/worker test -- --testPathPattern=tier-vocab` → all pass
3. `grep "GOOD" web/src/lib/game-card/transform/index.ts` → TIER_SCORE entry present
4. `npm --prefix apps/worker test --no-coverage` → all existing tests pass
5. `cd web && npx tsc --noEmit` → zero errors
</verification>

<success_criteria>
- deriveAction() returns HOLD for GOOD, PASS for OK, PASS for BAD — no fallthrough to default for any of the 6 canonical tier values
- TIER_SCORE in web transform covers the decision-pipeline-v2 tier vocabulary
- 9 cases tested and passing
- Zero regressions in existing worker and web tests
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-03-SUMMARY.md`
</output>
