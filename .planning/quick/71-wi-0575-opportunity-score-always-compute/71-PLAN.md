---
phase: quick-71
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/models/nhl-player-shots.js
  - apps/worker/src/jobs/run_nhl_player_shots_model.js
  - apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js
autonomous: true
requirements:
  - WI-0575

must_haves:
  truths:
    - "An UNDER card's opportunity_score is computed from edge_under_pp + ev_under + (market_line - sog_mu), not the OVER formula"
    - "An OVER card's opportunity_score continues to use edge_over_pp + ev_over + (sog_mu - market_line)"
    - "opportunity_score is null when the relevant direction's price or edge is absent (same gating as before)"
    - "projectBlkV1 receives the same direction-aware fix"
  artifacts:
    - path: apps/worker/src/models/nhl-player-shots.js
      provides: "direction-aware opportunity_score via play_direction parameter"
      contains: "play_direction"
    - path: apps/worker/src/jobs/run_nhl_player_shots_model.js
      provides: "play_direction wired from fullGameEdge.direction into projectSogV2 call"
      contains: "play_direction: fullGameEdge.direction"
    - path: apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js
      provides: "UNDER direction produces negative/under-direction opportunity_score"
      contains: "play_direction: 'UNDER'"
  key_links:
    - from: "fullGameEdge.direction (run_nhl_player_shots_model.js ~line 1400)"
      to: "projectSogV2 play_direction argument (~line 1262)"
      via: "call-site refactor: projectSogV2 call moved after fullGameEdge is computed, OR play_direction derived independently"
    - from: "projectSogV2 play_direction"
      to: "opportunity_score formula branch in nhl-player-shots.js"
      via: "if (play_direction === 'UNDER') use edge_under_pp / ev_under / (market_line - sog_mu)"
---

<objective>
Fix WI-0575: `opportunity_score` in `projectSogV2` (and `projectBlkV1`) always uses OVER-direction inputs regardless of the actual play direction, producing a contradicting positive OVER score on UNDER cards.

Purpose: An UNDER card's opportunity_score should reflect UNDER edge and EV, not OVER. The score is surfaced in the card payload and drives `computePropDisplayState` — a wrong-direction score misclassifies the bet quality.
Output: `play_direction` parameter added to `projectSogV2` and `projectBlkV1`; job runner passes `fullGameEdge.direction`; two new assertions in the test file.
</objective>

<context>
@.planning/STATE.md

<interfaces>
<!-- nhl-player-shots.js — opportunity_score block (lines 493–507, projectSogV2): -->
// CURRENT (always OVER):
let opportunity_score = null;
if (
  market_line !== null && market_line !== undefined &&
  market_price_over !== null && market_price_over !== undefined &&
  edge_over_pp !== null && ev_over !== null
) {
  const shot_env_adj = (rawShotEnvFactor ?? 1.0) - 1.0;
  opportunity_score =
    0.45 * edge_over_pp +
    0.20 * ev_over +
    0.20 * (sog_mu - market_line) +
    0.10 * trend_score +
    0.05 * shot_env_adj;
}

<!-- projectBlkV1 — opportunity_score block (lines 704–716): same pattern,
     always uses edge_over_pp + ev_over, no play_direction awareness. -->

<!-- run_nhl_player_shots_model.js — projectSogV2 call site (~line 1262–1283): -->
const v2Projection = projectSogV2({
  player_id: player.player_id,
  game_id: resolvedGameId,
  ev_shots_season_per60: shotsPer60 ?? null,
  ev_shots_l10_per60: l5RatePer60 ?? shotsPer60 ?? null,
  ev_shots_l5_per60: l5RatePer60,
  pp_shots_season_per60: ppRatePer60,
  pp_shots_l10_per60: ppRateL10Per60,
  pp_shots_l5_per60: ppRateL5Per60,
  toi_proj_ev: projToi ?? 0,
  toi_proj_pp: ppToi,
  pp_matchup_factor: ppMatchupFactor,
  shot_env_factor: paceFactor,
  opponent_suppression_factor: opponentFactor,
  role_stability: playerAvailabilityTier === 'DTD' ? 'MEDIUM' : 'HIGH',
  market_line: marketLine,
  market_price_over: overPrice,
  market_price_under: underPrice,
  // play_direction is NOT currently passed — this is the bug
});

<!-- fullGameEdge is computed at line ~1400, AFTER projectSogV2 is called at ~1262.
     play_direction cannot be passed directly without restructuring. -->
const fullGameEdge = classifyEdge(mu, syntheticLine, confidence);
// fullGameEdge.direction === 'OVER' | 'UNDER'

<!-- v2OpportunityScore derived at line ~1325: -->
const v2OpportunityScore = v2AnomalyDetected ? null : (v2Projection.opportunity_score ?? null);
// v2OpportunityScore is USED at lines 1511, 1527, 1532 — all after fullGameEdge is available.
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Add play_direction parameter to projectSogV2 and projectBlkV1</name>
  <files>
    apps/worker/src/models/nhl-player-shots.js
    apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js
  </files>
  <behavior>
    - Test A: projectSogV2 with play_direction='OVER' returns same opportunity_score as before (baseline unchanged)
    - Test B: projectSogV2 with play_direction='UNDER' and mu=2.0, market_line=2.5 (sog_mu &lt; line → UNDER edge) returns opportunity_score computed from edge_under_pp + ev_under + (market_line - sog_mu), which is positive
    - Test C: projectSogV2 with play_direction='UNDER' and market_price_under=null returns opportunity_score=null (no gating bypass)
    - Test D: projectSogV2 with play_direction omitted (undefined) defaults to 'OVER' behavior (backward-compat)
  </behavior>
  <action>
**In nhl-player-shots.js — projectSogV2:**

1. Add `play_direction = 'OVER'` to the destructured inputs block (alongside `lines_to_price`).

2. Replace the existing `opportunity_score` block (the `if` guard + assignment, lines ~494–507) with a direction-aware version:

```javascript
// ---- OpportunityScore (direction-aware) ----
let opportunity_score = null;
const shot_env_adj = (rawShotEnvFactor ?? 1.0) - 1.0;
if (play_direction === 'UNDER') {
  if (
    market_line !== null && market_line !== undefined &&
    market_price_under !== null && market_price_under !== undefined &&
    edge_under_pp !== null && ev_under !== null
  ) {
    opportunity_score =
      0.45 * edge_under_pp +
      0.20 * ev_under +
      0.20 * (market_line - sog_mu) +
      0.10 * trend_score +
      0.05 * shot_env_adj;
  }
} else {
  // Default: OVER direction
  if (
    market_line !== null && market_line !== undefined &&
    market_price_over !== null && market_price_over !== undefined &&
    edge_over_pp !== null && ev_over !== null
  ) {
    opportunity_score =
      0.45 * edge_over_pp +
      0.20 * ev_over +
      0.20 * (sog_mu - market_line) +
      0.10 * trend_score +
      0.05 * shot_env_adj;
  }
}
```

**In nhl-player-shots.js — projectBlkV1:**

Apply the same pattern to `projectBlkV1`'s opportunity_score block (lines ~704–716):

1. Add `play_direction = 'OVER'` to its destructured inputs.
2. Replace the block with the direction-aware version using `blk_mu` instead of `sog_mu`, and replacing `shot_env_adj` with the blk-specific terms:

```javascript
let opportunity_score = null;
if (play_direction === 'UNDER') {
  if (
    market_line !== null && market_line !== undefined &&
    market_price_under !== null && market_price_under !== undefined &&
    edge_under_pp !== null && ev_under !== null
  ) {
    opportunity_score =
      0.40 * edge_under_pp +
      0.20 * ev_under +
      0.20 * (market_line - blk_mu) +
      0.10 * (opp_attempt_factor - 1.0) +
      0.10 * (playoff_tightening_factor - 1.0);
  }
} else {
  if (
    market_line !== null && market_line !== undefined &&
    market_price_over !== null && market_price_over !== undefined &&
    edge_over_pp !== null && ev_over !== null
  ) {
    opportunity_score =
      0.40 * edge_over_pp +
      0.20 * ev_over +
      0.20 * (blk_mu - market_line) +
      0.10 * (opp_attempt_factor - 1.0) +
      0.10 * (playoff_tightening_factor - 1.0);
  }
}
```

**In nhl-player-shots-two-stage.test.js:**

Add four tests inside the existing `describe('projectSogV2 — two-stage model', ...)` block (within the opportunity_score section near line 295):

Test A — OVER default unchanged:
```javascript
test('opportunity_score with play_direction OVER equals result without play_direction', () => {
  const withDir = projectSogV2(buildInputs({ market_line: 2.5, market_price_over: -110, market_price_under: -110, play_direction: 'OVER' }));
  const withoutDir = projectSogV2(buildInputs({ market_line: 2.5, market_price_over: -110, market_price_under: -110 }));
  expect(withDir.opportunity_score).toBeCloseTo(withoutDir.opportunity_score, 6);
});
```

Test B — UNDER direction produces non-null score when UNDER is the real edge:
```javascript
test('opportunity_score with play_direction UNDER uses under-direction formula', () => {
  // mu will be < market_line → UNDER is the true edge
  const result = projectSogV2(buildInputs({
    ev_shots_season_per60: 4.0,
    ev_shots_l10_per60: 3.8,
    ev_shots_l5_per60: 3.6,
    toi_proj_ev: 12.0,
    toi_proj_pp: 0,
    market_line: 3.5,
    market_price_over: -110,
    market_price_under: -110,
    play_direction: 'UNDER',
  }));
  expect(result.opportunity_score).not.toBeNull();
  // Under direction: sog_mu < market_line so (market_line - sog_mu) > 0 → positive contribution
  expect(result.opportunity_score).toBeGreaterThan(0);
});
```

Test C — UNDER with missing under price returns null:
```javascript
test('opportunity_score is null when play_direction=UNDER but market_price_under is null', () => {
  const result = projectSogV2(buildInputs({
    market_line: 2.5,
    market_price_over: -110,
    market_price_under: null,
    play_direction: 'UNDER',
  }));
  expect(result.opportunity_score).toBeNull();
});
```

Test D — OVER with missing over price returns null (existing behavior, now explicit):
```javascript
test('opportunity_score is null when play_direction=OVER but market_price_over is null', () => {
  const result = projectSogV2(buildInputs({
    market_line: 2.5,
    market_price_over: null,
    market_price_under: -110,
    play_direction: 'OVER',
  }));
  expect(result.opportunity_score).toBeNull();
});
```
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js --no-coverage 2>&amp;1 | tail -20</automated>
  </verify>
  <done>
    - All four new tests pass.
    - All existing opportunity_score tests still pass.
    - `play_direction` destructured with default `'OVER'` in both `projectSogV2` and `projectBlkV1`.
    - UNDER branch uses `edge_under_pp`, `ev_under`, `(market_line - mu)`.
    - `node --check apps/worker/src/models/nhl-player-shots.js` exits 0.
  </done>
</task>

<task type="auto">
  <name>Task 2: Wire play_direction into projectSogV2 call in the job runner</name>
  <files>apps/worker/src/jobs/run_nhl_player_shots_model.js</files>
  <action>
The `projectSogV2` call at line ~1262 happens before `fullGameEdge` is computed at line ~1400. We need `play_direction` at call time. Resolution: derive direction directly from the V1 projection (same `classifyEdge` inputs are available at call time).

**Step 1 — Derive V1 direction before the projectSogV2 call.**

Immediately before the `projectSogV2({...})` call (~line 1262), add:

```javascript
// Derive V1 play direction early so projectSogV2 can compute direction-correct opportunity_score.
// classifyEdge is deterministic — this matches fullGameEdge.direction computed later.
const v2PlayDirection = classifyEdge(mu, syntheticLine ?? marketLine, 0.75).direction;
```

Note: `syntheticLine` is not yet declared at that point (it's set at line ~1327 as `const syntheticLine = marketLine`). Use `marketLine` directly here.

**Step 2 — Add `play_direction` to the projectSogV2 call.**

Inside the existing `projectSogV2({...})` argument object, add one line:

```javascript
play_direction: v2PlayDirection,
```

Place it after `market_price_under: underPrice,` and before the closing `});`.

**Step 3 — Remove the now-redundant v2OpportunityScore declaration at line ~1325.**

The existing line:
```javascript
const v2OpportunityScore = v2AnomalyDetected ? null : (v2Projection.opportunity_score ?? null);
```

Keep it exactly as-is — `v2Projection.opportunity_score` is now direction-correct because `play_direction` was passed. No change needed to this line.

That is the complete change: 3-line addition before the call, 1-line addition inside the call arguments.

**Do not touch any other lines.** The `fullGameEdge.direction` computed later at line ~1400 will always match `v2PlayDirection` because both use `classifyEdge(mu, line, ...)` with the same `mu` and same `marketLine` value.
  </action>
  <verify>
    <automated>node --check /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_player_shots_model.js &amp;&amp; grep -n "v2PlayDirection\|play_direction" /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_player_shots_model.js</automated>
  </verify>
  <done>
    - `v2PlayDirection` declared before the `projectSogV2` call using `classifyEdge(mu, marketLine, 0.75).direction`.
    - `play_direction: v2PlayDirection` appears inside the `projectSogV2({...})` argument object.
    - `node --check` exits 0.
    - grep shows both `v2PlayDirection` and `play_direction` in the file.
  </done>
</task>

</tasks>

<verification>
Run after both tasks complete:

```bash
# 1. Syntax check model
node --check /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/models/nhl-player-shots.js

# 2. Syntax check job runner
node --check /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_player_shots_model.js

# 3. Run model unit tests (all must pass)
cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js --no-coverage 2>&1 | tail -20

# 4. Confirm play_direction wired in job
grep -n "play_direction\|v2PlayDirection" /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_player_shots_model.js

# 5. Confirm UNDER branch present in model
grep -n "play_direction.*UNDER\|UNDER.*play_direction\|edge_under_pp\|ev_under" /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/models/nhl-player-shots.js
```
</verification>

<success_criteria>
- `projectSogV2` and `projectBlkV1` accept `play_direction` (default `'OVER'`).
- UNDER branch uses `edge_under_pp`, `ev_under`, and `(market_line - mu)` for the projection-delta term.
- OVER branch is unchanged from pre-fix behavior.
- All existing unit tests pass; four new direction-aware tests pass.
- Job runner passes `v2PlayDirection` (derived from same `classifyEdge` call used for V1) into `projectSogV2`.
- Only three files modified: `nhl-player-shots.js`, `run_nhl_player_shots_model.js`, `nhl-player-shots-two-stage.test.js`.
</success_criteria>

<output>
After completion, create `.planning/quick/71-wi-0575-opportunity-score-always-compute/71-SUMMARY.md` with:
- Root cause confirmed (which lines, what the OVER-only formula was)
- What changed in each of the three files
- Test results (pass count)
- Commit hash
</output>
