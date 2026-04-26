---
phase: mlb-model-port
plan: 05
type: execute
wave: 5
depends_on: [mlb-04]
files_modified:
  - packages/data/db/migrations/042_create_mlb_pitcher_game_logs.sql
  - apps/worker/src/jobs/pull_mlb_pitcher_stats.js
  - apps/worker/src/models/mlb-model.js
  - scripts/backtest_mlb.js
autonomous: true
must_haves:
  truths:
    - "mlb_pitcher_game_logs table stores one row per pitcher start (game_pk, mlb_pitcher_id, game_date, ip, strikeouts, walks, hits, earned_runs, season)."
    - "pull_mlb_pitcher_stats.js stores raw game logs to mlb_pitcher_game_logs in addition to the existing upsert to mlb_pitcher_stats."
    - "computeKPerNineAsOf(mlbPitcherId, asOfDate, db) computes k_per_9 and recent_ip from game_logs WHERE game_date < asOfDate — true walk-forward."
    - "scripts/backtest_mlb.js replays the JS model against settled card_results and prints win rates by confidence tier."
  artifacts:
    - path: "packages/data/db/migrations/042_create_mlb_pitcher_game_logs.sql"
      provides: "Raw per-start game log storage — enables walk-forward backtest"
    - path: "scripts/backtest_mlb.js"
      provides: "Standalone backtest script: reads settled MLB cards → replays model → prints win rates"
---

<objective>
Close Gap 2: store raw pitcher game logs and build the JS walk-forward backtest.

Purpose: The Python backtest works because it queries game_logs WHERE game_date < as_of_date. We need the same capability in JS. Store raw starts to DB, expose a computeKPerNineAsOf() function, and ship a backtest script that replays the model against settled card_results so you can validate thresholds without the Python side.
Output: Migration + updated ingest job + computeKPerNineAsOf helper + scripts/backtest_mlb.js.
</objective>

<context>
@apps/worker/src/jobs/pull_mlb_pitcher_stats.js
@apps/worker/src/models/mlb-model.js
@packages/data/db/migrations/041_create_mlb_game_weather.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migration 042_create_mlb_pitcher_game_logs.sql</name>
  <files>packages/data/db/migrations/042_create_mlb_pitcher_game_logs.sql</files>
  <action>Create migration:

```sql
CREATE TABLE IF NOT EXISTS mlb_pitcher_game_logs (
  id              TEXT PRIMARY KEY,
  mlb_pitcher_id  INTEGER NOT NULL,
  game_pk         INTEGER NOT NULL,
  game_date       TEXT NOT NULL,
  season          INTEGER NOT NULL,
  innings_pitched REAL,
  strikeouts      INTEGER,
  walks           INTEGER,
  hits            INTEGER,
  earned_runs     INTEGER,
  opponent        TEXT,
  home_away       TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mlb_pitcher_id, game_pk)
);

CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_pitcher_date
  ON mlb_pitcher_game_logs (mlb_pitcher_id, game_date);

CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_season
  ON mlb_pitcher_game_logs (mlb_pitcher_id, season, game_date);
```
</action>
  <verify>echo "Migration file created"</verify>
  <done>File exists and is valid SQL.</done>
</task>

<task type="auto">
  <name>Task 2: Update pull_mlb_pitcher_stats.js to store raw game logs</name>
  <files>apps/worker/src/jobs/pull_mlb_pitcher_stats.js</files>
  <action>Add `ensureGameLogsTable(db)` and `upsertGameLogs(db, mlbPitcherId, gameLogSplits, season)` functions, then call them in the main job after the existing pitcher stats upsert.

**ensureGameLogsTable** (inline CREATE TABLE IF NOT EXISTS — same pattern as ensurePitcherStatsTable):
```js
function ensureGameLogsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_pitcher_game_logs (
      id              TEXT PRIMARY KEY,
      mlb_pitcher_id  INTEGER NOT NULL,
      game_pk         INTEGER NOT NULL,
      game_date       TEXT NOT NULL,
      season          INTEGER NOT NULL,
      innings_pitched REAL,
      strikeouts      INTEGER,
      walks           INTEGER,
      hits            INTEGER,
      earned_runs     INTEGER,
      opponent        TEXT,
      home_away       TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (mlb_pitcher_id, game_pk)
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_pitcher_date
      ON mlb_pitcher_game_logs (mlb_pitcher_id, game_date);
  `);
}
```

**upsertGameLogs**: The gameLog splits come from the `GET /people/{id}/stats?stats=gameLog` response. Each split has:
- `game.gamePk` → game_pk
- `date` → game_date (format "2025-04-02")
- `stat.inningsPitched` → innings_pitched
- `stat.strikeOuts` → strikeouts
- `stat.baseOnBalls` → walks
- `stat.hits` → hits
- `stat.earnedRuns` → earned_runs
- `game.teams.away.team.name` / home detection via `game.teams.home.team.id` matching pitcher team

```js
function upsertGameLogs(db, mlbPitcherId, splits, season) {
  ensureGameLogsTable(db);
  const stmt = db.prepare(`
    INSERT INTO mlb_pitcher_game_logs
      (id, mlb_pitcher_id, game_pk, game_date, season,
       innings_pitched, strikeouts, walks, hits, earned_runs, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mlb_pitcher_id, game_pk) DO UPDATE SET
      innings_pitched = excluded.innings_pitched,
      strikeouts = excluded.strikeouts,
      walks = excluded.walks,
      hits = excluded.hits,
      earned_runs = excluded.earned_runs,
      updated_at = datetime('now')
  `);
  let count = 0;
  for (const split of splits) {
    const gamePk = split?.game?.gamePk;
    const gameDate = split?.date;
    if (!gamePk || !gameDate) continue;
    const stat = split?.stat ?? {};
    stmt.run(
      uuidV4(),
      mlbPitcherId,
      gamePk,
      gameDate,
      season,
      parseFloat(stat.inningsPitched) || null,
      parseInt(stat.strikeOuts, 10) || null,
      parseInt(stat.baseOnBalls, 10) || null,
      parseInt(stat.hits, 10) || null,
      parseInt(stat.earnedRuns, 10) || null,
    );
    count += 1;
  }
  return count;
}
```

In the main job function, after building the per-pitcher stats, call `upsertGameLogs(db, pitcherId, gameLogSplits, 2026)`. The `gameLogSplits` are already fetched in the existing code — just pass them through instead of discarding after computing recent_k_per_9.

Pass all splits (not just last 5) to upsertGameLogs. The recent_k_per_9 computation can still use only the last 5 for the mlb_pitcher_stats upsert.

Also export `upsertGameLogs` and `ensureGameLogsTable` from module.exports for use by the backtest script.
</action>
  <verify>node apps/worker/src/jobs/pull_mlb_pitcher_stats.js --dry-run</verify>
  <done>Dry run exits 0. Live run populates both mlb_pitcher_stats and mlb_pitcher_game_logs.</done>
</task>

<task type="auto">
  <name>Task 3: Add computeKPerNineAsOf to mlb-model.js</name>
  <files>apps/worker/src/models/mlb-model.js</files>
  <action>Add a walk-forward helper that replicates the Python anti-look-ahead mechanism. This function takes a DB instance so it can be called from the backtest script without coupling the model to DB imports at module load time.

```js
/**
 * Compute pitcher K/9 and recent IP as-of a specific date.
 * Uses only game logs WHERE game_date < asOfDate — true walk-forward simulation.
 * Anti-look-ahead: same guarantee as Python BacktestEngine.get_pitcher_data_as_of_date().
 *
 * @param {number} mlbPitcherId
 * @param {string} asOfDate - 'YYYY-MM-DD'
 * @param {object} db - better-sqlite3 database instance
 * @param {number} recentStarts - number of recent starts for recent_k_per_9 (default 5)
 * @returns {{ k_per_9, recent_k_per_9, recent_ip, era, whip } | null}
 */
function computePitcherStatsAsOf(mlbPitcherId, asOfDate, db, recentStarts = 5) {
  // All starts before asOfDate in current season
  const season = new Date(asOfDate).getFullYear();
  const allStarts = db.prepare(`
    SELECT innings_pitched, strikeouts, walks, hits, earned_runs, game_date
    FROM mlb_pitcher_game_logs
    WHERE mlb_pitcher_id = ?
      AND season = ?
      AND game_date < ?
      AND innings_pitched > 0
    ORDER BY game_date DESC
  `).all(mlbPitcherId, season, asOfDate);

  if (allStarts.length === 0) return null;

  // Season totals
  const totalIp = allStarts.reduce((s, r) => s + (r.innings_pitched ?? 0), 0);
  const totalK  = allStarts.reduce((s, r) => s + (r.strikeouts ?? 0), 0);
  const totalBb = allStarts.reduce((s, r) => s + (r.walks ?? 0), 0);
  const totalH  = allStarts.reduce((s, r) => s + (r.hits ?? 0), 0);
  const totalEr = allStarts.reduce((s, r) => s + (r.earned_runs ?? 0), 0);

  const k_per_9 = totalIp > 0 ? (totalK / totalIp) * 9 : null;
  const era = totalIp > 0 ? (totalEr / totalIp) * 9 : null;
  const whip = totalIp > 0 ? (totalBb + totalH) / totalIp : null;

  // Recent starts
  const recent = allStarts.slice(0, recentStarts);
  const recentIpSum = recent.reduce((s, r) => s + (r.innings_pitched ?? 0), 0);
  const recentKSum  = recent.reduce((s, r) => s + (r.strikeouts ?? 0), 0);

  const recent_k_per_9 = recentIpSum > 0 ? (recentKSum / recentIpSum) * 9 : k_per_9;
  const recent_ip = recent.length > 0 ? recentIpSum / recent.length : null;

  return { k_per_9, recent_k_per_9, recent_ip, era, whip, starts: allStarts.length };
}
```

Add to module.exports.
</action>
  <verify>node -e "const {computePitcherStatsAsOf}=require('./apps/worker/src/models/mlb-model'); console.log(typeof computePitcherStatsAsOf)"</verify>
  <done>computePitcherStatsAsOf is exported as a function.</done>
</task>

<task type="auto">
  <name>Task 4: Create scripts/backtest_mlb.js</name>
  <files>scripts/backtest_mlb.js</files>
  <action>Create standalone backtest script. Reads settled MLB card_results from DB, replays the model with as_of_date stats, groups by confidence tier, reports win rates.

```js
#!/usr/bin/env node
'use strict';
/**
 * MLB Model Backtest
 *
 * Replays the JS MLB model against settled card_results.
 * Uses computePitcherStatsAsOf() for true walk-forward simulation.
 *
 * Usage:
 *   node scripts/backtest_mlb.js
 *   node scripts/backtest_mlb.js --sport mlb --days 60
 *   node scripts/backtest_mlb.js --min-conf 7
 */

require('dotenv').config();
const { getDatabase, withDb } = require('./packages/data');
const { computePitcherStatsAsOf, projectStrikeouts } = require('./apps/worker/src/models/mlb-model');

function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 365, minConf: 1, market: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i+1]) { args.days = parseInt(argv[++i], 10); }
    if (argv[i] === '--min-conf' && argv[i+1]) { args.minConf = parseInt(argv[++i], 10); }
    if (argv[i] === '--market' && argv[i+1]) { args.market = argv[++i]; }
  }
  return args;
}

function confidenceBucket(conf) {
  if (conf >= 9) return 'HIGH (9-10)';
  if (conf >= 8) return 'HIGH (8-10)';
  if (conf >= 7) return 'MED (7-8)';
  return 'LOW (<7)';
}

async function main() {
  const args = parseArgs();

  await withDb(() => {
    const db = getDatabase();

    // Load settled MLB strikeout cards with game_date and pitcher data
    // card_payloads.payload_data has the prediction, odds_snapshot has raw_data
    // card_results has status (won/lost/push) and result
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - args.days);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const settledCards = db.prepare(`
      SELECT
        cr.card_id,
        cr.game_id,
        cr.status,
        cr.result,
        cr.settled_at,
        cp.payload_data,
        os.raw_data,
        os.captured_at,
        g.game_time_utc
      FROM card_results cr
      JOIN card_payloads cp ON cr.card_id = cp.id
      JOIN games g ON cr.game_id = g.game_id
      LEFT JOIN odds_snapshots os ON os.game_id = cr.game_id
      WHERE cr.sport = 'MLB'
        AND cr.status IN ('won', 'lost', 'push')
        AND date(cr.settled_at) >= ?
      ORDER BY cr.settled_at DESC
    `).all(cutoffStr);

    if (settledCards.length === 0) {
      console.log('No settled MLB cards found. Run the model for a few weeks first.');
      console.log(`Checked from: ${cutoffStr}`);
      process.exit(0);
    }

    // Group by confidence tier
    const tiers = {};
    let total = 0, replayed = 0, skipped = 0;

    for (const card of settledCards) {
      total++;
      const payload = (() => {
        try { return typeof card.payload_data === 'string' ? JSON.parse(card.payload_data) : card.payload_data; }
        catch { return {}; }
      })();
      const raw = (() => {
        try { return typeof card.raw_data === 'string' ? JSON.parse(card.raw_data) : (card.raw_data ?? {}); }
        catch { return {}; }
      })();

      const mlb = raw?.mlb ?? {};
      const gameDate = (card.game_time_utc ?? card.settled_at ?? '').slice(0, 10);
      if (!gameDate) { skipped++; continue; }

      // Re-run strikeout projection with as_of_date stats if pitcher ID available
      const homePitcherId = mlb?.home_pitcher?.mlb_id ?? null;
      const line = mlb?.strikeout_lines?.home ?? payload?.market?.total ?? null;

      if (!line) { skipped++; continue; }

      let pitcherStats = mlb?.home_pitcher ?? null;
      if (homePitcherId) {
        pitcherStats = computePitcherStatsAsOf(homePitcherId, gameDate, db) ?? pitcherStats;
      }
      if (!pitcherStats?.k_per_9) { skipped++; continue; }

      const result = projectStrikeouts(pitcherStats, line, {
        wind_mph: mlb?.wind_mph ?? null,
        temp_f: mlb?.temp_f ?? null,
      });
      if (!result || result.prediction === 'PASS') { skipped++; continue; }

      const conf = result.confidence;
      const bucket = confidenceBucket(conf);
      if (!tiers[bucket]) tiers[bucket] = { wins: 0, losses: 0, pushes: 0 };

      const outcome = card.result ?? card.status;
      if (outcome === 'won') tiers[bucket].wins++;
      else if (outcome === 'lost') tiers[bucket].losses++;
      else if (outcome === 'push') tiers[bucket].pushes++;

      replayed++;
    }

    // Print report
    console.log('\n========================================');
    console.log('  MLB Strikeout Model Backtest Report');
    console.log('========================================');
    console.log(`Period: Last ${args.days} days (from ${cutoffStr})`);
    console.log(`Cards: ${total} settled, ${replayed} replayed, ${skipped} skipped\n`);

    if (replayed === 0) {
      console.log('Not enough data yet. Need settled MLB strikeout cards.');
      return;
    }

    const allTiers = ['HIGH (9-10)', 'HIGH (8-10)', 'MED (7-8)', 'LOW (<7)'];
    console.log('Confidence Tier | W    | L    | P  | Win Rate');
    console.log('----------------|------|------|----|---------');
    for (const tier of allTiers) {
      const t = tiers[tier];
      if (!t) continue;
      const total = t.wins + t.losses + t.pushes;
      const winRate = total > 0 ? ((t.wins / total) * 100).toFixed(1) : 'N/A';
      console.log(`${tier.padEnd(16)}| ${String(t.wins).padEnd(5)}| ${String(t.losses).padEnd(5)}| ${String(t.pushes).padEnd(3)}| ${winRate}%`);
    }
    console.log('\nTarget: HIGH (8-10) >= 80% win rate per spec backtest');
  });
}

main().catch(err => {
  console.error('Backtest error:', err.message);
  process.exit(1);
});
```
</action>
  <verify>node scripts/backtest_mlb.js --days 30 2>&1 | head -20</verify>
  <done>Script runs without error. Reports "No settled MLB cards found" (expected early in season) or prints a tier table.</done>
</task>

</tasks>

<verification>
- node apps/worker/src/jobs/pull_mlb_pitcher_stats.js --dry-run exits 0
- node -e "const {computePitcherStatsAsOf}=require('./apps/worker/src/models/mlb-model'); console.log(typeof computePitcherStatsAsOf)" → function
- node scripts/backtest_mlb.js --days 30 runs without crash
</verification>

<success_criteria>
- Raw game logs stored per start (not just pre-computed recent stats)
- computePitcherStatsAsOf uses WHERE game_date < asOfDate — no look-ahead
- Backtest script produces tier table once settled cards exist; exits cleanly with message when no data yet
- No regression to existing pull_mlb_pitcher_stats behavior
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-model-port/mlb-05-SUMMARY.md`
</output>
