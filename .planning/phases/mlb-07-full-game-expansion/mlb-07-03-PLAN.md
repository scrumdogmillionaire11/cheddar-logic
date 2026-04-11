---
phase: mlb-07-full-game-expansion
plan: 03
type: execute
wave: 3
depends_on: ["mlb-07-02"]
files_modified:
  - apps/worker/src/models/mlb-model.js
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/models/__tests__/mlb-model.test.js
autonomous: true

must_haves:
  truths:
    - "computeMLBDriverCards() returns a full_game_ml card with edge and projected_win_prob_home fields when ml_home/ml_away prices are present in the snapshot"
    - "computeMLBDriverCards() returns a full_game_ml card when full-game ML line is available"
    - "selectMlbGameMarket() ranks all three markets (f5_total, full_game_total, full_game_ml) by edge*confidence and returns the highest"
    - "run_mlb_model.js resolves ml_home/ml_away prices and setsfull_game_ml_ok in pipeline state"
    - "All pre-existing mlb-model tests pass"
  artifacts:
    - path: "apps/worker/src/models/mlb-model.js"
      provides: "projectFullGameML(), updated selectMlbGameMarket()"
      exports: ["projectFullGameML"]
    - path: "apps/worker/src/jobs/run_mlb_model.js"
      provides: "ml_home/ml_away resolution, full_game_ml_ok flag"
    - path: "apps/worker/src/models/__tests__/mlb-model.test.js"
      provides: ">=3 new unit tests for projectFullGameML and selectMlbGameMarket 3-way ranking"
  key_links:
    - from: "projectFullGameML"
      to: "projectFullGameTotal"
      via: "calls projectFullGameTotal() to get homeRuns/awayRuns"
      pattern: "projectFullGameTotal"
    - from: "selectMlbGameMarket"
      to: "full_game_ml card"
      via: "marketScore(card) = Math.abs(card.edge) * card.confidence ranking"
      pattern: "marketScore"
    - from: "resolveMlbFullGameTotalContext"
      to: "ml_home / ml_away"
      via: "reads h2h prices from snapshot alongside total line"
      pattern: "ml_home|ml_away"
---

<objective>
Add full-game moneyline projection and upgrade the market selector to rank all three MLB markets by edge×confidence.

Purpose: The full-game ML is the highest-volume MLB bet type. Without it, the model can only evaluate totals. The market selector upgrade ensures the model always surfaces its highest-edge opportunity regardless of market type.

Output:
- `projectFullGameML(homePitcher, awayPitcher, mlHome, mlAway, context)` using logistic coefficient 0.55 (vs F5's 0.8 — more regression to the mean for full game)
- `computeMLBDriverCards()` produces a `full_game_ml` card when ml_home/ml_away prices are set
- `selectMlbGameMarket()` ranks f5_total / full_game_total / full_game_ml by `Math.abs(edge) * confidence`
- `run_mlb_model.js` resolves h2h prices and sets `full_game_ml_ok` in availability/pipeline state
- ≥3 new unit tests
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/mlb-07-full-game-expansion/mlb-07-02-PLAN.md
@apps/worker/src/models/mlb-model.js
@apps/worker/src/jobs/run_mlb_model.js
@apps/worker/src/models/__tests__/mlb-model.test.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add projectFullGameML() and upgrade selectMlbGameMarket() in mlb-model.js</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>
Add `projectFullGameML(homePitcher, awayPitcher, mlHome, mlAway, context = {})` after `projectFullGameTotal`. Implementation:

1. Call `projectFullGameTotal(homePitcher, awayPitcher, context)` to get `homeRuns` and `awayRuns`.
2. Compute run differential: `diff = homeRuns - awayRuns`
3. Win probability using logistic: `winProbHome = 1 / (1 + Math.exp(-0.55 * diff))`
   - Coefficient 0.55 is intentionally lower than F5's 0.8 (more regression over 9 innings vs 5)
4. Devig the moneyline prices to get implied probabilities:
   - `impliedHome = americanToProb(mlHome)`, `impliedAway = americanToProb(mlAway)`
   - reuse the existing `devig2way(impliedHome, impliedAway)` helper if present, else compute: `vigFree = impliedHome / (impliedHome + impliedAway)`
5. Edge vs the devigged market: `edge = winProbHome - vigFreeHome`
6. Determine side: `side = edge > 0 ? 'HOME' : 'AWAY'`; use `Math.abs(edge)` for edgeAbs
7. Apply LEAN_EDGE_MIN (0.04) gate: `ev_threshold_passed = edgeAbs >= 0.04`
8. Confidence: `0.5 + Math.min(edgeAbs, 0.15) * 2` (same formula as F5 ML, capped at 0.8)
9. Return:
```js
{
  side,
  prediction: side === 'HOME' ? mlHome : mlAway,
  edge: side === 'HOME' ? edge : -edge,
  projected_win_prob_home: winProbHome,
  market_implied_prob_home: vigFreeHome,
  tie_probability: 0,          // no tie in MLB full game
  confidence,
  ev_threshold_passed,
  projection_source: 'FULL_MODEL',
  used_full_model_path: true,
  reasoning: `Full-game ML: projected home win prob ${(winProbHome*100).toFixed(1)}% vs market ${(vigFreeHome*100).toFixed(1)}%; diff=${diff.toFixed(2)}`
}
```

**Upgrade selectMlbGameMarket():**
Currently only evaluates `f5_total`. Replace the selection logic with:
```js
function marketScore(card) {
  if (!card || !card.ev_threshold_passed) return -Infinity;
  return Math.abs(card.edge) * (card.confidence || 0.5);
}
const candidates = [
  { key: 'f5_total',        card: driverCards.find(d => d.market === 'f5_total') ?? null },
  { key: 'full_game_total', card: driverCards.find(d => d.market === 'full_game_total') ?? null },
  { key: 'full_game_ml',    card: driverCards.find(d => d.market === 'full_game_ml') ?? null },
].filter(c => c.card != null);
const best = candidates.reduce((a, b) => marketScore(a.card) >= marketScore(b.card) ? a : b, candidates[0]);
if (!best || !best.card.ev_threshold_passed) return { market: null, reason: 'no_qualifying_market' };
return { market: best.key, card: best.card, score: marketScore(best.card) };
```

**Wire full_game_ml into computeMLBDriverCards():**
After the block that builds `full_game_total` card, add:
```js
if (mlb.ml_home != null && mlb.ml_away != null) {
  const fgMlContext = {
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
  const fgMlResult = projectFullGameML(homePitcher, awayPitcher, mlb.ml_home, mlb.ml_away, fgMlContext);
  if (fgMlResult) {
    cards.push({
      market: 'full_game_ml',
      prediction: fgMlResult.side,
      confidence: fgMlResult.confidence,
      ev_threshold_passed: fgMlResult.ev_threshold_passed,
      reasoning: fgMlResult.reasoning,
      edge: fgMlResult.edge,
      projected_win_prob_home: fgMlResult.projected_win_prob_home,
      projection_source: fgMlResult.projection_source,
      drivers: [{
        type: 'mlb-fg-ml',
        edge: fgMlResult.edge,
        side: fgMlResult.side,
        win_prob: fgMlResult.projected_win_prob_home,
      }],
    });
  }
}
```

**Export:** Add `projectFullGameML` to the module.exports at the bottom.
  </action>
  <verify>
```bash
npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | tail -20
```
All existing tests pass. `projectFullGameML` appears in module.exports grep output.
  </verify>
  <done>
`projectFullGameML` exported; `selectMlbGameMarket` uses `marketScore` ranking; `computeMLBDriverCards` produces `full_game_ml` card when ml prices present; all pre-existing tests pass.
  </done>
</task>

<task type="auto">
  <name>Task 2: Extend run_mlb_model.js with h2h price resolution and add unit tests</name>
  <files>
    apps/worker/src/jobs/run_mlb_model.js
    apps/worker/src/models/__tests__/mlb-model.test.js
  </files>
  <action>
**In run_mlb_model.js — extend resolveMlbFullGameTotalContext():**
The function currently returns `{ line, over_price, under_price }`. Extend it to also read h2h moneyline prices from the same snapshot source:
```js
// After reading total line, read h2h prices
const h2hSnap = /* same snapshot read you already do for total */;
const mlHome = h2hSnap?.h2h?.home ?? h2hSnap?.h2h?.[0]?.price_home ?? null;
const mlAway = h2hSnap?.h2h?.away ?? h2hSnap?.h2h?.[0]?.price_away ?? null;
return { line, over_price, under_price, ml_home: mlHome, ml_away: mlAway };
```
Follow the exact same pattern used elsewhere in this file for reading h2h prices (grep `h2h` in this file to find the existing pattern).

**In buildMlbMarketAvailability():**
Add `full_game_ml_ok` alongside `full_game_total_ok`:
```js
full_game_ml_ok: ctx.ml_home != null && ctx.ml_away != null,
```

**In buildMlbPipelineState():**
Pass `ml_home` and `ml_away` through to the context object that gets passed to `computeMLBDriverCards`:
```js
ml_home: fullGameCtx.ml_home,
ml_away: fullGameCtx.ml_away,
```

**New unit tests in mlb-model.test.js (≥3):**

Test 1 — Dominant home starter favors HOME:
```js
it('projectFullGameML returns HOME when home SP is dominant', () => {
  const home = buildTestPitcher({ era: 2.8, whip: 1.05, ip_per_start: 6.5 });
  const away = buildTestPitcher({ era: 4.8, whip: 1.40, ip_per_start: 5.5 });
  const result = projectFullGameML(home, away, -150, +130, {});
  expect(result.side).toBe('HOME');
  expect(result.projected_win_prob_home).toBeGreaterThan(0.5);
  expect(result.used_full_model_path).toBe(true);
});
```

Test 2 — Even matchup produces small edge or PASS:
```js
it('projectFullGameML produces small edge for even matchup', () => {
  const home = buildTestPitcher({ era: 4.0, whip: 1.25, ip_per_start: 5.8 });
  const away = buildTestPitcher({ era: 4.0, whip: 1.25, ip_per_start: 5.8 });
  const result = projectFullGameML(home, away, -110, -110, {});
  expect(Math.abs(result.edge)).toBeLessThan(0.05);
});
```

Test 3 — selectMlbGameMarket 3-way ranking picks highest score:
```js
it('selectMlbGameMarket selects highest edge*confidence market', () => {
  const cards = [
    { market: 'f5_total',        edge: 0.04, confidence: 0.6, ev_threshold_passed: true },
    { market: 'full_game_total', edge: 0.08, confidence: 0.7, ev_threshold_passed: true },
    { market: 'full_game_ml',    edge: 0.03, confidence: 0.5, ev_threshold_passed: true },
  ];
  // selectMlbGameMarket signature: (gameId, oddsSnapshot, driverCards[])
  const result = selectMlbGameMarket("test-id", {}, cards);
  expect(result.market).toBe('full_game_total');
});
```

Use the existing test helper patterns (buildTestPitcher or equivalent) already in the test file. Import `projectFullGameML` and `selectMlbGameMarket` from the model.
  </action>
  <verify>
```bash
npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | tail -20
```
3 new tests pass. `full_game_ml_ok` appears in buildMlbMarketAvailability output.
  </verify>
  <done>
`resolveMlbFullGameTotalContext` returns `ml_home`/`ml_away`; `full_game_ml_ok` in availability; ml prices threaded into pipeline state; 3 new unit tests pass; total test count increases by ≥3.
  </done>
</task>

</tasks>

<verification>
```bash
npm --prefix apps/worker test -- --testPathPattern=mlb-model 2>&1 | tail -20
grep -n "projectFullGameML\|full_game_ml_ok\|marketScore" apps/worker/src/models/mlb-model.js | head -20
grep -n "full_game_ml_ok\|ml_home\|ml_away" apps/worker/src/jobs/run_mlb_model.js | head -20
```
All pre-existing tests pass. 3 new tests added. Key exports and flags present.
</verification>

<success_criteria>
- `projectFullGameML` exported from mlb-model.js
- `selectMlbGameMarket` uses `marketScore = Math.abs(edge) * confidence` 3-way ranking
- `computeMLBDriverCards` produces `full_game_ml` card when ml prices in context
- `resolveMlbFullGameTotalContext` returns `{ ..., ml_home, ml_away }`
- `buildMlbMarketAvailability` sets `full_game_ml_ok`
- ≥3 new unit tests pass (dominant HOME, even matchup, 3-way ranking)
- All pre-existing mlb-model tests pass
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-07-full-game-expansion/mlb-07-03-SUMMARY.md`
</output>
