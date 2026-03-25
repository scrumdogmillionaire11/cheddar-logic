---
phase: mlb-model-port
plan: 03
type: execute
wave: 3
depends_on: [mlb-01, mlb-02]
files_modified:
  - apps/worker/src/models/index.js
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/schedulers/main.js
autonomous: true
must_haves:
  truths:
    - "getInference('MLB', ...) calls computeMLBDriverCards and returns best card result instead of falling through to mock constant."
    - "run_mlb_model.js enriches each oddsSnapshot with pitcher data from DB before calling model.infer."
    - "pull_mlb_pitcher_stats runs as a pre-model job in scheduler on the same cadence as run_mlb_model."
    - "computeMLBDriverCards is exported from models/index.js."
    - "MLB inference result has is_mock: false when pitcher data is present."
  artifacts:
    - path: "apps/worker/src/models/index.js"
      provides: "MLB branch in getInference + computeMLBDriverCards export"
    - path: "apps/worker/src/jobs/run_mlb_model.js"
      provides: "Pitcher enrichment before model.infer"
    - path: "apps/worker/src/schedulers/main.js"
      provides: "pull_mlb_pitcher_stats wired as MLB pre-model job"
  key_links:
    - from: "apps/worker/src/jobs/run_mlb_model.js"
      to: "apps/worker/src/models/index.js"
      via: "model.infer(gameId, enrichedOddsSnapshot)"
      pattern: "enrichMlbPitcherData|raw_data.*mlb"
    - from: "apps/worker/src/schedulers/main.js"
      to: "apps/worker/src/jobs/pull_mlb_pitcher_stats.js"
      via: "pre-model job chain"
      pattern: "pull_mlb_pitcher_stats"
---

<objective>
Wire the MLB model into the live inference and scheduling pipeline.

Purpose: Replace mock constant fallback with real computeMLBDriverCards output. Add pitcher data enrichment in run_mlb_model.js. Register pull_mlb_pitcher_stats as a pre-model job so pitchers are fresh before inference runs.
Output: End-to-end MLB inference path that reads real pitcher data and emits cards with is_mock=false.
</objective>

<context>
@apps/worker/src/models/index.js
@apps/worker/src/jobs/run_mlb_model.js
@apps/worker/src/schedulers/main.js
@apps/worker/src/jobs/pull_mlb_pitcher_stats.js
@apps/worker/src/models/mlb-model.js
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add computeMLBDriverCards to models/index.js and wire getInference MLB branch</name>
  <files>apps/worker/src/models/index.js</files>
  <action>
1. At the top of the file, require mlb-model:
   ```js
   const { computeMLBDriverCards } = require('./mlb-model');
   ```

2. In getInference, find the comment `// Remaining sports (NFL, MLB, FPL)` (around line 1948) and insert before it:
   ```js
   if (sport === 'MLB') {
     const mlbCards = computeMLBDriverCards(gameId, oddsSnapshot);
     if (mlbCards.length > 0) {
       const best = mlbCards.reduce((a, b) => b.confidence > a.confidence ? b : a);
       return {
         prediction: best.prediction,
         confidence: best.confidence,
         ev_threshold_passed: best.ev_threshold_passed,
         reasoning: best.reasoning,
         drivers: mlbCards,
         inference_source: 'local',
         model_endpoint: null,
         is_mock: false,
       };
     }
   }
   ```
   (If no cards returned — no pitcher data yet — falls through to mock constant as before.)

3. Add computeMLBDriverCards to module.exports.
</action>
  <verify>node -e "const {computeMLBDriverCards,getModel}=require('./apps/worker/src/models'); console.log(typeof computeMLBDriverCards)"</verify>
  <done>computeMLBDriverCards is a function in the exports. getInference('MLB', ...) with enriched snapshot returns is_mock=false.</done>
</task>

<task type="auto">
  <name>Task 2: Add pitcher enrichment in run_mlb_model.js</name>
  <files>apps/worker/src/jobs/run_mlb_model.js</files>
  <action>
1. Add require at top:
   ```js
   const { getDatabase } = require('@cheddar-logic/data');
   ```

2. Add enrichMlbPitcherData helper function (inline, before runMLBModel):
   ```js
   function enrichMlbPitcherData(oddsSnapshot) {
     // Reads pitcher stats from DB for today's probable pitchers.
     // Attaches to raw_data.mlb. Fails gracefully if no rows found.
     const mlbIdHome = oddsSnapshot?.raw_data?.mlb?.home_pitcher_mlb_id ?? null;
     const mlbIdAway = oddsSnapshot?.raw_data?.mlb?.away_pitcher_mlb_id ?? null;

     try {
       const db = getDatabase();
       const lookup = db.prepare(
         'SELECT * FROM mlb_pitcher_stats WHERE mlb_id = ? LIMIT 1'
       );

       const homePitcher = mlbIdHome ? (lookup.get(mlbIdHome) ?? null) : null;
       const awayPitcher = mlbIdAway ? (lookup.get(mlbIdAway) ?? null) : null;

       const existingRaw = typeof oddsSnapshot.raw_data === 'string'
         ? JSON.parse(oddsSnapshot.raw_data)
         : (oddsSnapshot.raw_data ?? {});

       const mlb = existingRaw.mlb ?? {};

       return {
         ...oddsSnapshot,
         raw_data: {
           ...existingRaw,
           mlb: {
             ...mlb,
             home_pitcher: homePitcher ? {
               era: homePitcher.era,
               whip: homePitcher.whip,
               k_per_9: homePitcher.k_per_9,
               recent_k_per_9: homePitcher.recent_k_per_9,
               avg_ip: homePitcher.recent_ip,
             } : mlb.home_pitcher ?? null,
             away_pitcher: awayPitcher ? {
               era: awayPitcher.era,
               whip: awayPitcher.whip,
               k_per_9: awayPitcher.k_per_9,
               recent_k_per_9: awayPitcher.recent_k_per_9,
               avg_ip: awayPitcher.recent_ip,
             } : mlb.away_pitcher ?? null,
           },
         },
       };
     } catch (err) {
       console.warn(`[MLBModel] Pitcher enrichment failed: ${err.message}`);
       return oddsSnapshot; // proceed without enrichment
     }
   }
   ```

   NOTE: The pitcher MLB IDs (home_pitcher_mlb_id / away_pitcher_mlb_id) need to be in raw_data.mlb from the odds snapshot OR we look them up by team name. For now: pull_mlb_pitcher_stats already runs before run_mlb_model — it can store a side table of `today_game_pitchers` keyed by game_id. Alternatively, enrich by game_id lookup:

   Simpler approach — query by approximate team+date match is fragile. Better: pull_mlb_pitcher_stats stores a `today_game_pitchers` map as a JSON blob in `job_runs` metadata, OR the enrichment reads `mlb_pitcher_stats` ordered by updated_at to get all pitchers refreshed today and matches by team name.

   **Use team name matching**: In pull_mlb_pitcher_stats, store `team` field. In enrichMlbPitcherData:
   ```js
   const homeTeam = oddsSnapshot?.home_team ?? '';
   const awayTeam = oddsSnapshot?.away_team ?? '';
   const byTeam = db.prepare(
     "SELECT * FROM mlb_pitcher_stats WHERE team = ? AND date(updated_at) = date('now') LIMIT 1"
   );
   const homePitcher = homeTeam ? (byTeam.get(homeTeam) ?? null) : null;
   const awayPitcher = awayTeam ? (byTeam.get(awayTeam) ?? null) : null;
   ```

   Use this team-name approach (simpler, no schema change needed).

3. In the game processing loop inside runMLBModel, before `const modelOutput = await model.infer(...)`:
   ```js
   let oddsSnapshot = gameOdds[gameId];
   oddsSnapshot = enrichMlbPitcherData(oddsSnapshot);
   const modelOutput = await model.infer(gameId, oddsSnapshot);
   ```
   (Replace the existing `const oddsSnapshot = gameOdds[gameId];` line.)

4. Also need to set strikeout_lines and f5_line in raw_data.mlb from the odds snapshot fields. Add to enrichMlbPitcherData:
   ```js
   // Attach market lines from odds snapshot to raw_data.mlb
   mlb.total_line = oddsSnapshot.total ?? mlb.total_line ?? null;
   mlb.f5_line = oddsSnapshot.total_f5 ?? mlb.f5_line ?? null;
   // Strikeout lines come from player_prop_lines table — out of scope for this WI.
   // Leave strikeout_lines as-is (from existing raw_data or null).
   ```
</action>
  <verify>node -e "require('./apps/worker/src/jobs/run_mlb_model')" && echo OK</verify>
  <done>File loads without error. runMLBModel with dryRun=true exits 0.</done>
</task>

<task type="auto">
  <name>Task 3: Register pull_mlb_pitcher_stats in scheduler</name>
  <files>apps/worker/src/schedulers/main.js</files>
  <action>
1. Add require near other job imports:
   ```js
   const { pullMlbPitcherStats } = require('../jobs/pull_mlb_pitcher_stats');
   ```

2. Find where the MLB model job is queued (search for `run_mlb_model` / `ENABLE_MLB_MODEL`). Before that block, add a pre-model pitcher stats pull:
   ```js
   // Pre-model: refresh MLB pitcher stats ~2h before game time
   if (process.env.ENABLE_MLB_MODEL !== 'false') {
     const pitcherJobKey = `pull_mlb_pitcher_stats|${nowEt.toISODate()}`;
     jobs.push({
       jobName: 'pull_mlb_pitcher_stats',
       jobKey: pitcherJobKey,
       execute: pullMlbPitcherStats,
       args: { jobKey: pitcherJobKey, dryRun },
       reason: 'pre-model MLB pitcher stats refresh',
     });
   }
   ```

   Place this block immediately before (not after) the block that queues run_mlb_model, so pull runs first in the same scheduler tick.

   Read the surrounding context carefully before inserting — follow the exact same jobs.push() pattern used by neighboring sport blocks.
</action>
  <verify>node -e "require('./apps/worker/src/schedulers/main')" && echo OK</verify>
  <done>Scheduler loads. pull_mlb_pitcher_stats appears in SPORT_JOBS or is pushed before run_mlb_model in the same tick.</done>
</task>

</tasks>

<verification>
- node apps/worker/src/jobs/run_mlb_model.js exits 0 (dryRun path or no-games path)
- node -e "const {getInference}=require('./apps/worker/src/models'); const snap={home_team:'NYY',away_team:'BOS',raw_data:{mlb:{home_pitcher:{k_per_9:10,recent_k_per_9:11,recent_ip:6,era:2.8,whip:1.05},away_pitcher:{k_per_9:7,recent_k_per_9:6.5,recent_ip:5,era:4.5,whip:1.4},strikeout_lines:{home:6.5},f5_line:4.5}}}; getInference('MLB','g1',snap).then(r=>console.log(r.is_mock, r.inference_source))"
  → prints: false local
- npm --prefix apps/worker test runs without new failures
</verification>

<success_criteria>
- is_mock: false when pitcher data present in raw_data.mlb
- Falls back to mock constant gracefully when no pitcher data (missing raw_data.mlb)
- Scheduler loads cleanly; pull_mlb_pitcher_stats queued before run_mlb_model
- No circular requires introduced
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-model-port/mlb-03-SUMMARY.md`
</output>
