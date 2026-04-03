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
  getUnsettledProjectionCards,
  setProjectionActualResult,
} = require('@cheddar-logic/data');
const { fetchNhlSettlementSnapshot } = require('./nhl-settlement-source');
const { fetchF5Total } = require('./settle_mlb_f5');

const JOB_NAME = 'settle_projections';

/**
 * Resolve the NHL Gamecenter ID from the game_id_map table or by treating
 * a pure-numeric canonical game_id as the native NHL ID (same logic as
 * settle_game_results.js resolveNhlGamecenterId).
 *
 * @param {object} db - better-sqlite3 DB instance
 * @param {string} gameId - canonical game_id
 * @returns {string|null}
 */
function resolveNhlGamecenterId(db, gameId) {
  // Try explicit mapping first
  try {
    const row = db
      .prepare(
        `SELECT external_game_id
         FROM game_id_map
         WHERE sport = 'nhl'
           AND provider IN ('nhl', 'nhl_api', 'nhl_gamecenter')
           AND game_id = ?
         LIMIT 1`,
      )
      .get(gameId);
    if (row?.external_game_id) return String(row.external_game_id);
  } catch {
    // game_id_map may not exist — fall through
  }

  // Fall back: pure-numeric game_id is the native NHL ID
  const raw = String(gameId || '').trim();
  if (/^\d{6,}$/.test(raw)) return raw;

  return null;
}

async function settleProjections({ jobKey = null, dryRun = false } = {}) {
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
      const unsettled = getUnsettledProjectionCards();

      if (unsettled.length === 0) {
        if (!dryRun) markJobRunSuccess(jobRunId, { settled: 0, skipped: 0 });
        console.log(`[${JOB_NAME}] settled=0 skipped=0`);
        return { success: true, jobRunId, settled: 0, skipped: 0 };
      }

      let settled = 0;
      let skipped = 0;

      for (const card of unsettled) {
        try {
          const payload =
            typeof card.payload_data === 'string'
              ? JSON.parse(card.payload_data)
              : card.payload_data;

          // ── NHL nhl-pace-1p ──────────────────────────────────────────────
          if (card.card_type === 'nhl-pace-1p') {
            const nhlGameId = resolveNhlGamecenterId(db, card.game_id);
            if (!nhlGameId) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: no NHL Gamecenter ID resolvable`,
              );
              skipped++;
              continue;
            }

            const snapshot = await fetchNhlSettlementSnapshot({ nhlGameId });

            if (!snapshot.available) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: snapshot unavailable (${snapshot.reason || 'unknown'})`,
              );
              skipped++;
              continue;
            }

            if (!snapshot.isFirstPeriodComplete) {
              // Game not yet past 1P — skip silently, will be retried
              skipped++;
              continue;
            }

            const goals1p =
              (snapshot.homeFirstPeriodScore ?? 0) +
              (snapshot.awayFirstPeriodScore ?? 0);

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { goals_1p: goals1p });
            }
            console.log(
              `  [${JOB_NAME}] nhl ${card.game_id}: goals_1p=${goals1p}`,
            );
            settled++;
            continue;
          }

          // ── MLB mlb-f5 ───────────────────────────────────────────────────
          if (card.card_type === 'mlb-f5') {
            const gameDate = card.game_time_utc?.slice(0, 10);
            const homeTeam = card.home_team;
            const awayTeam = card.away_team;
            const gamePkKey =
              gameDate && homeTeam && awayTeam
                ? `${gameDate}|${homeTeam}|${awayTeam}`
                : null;

            const pkRow = gamePkKey
              ? db
                  .prepare(
                    'SELECT game_pk FROM mlb_game_pk_map WHERE game_pk_key = ?',
                  )
                  .get(gamePkKey)
              : null;

            if (!pkRow?.game_pk) {
              console.warn(
                `  [${JOB_NAME}] mlb ${card.game_id}: no gamePk in mlb_game_pk_map for key=${gamePkKey ?? `(missing date/teams)`}`,
              );
              skipped++;
              continue;
            }

            const actualF5 = await fetchF5Total(pkRow.game_pk);

            if (actualF5 === null) {
              // Game may not yet be 5 innings complete — skip silently
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { runs_f5: actualF5 });
            }
            console.log(
              `  [${JOB_NAME}] mlb ${card.game_id}: runs_f5=${actualF5}`,
            );
            settled++;
            continue;
          }

          // Unknown card_type in the result set — skip
          skipped++;
        } catch (err) {
          console.warn(`  [${JOB_NAME}] ${card.game_id}: ${err.message}`);
          skipped++;
        }
      }

      if (!dryRun) markJobRunSuccess(jobRunId, { settled, skipped });
      console.log(`[${JOB_NAME}] settled=${settled} skipped=${skipped}`);
      return { success: true, jobRunId, settled, skipped };
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
  settleProjections({ dryRun: args.dryRun })
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { JOB_NAME, settleProjections, parseCliArgs };
