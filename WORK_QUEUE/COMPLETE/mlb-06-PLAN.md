---
phase: mlb-model-port
plan: 06
type: execute
wave: 6
depends_on: [mlb-05]
files_modified:
  - apps/worker/src/jobs/pull_mlb_pitcher_stats.js
  - apps/worker/src/jobs/settle_mlb_f5.js
  - apps/worker/src/schedulers/main.js
autonomous: true
must_haves:
  truths:
    - "settle_mlb_f5.js fetches inning-by-inning linescore from statsapi.mlb.com/api/v1.1/game/{gamePk}/feed/live and sums innings 1-5 home+away runs."
    - "F5 actual total stored in game_results.metadata.f5_total as a number."
    - "pull_mlb_pitcher_stats.js stores mlb_game_pk in mlb_pitcher_stats (or a side table) so settle_mlb_f5 can look up gamePk from game_id."
    - "settle_mlb_f5 settles card_results rows with card_type='mlb-model-output' that have market='f5_total' using actual vs predicted F5 total."
    - "Job registered in scheduler to run after game completion window (T+4h post game_time)."
  artifacts:
    - path: "apps/worker/src/jobs/settle_mlb_f5.js"
      provides: "F5 settlement job — fetches linescore, grades OVER/UNDER/PUSH against actual first-5-innings total"
---

<objective>
Close Gap 3: fetch F5 actuals from MLB Stats API and settle F5 cards.

Purpose: The `/game/{gamePk}/feed/live` endpoint (free, public) provides inning-by-inning scores. Sum innings 1-5 to get the actual F5 total, compare to the predicted line, settle card_results rows. Without this, F5 cards stay pending indefinitely.
Output: settle_mlb_f5.js + gamePk storage + scheduler registration.
</objective>

<context>
@apps/worker/src/jobs/pull_mlb_pitcher_stats.js
@apps/worker/src/schedulers/main.js
@packages/data/db/migrations/008_create_game_results.sql
@packages/data/db/migrations/007_create_card_results.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Store mlb_game_pk in pull_mlb_pitcher_stats.js</name>
  <files>apps/worker/src/jobs/pull_mlb_pitcher_stats.js</files>
  <action>The schedule endpoint already returns `gamePk` for each game. Add a `mlb_game_pks` table (or store in mlb_pitcher_stats.metadata) to map `game_id → gamePk` so the settlement job can look it up.

Simplest approach: add a `game_pk INTEGER` column to `mlb_pitcher_stats` using `ensurePitcherStatsTable` (via ALTER TABLE IF NOT EXISTS pattern) — but that complicates the migration. Better: add a new small table inline in ensurePitcherStatsTable:

```js
function ensureMlbGamePkTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_pk_map (
      game_id   TEXT PRIMARY KEY,
      game_pk   INTEGER NOT NULL,
      game_date TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_game_pk_map_date
      ON mlb_game_pk_map (game_date);
  `);
}
```

In the main job function, after fetching the schedule, upsert each game's gamePk:
```js
function upsertGamePkMap(db, gameId, gamePk, gameDate) {
  ensureMlbGamePkMap(db);
  db.prepare(`
    INSERT INTO mlb_game_pk_map (game_id, game_pk, game_date)
    VALUES (?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      game_pk = excluded.game_pk,
      game_date = excluded.game_date,
      updated_at = datetime('now')
  `).run(gameId, gamePk, gameDate);
}
```

The `game_id` for our system is built by the odds ingestion — it's NOT the same as `gamePk`. The schedule endpoint gives us `gamePk` and teams/date. Store both so we can match later.

For now store the gamePk keyed by `${gameDate}_${homeAbbr}_${awayAbbr}` as a lookup key, OR just store gamePk + date and let the settlement job find matches by game_date + team names.

Store as: `game_date + "_" + homeTeamName + "_" + awayTeamName` → gamePk. Settlement job will match our `game_id` to this by querying `WHERE game_date = ? AND (game_id LIKE ? OR ...)`.

Actually simplest: store `game_pk_key = game_date + "|" + home_abbr + "|" + away_abbr` as the primary key. Settlement job reconstructs this from game_results data.

Read the schedule endpoint's team abbreviation fields to determine what `home_abbr` looks like (probably `teams.home.team.abbreviation`).
</action>
  <verify>node apps/worker/src/jobs/pull_mlb_pitcher_stats.js --dry-run</verify>
  <done>Dry run exits 0. Live run populates mlb_game_pk_map.</done>
</task>

<task type="auto">
  <name>Task 2: Implement settle_mlb_f5.js</name>
  <files>apps/worker/src/jobs/settle_mlb_f5.js</files>
  <action>Create settlement job following pull_mlb_pitcher_stats.js structure. Key logic:

```js
'use strict';
require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase, insertJobRun, markJobRunSuccess, markJobRunFailure,
  shouldRunJobKey, withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'settle_mlb_f5';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

// Fetch inning-by-inning linescore for a completed game
async function fetchF5Total(gamePk) {
  // Try v1.1 feed/live first (same as Python)
  const urls = [
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    `${MLB_API_BASE}/game/${gamePk}/feed/live`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'cheddar-logic-worker' } });
      if (!res.ok) continue;
      const data = await res.json();
      const linescore = data?.liveData?.linescore ?? data?.linescore;
      if (!linescore || !Array.isArray(linescore.innings)) continue;
      const first5 = linescore.innings.slice(0, 5);
      if (first5.length < 5) return null; // game not yet 5 innings complete
      const f5Total = first5.reduce((sum, inning) => {
        return sum + (inning?.home?.runs ?? 0) + (inning?.away?.runs ?? 0);
      }, 0);
      return f5Total;
    } catch {
      // try next URL
    }
  }
  return null;
}

// Settle F5 card: compare prediction (OVER/UNDER) to actual total vs line
function gradeF5Card(prediction, line, actualTotal) {
  if (actualTotal === null || line === null) return null;
  const edge = actualTotal - line;
  if (Math.abs(edge) < 0.05) return 'push'; // within rounding
  if (prediction === 'OVER') return actualTotal > line ? 'won' : 'lost';
  if (prediction === 'UNDER') return actualTotal < line ? 'won' : 'lost';
  return null; // PASS cards shouldn't be settled
}

async function settleMlbF5({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobRunId: null };
    }

    let jobInserted = false;
    try {
      if (!dryRun) {
        insertJobRun(JOB_NAME, jobRunId, jobKey);
        jobInserted = true;
      }

      const db = getDatabase();

      // Find pending MLB F5 cards where game is likely complete (T+4h)
      const cutoffTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const pendingF5 = db.prepare(`
        SELECT
          cr.id as result_id,
          cr.card_id,
          cr.game_id,
          cp.payload_data,
          g.game_time_utc,
          gr.metadata as game_result_meta
        FROM card_results cr
        JOIN card_payloads cp ON cr.card_id = cp.id
        JOIN games g ON cr.game_id = g.game_id
        LEFT JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
        WHERE cr.sport = 'MLB'
          AND cr.status = 'pending'
          AND g.game_time_utc < ?
        ORDER BY g.game_time_utc DESC
        LIMIT 50
      `).all(cutoffTime);

      if (pendingF5.length === 0) {
        if (!dryRun) markJobRunSuccess(jobRunId, { settled: 0 });
        return { success: true, jobRunId, settled: 0 };
      }

      let settled = 0, failed = 0;

      for (const card of pendingF5) {
        try {
          const payload = typeof card.payload_data === 'string'
            ? JSON.parse(card.payload_data) : card.payload_data;

          // Only settle F5 market cards
          if (payload?.market_key !== 'f5_total' && !String(payload?.market ?? '').includes('f5')) continue;

          const prediction = payload?.prediction;
          const line = payload?.market?.line ?? payload?.f5_line ?? null;
          if (!prediction || prediction === 'PASS' || !line) continue;

          // Check if F5 total already in game_results metadata
          let actualF5 = null;
          if (card.game_result_meta) {
            const meta = typeof card.game_result_meta === 'string'
              ? JSON.parse(card.game_result_meta) : card.game_result_meta;
            actualF5 = meta?.f5_total ?? null;
          }

          // If not cached, fetch from MLB API
          if (actualF5 === null) {
            // Look up gamePk from mlb_game_pk_map
            const gameDate = card.game_time_utc?.slice(0, 10);
            const pkRow = gameDate ? db.prepare(
              'SELECT game_pk FROM mlb_game_pk_map WHERE game_date = ? LIMIT 1'
            ).get(gameDate) : null;

            if (!pkRow?.game_pk) { failed++; continue; }

            actualF5 = await fetchF5Total(pkRow.game_pk);

            // Cache in game_results metadata
            if (actualF5 !== null && !dryRun) {
              db.prepare(`
                UPDATE game_results SET
                  metadata = json_set(COALESCE(metadata, '{}'), '$.f5_total', ?),
                  updated_at = datetime('now')
                WHERE game_id = ?
              `).run(actualF5, card.game_id);
            }
          }

          if (actualF5 === null) { failed++; continue; }

          const outcome = gradeF5Card(prediction, line, actualF5);
          if (!outcome) { failed++; continue; }

          if (!dryRun) {
            db.prepare(`
              UPDATE card_results SET
                status = ?,
                result = ?,
                settled_at = datetime('now'),
                updated_at = datetime('now')
              WHERE id = ?
            `).run(outcome, outcome, card.result_id);
          }

          console.log(`  [${JOB_NAME}] ${card.game_id}: F5 actual=${actualF5} vs line=${line} → ${outcome}`);
          settled++;
        } catch (err) {
          console.warn(`  [${JOB_NAME}] ${card.game_id}: ${err.message}`);
          failed++;
        }
      }

      if (!dryRun) markJobRunSuccess(jobRunId, { settled, failed });
      console.log(`[${JOB_NAME}] settled=${settled} failed=${failed}`);
      return { success: true, jobRunId, settled, failed };
    } catch (err) {
      if (!dryRun && jobInserted) {
        try { markJobRunFailure(jobRunId, err.message); } catch {}
      }
      return { success: false, error: err.message };
    }
  });
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs();
  settleMlbF5({ dryRun: args.dryRun })
    .then(r => process.exit(r.success ? 0 : 1))
    .catch(err => { console.error(err.message); process.exit(1); });
}

module.exports = { JOB_NAME, settleMlbF5, fetchF5Total, gradeF5Card, parseCliArgs };
```
</action>
  <verify>node apps/worker/src/jobs/settle_mlb_f5.js --dry-run</verify>
  <done>Dry run exits 0. Logs "settled=0 failed=0" when no pending F5 cards exist (expected early-season).</done>
</task>

<task type="auto">
  <name>Task 3: Register settle_mlb_f5 in scheduler</name>
  <files>apps/worker/src/schedulers/main.js</files>
  <action>Add require for settleMlbF5. Register as a post-game settlement job that runs in the evening (after most games complete). Cadence: run it whenever the scheduler ticks during evening hours (same approach as other settlement jobs in the scheduler).

```js
const { settleMlbF5 } = require('../jobs/settle_mlb_f5');
```

Find where other settlement jobs are queued (search for `settle_game_results`, `settle_pending_cards`). Add MLB F5 settlement near them:

```js
if (process.env.ENABLE_MLB_MODEL !== 'false') {
  const f5SettleKey = `settle_mlb_f5|${nowEt.toISODate()}|${nowEt.hour}`;
  jobs.push({
    jobName: 'settle_mlb_f5',
    jobKey: f5SettleKey,
    execute: settleMlbF5,
    args: { jobKey: f5SettleKey, dryRun },
    reason: 'MLB F5 card settlement (post-game)',
  });
}
```

The per-hour jobKey ensures it runs once per hour and re-tries if pending cards remain from earlier ticks.
</action>
  <verify>node -e "require('./apps/worker/src/schedulers/main')" && echo OK</verify>
  <done>Scheduler loads. settleMlbF5 is queued.</done>
</task>

</tasks>

<verification>
- node apps/worker/src/jobs/settle_mlb_f5.js --dry-run exits 0
- node scripts/backtest_mlb.js --days 30 still runs without error
- node -e "const {gradeF5Card}=require('./apps/worker/src/jobs/settle_mlb_f5'); console.log(gradeF5Card('OVER',4.5,5))" → "won"
- console.log(gradeF5Card('UNDER',4.5,5)) → "lost"
- console.log(gradeF5Card('OVER',4.5,4.5)) → "push"
</verification>

<success_criteria>
- F5 actuals fetched from statsapi.mlb.com (free, no key) via /feed/live
- Cached in game_results.metadata.f5_total to avoid redundant API calls
- grade F5 card correctly handles OVER/UNDER/push
- Returns null (skips) when game not yet 5 innings complete
- Settlement is idempotent via jobKey per hour
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-model-port/mlb-06-SUMMARY.md`
</output>
