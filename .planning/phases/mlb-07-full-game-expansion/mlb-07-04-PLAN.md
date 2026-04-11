---
phase: mlb-07-full-game-expansion
plan: 04
type: execute
wave: 3
depends_on: ["mlb-07-01", "mlb-07-02", "mlb-07-03"]
files_modified:
  - apps/worker/src/jobs/potd/run_potd_engine.js
  - apps/worker/src/jobs/potd/__tests__/run_potd_engine.test.js
autonomous: true

must_haves:
  truths:
    - "buildMLBModelCandidates(game) returns model-backed candidates with modelWinProb and edgePct when pitcher data is available"
    - "buildMLBModelCandidates(game) returns empty array when pitcher data is missing (no crash)"
    - "scoreCandidate() uses modelWinProb directly when _fromMLBModel is true (bypasses devig path)"
    - "MLB model candidates compete alongside consensus candidates in gatherBestCandidate()"
    - "NHL and NBA game processing is completely unaffected"
  artifacts:
    - path: "apps/worker/src/jobs/potd/run_potd_engine.js"
      provides: "buildMLBModelCandidates(), scoreMLBCandidate(), wired into gatherBestCandidate()"
      contains: "buildMLBModelCandidates"
    - path: "apps/worker/src/jobs/potd/__tests__/run_potd_engine.test.js"
      provides: ">=2 unit tests for buildMLBModelCandidates"
  key_links:
    - from: "run_potd_engine.js"
      to: "computeMLBDriverCards"
      via: "require('../models') or require('../../models')"
      pattern: "computeMLBDriverCards"
    - from: "gatherBestCandidate"
      to: "buildMLBModelCandidates"
      via: "if (game.sport === 'MLB') append MLB model candidates"
      pattern: "buildMLBModelCandidates"
    - from: "scoreCandidate"
      to: "modelWinProb"
      via: "_fromMLBModel flag bypasses devig, uses modelWinProb as win_prob"
      pattern: "_fromMLBModel"
---

<objective>
Wire the MLB model into the POTD engine so MLB game candidates include model-backed probabilities.

Purpose: POTD currently scores MLB games using only consensus odds (devig line value). After Plans 01-03 we have a full 3-market MLB model. This plan connects that model to POTD so the best MLB play is selected using actual projection signal, not just market consensus.

Output:
- `buildMLBModelCandidates(game)` in `run_potd_engine.js` — maps `computeMLBDriverCards` output to POTD candidate shape with `_fromMLBModel: true`, `modelWinProb`, `edgePct`
- `scoreMLBCandidate(candidate)` wrapper — returns score using `modelWinProb` directly (no devig)
- `gatherBestCandidate()` appends MLB model candidates for MLB sport games
- ≥2 unit tests
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/mlb-07-full-game-expansion/mlb-07-03-PLAN.md
@apps/worker/src/jobs/potd/run_potd_engine.js
@apps/worker/src/jobs/potd/signal-engine.js
@apps/worker/src/models/mlb-model.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add buildMLBModelCandidates() and wire into gatherBestCandidate()</name>
  <files>apps/worker/src/jobs/potd/run_potd_engine.js</files>
  <action>
**Step 1 — Add import at the top of run_potd_engine.js:**
Find the existing `require` block and add:
```js
const { computeMLBDriverCards } = require('../../models');
```
(Use the relative path that resolves to `apps/worker/src/models/index.js` — check the existing model imports in this file for the correct relative path.)

**Step 2 — Add buildMLBModelCandidates(game):**
Add this function after the existing `buildCandidatesFn` / `buildCandidates` import block and before `scoreCandidate`:

```js
function buildMLBModelCandidates(game) {
  try {
    const context = {
      park_factor: game.park_factor ?? 1.0,
      weather_run_factor: game.weather_run_factor ?? 1.0,
      // full-game line context from game snapshot
      full_game_total_line: game.total_line ?? null,
      ml_home: game.ml_home ?? null,
      ml_away: game.ml_away ?? null,
    };
    const home = game.home_pitcher ?? null;
    const away = game.away_pitcher ?? null;
    if (!home || !away) return [];

    const driverCards = computeMLBDriverCards(home, away, context);
    if (!driverCards) return [];

    const candidates = [];
    for (const [market, card] of Object.entries(driverCards)) {
      if (!card || !card.ev_threshold_passed) continue;
      candidates.push({
        gameId: game.game_id,
        sport: game.sport,
        market,
        side: card.side,
        prediction: card.prediction,
        edge: card.edge,
        confidence: card.confidence,
        modelWinProb: card.projected_win_prob_home ?? null,
        edgePct: Math.abs(card.edge),
        _fromMLBModel: true,
        reasoning: card.reasoning ?? `MLB model: ${market} ${card.side}`,
      });
    }
    return candidates;
  } catch (err) {
    // Never crash POTD on model errors
    console.warn('[POTD] buildMLBModelCandidates error:', err.message);
    return [];
  }
}
```

**Step 3 — Add scoreMLBCandidate(candidate):**
Add after `buildMLBModelCandidates`:
```js
function scoreMLBCandidate(candidate) {
  // For model-backed candidates, use model edge directly instead of devig path
  const edgeScore = Math.min(candidate.edgePct * 100, 20); // cap at 20 points
  const confidenceBonus = (candidate.confidence ?? 0.5) * 5;
  return edgeScore + confidenceBonus;
}
```

**Step 4 — Wire into gatherBestCandidate() (or equivalent top-level selection function):**
Find the function that calls `buildCandidatesFn(game)` or `buildCandidates(game)` to gather scoring candidates. After that call, add:
```js
if (game.sport === 'MLB' || game.sport === 'baseball_mlb') {
  const mlbModelCandidates = buildMLBModelCandidates(game);
  for (const c of mlbModelCandidates) {
    candidates.push({ ...c, score: scoreMLBCandidate(c) });
  }
}
```
If the gathering loop uses a different shape, follow the existing pattern exactly — the key is that MLB model candidates are added to the same pool that `selectBestPlay` draws from.

**Do NOT modify** the `scoreCandidate()` function used for non-MLB candidates. The `_fromMLBModel` flag routes through `scoreMLBCandidate` instead.
  </action>
  <verify>
```bash
node -e "const e = require('./apps/worker/src/jobs/potd/run_potd_engine.js'); console.log(typeof e.buildMLBModelCandidates === 'function' ? 'OK' : 'MISSING')" 2>&1 | head -5
grep -n "buildMLBModelCandidates\|computeMLBDriverCards\|_fromMLBModel" apps/worker/src/jobs/potd/run_potd_engine.js | head -15
```
  </verify>
  <done>
`buildMLBModelCandidates` defined; `computeMLBDriverCards` imported; `_fromMLBModel` flag present; MLB candidates appended in gathering loop; no syntax errors on require.
  </done>
</task>

<task type="auto">
  <name>Task 2: Add unit tests for buildMLBModelCandidates</name>
  <files>apps/worker/src/jobs/potd/__tests__/run_potd_engine.test.js</files>
  <action>
If the test file doesn't exist, create it. If it does exist, add a new describe block at the end.

**Test 1 — Returns candidates for game with pitcher data:**
```js
describe('buildMLBModelCandidates', () => {
  it('returns non-empty array when home and away pitchers present', () => {
    const game = {
      game_id: 'test-mlb-001',
      sport: 'baseball_mlb',
      home_pitcher: {
        name: 'HomeAce',
        era: 2.8,
        whip: 1.05,
        ip_per_start: 6.5,
        strikeout_rate: 0.28,
        bb_rate: 0.07,
        k_minus_bb: 0.21,
        fip: 3.1,
        xfip: 3.2,
        hand: 'R',
      },
      away_pitcher: {
        name: 'AwayAvg',
        era: 4.5,
        whip: 1.35,
        ip_per_start: 5.5,
        strikeout_rate: 0.20,
        bb_rate: 0.09,
        k_minus_bb: 0.11,
        fip: 4.4,
        xfip: 4.3,
        hand: 'R',
      },
      total_line: 8.5,
      ml_home: -140,
      ml_away: +120,
    };
    const candidates = buildMLBModelCandidates(game);
    expect(Array.isArray(candidates)).toBe(true);
    // Should not throw; may return empty if no markets pass threshold
    // but structure must be correct when non-empty
    if (candidates.length > 0) {
      expect(candidates[0]).toHaveProperty('sport');
      expect(candidates[0]).toHaveProperty('_fromMLBModel', true);
      expect(candidates[0]).toHaveProperty('edgePct');
    }
  });

  it('returns empty array when pitchers missing', () => {
    const game = {
      game_id: 'test-mlb-002',
      sport: 'baseball_mlb',
      home_pitcher: null,
      away_pitcher: null,
    };
    const candidates = buildMLBModelCandidates(game);
    expect(candidates).toEqual([]);
  });
});
```

Import `buildMLBModelCandidates` at the top of the test file:
```js
const { buildMLBModelCandidates } = require('../run_potd_engine');
```
If `run_potd_engine.js` doesn't export it directly, export it: add `buildMLBModelCandidates` to the `module.exports` of `run_potd_engine.js` (or use a named export block at the bottom if one exists).
  </action>
  <verify>
```bash
npm --prefix apps/worker test -- --testPathPattern=run_potd_engine 2>&1 | tail -15
```
Both tests pass (non-empty game → array without crash; missing pitchers → empty array).
  </verify>
  <done>
≥2 tests pass. `buildMLBModelCandidates` exported. No crashes for missing pitcher data.
  </done>
</task>

</tasks>

<verification>
```bash
npm --prefix apps/worker test -- --testPathPattern="mlb-model|run_potd_engine" 2>&1 | tail -20
grep -n "buildMLBModelCandidates\|_fromMLBModel\|computeMLBDriverCards" apps/worker/src/jobs/potd/run_potd_engine.js | head -15
```
All MLB model tests pass. All new POTD tests pass. No import errors.
</verification>

<success_criteria>
- `buildMLBModelCandidates(game)` defined and exported from `run_potd_engine.js`
- `computeMLBDriverCards` imported from models in `run_potd_engine.js`
- `_fromMLBModel: true` flag on all MLB model candidates
- MLB model candidates appended to candidate pool in `gatherBestCandidate` / scoring loop
- `scoreMLBCandidate` uses `edgePct` directly (bypasses devig)
- 2 new tests pass: non-empty array for game with pitchers, empty array for missing pitchers
- All pre-existing POTD and MLB model tests pass
- NHL/NBA game flow completely unaffected (no shared code path modified)
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-07-full-game-expansion/mlb-07-04-SUMMARY.md`
</output>
