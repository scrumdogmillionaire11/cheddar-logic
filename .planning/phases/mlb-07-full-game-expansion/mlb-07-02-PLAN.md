---
phase: mlb-07-full-game-expansion
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/models/__tests__/mlb-model.test.js
autonomous: true

must_haves:
  truths:
    - "projectLateInningsRuns() returns a late_innings_runs value > 0 for any valid offense profile"
    - "projectFullGameTotal() returns a projected total that is strictly greater than the F5 projection for the same matchup"
    - "projectFullGameTotalCard() emits OVER when projected > line by >= 0.6 and confidence >= 8"
    - "computeMLBDriverCards() includes a full_game_total card when mlb.full_game_line or mlb.total is non-null"
    - "All 25+ pre-existing MLB model tests pass with zero regressions"
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "projectLateInningsRuns, projectFullGameTotal, projectFullGameTotalCard functions; full_game_total driver in computeMLBDriverCards"
      contains: "MLB_FG_DEFAULT_BULLPEN_ERA"
    - path: "apps/worker/src/models/__tests__/mlb-model.test.js"
      provides: "≥4 new test cases for late innings, full-game projection, full-game card output"
      min_lines: 4
  key_links:
    - from: "projectFullGameTotal()"
      to: "projectF5Total()"
      via: "const f5Proj = projectF5Total(homePitcher, awayPitcher, context);"
      pattern: "projectF5Total"
    - from: "projectFullGameTotal()"
      to: "projectLateInningsRuns()"
      via: "homeLate = projectLateInningsRuns(...)"
      pattern: "projectLateInningsRuns"
    - from: "computeMLBDriverCards()"
      to: "projectFullGameTotalCard()"
      via: "if (mlb.full_game_line != null || mlb.total != null)"
      pattern: "full_game_total"
---

<objective>
Build the full-game total projection model by extending F5 runs through innings 6-9 via a bullpen-quality layer.

Purpose: The research confirms that treating F5 as "(5/9) of the full game" is wrong — late innings have a distinct driver (bullpen quality, not starter quality). This plan adds `projectLateInningsRuns()`, composites it with `projectF5Total()` to form `projectFullGameTotal()`, and wires the full-game total card into `computeMLBDriverCards()`.

Output: Three new functions in `mlb-model.js` (`projectLateInningsRuns`, `projectFullGameTotal`, `projectFullGameTotalCard`) plus a `full_game_total` driver card type. ≥4 new tests.
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
  <name>Task 1: Add projectLateInningsRuns() and projectFullGameTotal()</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>
Add the following after the `buildF5SyntheticFallbackProjection` function (around line 377):

**Constant to add at top of file** (near other MLB_F5_DEFAULT_* constants):
```js
const MLB_FG_DEFAULT_BULLPEN_ERA = 4.0;   // MLB league-average bullpen ERA used when no team-specific data
const MLB_FG_LATE_INNINGS = 4;            // innings 6-9
const MLB_FG_EDGE_THRESHOLD = 0.6;        // slightly wider than F5 (0.5) — more innings variance
```

**`projectLateInningsRuns(offenseProfile, pitcherHandedness, opponentBullpenEra, environment)`**:

```js
/**
 * Project late-innings (6-9) runs for one team.
 * Uses opponent bullpen ERA as the run-allowing skill proxy, same offense composite as F5.
 *
 * @param {object|null} offenseProfile  - team batting stats (wrc_plus, xwoba, etc.)
 * @param {string} pitcherHandedness    - 'R'|'L'; used for platoon split on offense
 * @param {number|null} opponentBullpenEra - opponent bullpen ERA; null → league average (4.0)
 * @param {object} [environment={}]     - { park_run_factor, temp_f, wind_mph, wind_dir, roof }
 * @returns {{ late_innings_runs: number, bullpen_era_used: number, bullpen_source: string }}
 */
function projectLateInningsRuns(offenseProfile, pitcherHandedness, opponentBullpenEra, environment = {}) {
  const bullpenEra = toFiniteNumberOrNull(opponentBullpenEra) ?? MLB_FG_DEFAULT_BULLPEN_ERA;
  const bullpenSource = opponentBullpenEra != null ? 'DATA' : 'LEAGUE_AVG';

  const parkFactor = clampValue(toFiniteNumberOrNull(environment?.park_run_factor) ?? 1.0, 0.9, 1.12);
  const weatherFactor = resolveWeatherRunFactor(environment) ?? 1.0;

  // Offense quality against typical RHP bullpen (most relievers are RHP)
  const matchupProfile = resolveTeamSplitProfile(offenseProfile, pitcherHandedness ?? 'R');
  const offenseMult = matchupProfile
    ? resolveOffenseComposite(matchupProfile)
    : 1.0;

  const adjustedBullpenRa9 = bullpenEra * offenseMult * parkFactor * weatherFactor;
  const lateInningsRuns = Math.max(0.15, adjustedBullpenRa9 * (MLB_FG_LATE_INNINGS / 9));

  return { late_innings_runs: lateInningsRuns, bullpen_era_used: bullpenEra, bullpen_source: bullpenSource };
}
```

**`projectFullGameTotal(homePitcher, awayPitcher, context = {})`**:

```js
/**
 * Project full-game (9-inning) expected run total.
 * Combines F5 starter projection (innings 1-5) with late-innings bullpen projection (innings 6-9).
 *
 * Context extensions (optional — gracefully degrade to league avg if missing):
 *   context.home_bullpen_era   — home team's bullpen ERA (away team bats against it)
 *   context.away_bullpen_era   — away team's bullpen ERA (home team bats against it)
 *
 * @returns {object|null} null if F5 projection fails (missing core inputs)
 */
function projectFullGameTotal(homePitcher, awayPitcher, context = {}) {
  // Build F5 component first
  const f5Proj = projectF5Total(homePitcher, awayPitcher, context);
  if (!f5Proj || f5Proj.projection_source === 'NO_BET') return null;
  if (f5Proj.projected_home_f5_runs == null || f5Proj.projected_away_f5_runs == null) return null;

  const environment = {
    park_run_factor: context?.park_run_factor,
    temp_f:          context?.temp_f,
    wind_mph:        context?.wind_mph,
    wind_dir:        context?.wind_dir,
    roof:            context?.roof,
  };

  // Home team bats against AWAY bullpen in innings 6-9
  const homeLate = projectLateInningsRuns(
    context?.home_offense_profile,
    awayPitcher?.handedness ?? 'R',
    context?.away_bullpen_era,
    environment,
  );
  // Away team bats against HOME bullpen in innings 6-9
  const awayLate = projectLateInningsRuns(
    context?.away_offense_profile,
    homePitcher?.handedness ?? 'R',
    context?.home_bullpen_era,
    environment,
  );

  const homeFullGameRuns = f5Proj.projected_home_f5_runs + homeLate.late_innings_runs;
  const awayFullGameRuns = f5Proj.projected_away_f5_runs + awayLate.late_innings_runs;
  const fgTotal = homeFullGameRuns + awayFullGameRuns;

  const rangeWidth = Math.max(0.5, Math.sqrt(Math.max(fgTotal, 0.1)) * 0.35);

  // Confidence: base from F5, +1 if at least one real bullpen ERA provided
  let confidence = f5Proj.confidence;
  if (context?.home_bullpen_era != null || context?.away_bullpen_era != null) confidence = Math.min(confidence + 1, 10);
  const bullpenDataPresent = homeLate.bullpen_source === 'DATA' || awayLate.bullpen_source === 'DATA';

  return {
    base: fgTotal,
    confidence,
    projection_source: bullpenDataPresent
      ? f5Proj.projection_source
      : f5Proj.projection_source === 'FULL_MODEL' ? 'FULL_MODEL_AVG_BULLPEN' : f5Proj.projection_source,
    status_cap: f5Proj.status_cap,
    missing_inputs: f5Proj.missing_inputs,
    projected_home_fg_runs: homeFullGameRuns,
    projected_away_fg_runs: awayFullGameRuns,
    projected_home_f5_runs: f5Proj.projected_home_f5_runs,
    projected_away_f5_runs: f5Proj.projected_away_f5_runs,
    projected_fg_total_mean: fgTotal,
    projected_total_mean: fgTotal,          // alias -- WI-0872 acceptance criterion 1
    projected_fg_total_low:  Math.max(0, fgTotal - rangeWidth),
    projected_fg_total_high: fgTotal + rangeWidth,
    home_bullpen_era: homeLate.bullpen_era_used,
    away_bullpen_era: awayLate.bullpen_era_used,
    home_bullpen_source: homeLate.bullpen_source,
    away_bullpen_source: awayLate.bullpen_source,
    park_run_factor: f5Proj.park_run_factor,
    weather_factor: f5Proj.weather_factor,
    playability: {
      over_playable_at_or_below: roundToHalf(fgTotal - MLB_FG_EDGE_THRESHOLD, 'floor'),
      under_playable_at_or_above: roundToHalf(fgTotal + MLB_FG_EDGE_THRESHOLD, 'ceil'),
    },
  };
}
```

**`projectFullGameTotalCard(homePitcher, awayPitcher, fgLine, context = {})`**:
Model this closely on `projectF5TotalCard()` (around line 600), but:
- Call `projectFullGameTotal()` instead of `projectF5Total()`
- Use edge threshold `MLB_FG_EDGE_THRESHOLD` (0.6) instead of `MLB_F5_EDGE_THRESHOLD` (0.5)
- Use `proj.projected_fg_total_mean ?? proj.base` for the projected total
- Set `projection.projected_total` to the full-game total, not F5
- Label as `sourceLabel = 'FG FULL_MODEL'` / `'FG DEGRADED_MODEL'` / `'FG AVG_BULLPEN'` in `reasoning`

The shape of the return object must be identical to `projectF5TotalCard()` so `computeMLBDriverCards()` handles it the same way.
  </action>
  <verify>
    ```bash
    grep -n "projectLateInningsRuns\|projectFullGameTotal\|MLB_FG_DEFAULT_BULLPEN_ERA\|MLB_FG_LATE_INNINGS" \
      apps/worker/src/models/mlb-model.js | head -20
    ```
    Should show ≥8 lines (constant declarations + function signatures + call sites).
  </verify>
  <done>
    Three new functions exist in mlb-model.js; `projectFullGameTotal()` references `projectF5Total()` and `projectLateInningsRuns()`; full-game card shape mirrors F5 card shape.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire full_game_total into computeMLBDriverCards() and add unit tests</name>
  <files>
    apps/worker/src/models/mlb-model.js
    apps/worker/src/models/__tests__/mlb-model.test.js
  </files>
  <action>
**Part A — Wire into computeMLBDriverCards():**

In `computeMLBDriverCards(gameId, oddsSnapshot)` (around line 825), after the existing F5 total card block, add:

```js
  // Full-game total card (uses mlb.total or mlb.full_game_line + home/away bullpen ERA from payload)
  const fgLine = mlb.full_game_line != null
    ? toFiniteNumberOrNull(mlb.full_game_line)
    : toFiniteNumberOrNull(mlb.total ?? oddsSnapshot?.total);
  if (fgLine != null) {
    const fgContext = {
      home_offense_profile: mlb.home_offense_profile ?? null,
      away_offense_profile: mlb.away_offense_profile ?? null,
      park_run_factor: mlb.park_run_factor ?? null,
      temp_f: mlb.temp_f ?? null,
      wind_mph: mlb.wind_mph ?? null,
      wind_dir: mlb.wind_dir ?? null,
      roof: mlb.roof ?? null,
      home_bullpen_era: mlb.home_bullpen_era ?? null,
      away_bullpen_era: mlb.away_bullpen_era ?? null,
    };
    const fgResult = projectFullGameTotalCard(homePitcher, awayPitcher, fgLine, fgContext);
    if (fgResult) {
      cards.push({
        market: 'full_game_total',
        prediction: fgResult.prediction,
        confidence: fgResult.confidence / 10,
        ev_threshold_passed: fgResult.ev_threshold_passed,
        reasoning: fgResult.reasoning,
        status: fgResult.status,
        action: fgResult.action,
        classification: fgResult.classification,
        projection_source: fgResult.projection_source,
        status_cap: fgResult.status_cap,
        pass_reason_code: fgResult.pass_reason_code,
        reason_codes: fgResult.reason_codes,
        missing_inputs: fgResult.missing_inputs,
        playability: fgResult.playability,
        projection: fgResult.projection,
        drivers: [{
          type: 'mlb-fg',
          edge: fgResult.edge,
          projected: fgResult.projected,
          projection_source: fgResult.projection_source,
        }],
      });
    }
  }
```

Also export the new functions. In `module.exports` at the bottom of `mlb-model.js`, add:
```js
  projectLateInningsRuns,
  projectFullGameTotal,
  projectFullGameTotalCard,
```

**Part B — Unit tests:**

Add a `describe('projectFullGameTotal and late innings', ...)` block in `mlb-model.test.js`:

**Test A — `projectLateInningsRuns` gives higher output for elite offense vs weak bullpen:**
```js
test('projectLateInningsRuns: elite offense + weak bullpen → higher late runs', () => {
  const eliteOffense = { wrc_plus: 120, xwoba: 0.360 };
  const avgOffense   = { wrc_plus: 100, xwoba: 0.320 };
  const weakBullpen  = 5.2;  // ERA
  const avgEnv = { park_run_factor: 1.0 };
  const eliteRuns  = projectLateInningsRuns(eliteOffense, 'R', weakBullpen, avgEnv);
  const avgRuns    = projectLateInningsRuns(avgOffense, 'R', weakBullpen, avgEnv);
  expect(eliteRuns.late_innings_runs).toBeGreaterThan(avgRuns.late_innings_runs);
  expect(eliteRuns.bullpen_era_used).toBe(5.2);
  expect(eliteRuns.bullpen_source).toBe('DATA');
});
```

**Test B — `projectLateInningsRuns` defaults to league-avg bullpen when ERA is null:**
```js
test('projectLateInningsRuns: defaults to MLB_FG_DEFAULT_BULLPEN_ERA when null', () => {
  const offense = { wrc_plus: 100, xwoba: 0.320 };
  const result  = projectLateInningsRuns(offense, 'R', null, { park_run_factor: 1.0 });
  expect(result.bullpen_source).toBe('LEAGUE_AVG');
  expect(result.bullpen_era_used).toBe(4.0);
  expect(result.late_innings_runs).toBeGreaterThan(0);
});
```

**Test C — `projectFullGameTotal` > F5 projection for same matchup:**
```js
test('projectFullGameTotal returns higher total than projectF5Total for same matchup', () => {
  const home = { siera: 3.80, x_fip: 3.75, x_era: 3.90, handedness: 'R',
    avg_ip: 5.5, pitch_count_avg: 92, bb_pct: 0.08, k_per_9: 9.2, whip: 1.15, era: 3.90 };
  const away = { siera: 4.20, x_fip: 4.10, x_era: 4.30, handedness: 'L',
    avg_ip: 5.0, pitch_count_avg: 88, bb_pct: 0.09, k_per_9: 8.0, whip: 1.25, era: 4.20 };
  const context = {
    home_offense_profile: { wrc_plus: 102, xwoba: 0.322 },
    away_offense_profile: { wrc_plus: 99,  xwoba: 0.318 },
    park_run_factor: 1.0, temp_f: 72, wind_mph: 5, roof: null,
  };
  const fgResult = projectFullGameTotal(home, away, context);
  const f5Result = projectF5Total(home, away, context);
  expect(fgResult).not.toBeNull();
  expect(fgResult.projected_fg_total_mean).toBeGreaterThan(f5Result.projected_total_mean);
});
```

**Test D — `computeMLBDriverCards` includes full_game_total card when total line present:**
```js
test('computeMLBDriverCards includes full_game_total card when total line present', () => {
  const snapshot = {
    total: 8.5,
    raw_data: JSON.stringify({ mlb: {
      home_pitcher: { siera: 3.80, x_fip: 3.75, x_era: 3.90, handedness: 'R',
        avg_ip: 5.5, pitch_count_avg: 92, bb_pct: 0.08, k_per_9: 9.2, whip: 1.15, era: 3.90,
        times_through_order_profile: { '1st': 3.5, '3rd': 3.8 } },
      away_pitcher: { siera: 4.20, x_fip: 4.10, x_era: 4.30, handedness: 'L',
        avg_ip: 5.0, pitch_count_avg: 88, bb_pct: 0.09, k_per_9: 8.0, whip: 1.25, era: 4.20,
        times_through_order_profile: { '1st': 3.7, '3rd': 4.1 } },
      home_offense_profile: { wrc_plus: 105, xwoba: 0.325 },
      away_offense_profile: { wrc_plus: 98,  xwoba: 0.315 },
      park_run_factor: 1.0, temp_f: 72, wind_mph: 5, roof: null,
      f5_line: 4.5,
    }}
  };
  const cards = computeMLBDriverCards('test-game-001', snapshot);
  const fgCard = cards.find((c) => c.market === 'full_game_total');
  expect(fgCard).toBeDefined();
  expect(typeof fgCard.confidence).toBe('number');
  expect(['OVER', 'UNDER', 'PASS']).toContain(fgCard.prediction);
});
```

Import `projectLateInningsRuns`, `projectFullGameTotal` from the module at the top of the test file.


**Test E -- avg-starter + avg-bullpen game projects 8.5-9.5 (WI-0872 acceptance #4):**
Add test asserting projectFullGameTotal(avgHome, avgAway, ctx).projected_fg_total_mean is between 8.5 and 9.5 when both pitchers have league-average metrics (siera~4.2, era~4.2), avg offense (wrc_plus=100), avg bullpen (era=4.0), neutral park/weather.

**Test F -- elite-starter game projects lower total than avg-starter (WI-0872 acceptance #5):**
Add test asserting projectFullGameTotal(eliteHome, oppAway, ctx).projected_fg_total_mean < projectFullGameTotal(avgHome, oppAway, ctx).projected_fg_total_mean where eliteHome has siera~2.6/era~2.6 and avgHome has siera~4.2/era~4.2, same away pitcher and context for both calls.
  </action>
  <verify>
    ```bash
    npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | tail -20
    ```
    All tests pass including ≥4 new full-game tests.
  </verify>
  <done>
    `computeMLBDriverCards()` returns `full_game_total` card when total line is in snapshot; all 4 new tests pass; pre-existing tests unaffected.
  </done>
</task>

</tasks>

<verification>
```bash
npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | grep -E "PASS|FAIL|Tests:"
grep -c "projectFullGameTotal\|projectLateInningsRuns\|full_game_total" apps/worker/src/models/mlb-model.js
```
All tests pass. grep shows ≥10 references to the new functions.
</verification>

<success_criteria>
- `projectLateInningsRuns()`, `projectFullGameTotal()`, `projectFullGameTotalCard()` exist and are explicitly added to `module.exports` in `mlb-model.js`
- `computeMLBDriverCards()` produces `full_game_total` card when total line present
- Full-game total is always greater than F5 for the same matchup
- All pre-existing MLB model tests pass
- ≥4 new tests cover late innings + full-game projection
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-07-full-game-expansion/mlb-07-02-SUMMARY.md`
</output>
