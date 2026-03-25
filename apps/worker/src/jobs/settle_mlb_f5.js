'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'settle_mlb_f5';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

/**
 * Fetch inning-by-inning linescore for a completed game and sum innings 1-5.
 * Returns null if the game is not yet 5 innings complete or API unavailable.
 */
async function fetchF5Total(gamePk) {
  const urls = [
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    `${MLB_API_BASE}/game/${gamePk}/feed/live`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'cheddar-logic-worker' },
      });
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

/**
 * Grade an F5 card: compare OVER/UNDER prediction vs actual total vs line.
 * Returns 'won', 'lost', 'push', or null (if unsettleable).
 */
function gradeF5Card(prediction, line, actualTotal) {
  if (actualTotal === null || line === null) return null;
  const edge = actualTotal - line;
  if (Math.abs(edge) < 0.05) return 'push'; // within rounding
  if (prediction === 'OVER') return actualTotal > line ? 'won' : 'lost';
  if (prediction === 'UNDER') return actualTotal < line ? 'won' : 'lost';
  return null; // PASS cards and unknown predictions are not settled
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
        if (!dryRun) markJobRunSuccess(jobRunId, { settled: 0, failed: 0 });
        console.log(`[${JOB_NAME}] settled=0 failed=0`);
        return { success: true, jobRunId, settled: 0, failed: 0 };
      }

      let settled = 0;
      let failed = 0;

      for (const card of pendingF5) {
        try {
          const payload =
            typeof card.payload_data === 'string'
              ? JSON.parse(card.payload_data)
              : card.payload_data;

          // Only settle F5 market cards
          const marketKey = payload?.market_key ?? payload?.market ?? '';
          if (!String(marketKey).includes('f5')) continue;

          const prediction = payload?.prediction;
          const line = payload?.market?.line ?? payload?.f5_line ?? null;
          if (!prediction || prediction === 'PASS' || line === null) continue;

          // Check if F5 total already cached in game_results metadata
          let actualF5 = null;
          if (card.game_result_meta) {
            const meta =
              typeof card.game_result_meta === 'string'
                ? JSON.parse(card.game_result_meta)
                : card.game_result_meta;
            actualF5 = meta?.f5_total ?? null;
          }

          // If not cached, look up gamePk from mlb_game_pk_map and fetch from MLB API
          if (actualF5 === null) {
            const gameDate = card.game_time_utc?.slice(0, 10);
            const pkRow = gameDate
              ? db
                  .prepare(
                    'SELECT game_pk FROM mlb_game_pk_map WHERE game_date = ? LIMIT 1',
                  )
                  .get(gameDate)
              : null;

            if (!pkRow?.game_pk) {
              console.warn(
                `  [${JOB_NAME}] ${card.game_id}: no gamePk in mlb_game_pk_map for date=${gameDate}`,
              );
              failed++;
              continue;
            }

            actualF5 = await fetchF5Total(pkRow.game_pk);

            // Cache in game_results metadata to avoid repeat fetches
            if (actualF5 !== null && !dryRun) {
              db.prepare(`
                UPDATE game_results SET
                  metadata = json_set(COALESCE(metadata, '{}'), '$.f5_total', ?),
                  updated_at = datetime('now')
                WHERE game_id = ?
              `).run(actualF5, card.game_id);
            }
          }

          if (actualF5 === null) {
            console.warn(
              `  [${JOB_NAME}] ${card.game_id}: F5 total unavailable (game may be incomplete)`,
            );
            failed++;
            continue;
          }

          const outcome = gradeF5Card(prediction, line, actualF5);
          if (!outcome) {
            console.warn(
              `  [${JOB_NAME}] ${card.game_id}: ungradeable prediction="${prediction}" line=${line} actual=${actualF5}`,
            );
            failed++;
            continue;
          }

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

          console.log(
            `  [${JOB_NAME}] ${card.game_id}: F5 actual=${actualF5} vs line=${line} prediction=${prediction} → ${outcome}`,
          );
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
        try {
          markJobRunFailure(jobRunId, err.message);
        } catch {}
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
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { JOB_NAME, settleMlbF5, fetchF5Total, gradeF5Card, parseCliArgs };
