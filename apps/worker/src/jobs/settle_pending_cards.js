/**
 * Settle Pending Cards Job
 *
 * Resolves pending card_results rows by joining with final game_results,
 * applying win/loss/push logic, and computing tracking_stats aggregates.
 * Closes Gap 2 and Gap 3 from SETTLEMENT_AUDIT.md.
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/settle_pending_cards.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:settle-cards)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const dbBackup = require('../utils/db-backup.js');

const {
  buildMarketKey,
  createMarketError,
  upsertTrackingStat,
  incrementTrackingStat,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  normalizeMarketType,
  normalizeSelectionForMarket,
  parseLine,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

function parseLockedPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function assertLockedMarketContext(row, payloadData) {
  if (!row.market_key) {
    throw createMarketError(
      'SETTLEMENT_REQUIRES_MARKET_KEY',
      `Card ${row.card_id} cannot settle without market_key`,
      { cardId: row.card_id, gameId: row.game_id },
    );
  }

  const marketType = normalizeMarketType(row.market_type);
  if (!marketType) {
    throw createMarketError(
      'INVALID_MARKET_TYPE',
      `Card ${row.card_id} has invalid stored market_type "${row.market_type}"`,
      { cardId: row.card_id, marketType: row.market_type },
    );
  }

  const selection = normalizeSelectionForMarket({
    marketType,
    selection: row.selection,
    homeTeam: payloadData?.home_team ?? null,
    awayTeam: payloadData?.away_team ?? null,
  });

  const line = parseLine(row.line);
  if ((marketType === 'SPREAD' || marketType === 'TOTAL') && line === null) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      `Card ${row.card_id} missing line for ${marketType} settlement`,
      { cardId: row.card_id, marketType, line: row.line },
    );
  }

  const lockedPrice = parseLockedPrice(row.locked_price);
  if (lockedPrice === null) {
    throw createMarketError(
      'MISSING_LOCKED_PRICE',
      `Card ${row.card_id} missing locked_price at settlement`,
      { cardId: row.card_id, marketType, selection },
    );
  }

  const expectedMarketKey = buildMarketKey({
    gameId: row.game_id,
    marketType,
    selection,
    line,
  });

  if (expectedMarketKey !== row.market_key) {
    throw createMarketError(
      'MARKET_KEY_MISMATCH',
      `Card ${row.card_id} market_key mismatch`,
      {
        cardId: row.card_id,
        marketKey: row.market_key,
        expectedMarketKey,
      },
    );
  }

  return {
    marketKey: row.market_key,
    marketType,
    selection,
    line,
    lockedPrice,
  };
}

function gradeLockedMarket({
  marketType,
  selection,
  line,
  homeScore,
  awayScore,
}) {
  if (marketType === 'MONEYLINE') {
    if (selection === 'HOME') {
      if (homeScore > awayScore) return 'win';
      if (homeScore < awayScore) return 'loss';
      return 'push';
    }

    if (awayScore > homeScore) return 'win';
    if (awayScore < homeScore) return 'loss';
    return 'push';
  }

  if (marketType === 'SPREAD') {
    if (!Number.isFinite(line)) {
      throw createMarketError(
        'MISSING_MARKET_LINE',
        'Spread settlement requires finite line',
        { marketType, selection, line },
      );
    }

    const diff =
      selection === 'HOME'
        ? homeScore + line - awayScore
        : awayScore + line - homeScore;

    if (diff > 0) return 'win';
    if (diff < 0) return 'loss';
    return 'push';
  }

  if (!Number.isFinite(line)) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      'Total settlement requires finite line',
      { marketType, selection, line },
    );
  }

  const actualTotal = homeScore + awayScore;
  if (actualTotal > line) return selection === 'OVER' ? 'win' : 'loss';
  if (actualTotal < line) return selection === 'UNDER' ? 'win' : 'loss';
  return 'push';
}

function computePnlUnits(result, odds) {
  if (result === 'push') return 0.0;
  if (result === 'loss') return -1.0;
  if (result !== 'win') return null;
  if (!Number.isFinite(odds) || odds === 0) return null;

  if (odds > 0) {
    return odds / 100;
  }

  return 100 / Math.abs(odds);
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, log only, no DB writes
 */
async function settlePendingCards({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-settle-cards-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[SettleCards] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[SettleCards] Job key: ${jobKey}`);
  }
  console.log(`[SettleCards] Time: ${new Date().toISOString()}`);

  // Backup database before settlement
  dbBackup.backupDatabase('before-settle-cards');

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[SettleCards] Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[SettleCards] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      const jobStartTime = new Date().toISOString();
      console.log('[SettleCards] Recording job start...');
      insertJobRun('settle_pending_cards', jobRunId, jobKey);

      const db = getDatabase();

      // --- Step 1: Settle pending card_results ---

      // Join pending card_results with final game_results and display ledger
      const pendingStmt = db.prepare(`
        SELECT
          cr.id AS result_id,
          cr.card_id,
          cr.game_id,
          cr.sport,
          cr.market_key,
          cr.market_type,
          cr.selection,
          cr.line,
          cr.locked_price,
          cr.metadata,
          cdl.pick_id,
          cdl.displayed_at,
          cdl.api_endpoint,
          cp.payload_data,
          gr.final_score_home,
          gr.final_score_away
        FROM card_results cr
        INNER JOIN card_display_log cdl ON cr.card_id = cdl.pick_id
        INNER JOIN game_results gr ON cr.game_id = gr.game_id
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'pending'
          AND cr.market_key IS NOT NULL
          AND gr.status = 'final'
      `);

      const pendingRows = pendingStmt.all();
      console.log(
        `[SettleCards] Found ${pendingRows.length} pending card_results with final game scores`,
      );

      let cardsSettled = 0;
      let cardsErrored = 0;
      const settledAt = new Date().toISOString();

      for (const pendingCard of pendingRows) {
        const gameInfo = `${pendingCard.sport} ${pendingCard.game_id}`;

        // Parse payload data
        let payloadData;
        try {
          payloadData =
            typeof pendingCard.payload_data === 'string'
              ? JSON.parse(pendingCard.payload_data)
              : pendingCard.payload_data;
        } catch (parseErr) {
          console.warn(
            `[SettleCards] Failed to parse payload_data for card ${pendingCard.card_id}: ${parseErr.message}`,
          );
          continue;
        }

        const homeScore = Number(pendingCard.final_score_home) || 0;
        const awayScore = Number(pendingCard.final_score_away) || 0;

        try {
          const lockedMarket = assertLockedMarketContext(pendingCard, payloadData);
          const result = gradeLockedMarket({
            marketType: lockedMarket.marketType,
            selection: lockedMarket.selection,
            line: lockedMarket.line,
            homeScore,
            awayScore,
          });
          const pnlUnits = computePnlUnits(result, lockedMarket.lockedPrice);

          const updateStmt = db.prepare(`
            UPDATE card_results
            SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?
            WHERE id = ? AND status = 'pending'
          `);
          const updateResult = updateStmt.run(
            result,
            settledAt,
            pnlUnits,
            pendingCard.result_id,
          );
          if (updateResult.changes) {
            cardsSettled++;
            console.log(
              `[SettleCards] Settled card ${pendingCard.card_id}: ${lockedMarket.marketType}/${lockedMarket.selection} ` +
                `(${lockedMarket.marketKey}) -> ${result} (pnl: ${pnlUnits})`,
            );
          } else {
            console.log(
              `[SettleCards] Skipping already-settled card ${pendingCard.card_id}`,
            );
          }
        } catch (settlementErr) {
          cardsErrored++;
          const errorCode = settlementErr?.code || 'SETTLEMENT_CONTRACT_ERROR';
          console.warn(
            `[SettleCards] Contract error for card ${pendingCard.card_id}: ${errorCode} ${settlementErr.message}`,
          );

          let metadata = {};
          if (typeof pendingCard.metadata === 'string' && pendingCard.metadata) {
            try {
              metadata = JSON.parse(pendingCard.metadata);
            } catch {
              metadata = {};
            }
          }
          metadata.settlement_error = {
            code: errorCode,
            message: settlementErr.message,
            at: settledAt,
          };

          const errorStmt = db.prepare(`
            UPDATE card_results
            SET status = 'error', result = 'void', settled_at = ?, metadata = ?
            WHERE id = ? AND status = 'pending'
          `);
          const errorResult = errorStmt.run(
            settledAt,
            JSON.stringify(metadata),
            pendingCard.result_id,
          );
          if (!errorResult.changes) {
            console.log(
              `[SettleCards] Skipping error update for already-settled card ${pendingCard.card_id}`,
            );
          }
        }
      }

      console.log(
        `[SettleCards] Step 1 complete — ${cardsSettled} cards settled, ${cardsErrored} cards errored`,
      );

      // --- Step 2: Increment tracking_stats (race-safe) ---

      // Aggregate only cards settled in THIS run (delta-based)
      const aggregateStmt = db.prepare(`
        SELECT
          sport,
          result,
          COUNT(*) AS count,
          SUM(pnl_units) AS total_pnl
        FROM card_results
        WHERE status = 'settled'
          AND settled_at >= ?
        GROUP BY sport, result
      `);

      const aggregateRows = aggregateStmt.all(jobStartTime);

      // Build per-sport deltas for this run only
      const sportDeltas = {};
      for (const row of aggregateRows) {
        const sport = row.sport;
        if (!sportDeltas[sport]) {
          sportDeltas[sport] = { deltaWins: 0, deltaLosses: 0, deltaPushes: 0, deltaPnl: 0 };
        }
        const count = Number(row.count) || 0;
        const pnl = Number(row.total_pnl) || 0;
        if (row.result === 'win') {
          sportDeltas[sport].deltaWins += count;
          sportDeltas[sport].deltaPnl += pnl;
        } else if (row.result === 'loss') {
          sportDeltas[sport].deltaLosses += count;
          sportDeltas[sport].deltaPnl += pnl;
        } else if (row.result === 'push') {
          sportDeltas[sport].deltaPushes += count;
          sportDeltas[sport].deltaPnl += pnl;
        }
      }

      let statsIncremented = 0;
      for (const [sport, deltas] of Object.entries(sportDeltas)) {
        const { deltaWins, deltaLosses, deltaPushes, deltaPnl } = deltas;

        incrementTrackingStat({
          id: `stat-${sport}-all-alltime`,
          statKey: `${sport}|moneyline|all|all|all|alltime`,
          sport,
          marketType: 'moneyline',
          direction: 'all',
          confidenceTier: 'all',
          driverKey: 'all',
          timePeriod: 'alltime',
          deltaWins,
          deltaLosses,
          deltaPushes,
          deltaPnl,
          metadata: { lastIncrementAt: new Date().toISOString(), jobRunId },
        });

        console.log(
          `[SettleCards] Incremented tracking_stat for ${sport}: +${deltaWins}W / +${deltaLosses}L / +${deltaPushes}P (pnl: ${deltaPnl >= 0 ? '+' : ''}${deltaPnl.toFixed(3)})`,
        );
        statsIncremented++;
      }

      console.log(
        `[SettleCards] Step 2 complete — ${statsIncremented} tracking_stats incremented`,
      );

      const cardsArchived = 0;

      markJobRunSuccess(jobRunId);
      console.log(
        `[SettleCards] Job complete — cardsSettled: ${cardsSettled}, cardsErrored: ${cardsErrored}, cardsArchived: ${cardsArchived}, statsIncremented: ${statsIncremented}`,
      );

      return {
        success: true,
        jobRunId,
        jobKey,
        cardsSettled,
        cardsErrored,
        cardsArchived,
        statsIncremented,
        errors: [],
      };
    } catch (error) {
      if (error.code === 'JOB_RUN_ALREADY_CLAIMED') {
        console.log(
          `[RaceGuard] Skipping settle_pending_cards (job already claimed): ${jobKey || 'none'}`,
        );
        return { success: true, jobRunId: null, skipped: true, jobKey };
      }
      console.error(`[SettleCards] Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[SettleCards] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  settlePendingCards()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = {
  settlePendingCards,
  __private: {
    assertLockedMarketContext,
    computePnlUnits,
    gradeLockedMarket,
  },
};
