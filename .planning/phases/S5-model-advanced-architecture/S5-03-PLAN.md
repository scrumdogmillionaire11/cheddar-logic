---
phase: S5-model-advanced-architecture
plan: "03"
type: execute
wave: 2
depends_on: ["S5-01", "S5-02"]
files_modified:
  - apps/worker/src/models/residual-projection.js
  - apps/worker/src/models/__tests__/residual-projection.test.js
  - packages/data/db/migrations/072_add_residual_to_clv_entries.sql
  - apps/worker/src/models/cross-market.js
  - apps/worker/src/models/nhl-pace-model.js
  - apps/worker/src/models/projections.js
  - apps/worker/src/jobs/run_residual_validation.js
  - apps/worker/src/schedulers/main.js
  - apps/worker/package.json
autonomous: true

must_haves:
  truths:
    - "computeResidual(6.4, 5.5, 'OVER') returns { residual: 0.9, direction: 'OVER', source: 'MODEL_VS_MARKET' }"
    - "computeResidual with residual near 0 (< 0.15) returns direction: 'NEUTRAL'"
    - "cross-market.js projection_comparison includes residual field for NHL and NBA total decisions"
    - "card payload includes residual in projection metadata"
    - "run_residual_validation job produces log line with pearson_r and hit_rate_q4"
    - "clv_entries table extended with residual column via migration 072"
    - "run_residual_validation is registered in schedulers/main.js and runnable via npm run job:run-residual-validation"
  artifacts:
    - path: "apps/worker/src/models/residual-projection.js"
      provides: "computeResidual() function"
      exports: ["computeResidual"]
      min_lines: 50
    - path: "apps/worker/src/models/__tests__/residual-projection.test.js"
      provides: "unit tests for computeResidual"
      min_lines: 30
    - path: "packages/data/db/migrations/072_add_residual_to_clv_entries.sql"
      provides: "ALTER TABLE clv_entries ADD residual"
      contains: "ALTER TABLE"
    - path: "apps/worker/src/jobs/run_residual_validation.js"
      provides: "batch validation job"
      exports: ["run"]
  key_links:
    - from: "apps/worker/src/models/cross-market.js"
      to: "apps/worker/src/models/residual-projection.js"
      via: "require('./residual-projection')"
      pattern: "residual-projection"
    - from: "cross-market.js projection_comparison"
      to: "residual field"
      via: "computeResidual(modelFairTotal, consensusLine, side)"
      pattern: "computeResidual"
    - from: "apps/worker/src/models/projections.js"
      to: "fairLine field"
      via: "buildModelOutput wraps projectedTotal as fairLine"
      pattern: "fairLine"
    - from: "apps/worker/src/schedulers/main.js"
      to: "apps/worker/src/jobs/run_residual_validation.js"
      via: "schedule(runResidualValidation.run, ...)"
      pattern: "run_residual_validation"
---

<objective>
WI-0829: Add a residual projection layer that computes the model's expected deviation from the consensus market line rather than predicting the total from scratch. Run in parallel with the existing signal so residual predictive value can be validated before replacing current logic.

Purpose: Current model reconstructs public information from the same public features — any edge disappears vs closing lines. Residual forces each feature to justify itself relative to the market prior.
Output: residual-projection.js module, wired into NHL + NBA cross-market path, validation job reading CLV history.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0829.md
@.planning/phases/S5-model-advanced-architecture/S5-01-SUMMARY.md
@apps/worker/src/models/cross-market.js
@apps/worker/src/models/projections.js
@apps/worker/src/models/nhl-pace-model.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create residual-projection.js, tests, and migration 072</name>
  <files>
    apps/worker/src/models/residual-projection.js
    apps/worker/src/models/__tests__/residual-projection.test.js
    packages/data/db/migrations/072_add_residual_to_clv_entries.sql
  </files>
  <action>
**`apps/worker/src/models/residual-projection.js`:**

Implement `computeResidual` exactly as specified in the WI — do NOT modify the algorithm. Copy the full function from WI-0829 verbatim (the JS implementation using the Horner polynomial approx for erf). Export as `module.exports = { computeResidual }`.

Key logic:
- `residual = modelFairLine - consensusLine`
- `z = residual / sigma` (default sigma = 1.8)
- Normal CDF via Abramowitz–Stegun approximation (polynomial in WI text)
- `overProb = 1 - cdfValue`
- `direction`: `'NEUTRAL'` if `|residual| < 0.15`, else `'OVER'`/`'HOME'` if positive, `'UNDER'`/`'AWAY'` if negative — side param determines which label
- Returns `null` if either input is null

**`apps/worker/src/models/__tests__/residual-projection.test.js`:**

Jest tests:
- `computeResidual(6.4, 5.5, 'OVER')` → `residual = 0.9`, `direction = 'OVER'`, `source = 'MODEL_VS_MARKET'`
- `computeResidual(5.5, 5.5, 'OVER')` → `direction = 'NEUTRAL'`
- `computeResidual(5.0, 5.5, 'OVER')` → `direction = 'UNDER'`
- `computeResidual(null, 5.5, 'OVER')` → `null`
- `computeResidual(5.5, null, 'OVER')` → `null`
- HOME side: `computeResidual(105, 103, 'HOME')` → `direction = 'HOME'`
- HOME side: `computeResidual(101, 103, 'HOME')` → `direction = 'AWAY'`
- `residualProb` is between 0 and 1 for any finite inputs

**Migration `072_add_residual_to_clv_entries.sql`:**
```sql
ALTER TABLE clv_entries ADD COLUMN residual REAL;
```
  </action>
  <verify>
    npm --prefix apps/worker test -- --testPathPattern="residual-projection" --no-coverage 2>&1 | tail -10
    cat packages/data/db/migrations/072_add_residual_to_clv_entries.sql
  </verify>
  <done>
    All residual-projection unit tests pass.
    Migration file exists with ALTER TABLE statement.
    computeResidual exported from residual-projection.js.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire residual into cross-market, NHL/NBA models, and add validation job</name>
  <files>
    apps/worker/src/models/cross-market.js
    apps/worker/src/models/nhl-pace-model.js
    apps/worker/src/models/projections.js
    apps/worker/src/jobs/run_residual_validation.js
    apps/worker/src/schedulers/main.js
  </files>
  <action>
**`apps/worker/src/models/cross-market.js`:**
1. Add at top: `const { computeResidual } = require('./residual-projection');`
2. Locate the `projection_comparison` object returned for NHL and NBA total decisions (the object that already exists per WI-0571)
3. Add `residual: computeResidual(modelFairTotal, consensusLine, side)` to that object
4. `modelFairTotal` comes from the NHL/NBA model return value; use null if not present
5. `consensusLine` is the vig-free midpoint already computed in cross-market (use the existing variable name)
6. Also write `residual` field to the card payload metadata object (where `projection_comparison` is saved)

**`apps/worker/src/models/nhl-pace-model.js`:**
- Ensure `modelFairTotal` (the internally computed expected total) is promoted to the returned object
- If it's already computed internally but not returned: add it to the return object as `fairLine: modelFairTotal`
- Do NOT change the internal computation

**`apps/worker/src/models/projections.js`:**
- Find `projectNBACanonical`'s return / `buildModelOutput` wrapper
- Ensure it exposes `fairLine: projectedTotal` (or rename `projectedTotal` → `fairLine` in the output wrapper only, not internally)
- If `fairLine` already exists: no change needed

**`apps/worker/src/jobs/run_residual_validation.js`:**

Create batch validation job:
```js
'use strict';
// Reads 30d of clv_entries with outcome + residual, computes:
// 1. Pearson correlation of residual vs clv
// 2. Hit rate stratified by residual quartile (Q1 bottom 25%, Q4 top 25%)

async function run(db) {
  const rows = db.prepare(`
    SELECT residual, clv, outcome
    FROM clv_entries
    WHERE outcome IS NOT NULL
      AND residual IS NOT NULL
      AND clv IS NOT NULL
      AND created_at >= datetime('now', '-30 days')
  `).all();

  if (rows.length < 20) {
    console.log('[RESIDUAL_VAL] insufficient data for validation');
    return { skipped: true };
  }

  // Pearson r between residual and clv
  const pearsonR = computePearson(rows.map(r => r.residual), rows.map(r => r.clv));

  // Quartile hit rate (outcome = 1 is win)
  const sorted = [...rows].sort((a, b) => a.residual - b.residual);
  const q = Math.floor(sorted.length / 4);
  const q1 = sorted.slice(0, q);
  const q4 = sorted.slice(sorted.length - q);
  const hitRate = arr => arr.filter(r => r.outcome === 1).length / arr.length;
  const hitRateQ1 = hitRate(q1);
  const hitRateQ4 = hitRate(q4);
  const delta = hitRateQ4 - hitRateQ1;

  if (delta < 0.04) {
    console.warn('[RESIDUAL_VAL] residual has no predictive value: Q4-Q1 delta=', delta.toFixed(3));
  }
  console.log('[RESIDUAL_VAL]', { pearson_r: pearsonR.toFixed(4), hit_rate_q1: hitRateQ1.toFixed(3), hit_rate_q4: hitRateQ4.toFixed(3), n: rows.length });
  return { pearsonR, hitRateQ1, hitRateQ4, n: rows.length };
}
```

Implement `computePearson(xs, ys)` inline (mean, covariance, stddev via O(n) loops — no external dependency).

Export `module.exports = { run }`.

**`apps/worker/src/schedulers/main.js` — register validation job:**
- Add at top: `const { run: runResidualValidation } = require('../jobs/run_residual_validation');`
- Register using the same pattern as `runDrClaireHealthReport` — a daily off-peak slot (e.g. 04:30 ET); label `run_residual_validation`
- Also add `job:run-residual-validation` to `apps/worker/package.json` scripts: `"node src/jobs/run_residual_validation.js"`
  </action>
  <verify>
    grep -n "computeResidual\|residual" apps/worker/src/models/cross-market.js | head -15
    grep -n "fairLine\|modelFairTotal" apps/worker/src/models/nhl-pace-model.js apps/worker/src/models/projections.js
    grep -n "exports" apps/worker/src/jobs/run_residual_validation.js
    npm --prefix apps/worker test -- --testPathPattern="residual|cross-market" --no-coverage 2>&1 | tail -10
  </verify>
  <done>
    computeResidual called in cross-market.js with result added to projection_comparison.
    residual written to card payload metadata.
    nhl-pace-model.js returns fairLine field.
    projections.js projectNBACanonical exposes fairLine.
    run_residual_validation.js exports run() and logs pearson_r + hit_rate_q4.
    All relevant tests pass with no regressions.
  </done>
</task>

</tasks>

<verification>
npm --prefix apps/worker test -- --testPathPattern="residual-projection|cross-market" --no-coverage 2>&1 | tail -15
grep -rn "computeResidual" apps/worker/src/models/cross-market.js
grep -rn "fairLine" apps/worker/src/models/nhl-pace-model.js apps/worker/src/models/projections.js
cat packages/data/db/migrations/072_add_residual_to_clv_entries.sql
</verification>

<success_criteria>
- computeResidual unit tests: all pass including null guard and direction cases
- cross-market.js projection_comparison includes residual for NHL + NBA totals
- card payload metadata includes residual field
- nhl-pace-model + projections expose fairLine
- run_residual_validation runs and logs pearson_r + quartile hit rates
- migration 072 adds residual column to clv_entries
- worker test suite passes with no regressions
- run_residual_validation registered in schedulers/main.js; `npm run job:run-residual-validation` executes without error
</success_criteria>

<output>
After completion, create `.planning/phases/S5-model-advanced-architecture/S5-03-SUMMARY.md`
</output>
