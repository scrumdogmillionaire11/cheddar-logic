'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  hasSuccessfulJobRun,
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

async function fetchMlbPitcherKs(gamePk) {
  const urls = [
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    `https://statsapi.mlb.com/api/v1/game/${gamePk}/feed/live`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'cheddar-logic-worker' } });
      if (!res.ok) continue;
      const data = await res.json();
      const gameState = String(data?.gameData?.status?.abstractGameState || '').toUpperCase();
      if (gameState !== 'FINAL') return { available: false, reason: 'game_not_final' };
      const ksByPlayerId = {};
      for (const side of ['home', 'away']) {
        const players = data?.liveData?.boxscore?.teams?.[side]?.players ?? {};
        for (const [key, pData] of Object.entries(players)) {
          const ks = pData?.stats?.pitching?.strikeOuts;
          if (ks !== undefined && ks !== null) {
            // key is "ID8675309"
            const id = key.replace(/^ID/, '');
            ksByPlayerId[id] = Number(ks);
          }
        }
      }
      return { available: true, ksByPlayerId };
    } catch {
      // try next url
    }
  }
  return { available: false, reason: 'fetch_failed' };
}

async function settleProjections({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobRunId: null };
    }

    // Sequential ordering guard: projection settlement must not run before game results complete.
    // Job key format: settle|hourly|YYYY-MM-DD|HH|projections (or settle|nightly|YYYY-MM-DD|projections).
    // Replace the |projections suffix with |game-results to derive the expected game-results key.
    if (jobKey) {
      const gameResultsJobKey = jobKey.replace(/\|projections$/, '|game-results');
      if (!hasSuccessfulJobRun(gameResultsJobKey)) {
        console.log(
          `[${JOB_NAME}] SKIP: settle_game_results not yet SUCCESS for this window — skipping projection settlement (expected key: ${gameResultsJobKey})`,
        );
        return { success: true, jobRunId: null, skipped: true, guardedBy: 'game-results', jobKey };
      }
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

          // ── NHL nhl-player-shots ─────────────────────────────────────────
          if (card.card_type === 'nhl-player-shots') {
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

            if (!snapshot.isFinal) {
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const shots = snapshot.playerShots.fullGameByPlayerId[playerId];
            if (shots === undefined || shots === null) {
              console.warn(
                `  [${JOB_NAME}] nhl-player-shots ${card.game_id} player=${playerId}: not found in snapshot`,
              );
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { shots });
            }
            console.log(
              `  [${JOB_NAME}] nhl-player-shots ${card.game_id} player=${playerId}: shots=${shots}`,
            );
            settled++;
            continue;
          }

          // ── NHL nhl-player-shots-1p ──────────────────────────────────────
          if (card.card_type === 'nhl-player-shots-1p') {
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
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const shots_1p = snapshot.playerShots.firstPeriodByPlayerId[playerId];
            if (shots_1p === undefined || shots_1p === null) {
              console.warn(
                `  [${JOB_NAME}] nhl-player-shots-1p ${card.game_id} player=${playerId}: not found in snapshot`,
              );
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { shots_1p });
            }
            console.log(
              `  [${JOB_NAME}] nhl-player-shots-1p ${card.game_id} player=${playerId}: shots_1p=${shots_1p}`,
            );
            settled++;
            continue;
          }

          // ── NHL nhl-player-blk ───────────────────────────────────────────
          if (card.card_type === 'nhl-player-blk') {
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

            if (!snapshot.isFinal) {
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const blocks = snapshot.playerBlocks.fullGameByPlayerId[playerId];
            if (blocks === undefined || blocks === null) {
              console.warn(
                `  [${JOB_NAME}] nhl-player-blk ${card.game_id} player=${playerId}: not found in snapshot`,
              );
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { blocks });
            }
            console.log(
              `  [${JOB_NAME}] nhl-player-blk ${card.game_id} player=${playerId}: blocks=${blocks}`,
            );
            settled++;
            continue;
          }

          // ── MLB mlb-pitcher-k ────────────────────────────────────────────
          if (card.card_type === 'mlb-pitcher-k') {
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

            const ksResult = await fetchMlbPitcherKs(pkRow.game_pk);

            if (!ksResult.available) {
              // Game may not yet be final — skip silently
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const pitcher_ks = ksResult.ksByPlayerId[playerId];
            if (pitcher_ks === undefined) {
              console.warn(
                `  [${JOB_NAME}] mlb-pitcher-k ${card.game_id} player=${playerId}: not found in boxscore`,
              );
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { pitcher_ks });
            }
            console.log(
              `  [${JOB_NAME}] mlb-pitcher-k ${card.game_id} player=${playerId}: pitcher_ks=${pitcher_ks}`,
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

module.exports = { JOB_NAME, settleProjections, parseCliArgs, fetchMlbPitcherKs };
