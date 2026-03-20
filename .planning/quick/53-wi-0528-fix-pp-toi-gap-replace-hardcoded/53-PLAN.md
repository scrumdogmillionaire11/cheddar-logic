---
phase: quick
plan: 53
type: execute
wave: 1
depends_on: []
files_modified:
  - apps/worker/src/jobs/pull_nhl_player_shots.js
  - apps/worker/src/jobs/run_nhl_player_shots_model.js
  - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
autonomous: true
requirements: [WI-0528]
must_haves:
  truths:
    - "PP-heavy players have toi_proj_pp > 0 passed to projectSogV2 when avgPpToi is present in raw_data"
    - "Players with no avgPpToi in raw_data get toi_proj_pp: 0 (safe fallback — no regression)"
    - "pull_nhl_player_shots enriches rawData with ppToi from featuredStats.regularSeason.subSeason.avgPpToi"
    - "New tests prove toi_proj_pp is read from rawData and forwarded to projectSogV2"
  artifacts:
    - path: "apps/worker/src/jobs/pull_nhl_player_shots.js"
      provides: "ppToi field in enrichedRawData from subSeason.avgPpToi"
    - path: "apps/worker/src/jobs/run_nhl_player_shots_model.js"
      provides: "toi_proj_pp read from rawData.ppToi instead of hardcoded 0"
    - path: "apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js"
      provides: "Tests verifying toi_proj_pp forwarding"
  key_links:
    - from: "pull_nhl_player_shots.js enrichedRawData"
      to: "player_shot_logs.raw_data (JSON column)"
      via: "upsertPlayerShotLog"
      pattern: "ppToi.*avgPpToi"
    - from: "run_nhl_player_shots_model.js rawData.ppToi"
      to: "projectSogV2 toi_proj_pp argument"
      via: "JSON.parse(raw_data).ppToi"
      pattern: "toi_proj_pp.*ppToi"
---

<objective>
Replace the hardcoded `toi_proj_pp: 0` in the NHL shots pipeline with real PP TOI derived from the NHL Stats API `featuredStats.regularSeason.subSeason.avgPpToi` field.

Purpose: PP-heavy players (power play units 1 and 2) contribute shots during man-advantage situations. Zeroing their PP contribution causes `projectSogV2` to systematically underproject their `sog_mu`, producing false COLD signals and suppressed opportunity scores.

Output: `pull_nhl_player_shots.js` stores `ppToi` in `rawData`; `run_nhl_player_shots_model.js` reads it back and passes it as `toi_proj_pp`; 2 new tests verify the wiring end-to-end.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
</context>

<interfaces>
<!-- Key contracts the executor needs. No codebase exploration required. -->

From apps/worker/src/jobs/pull_nhl_player_shots.js (buildLogRows function, lines 216-261):
The enrichedRawData object is built by spreading `game` (a `last5Games` entry) and adding
computed season-level fields. Currently adds:
  - `shotsPer60: seasonShotsPer60`
  - `projToi: <parsed from sub.avgToi>`

The NHL Stats API `featuredStats.regularSeason.subSeason` object contains:
  - `avgToi` — average total TOI per game ("MM:SS" string)
  - `avgPpToi` — average PP TOI per game ("MM:SS" string, present for forwards/D)
  - `shots`, `gamesPlayed` — used for shotsPer60 calculation

`parseToiMinutes(toi)` is already in scope. It accepts "MM:SS" strings and returns minutes as
a float (e.g., "2:30" → 2.5). Returns null for null/undefined input.

From apps/worker/src/jobs/run_nhl_player_shots_model.js (lines 828-839):
```javascript
let shotsPer60 = null;
let projToi = null;
if (l5Games[0]?.raw_data) {
  try {
    const rawData = JSON.parse(l5Games[0].raw_data);
    shotsPer60 = rawData.shotsPer60 || null;
    projToi = rawData.projToi || l5Games[0].toi_minutes || null;
  } catch {
    // Ignore parse errors
  }
}
```
And the projectSogV2 call (lines 1031-1051):
```javascript
const v2Projection = projectSogV2({
  ...
  toi_proj_ev: projToi ?? 0,
  toi_proj_pp: 0, // TODO(WI-NEXT): PP TOI not yet tracked — needs pp_toi from game logs
  ...
});
```

From apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js (lines 46-68):
`buildGames(n)` and `buildGamesFromShots(shotsByGame)` build mock `player_shot_logs` rows.
The `raw_data` field is currently set to `'{}'`.

Test pattern for verifying projectSogV2 call args (lines 700-770):
```javascript
const { shots } = loadFreshModule();
shots.projectSogV2.mockReturnValue({ sog_mu: 2.5, ... });
// ... set up db with buildGamesFromShots([3,3,3,3,3]) ...
// ... run the job ...
expect(shots.projectSogV2).toHaveBeenCalledWith(
  expect.objectContaining({ toi_proj_pp: <expected> })
);
```
</interfaces>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Enrich rawData with ppToi in pull_nhl_player_shots.js</name>
  <files>apps/worker/src/jobs/pull_nhl_player_shots.js</files>
  <behavior>
    - `computeSeasonPpToi(payload)` returns null when `subSeason` is missing
    - `computeSeasonPpToi(payload)` returns null when `subSeason.avgPpToi` is absent or not an "MM:SS" string
    - `computeSeasonPpToi(payload)` returns 2.5 for `avgPpToi: "2:30"`
    - `computeSeasonPpToi(payload)` returns 0.0 for `avgPpToi: "0:00"`
    - `buildLogRows` includes `ppToi: 2.5` in `enrichedRawData` when avgPpToi is "2:30"
    - `buildLogRows` includes `ppToi: null` in `enrichedRawData` when avgPpToi is absent
  </behavior>
  <action>
Add a `computeSeasonPpToi(payload)` function modeled after `computeSeasonShotsPer60`:

```javascript
function computeSeasonPpToi(payload) {
  const sub = payload?.featuredStats?.regularSeason?.subSeason;
  if (!sub) return null;
  if (!sub.avgPpToi || typeof sub.avgPpToi !== 'string' || !sub.avgPpToi.includes(':')) {
    return null;
  }
  const parsed = parseToiMinutes(sub.avgPpToi);
  return Number.isFinite(parsed) ? parsed : null;
}
```

Then add `ppToi` to `enrichedRawData` inside `buildLogRows`:

```javascript
const enrichedRawData = {
  ...game,
  shotsPer60: seasonShotsPer60,
  projToi: (() => { ... })(),   // existing
  ppToi: computeSeasonPpToi(payload),  // NEW
};
```

Note: `buildLogRows` receives `payload` as its second argument (already the case).
Check the function signature — it is `function buildLogRows(playerId, payload, fetchedAt)`.
Place `computeSeasonPpToi` immediately after `computeSeasonShotsPer60` (around line 214).
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>All existing pull_nhl_player_shots tests pass. New `computeSeasonPpToi` behavior tests pass. `ppToi` is present in enrichedRawData for players with avgPpToi and null for those without.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Read ppToi from rawData and wire into projectSogV2 in run_nhl_player_shots_model.js + tests</name>
  <files>
    apps/worker/src/jobs/run_nhl_player_shots_model.js
    apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
  </files>
  <behavior>
    - When `raw_data` contains `ppToi: 2.5`, `projectSogV2` is called with `toi_proj_pp: 2.5`
    - When `raw_data` contains `ppToi: null` or `ppToi` is absent, `projectSogV2` is called with `toi_proj_pp: 0`
    - When `raw_data` is `'{}'` (legacy rows), `projectSogV2` is called with `toi_proj_pp: 0` (no regression)
  </behavior>
  <action>
**In run_nhl_player_shots_model.js** (lines 828-839): extend the rawData extraction block to also read `ppToi`:

```javascript
let shotsPer60 = null;
let projToi = null;
let ppToi = 0;  // NEW — default 0 for safe fallback on legacy log rows
if (l5Games[0]?.raw_data) {
  try {
    const rawData = JSON.parse(l5Games[0].raw_data);
    shotsPer60 = rawData.shotsPer60 || null;
    projToi = rawData.projToi || l5Games[0].toi_minutes || null;
    ppToi = Number.isFinite(rawData.ppToi) && rawData.ppToi > 0 ? rawData.ppToi : 0;  // NEW
  } catch {
    // Ignore parse errors
  }
}
```

Then at line 1044, replace the hardcoded `toi_proj_pp: 0` with:
```javascript
toi_proj_pp: ppToi,  // WI-0528: real PP TOI from featuredStats.subSeason.avgPpToi (0 fallback for non-PP players)
```

Remove the old TODO comment.

**In run_nhl_player_shots_model.test.js**: Add two new tests to the existing describe block (after the current last test). Use the `buildGamesFromShots` helper but override `raw_data` to inject ppToi. Pattern:

```javascript
test('Test G: toi_proj_pp uses ppToi from raw_data when present', async () => {
  // raw_data with ppToi: 2.5
  const gamesWithPpToi = buildGamesFromShots([3,3,3,3,3]).map((g, i) =>
    i === 0 ? { ...g, raw_data: JSON.stringify({ shotsPer60: 9.0, projToi: 18.0, ppToi: 2.5 }) } : g
  );
  // build db, run job, assert projectSogV2 called with toi_proj_pp: 2.5
  expect(shots.projectSogV2).toHaveBeenCalledWith(
    expect.objectContaining({ toi_proj_pp: 2.5 })
  );
});

test('Test H: toi_proj_pp defaults to 0 when ppToi absent from raw_data (legacy rows)', async () => {
  // raw_data without ppToi field ('{}'  or legacy format)
  // assert projectSogV2 called with toi_proj_pp: 0
  expect(shots.projectSogV2).toHaveBeenCalledWith(
    expect.objectContaining({ toi_proj_pp: 0 })
  );
});
```

Follow the exact test scaffolding pattern used in existing Tests A-F (loadFreshModule, buildMockDb, db returns games, players, playerLogs, etc.). Look at tests at lines ~700-960 for the full pattern including `shots.projectSogV2.mockReturnValue(...)` and the `runNhlPlayerShotsModel(...)` call.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    All existing run_nhl_player_shots_model tests pass (no regression).
    Test G passes: `projectSogV2` receives `toi_proj_pp: 2.5` when rawData has `ppToi: 2.5`.
    Test H passes: `projectSogV2` receives `toi_proj_pp: 0` when rawData has no `ppToi`.
    `toi_proj_pp: 0` hardcode is gone from production code.
  </done>
</task>

</tasks>

<verification>
Full test suite passes for the affected files:

```bash
cd /Users/ajcolubiale/projects/cheddar-logic && npx jest apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js --no-coverage
```

Also confirm no references to the old TODO remain:
```bash
grep -n "PP TOI not yet tracked" /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_player_shots_model.js
```
Should return no output.
</verification>

<success_criteria>
- `computeSeasonPpToi` extracts `avgPpToi` from NHL API payload and returns minutes as float
- `enrichedRawData.ppToi` is populated in pull_nhl_player_shots.js (non-null for PP players)
- `toi_proj_pp: 0` hardcode replaced with `ppToi` variable in run_nhl_player_shots_model.js
- 2 new tests (Test G + Test H) prove the rawData → projectSogV2 wiring
- All existing tests remain passing (zero regression)
- PP-heavy players now receive non-zero `toi_proj_pp`, improving `sog_mu` accuracy
</success_criteria>

<output>
After completion, create `.planning/quick/53-wi-0528-fix-pp-toi-gap-replace-hardcoded/53-SUMMARY.md` following the standard summary template.
</output>
