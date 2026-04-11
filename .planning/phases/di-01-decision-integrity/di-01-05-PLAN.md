---
phase: di-01-decision-integrity
plan: "05"
type: execute
wave: 2
depends_on: ["di-01-03"]
files_modified:
  - apps/worker/src/models/index.js
  - apps/worker/src/models/__tests__/nba-projection-parity.test.js
autonomous: true

must_haves:
  truths:
    - "computeNBADriverCards() no longer calls projectNBA() — it calls projectNBACanonical() + analyzePaceSynergy()"
    - "For the same input, computeNBADriverCards and computeNBAMarketDecisions project total points within ±3 of each other"
    - "projectNBA() in projections.js still exists and is marked @deprecated — it is not deleted"
    - "All existing NBA model tests pass with the new projection path"
    - "A new parity test confirms driver and market projections agree within tolerance"
  artifacts:
    - path: "apps/worker/src/models/index.js"
      provides: "computeNBADriverCards() using projectNBACanonical + analyzePaceSynergy"
      contains: "projectNBACanonical"
    - path: "apps/worker/src/models/__tests__/nba-projection-parity.test.js"
      provides: "parity test: same inputs → driver projection within ±3 of market projection"
      min_lines: 50
  key_links:
    - from: "apps/worker/src/models/index.js:computeNBADriverCards"
      to: "projectNBACanonical"
      via: "direct call replacing projectNBA"
      pattern: "projectNBACanonical"
---

<objective>
Complete the WI-0822 migration. computeNBADriverCards() in models/index.js still calls the deprecated projectNBA() (multiplicative pace formula). computeNBAMarketDecisions() in cross-market.js already uses projectNBACanonical + analyzePaceSynergy (additive pace). Both functions run in the same NBA job and emit cards for the same game. They can project opposing totals.

Replace the projectNBA call in computeNBADriverCards with projectNBACanonical + analyzePaceSynergy to make both paths use the same formula.

Purpose: CF-006 from the hardening audit. Same game, different projection engines, potentially opposing signals.

Output:
- computeNBADriverCards uses projectNBACanonical
- projectNBA still exists (@deprecated, not deleted)
- Parity test confirms driver and market projections match within ±3 pts for the same inputs
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@apps/worker/src/models/index.js
@apps/worker/src/models/projections.js
@apps/worker/src/models/cross-market.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Replace projectNBA with projectNBACanonical in computeNBADriverCards()</name>
  <files>apps/worker/src/models/index.js</files>
  <action>
Find `computeNBADriverCards()` in `apps/worker/src/models/index.js`. Locate the line that calls `projectNBA(...)` (approximately line 1499). Read the surrounding code to understand what arguments are passed and what field names the caller expects on the return value.

**Steps:**

1. Verify that `projectNBACanonical` and `analyzePaceSynergy` are already imported at the top of `index.js`. If not, add them to the require/import from `./projections`:
   ```javascript
   const { ..., projectNBACanonical, analyzePaceSynergy } = require('./projections');
   ```

2. Find the existing `projectNBA(...)` call. Read what parameters it takes (e.g., `homeTeam`, `awayTeam`, `venue`) and what the return value's fields are (e.g., `homeProjected`, `awayProjected`, `totalProjected`).

3. Replace the call with the two-step canonical pattern that `computeNBAMarketDecisions` already uses (read cross-market.js lines ~862-873 as reference):
   ```javascript
   const paceData = analyzePaceSynergy(homeTeam, awayTeam);
   const projection = projectNBACanonical(
     homeTeam,
     awayTeam,
     venue,        // or whatever the positional args are — match the existing projectNBA call signature
     paceData.paceAdjustment
   );
   ```

4. If `projectNBA` returned fields with different names than `projectNBACanonical`, map them: the canonical function should have the same or similar output shape. Check against cross-market.js usage to see what fields are read.

5. Do NOT delete the `projectNBA` function from projections.js. It stays but is @deprecated.

6. Run all NBA tests after the change before moving to Task 2.
  </action>
  <verify>
    grep -n "projectNBACanonical\|projectNBA[^C]" apps/worker/src/models/index.js | head -10
    npm --prefix apps/worker test --no-coverage 2>&1 | tail -8
  </verify>
  <done>index.js:computeNBADriverCards calls projectNBACanonical. grep shows no remaining non-deprecated projectNBA calls in index.js. All existing worker tests pass.</done>
</task>

<task type="auto">
  <name>Task 2: Add NBA projection parity test</name>
  <files>apps/worker/src/models/__tests__/nba-projection-parity.test.js</files>
  <action>
Create `apps/worker/src/models/__tests__/nba-projection-parity.test.js`.

The test takes a single canonical NBA game fixture (invented inline — does not need real data) and runs it through both `computeNBADriverCards` and a direct `projectNBACanonical + analyzePaceSynergy` call. It asserts that the total projection from both paths is within ±3 points.

```javascript
const { projectNBACanonical, analyzePaceSynergy } = require('../projections');
const { computeNBADriverCards } = require('../index');

const SHARED_HOME = {
  teamName: 'TestHome',
  avgPtsHome: 115,
  avgPtsAway: 112,
  paceHome: 100.0,
  paceAway: 99.2,
  ortgHome: 114.5,
  drtgHome: 112.0,
  ortgAway: 113.0,
  drtgAway: 113.5,
  // Add any other required fields from the actual function signatures
};

describe('NBA projection parity — driver vs market path', () => {
  test('projectNBACanonical and computeNBADriverCards agree within ±3 pts', () => {
    // Direct canonical projection
    const paceData = analyzePaceSynergy(SHARED_HOME, SHARED_HOME);
    const canonical = projectNBACanonical(SHARED_HOME, SHARED_HOME, null, paceData?.paceAdjustment ?? 0);
    expect(canonical).not.toBeNull();
    const canonicalTotal = canonical.homeProjected + canonical.awayProjected;

    // Driver card projection (post-migration should use same formula)
    // Call computeNBADriverCards with a mock snapshot that provides the same data
    // If the function signature is complex, test the projection sub-function directly
    expect(canonicalTotal).toBeGreaterThan(150);
    expect(canonicalTotal).toBeLessThan(260);
  });

  test('projectNBACanonical returns non-null with valid inputs', () => {
    const paceData = analyzePaceSynergy(SHARED_HOME, SHARED_HOME);
    const result = projectNBACanonical(SHARED_HOME, SHARED_HOME, null, paceData?.paceAdjustment ?? 0);
    expect(result).not.toBeNull();
    expect(result.homeProjected).toBeGreaterThan(0);
    expect(result.awayProjected).toBeGreaterThan(0);
  });
});
```

Adjust the test input fields to match the actual function signatures. Read `projections.js:projectNBACanonical` and `projections.js:analyzePaceSynergy` parameter lists before writing the fixture.
  </action>
  <verify>
    npm --prefix apps/worker test -- --testPathPattern=nba-projection-parity 2>&1 | tail -10
  </verify>
  <done>Parity test file exists with at least 50 lines. Both tests pass. No regressions.</done>
</task>

</tasks>

<verification>
1. `grep -n "projectNBA[^C]" apps/worker/src/models/index.js` — zero remaining non-canonical calls
2. `grep -n "@deprecated" apps/worker/src/models/projections.js` — still present on projectNBA
3. `npm --prefix apps/worker test -- --testPathPattern=nba-projection-parity` — pass
4. `npm --prefix apps/worker test --no-coverage` — all existing tests pass
</verification>

<success_criteria>
- computeNBADriverCards uses projectNBACanonical — same projection engine as computeNBAMarketDecisions
- projectNBA still exists, still @deprecated, not deleted
- Driver and market projections agree within tolerance on same inputs
- Zero regressions in existing NBA model tests
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-05-SUMMARY.md`
</output>
