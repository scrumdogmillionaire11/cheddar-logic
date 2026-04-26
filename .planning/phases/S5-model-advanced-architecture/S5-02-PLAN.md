---
phase: S5-model-advanced-architecture
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/data/db/migrations/071_calibration_models.sql
  - apps/worker/src/utils/calibration.js
  - apps/worker/src/utils/__tests__/calibration.test.js
  - apps/worker/src/jobs/fit_calibration_models.js
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/jobs/run_nba_model.js
  - apps/worker/src/jobs/run_nhl_model.js
  - apps/worker/src/schedulers/main.js
autonomous: true

must_haves:
  truths:
    - "DB migration 071 creates calibration_models table with correct schema"
    - "PAV isotonic fit on known xs/ys produces breakpoints with lower Brier score than raw"
    - "applyCalibration() interpolates correctly between breakpoints and clamps output [0.01, 0.99]"
    - "Card payloads include calibration_source: 'isotonic' or 'raw'"
    - "If no calibration row exists for a market, raw fair_prob is used without error"
    - "fit_calibration_models job runs without error against seeded data"
    - "Scheduler (schedulers/main.js) registers fit_calibration_models daily at 06:00 ET"
  artifacts:
    - path: "packages/data/db/migrations/071_calibration_models.sql"
      provides: "calibration_models table DDL"
      contains: "CREATE TABLE"
    - path: "apps/worker/src/utils/calibration.js"
      provides: "fitIsotonic() and applyCalibration()"
      exports: ["fitIsotonic", "applyCalibration"]
    - path: "apps/worker/src/jobs/fit_calibration_models.js"
      provides: "daily fit job"
      exports: ["run"]
      min_lines: 60
  key_links:
    - from: "apps/worker/src/jobs/run_mlb_model.js"
      to: "apps/worker/src/utils/calibration.js"
      via: "applyCalibration(rawFairProb, breakpoints)"
      pattern: "applyCalibration"
    - from: "apps/worker/src/jobs/run_nba_model.js"
      to: "apps/worker/src/utils/calibration.js"
      via: "applyCalibration(rawFairProb, breakpoints)"
      pattern: "applyCalibration"
    - from: "apps/worker/src/jobs/run_nhl_model.js"
      to: "apps/worker/src/utils/calibration.js"
      via: "applyCalibration(rawFairProb, breakpoints)"
      pattern: "applyCalibration"
    - from: "apps/worker/src/schedulers/main.js"
      to: "apps/worker/src/jobs/fit_calibration_models.js"
      via: "schedule('fit_calibration_models', ...)"
      pattern: "fit_calibration_models"
---

<objective>
WI-0831: Fit a per-market isotonic regression calibrator on historical `fair_prob` vs outcomes. Apply the calibration at inference time so `fair_prob` on card payloads is the corrected probability, not raw model output.

Purpose: Kelly fractions and net_edge calculations downstream are currently driven by uncorrected probabilities. A systematic +0.04 overestimate inflates Kelly stake by ~40%.
Output: Migration, calibration utility, fit job, and wired into MLB/NBA/NHL card write paths.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0831.md
@apps/worker/src/schedulers/main.js
@apps/worker/src/jobs/run_mlb_model.js
@packages/data/db/migrations/070_create_model_health_snapshots.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migration + calibration utility + fit job</name>
  <files>
    packages/data/db/migrations/071_calibration_models.sql
    apps/worker/src/utils/calibration.js
    apps/worker/src/utils/__tests__/calibration.test.js
    apps/worker/src/jobs/fit_calibration_models.js
  </files>
  <action>
**Migration `071_calibration_models.sql`:**
```sql
CREATE TABLE IF NOT EXISTS calibration_models (
  sport        TEXT NOT NULL,
  market_type  TEXT NOT NULL,
  fitted_at    TEXT NOT NULL,
  breakpoints_json TEXT NOT NULL,
  n_samples    INTEGER NOT NULL,
  isotonic_brier REAL NOT NULL,
  PRIMARY KEY (sport, market_type)
);
```

**`apps/worker/src/utils/calibration.js`:**

Implement Pool Adjacent Violators (PAV) isotonic regression:

```js
'use strict';

/**
 * Fit isotonic regression via Pool Adjacent Violators.
 * @param {number[]} xs - raw model probabilities (sorted ascending)
 * @param {number[]} ys - 0/1 outcomes aligned with xs
 * @returns {{ x: number, y: number }[]} breakpoints for linear interpolation
 */
function fitIsotonic(xs, ys) { ... }

/**
 * Apply saved calibration via linear interpolation on breakpoints.
 * Returns raw prob unchanged if breakpoints is null/empty.
 * @param {number} rawProb
 * @param {{ x: number, y: number }[] | null} breakpoints
 * @returns {{ calibratedProb: number, calibrationSource: 'isotonic' | 'raw' }}
 */
function applyCalibration(rawProb, breakpoints) { ... }
```

PAV implementation steps:
1. Create blocks: `[{sum_y, count, x_mean}]`, one per data point
2. While any adjacent pair violates monotonicity (block[i].y_avg > block[i+1].y_avg): pool them (merge, recalculate y_avg)
3. Convert blocks to breakpoints array `[{ x: block.x_mean, y: block.y_avg }]`
4. Return sorted by x

`applyCalibration` linear interpolation:
- If breakpoints null/length 0: return `{ calibratedProb: rawProb, calibrationSource: 'raw' }`
- Clamp rawProb to [bp[0].x, bp[last].x] before interpolating
- Linear interp between the two bracket points
- Clamp final output to [0.01, 0.99]
- Return `{ calibratedProb, calibrationSource: 'isotonic' }`

**`apps/worker/src/utils/__tests__/calibration.test.js`:**
- PAV test: xs=[0.4,0.5,0.6,0.7], ys=[0,0,1,1] → breakpoints monotone, Brier improved
- Interpolation test: given breakpoints [{x:0.4,y:0.38},{x:0.6,y:0.55}], applyCalibration(0.5) ≈ 0.465
- Clamp test: rawProb=0.99 → calibratedProb <= 0.99; rawProb=0.01 → calibratedProb >= 0.01
- Fallback test: applyCalibration(0.6, null).calibrationSource === 'raw'
- Fallback test: applyCalibration(0.6, []).calibrationSource === 'raw'

**`apps/worker/src/jobs/fit_calibration_models.js`:**
- Read `model_calibration` table (created by WI-0825): query distinct `(sport, market_type)` groups
- For each group: fetch `(fair_prob, outcome)` rows where `outcome IS NOT NULL`
- If n_samples < 30: skip that market (insufficient data), log `[CAL_FIT] skipped sport/market — only N samples`
- Sort by fair_prob ascending; call `fitIsotonic(xs, ys)`
- Compute `isotonic_brier` = mean squared error of calibrated probs vs ys
- Upsert into `calibration_models` with `fitted_at = new Date().toISOString()`
- Log `[CAL_FIT] fitted sport=MLB market=f5-total n=218 isotonic_brier=0.231`
- Export `async function run(db) { ... }`
  </action>
  <verify>
    npm --prefix apps/worker test -- --testPathPattern="calibration" --no-coverage 2>&1 | tail -10
    cat packages/data/db/migrations/071_calibration_models.sql
  </verify>
  <done>
    All calibration unit tests pass.
    Migration file exists with CREATE TABLE calibration_models.
    fit_calibration_models.js exports run() function.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire applyCalibration into card write paths + scheduler</name>
  <files>
    apps/worker/src/jobs/run_mlb_model.js
    apps/worker/src/jobs/run_nba_model.js
    apps/worker/src/jobs/run_nhl_model.js
    apps/worker/src/schedulers/main.js
  </files>
  <action>
**Pattern for each sport job file** (`run_mlb_model.js`, `run_nba_model.js`, `run_nhl_model.js`):

1. Add at top: `const { applyCalibration } = require('../utils/calibration');`
2. Before each card payload is written, read the calibration breakpoints for the relevant market:
   ```js
   const calRow = db.prepare(
     'SELECT breakpoints_json FROM calibration_models WHERE sport = ? AND market_type = ?'
   ).get(sport, marketType);
   const breakpoints = calRow ? JSON.parse(calRow.breakpoints_json) : null;
   const { calibratedProb, calibrationSource } = applyCalibration(fairProb, breakpoints);
   ```
3. Replace `fair_prob: fairProb` with `fair_prob: calibratedProb` in the card payload
4. Add `calibration_source: calibrationSource` to the card payload metadata

Do NOT change the edge calculation or PLAY/LEAN thresholds. Calibration only affects `fair_prob` and adds `calibration_source`.

Sport-to-marketType mapping:
- MLB F5: `sport='MLB', market_type='f5-total'`
- NBA full-game total: `sport='NBA', market_type='full-game-total'`
- NHL 1P: `sport='NHL', market_type='1p-total'`
- NHL full-game: `sport='NHL', market_type='full-game-total'`

If the `calibration_models` table does not exist (migration not yet run), wrap the `db.prepare()` in try/catch; log `[CAL_APPLY] table not ready — using raw` and continue with raw fair_prob. This prevents job failures before migration is applied.

**`apps/worker/src/schedulers/main.js` scheduler:**
Add `fit_calibration_models` to the daily schedule. Find the existing cron registration pattern (see how `runDrClaireHealthReport` or `refreshTeamMetricsDaily` are registered) and add:
```js
schedule(fitCalibrationModels.run, { cronTime: '0 6 * * *', label: 'fit_calibration_models', tz: 'America/New_York' });
```
Import the job at the top of schedulers/main.js, following the same pattern as `runDrClaireHealthReport`.
  </action>
  <verify>
    grep -n "applyCalibration\|calibration_source" apps/worker/src/jobs/run_mlb_model.js apps/worker/src/jobs/run_nba_model.js apps/worker/src/jobs/run_nhl_model.js
    grep -n "fit_calibration_models" apps/worker/src/schedulers/main.js
    npm --prefix apps/worker test -- --no-coverage 2>&1 | tail -10
  </verify>
  <done>
    applyCalibration called in all 3 sport job files.
    calibration_source appears in card payload writes.
    fit_calibration_models registered in apps/worker/src/schedulers/main.js.
    Full worker test suite passes with no regressions.
  </done>
</task>

</tasks>

<verification>
npm --prefix apps/worker test -- --testPathPattern="calibration|mlb-model|nhl|nba" --no-coverage 2>&1 | tail -15
grep -rn "applyCalibration" apps/worker/src/jobs/run_mlb_model.js apps/worker/src/jobs/run_nba_model.js apps/worker/src/jobs/run_nhl_model.js
grep -n "fit_calibration_models" apps/worker/src/schedulers/main.js
cat packages/data/db/migrations/071_calibration_models.sql
</verification>

<success_criteria>
- Migration 071 creates calibration_models table
- fitIsotonic PAV test: breakpoints produce lower Brier score than raw
- applyCalibration tests: interpolation and clamping correct
- fit_calibration_models job runs against seeded data without error
- card payloads include calibration_source: 'isotonic' | 'raw'
- graceful fallback when no calibration row exists — no error thrown
- full worker test suite passes with no regressions
</success_criteria>

<output>
After completion, create `.planning/phases/S5-model-advanced-architecture/S5-02-SUMMARY.md`
</output>
