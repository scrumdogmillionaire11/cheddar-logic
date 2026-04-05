---
phase: quick-133
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/run_nhl_player_shots_model.js
  - apps/worker/src/models/__tests__/nhl-blk-model.test.js
autonomous: true
requirements: [QUICK-133]
must_haves:
  truths:
    - "projectBlkV1 receives opponent_attempt_factor derived from opponent corsi proxy (clamped [0.90, 1.12])"
    - "projectBlkV1 receives playoff_tightening_factor > 1.0 when game date falls in NHL playoff window (post April 19)"
    - "projectBlkV1 receives lines_to_price from all blkLineCandidates so multi-line cards price every available line"
    - "nhl-blk-model.test.js covers opponent factor, playoff tightening, and multi-line pricing behaviors"
  artifacts:
    - path: "apps/worker/src/jobs/run_nhl_player_shots_model.js"
      provides: "wired opponent_attempt_factor, playoff_tightening_factor, lines_to_price into projectBlkV1 call"
      contains: "opponent_attempt_factor"
    - path: "apps/worker/src/models/__tests__/nhl-blk-model.test.js"
      provides: "test coverage for new wiring behavior"
      contains: "opponent_attempt_factor"
  key_links:
    - from: "run_nhl_player_shots_model.js (factorRow)"
      to: "projectBlkV1 opponent_attempt_factor"
      via: "corsi_for_pct / 50.0 from opponent team_metrics_cache"
      pattern: "opponent_attempt_factor"
    - from: "blkLineCandidates"
      to: "projectBlkV1 lines_to_price"
      via: "blkLineCandidates.map(c => c.line)"
      pattern: "lines_to_price"
---

<objective>
Wire three missing context factors into the NHL BLK model call site in `run_nhl_player_shots_model.js`. The `projectBlkV1` function accepts `opponent_attempt_factor`, `playoff_tightening_factor`, and `lines_to_price` but all three are currently unset (defaulting to 1.0 / empty). This means the model never adjusts BLK projections for opponent offensive pressure, playoff context, or alternate lines.

Purpose: The BLK model math is correct but its inputs are stubbed. Real projections must reflect how hard opponents shoot (more shots = more block opportunities), whether the game is playoff-intensity, and all available market lines.
Output: Updated call site in `run_nhl_player_shots_model.js` + tests confirming all three factors flow through.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

<!-- Key interfaces the executor needs — extracted from codebase -->
<interfaces>
<!-- From apps/worker/src/models/nhl-player-shots.js — projectBlkV1 signature -->
```javascript
// projectBlkV1(inputs) — full accepted input shape:
{
  player_id,
  game_id,
  ev_blocks_season_per60,    // from blkRateRow
  ev_blocks_l10_per60,       // from blkRateRow
  ev_blocks_l5_per60,        // from blkRateRow
  pk_blocks_season_per60,    // from blkRateRow
  pk_blocks_l10_per60,       // from blkRateRow
  pk_blocks_l5_per60,        // from blkRateRow
  toi_proj_ev,
  toi_proj_pk,
  role_stability,
  market_line,
  market_price_over,
  market_price_under,
  play_direction,
  // ↓ CURRENTLY MISSING from call site (all default to 1.0 / []):
  opponent_attempt_factor,   // [0.90, 1.12] — clamp enforced inside model
  defensive_zone_factor,     // [0.95, 1.08] — no DB source, keep 1.0 for now
  underdog_script_factor,    // [0.95, 1.10] — no DB source, keep 1.0 for now
  playoff_tightening_factor, // [1.00, 1.08] — derive from game date
  lines_to_price,            // number[] — all alternate line values
}
```

<!-- From run_nhl_player_shots_model.js — variables in scope at BLK call site (~line 3093) -->
// factorRow is already queried per-player for SOG. It contains:
//   factorRow?.opponent_pace_proxy  — opponent corsi_for_pct/50.0 (shots generated pressure)
//   factorRow?.team_pace_proxy      — player team pace proxy

// blkLineCandidates is array of {line, over_price, under_price, bookmaker} — all available lines
// blkMarket = blkLineCandidates[0] || synthetic fallback — only primary line used currently

// game object has: game_time_utc (ISO 8601 UTC string)
// NHL regular season ends ~April 18; playoffs start ~April 19 each year

<!-- Playoff tightening derivation (no DB flag — date-based heuristic) -->
// A game_date in playoff window (April 19 – June 30) gets playoff_tightening_factor = 1.06
// Regular season: 1.0
// Implementation:
//   const gameDate = new Date(game.game_time_utc);
//   const month = gameDate.getUTCMonth() + 1; // 1-12
//   const day = gameDate.getUTCDate();
//   const inPlayoffs = (month === 4 && day >= 19) || month === 5 || month === 6;
//   const blkPlayoffFactor = inPlayoffs ? 1.06 : 1.0;

<!-- opponent_attempt_factor derivation -->
// Opponent's forward pressure (how much they attack = how many blocks defenders get)
// Use opponent team's own pace proxy (their corsi_for_pct / 50.0 = shots generated ratio)
// factorRow.opponent_pace_proxy is already the opponent's corsi proxy (queried at line ~1938)
//
// const rawBlkOppAttemptFactor = Number.isFinite(factorRow?.opponent_pace_proxy) &&
//   factorRow.opponent_pace_proxy > 0
//   ? factorRow.opponent_pace_proxy
//   : 1.0;
// Pass as opponent_attempt_factor — clamp [0.90, 1.12] is enforced inside projectBlkV1
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Wire opponent_attempt_factor and playoff_tightening_factor into projectBlkV1 call</name>
  <files>apps/worker/src/jobs/run_nhl_player_shots_model.js, apps/worker/src/models/__tests__/nhl-blk-model.test.js</files>
  <behavior>
    - opponent_attempt_factor computed from factorRow.opponent_pace_proxy (already in scope); defaults to 1.0 when factorRow is null or value non-finite
    - playoff_tightening_factor = 1.06 when game_time_utc falls in April 19 – June 30; otherwise 1.0
    - Both values passed to projectBlkV1 at line ~3093
    - Existing test: "top-4 D with high opp_attempt and playoff_tightening ranks above baseline" already passes — no change needed there
    - Add test: "opponent_attempt_factor above 1.0 increases blk_mu compared to 1.0 baseline" (already in test file — verify it passes with existing model logic)
    - Verify no existing nhl-blk-model tests break
  </behavior>
  <action>
In `run_nhl_player_shots_model.js`, locate the `projectBlkV1({...})` call at ~line 3093 (inside the `if (blkMarket)` block).

Before the `projectBlkV1` call, add two factor derivations:

```javascript
// BLK: opponent attempt factor — how much the opponent generates shots (defender blocks opportunity)
// Uses opponent's corsi proxy already fetched by factorRow query above.
const blkOppAttemptFactor = Number.isFinite(factorRow?.opponent_pace_proxy) &&
  factorRow.opponent_pace_proxy > 0
  ? factorRow.opponent_pace_proxy
  : 1.0;

// BLK: playoff tightening — games in NHL playoff window get 1.06 boost
const blkGameDate = new Date(game.game_time_utc);
const blkGameMonth = blkGameDate.getUTCMonth() + 1; // 1-12
const blkGameDay = blkGameDate.getUTCDate();
const blkInPlayoffs =
  (blkGameMonth === 4 && blkGameDay >= 19) ||
  blkGameMonth === 5 ||
  blkGameMonth === 6;
const blkPlayoffFactor = blkInPlayoffs ? 1.06 : 1.0;
```

Then add these two fields to the `projectBlkV1({...})` call:
```javascript
opponent_attempt_factor: blkOppAttemptFactor,
playoff_tightening_factor: blkPlayoffFactor,
```

Note: `factorRow` may be undefined if the try/catch at ~line 1877 caught an error and never assigned it. Guard with optional chaining (`factorRow?.opponent_pace_proxy`). The `factorRow` variable is declared and set inside the try block, so it may not be in scope at the BLK call site. Inspect actual scoping — if `factorRow` is block-scoped to the try, either move the BLK factor computation inside the try block or hoist `opponentPaceProxy` to a higher-scoped variable (declare `let blkOppAttemptFactor = 1.0` before the try, set it inside).

In `apps/worker/src/models/__tests__/nhl-blk-model.test.js`, confirm the existing test "opponent_attempt_factor is clamped to [0.90, 1.12]" still passes after no model changes. Run test suite to verify no regressions.
  </action>
  <verify>
    <automated>node --experimental-vm-modules node_modules/.bin/jest apps/worker/src/models/__tests__/nhl-blk-model.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>All nhl-blk-model tests pass. `projectBlkV1` call in run_nhl_player_shots_model.js contains `opponent_attempt_factor` and `playoff_tightening_factor` fields. Both default to 1.0 when data unavailable.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Wire lines_to_price from blkLineCandidates for multi-line card pricing</name>
  <files>apps/worker/src/jobs/run_nhl_player_shots_model.js, apps/worker/src/models/__tests__/nhl-blk-model.test.js</files>
  <behavior>
    - lines_to_price passed as array of all line values from blkLineCandidates (not just [0])
    - When blkLineCandidates is empty (synthetic fallback), lines_to_price is [] (no change)
    - projectBlkV1 output contains fair_over_prob_by_line and fair_under_prob_by_line entries for every line in blkLineCandidates
    - Test: "lines_to_price with two distinct lines produces fair_over_prob_by_line entries for each" — already covered by existing multi-line test in test file; confirm passes
  </behavior>
  <action>
In `run_nhl_player_shots_model.js`, locate the `projectBlkV1({...})` call at ~line 3093.

Add `lines_to_price` to the call:
```javascript
lines_to_price: blkLineCandidates.map((c) => c.line).filter((l) => typeof l === 'number' && Number.isFinite(l)),
```

This passes all available market lines so the Poisson pricing loop in `projectBlkV1` produces `fair_over_prob_by_line` / `fair_under_prob_by_line` entries for each alternate line. When `EVENT_PRICING_DISABLED` is true, `blkLineCandidates` is already `[]` so `lines_to_price` becomes `[]` — no behavior change for disabled mode.

Also add a log line after `blkProjection` is computed to confirm multi-line output:
```javascript
if (blkLineCandidates.length > 1) {
  console.debug(`[${JOB_NAME}] [blk-multi-line] ${playerName}: pricing ${blkLineCandidates.length} lines: ${blkLineCandidates.map((c) => c.line).join(', ')}`);
}
```

In `apps/worker/src/models/__tests__/nhl-blk-model.test.js`, verify the existing test "fair_over_prob is monotonically decreasing as line increases" uses `lines_to_price: [0.5, 1.5, 2.5, 3.5, 4.5]` and still passes. No new test needed — existing test already covers multi-line pricing behavior.

Run the full nhl-blk-model test suite and the run_nhl_player_shots_model test suite to confirm no regressions.
  </action>
  <verify>
    <automated>node --experimental-vm-modules node_modules/.bin/jest apps/worker/src/models/__tests__/nhl-blk-model.test.js apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js --no-coverage 2>&1 | tail -30</automated>
  </verify>
  <done>lines_to_price field present in projectBlkV1 call. Multi-line test passes. run_nhl_player_shots_model test suite passes. grep confirms "lines_to_price" in the blkProjection call.</done>
</task>

</tasks>

<verification>
After both tasks:

1. `grep -n "opponent_attempt_factor\|playoff_tightening_factor\|lines_to_price" apps/worker/src/jobs/run_nhl_player_shots_model.js` — must show all three fields in the projectBlkV1 call block (~lines 3093–3109)
2. `node --experimental-vm-modules node_modules/.bin/jest apps/worker/src/models/__tests__/nhl-blk-model.test.js --no-coverage` — all tests pass
3. `node --experimental-vm-modules node_modules/.bin/jest apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js --no-coverage` — all tests pass
</verification>

<success_criteria>
- `opponent_attempt_factor` is derived from opponent's corsi proxy (factorRow.opponent_pace_proxy) and passed to projectBlkV1
- `playoff_tightening_factor` is 1.06 for games in NHL playoff window (April 19 – June 30), 1.0 otherwise
- `lines_to_price` is derived from all blkLineCandidates entries, not just index [0]
- No existing tests broken
- Both model test files pass clean
</success_criteria>

<output>
After completion, create `.planning/quick/133-nhl-blk-model-audit-opponent-factor-play/133-SUMMARY.md` following the summary template. Update `.planning/STATE.md` quick tasks table with entry #133.
</output>
