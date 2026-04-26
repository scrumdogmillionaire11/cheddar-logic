---
phase: S5-model-advanced-architecture
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/utils/score-engine.js
  - apps/worker/src/utils/__tests__/score-engine.test.js
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/models/nhl-pace-model.js
  - apps/worker/src/models/projections.js
autonomous: true

must_haves:
  truths:
    - "score-engine aggregate() accepts a feature vector and returns score in (0.2, 0.8)"
    - "MLB adjustedRa9 is computed via scoreEngine.aggregate(), existing MLB tests still pass"
    - "NHL pace adjustments are computed via scoreEngine.aggregate(), existing NHL tests still pass"
    - "NBA paceAdjustment in projectNBACanonical replaced with scoreEngine.aggregate(), existing NBA tests still pass"
    - "contributions and zScores appear in card drivers[] for at least MLB"
  artifacts:
    - path: "apps/worker/src/utils/score-engine.js"
      provides: "aggregate(features, opts) — z-score normalization + sigmoid transform"
      exports: ["aggregate"]
    - path: "apps/worker/src/utils/__tests__/score-engine.test.js"
      provides: "unit tests for aggregate()"
      min_lines: 40
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "MLB offense/defense using scoreEngine"
      contains: "scoreEngine.aggregate"
    - path: "apps/worker/src/models/nhl-pace-model.js"
      provides: "NHL pace using scoreEngine"
      contains: "scoreEngine.aggregate"
    - path: "apps/worker/src/models/projections.js"
      provides: "NBA paceAdjustment in projectNBACanonical using scoreEngine"
      contains: "scoreEngine.aggregate"
  key_links:
    - from: "apps/worker/src/models/mlb-model.js"
      to: "apps/worker/src/utils/score-engine.js"
      via: "require('../utils/score-engine')"
      pattern: "score-engine"
    - from: "scoreEngine.aggregate return value"
      to: "card drivers[]"
      via: "contributions + zScores spread into drivers"
      pattern: "contributions|zScores"
---

<objective>
WI-0830: Replace per-sport multiplicative adjustment stacks with a shared additive z-score aggregation layer. Each feature is normalised to a z-score, weighted, summed, and passed through a single globally-clamped sigmoid transform producing `modelScore ∈ (0.2, 0.8)`.

Purpose: Eliminates compounding amplification and non-comparable cross-sport scores — the root cause of extreme edge valuations identified in Sprints 1–2.
Output: `score-engine.js` utility + wired into MLB, NHL, NBA models.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0830.md
@apps/worker/src/models/mlb-model.js
@apps/worker/src/models/nhl-pace-model.js
@apps/worker/src/models/projections.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create score-engine.js and unit tests</name>
  <files>
    apps/worker/src/utils/score-engine.js
    apps/worker/src/utils/__tests__/score-engine.test.js
  </files>
  <action>
Create `apps/worker/src/utils/score-engine.js` implementing the aggregate function exactly as specified in WI-0830:

```js
'use strict';

/**
 * Aggregate a feature vector into a bounded model score via additive z-scores.
 *
 * @param {Array<{value:number, mean:number, std:number, weight:number, name:string}>} features
 * @param {{ outputClampLow?: number, outputClampHigh?: number, k?: number }} [opts]
 * @returns {{ score: number, contributions: Record<string,number>, zScores: Record<string,number> }}
 */
function aggregate(features, opts = {}) {
  const { outputClampLow = 0.2, outputClampHigh = 0.8, k = 2.0 } = opts;

  const contributions = {};
  const zScores = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const f of features) {
    const std = f.std > 0 ? f.std : 1e-6;
    const z = Math.max(-3, Math.min(3, (f.value - f.mean) / std));
    zScores[f.name] = Math.round(z * 10000) / 10000;
    const contribution = f.weight * z;
    contributions[f.name] = Math.round(contribution * 10000) / 10000;
    weightedSum += contribution;
    totalWeight += f.weight;
  }

  const S = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const rawScore = 1 / (1 + Math.exp(-k * S));
  const score = Math.max(outputClampLow, Math.min(outputClampHigh, rawScore));

  return { score: Math.round(score * 10000) / 10000, contributions, zScores };
}

module.exports = { aggregate };
```

Create `apps/worker/src/utils/__tests__/score-engine.test.js` with Jest tests:
- happy path: known feature vector produces score within 0.001 of expected
- zero-weight feature: excluded from score
- extreme z-score: clamped at ±3 — does not escape [0.2, 0.8]
- std=0 guard: does not throw
- all-neutral features: score ≈ 0.5
- outputClampLow/High opts: score respects custom clamp

Use Jest `expect(result.score).toBeCloseTo(expected, 3)` style. Do NOT use node:test.
  </action>
  <verify>
    cd apps/worker && npx jest --testPathPattern="score-engine" --no-coverage 2>&1 | tail -10
  </verify>
  <done>All score-engine tests pass; score-engine.js exports { aggregate }</done>
</task>

<task type="auto">
  <name>Task 2: Wire score-engine into MLB, NHL, NBA models</name>
  <files>
    apps/worker/src/models/mlb-model.js
    apps/worker/src/models/nhl-pace-model.js
    apps/worker/src/models/projections.js
  </files>
  <action>
**MLB model (`mlb-model.js`):**
- Add `const scoreEngine = require('../utils/score-engine');` at top
- In `resolveOffenseComposite` (or the equivalent final multiplier block), replace the multiplicative chain with a `scoreEngine.aggregate()` call using the existing constants as `mean`/`std` baselines. The features to aggregate are the ones currently multiplied (wRCPlus, contact multiplier, etc.)
- Spread `contributions` and `zScores` into the `drivers[]` array on the returned card object
- The returned score replaces the multiplicative composite value; scale back to the working range used by downstream code (i.e. if downstream expects a value near 1.0, use `score * 2` or adjust mean/std so the sigmoid midpoint maps to baseline 1.0 — document the scaling in a comment)

**NHL model (`nhl-pace-model.js`):**
- Add `const scoreEngine = require('../utils/score-engine');` at top
- Replace the pace adjustment multiplier block with a `scoreEngine.aggregate()` call using normalised pace features (paceRating, home/away pace delta, goalie composite from WI-0823)
- Existing NHL tests must still pass — keep the same output variable names; only change how the value is computed

**NBA model (`projections.js` — `projectNBACanonical`):**
- Add `const scoreEngine = require('../utils/score-engine');` at the top of projections.js (path relative to models/ folder: `../utils/score-engine`)
- Inside `projectNBACanonical`, locate the `paceAdjustment` multiplier derived from ORtg normalization (added by WI-0822). Replace the raw multiplier computation with a `scoreEngine.aggregate()` call using features: `homeOffRtgNorm`, `awayOffRtgNorm`, and `leagueAvgPace` with means/stds from the existing WI-0822 baseline constants in the file
- Keep `projectedTotal`, `homeProjected`, `awayProjected` variable names and the return object shape unchanged — only the paceAdjustment computation changes

**Critical:** Do NOT change PLAY/LEAN thresholds. Do NOT change which features are used — only change how they are combined. Structural change only.

Use the existing per-sport constants already in each file (e.g. `MLB_F5_DEFAULT_TEAM_XWOBA`, `LEAGUE_AVG_K_PCT`) as the `mean` values. Use ±10% of mean as `std` where no std is defined.
  </action>
  <verify>
    npm --prefix apps/worker test -- --testPathPattern="mlb-model|nhl-pace|nba-pace" --no-coverage 2>&1 | tail -15
  </verify>
  <done>
    All three model test suites pass with zero new failures.
    grep -r "scoreEngine.aggregate" apps/worker/src/models/mlb-model.js apps/worker/src/models/nhl-pace-model.js apps/worker/src/models/projections.js returns 3+ matches.
    grep -r "contributions\|zScores" apps/worker/src/models/mlb-model.js returns match (drivers wired for at least MLB).
  </done>
</task>

</tasks>

<verification>
npm --prefix apps/worker test -- --testPathPattern="score-engine|mlb-model|nhl-pace|nba" --no-coverage 2>&1 | tail -15
grep -rn "scoreEngine.aggregate" apps/worker/src/models/mlb-model.js apps/worker/src/models/nhl-pace-model.js apps/worker/src/models/projections.js
grep -rn "contributions\|zScores" apps/worker/src/models/mlb-model.js
</verification>

<success_criteria>
- score-engine.js unit tests: all pass, score within 0.001 of expected for known input
- MLB model: aggregate() called; existing test suite passes
- NHL model: aggregate() called; existing test suite passes
- NBA model: aggregate() called; existing test suite passes
- PLAY/LEAN thresholds unchanged
- contributions + zScores in MLB card drivers[]
</success_criteria>

<output>
After completion, create `.planning/phases/S5-model-advanced-architecture/S5-01-SUMMARY.md`
</output>
