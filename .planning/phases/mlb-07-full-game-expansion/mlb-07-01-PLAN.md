---
phase: mlb-07-full-game-expansion
plan: "01"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/models/__tests__/mlb-model.test.js
autonomous: true

must_haves:
  truths:
    - "projectF5ML() uses projected_home_f5_runs / projected_away_f5_runs from projectF5Total() when the full model succeeds"
    - "ERA-averaging fallback still activates when projectF5Total() returns null or projection_source is not FULL_MODEL"
    - "Return object includes tie_probability (number 0.05-0.28) and used_full_model_path (boolean)"
    - "All 25+ pre-existing MLB model tests pass with zero regressions"
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "Updated projectF5ML() with context param + full-model win-prob path"
      contains: "used_full_model_path"
    - path: "apps/worker/src/models/__tests__/mlb-model.test.js"
      provides: "≥3 new test cases for F5 ML full-model path, ERA fallback, tie_probability"
      min_lines: 3
  key_links:
    - from: "projectF5ML()"
      to: "projectF5Total()"
      via: "f5Proj = projectF5Total(homePitcher, awayPitcher, context)"
      pattern: "projectF5Total"
    - from: "projectF5ML return"
      to: "tie_probability field"
      via: "clampValue formula"
      pattern: "tie_probability"
---

<objective>
Fix `projectF5ML()` to use full-model run projections instead of the crude ERA-averaging formula.

Purpose: The current `projectF5ML()` uses `(era + 4.5) / 2 * (5/9)` as the expected runs per side. This ignores starter skill profile, offense composite, park/weather, and TTO profile — all of which `projectF5Total()` already computes. The fix connects the win-probability step to the existing full model output, making F5 ML predictions consistent with F5 total projections.

Output: Updated `projectF5ML()` with context param, full-model win-prob path, tie_probability field, ERA fallback preserved. Updated test suite with ≥3 new cases.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@data/mlb-research.md
@apps/worker/src/models/mlb-model.js
@apps/worker/src/models/__tests__/mlb-model.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix projectF5ML() to use full-model run projections</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>
Locate `function projectF5ML(homePitcher, awayPitcher, mlF5Home, mlF5Away)` (around line 679).

**Change 1 — Add `context = {}` as 5th parameter** (backward compatible; callers without it still work):
```js
function projectF5ML(homePitcher, awayPitcher, mlF5Home, mlF5Away, context = {}) {
```

**Change 2 — Add full-model run resolution before the ERA formula**:
After the null-guard section at the top of the function (the `if (!homePitcher || !awayPitcher)` block), insert:

```js
  const LEAGUE_AVG_RPG = 4.5;
  // Try full model path first (uses projectF5Total which has starter skill, offense, park, weather)
  const f5Proj = projectF5Total(homePitcher, awayPitcher, context);
  const usedFullModelPath =
    f5Proj != null &&
    f5Proj.projection_source !== 'NO_BET' &&
    f5Proj.projected_home_f5_runs != null &&
    f5Proj.projected_away_f5_runs != null;

  // Home team expected F5 runs — use full model if available, ERA fallback otherwise
  const homeExpected = usedFullModelPath
    ? f5Proj.projected_home_f5_runs
    : (awayPitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
  // Away team expected F5 runs — use full model if available, ERA fallback otherwise
  const awayExpected = usedFullModelPath
    ? f5Proj.projected_away_f5_runs
    : (homePitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
```

**Remove** the existing duplicate lines that set `homeExpected` and `awayExpected` and delete the stale comment:
```
// Home team expected F5 runs = function of away pitcher ERA
const homeExpected = (awayPitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
// Away team expected F5 runs = function of home pitcher ERA
const awayExpected = (homePitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
```
(The constant `LEAGUE_AVG_RPG` was defined inline at that point — with the refactor move it above the new block.)

**Change 3 — Add tie_probability after `winProbHome` is computed**:
Insert after the line `const winProbHome = 1 / (1 + Math.exp(-0.8 * runDiff));`:
```js
  // Approximate tie probability: higher when run diff is small, lower as diff grows
  // F5 ties occur ~20-28% when teams are evenly matched; falls with run differential
  const tieProbability = clampValue(0.26 - Math.abs(runDiff) * 0.09, 0.05, 0.26);
```

**Change 4 — Add `tie_probability` and `used_full_model_path` to the return object** (add alongside the existing `side`, `edge`, etc.):
```js
    tie_probability: tieProbability,
    used_full_model_path: usedFullModelPath,
```

Do NOT change the existing devig logic, LEAN_EDGE_MIN, CONFIDENCE_MIN, or the `reasoning` string (except it can optionally append `usedFullModelPath ? ' [FULL_MODEL]' : ' [ERA_FALLBACK]'` tag).
  </action>
  <verify>
    `grep -n "used_full_model_path\|tie_probability\|usedFullModelPath\|f5Proj = projectF5Total" apps/worker/src/models/mlb-model.js` should return ≥ 4 lines.
    `grep -n "projectF5ML" apps/worker/src/models/mlb-model.js | wc -l` should show the function definition plus call site(s).
  </verify>
  <done>
    `projectF5ML()` accepts 5th `context` param; uses `projectF5Total()` output for run expectations when full model succeeds; returns `tie_probability` and `used_full_model_path` in every code path.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add unit tests for F5 ML full-model path, ERA fallback, and tie_probability</name>
  <files>apps/worker/src/models/__tests__/mlb-model.test.js</files>
  <action>
Locate the existing `projectF5ML` test block (or create one in the same describe structure as the file uses — look at the file's top-level structure first). Add a new `describe('projectF5ML — full model path enhancements', ...)` block with ≥3 tests:

**Test A — full model path when pitcher has skill profile:**
```js
test('uses full-model projected runs when pitcher has siera/xfip', () => {
  const homePitcher = { siera: 3.80, x_fip: 3.75, x_era: 3.90, handedness: 'R',
    avg_ip: 5.5, pitch_count_avg: 92, bb_pct: 0.08, k_per_9: 9.2, whip: 1.15, era: 3.90 };
  const awayPitcher = { siera: 4.20, x_fip: 4.10, x_era: 4.30, handedness: 'L',
    avg_ip: 5.0, pitch_count_avg: 88, bb_pct: 0.09, k_per_9: 8.0, whip: 1.25, era: 4.20 };
  const context = {
    home_offense_profile: { wrc_plus: 105, xwoba: 0.325 },
    away_offense_profile: { wrc_plus: 98, xwoba: 0.315 },
    park_run_factor: 1.02, temp_f: 75, wind_mph: 5, wind_dir: 'OUT', roof: null,
  };
  const result = projectF5ML(homePitcher, awayPitcher, -120, 102, context);
  expect(result).not.toBeNull();
  expect(result.used_full_model_path).toBe(true);
  expect(typeof result.tie_probability).toBe('number');
  expect(result.tie_probability).toBeGreaterThanOrEqual(0.05);
  expect(result.tie_probability).toBeLessThanOrEqual(0.26);
});
```

**Test B — ERA fallback when pitcher has no skill profile (era-only):**
```js
test('falls back to ERA formula when pitcher has no siera/xfip/xera', () => {
  const homePitcher = { era: 3.60, whip: 1.15, k_per_9: 9.0, handedness: 'R' };
  const awayPitcher = { era: 4.80, whip: 1.35, k_per_9: 7.5, handedness: 'R' };
  const result = projectF5ML(homePitcher, awayPitcher, -115, 97, {});
  expect(result).not.toBeNull();
  expect(result.used_full_model_path).toBe(false);
  expect(typeof result.projected_win_prob_home).toBe('number');
  expect(result.projected_win_prob_home).toBeGreaterThan(0.5); // good home starter
});
```

**Test C — tie_probability bounded even with extreme run differential:**
```js
test('tie_probability stays in [0.05, 0.26] for extreme matchup', () => {
  // Historically great starter vs weak opponent — large expected run diff
  const homePitcher = { siera: 2.50, x_fip: 2.60, x_era: 2.70, handedness: 'R',
    avg_ip: 6.5, pitch_count_avg: 100, bb_pct: 0.06, k_per_9: 12, whip: 0.90, era: 2.50 };
  const awayPitcher = { era: 6.50, whip: 1.65, k_per_9: 6.0, handedness: 'R' };
  const result = projectF5ML(homePitcher, awayPitcher, -200, 170, {});
  if (result) {
    expect(result.tie_probability).toBeGreaterThanOrEqual(0.05);
    expect(result.tie_probability).toBeLessThanOrEqual(0.26);
  }
});
```

Use the same import/require pattern the test file already uses for `projectF5ML`. If `projectF5ML` is not yet exported from `mlb-model.js` (check `module.exports`), add it. Import `projectF5ML` at the top of the test file alongside existing imports. Run the test suite to confirm all tests pass.
  </action>
  <verify>
    `npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | tail -15`
    All tests pass; count shows ≥ 3 new passing tests in the F5 ML describe block.
  </verify>
  <done>
    ≥3 new test cases pass; projectF5ML exported; pre-existing tests unaffected.
  </done>
</task>

</tasks>

<verification>
Run full MLB model test suite:
```bash
npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | tail -20
```
All tests pass. No regressions. `grep -c "tie_probability\|used_full_model_path" apps/worker/src/models/mlb-model.js` returns ≥ 4.
</verification>

<success_criteria>
- `projectF5ML()` uses full-model run projections when available
- ERA fallback preserved for era-only pitchers
- `tie_probability` and `used_full_model_path` in every return path
- All MLB model tests pass (no regressions)
- ≥3 new tests cover the new behavior
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-07-full-game-expansion/mlb-07-01-SUMMARY.md`
</output>
