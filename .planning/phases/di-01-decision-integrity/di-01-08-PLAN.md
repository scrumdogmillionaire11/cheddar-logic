---
phase: di-01-decision-integrity
plan: "08"
type: execute
wave: 3
depends_on: ["di-01-04"]
files_modified:
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/jobs/run_nba_model.js
  - apps/worker/src/jobs/__tests__/run_nhl_model.playoff-sigma.test.js
autonomous: true

must_haves:
  truths:
    - "applyPlayoffSigmaMultiplier returns an object with sigma_source explicitly copied from the input"
    - "applyPlayoffSigmaMultiplier returns an object with margin multiplied (not lost) when the input has a margin field"
    - "applyPlayoffSigmaMultiplier returns an object with NO NaN fields — any missing source field multiplied as NaN is replaced with null"
    - "applyPlayoffSigmaMultiplier sets adjusted_for_playoffs: true on the output"
    - "A test file covers all 4 truths"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_model.js"
      provides: "applyPlayoffSigmaMultiplier with explicit field construction"
      contains: "adjusted_for_playoffs"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_model.playoff-sigma.test.js"
      provides: "4 tests covering sigma contract"
      min_lines: 55
  key_links:
    - from: "applyPlayoffSigmaMultiplier"
      to: "sigma_source field"
      via: "explicit: sigma_source: sigma.sigma_source"
      pattern: "sigma_source.*sigma\\.sigma_source|sigma\\.sigma_source"
---

<objective>
Make the playoff sigma multiplier's output shape explicit and tested. The current implementation spreads the sigma object and overwrites `spread` and `total` — but the `margin` field (the real NHL sigma field name) is never multiplied. And `sigma_source` survives only because of the spread, making it fragile to any future refactor.

Lock down the output contract: explicit field list, no NaN, adjusted_for_playoffs flag, sigma_source always preserved.

Purpose: CF-008 from the hardening audit. The WI-0814 safety gate reads sigma_source; if it's ever lost, all playoff PLAYs either get incorrectly demoted or incorrectly pass the gate. Neither is detectable without this test.

Output:
- applyPlayoffSigmaMultiplier with explicit field construction (no implicit spread gaps)
- adjusted_for_playoffs: true on output
- NaN guard on any field that was null/undefined in the source
- 4 tests
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@.planning/codebase/HARDENING_AUDIT.md
@apps/worker/src/jobs/run_nhl_model.js
@apps/worker/src/jobs/run_nba_model.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix applyPlayoffSigmaMultiplier in NHL and NBA runners</name>
  <files>apps/worker/src/jobs/run_nhl_model.js, apps/worker/src/jobs/run_nba_model.js</files>
  <action>
Find `applyPlayoffSigmaMultiplier` in `run_nhl_model.js` (~lines 285-315). The current pattern is:

```javascript
function applyPlayoffSigmaMultiplier(sigma, multiplier) {
  return { ...sigma, spread: sigma.spread * multiplier, total: sigma.total * multiplier };
}
```

The problem:
- `sigma.spread` does not exist on NHL sigma objects (the field is `margin`); `sigma.spread * multiplier = NaN → undefined`
- `margin` is never multiplied
- `sigma_source` survives only accidentally via the spread
- No `adjusted_for_playoffs` flag

Replace with explicit construction:

```javascript
function applyPlayoffSigmaMultiplier(sigma, multiplier) {
  if (!sigma || !multiplier) return sigma;
  const safe = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v * multiplier : v ?? null);
  return {
    // All source fields explicitly copied
    sigma_source: sigma.sigma_source,          // explicit — never lost
    games_sampled: sigma.games_sampled ?? null,
    // Sigma fields — multiply if present, preserve null if not
    margin: safe(sigma.margin),                // NHL spread sigma (correct field name)
    total: safe(sigma.total),
    spread: safe(sigma.spread),                // May be null on NHL sigma; safe() handles it
    // Playoff marker — consumed by downstream gates to know this was adjusted
    adjusted_for_playoffs: true,
    // Debug
    playoff_sigma_multiplier: multiplier,
  };
}
```

Make the same update in `run_nba_model.js` where the identical function exists (approximately lines 342-349). The same explicit construction should be used.

Do NOT change callers of `applyPlayoffSigmaMultiplier`. Only change the function body.
  </action>
  <verify>
    grep -n "adjusted_for_playoffs\|sigma_source.*sigma\\.sigma_source\|safe(" apps/worker/src/jobs/run_nhl_model.js | head -10
    grep -n "adjusted_for_playoffs" apps/worker/src/jobs/run_nba_model.js | head -5
    npm --prefix apps/worker test --no-coverage 2>&1 | tail -8
  </verify>
  <done>
    Both runner files contain updated applyPlayoffSigmaMultiplier with explicit field list. adjusted_for_playoffs and sigma_source are explicit. All existing tests pass.
  </done>
</task>

<task type="auto">
  <name>Task 2: Write playoff sigma contract tests</name>
  <files>apps/worker/src/jobs/__tests__/run_nhl_model.playoff-sigma.test.js</files>
  <action>
To make `applyPlayoffSigmaMultiplier` directly testable without loading the entire job file, add an export at the end of `run_nhl_model.js`:

```javascript
// Test exports — not used in production
if (process.env.NODE_ENV === 'test') {
  module.exports = { ...(module.exports ?? {}), applyPlayoffSigmaMultiplier };
}
```

If the file already has a conditional test-export block, add to it.

Then create `apps/worker/src/jobs/__tests__/run_nhl_model.playoff-sigma.test.js`:

```javascript
process.env.NODE_ENV = 'test';
const { applyPlayoffSigmaMultiplier } = require('../run_nhl_model');

describe('applyPlayoffSigmaMultiplier — sigma contract', () => {
  test('preserves sigma_source from input', () => {
    const sigma = { margin: 1.8, total: 2.0, sigma_source: 'computed', games_sampled: 24 };
    const result = applyPlayoffSigmaMultiplier(sigma, 1.15);
    expect(result.sigma_source).toBe('computed');
  });

  test('multiplies margin field (NHL sigma shape)', () => {
    const sigma = { margin: 2.0, total: 2.5, sigma_source: 'computed', games_sampled: 20 };
    const result = applyPlayoffSigmaMultiplier(sigma, 1.1);
    expect(result.margin).toBeCloseTo(2.2, 4);
    expect(result.total).toBeCloseTo(2.75, 4);
  });

  test('no NaN fields in output', () => {
    // sigma.spread is null on NHL — should not produce NaN
    const sigma = { margin: 1.9, total: 2.1, sigma_source: 'fallback', games_sampled: 8, spread: null };
    const result = applyPlayoffSigmaMultiplier(sigma, 1.2);
    for (const [key, val] of Object.entries(result)) {
      if (typeof val === 'number') {
        expect(Number.isNaN(val)).toBe(false);
      }
    }
  });

  test('sets adjusted_for_playoffs=true', () => {
    const sigma = { margin: 1.8, total: 2.0, sigma_source: 'computed' };
    const result = applyPlayoffSigmaMultiplier(sigma, 1.1);
    expect(result.adjusted_for_playoffs).toBe(true);
  });

  test('handles null/undefined input gracefully', () => {
    expect(applyPlayoffSigmaMultiplier(null, 1.1)).toBeNull();
    expect(applyPlayoffSigmaMultiplier(undefined, 1.1)).toBeUndefined();
  });
});
```

Run: `npm --prefix apps/worker test -- --testPathPattern=run_nhl_model.playoff-sigma 2>&1 | tail -10`
  </action>
  <verify>
    npm --prefix apps/worker test -- --testPathPattern=playoff-sigma 2>&1 | tail -10
    wc -l apps/worker/src/jobs/__tests__/run_nhl_model.playoff-sigma.test.js
  </verify>
  <done>5 tests all pass. Test file has at least 55 lines. No NaN assertion test catches the previously missing margin multiplication. All prior tests pass.</done>
</task>

</tasks>

<verification>
1. `grep -n "sigma_source.*sigma\.sigma_source" apps/worker/src/jobs/run_nhl_model.js` — explicit copy present
2. `grep -n "adjusted_for_playoffs" apps/worker/src/jobs/run_nhl_model.js apps/worker/src/jobs/run_nba_model.js` — both present
3. `npm --prefix apps/worker test -- --testPathPattern=playoff-sigma` — 5 pass
4. `npm --prefix apps/worker test --no-coverage` — all pass
</verification>

<success_criteria>
- applyPlayoffSigmaMultiplier preserves sigma_source, multiplies margin correctly, produces no NaN fields, sets adjusted_for_playoffs=true
- Same fix applied in both run_nhl_model.js and run_nba_model.js
- 5 tests cover the full sigma contract
- Zero regressions in existing NHL/NBA runner tests
</success_criteria>

<output>
After completion, create `.planning/phases/di-01-decision-integrity/di-01-08-SUMMARY.md`
</output>
