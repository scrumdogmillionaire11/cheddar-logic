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

const { v4: uuidV4 } = require('uuid');
const dbBackup = require('../utils/db-backup.js');

const {
  buildMarketKey,
  createMarketError,
  upsertTrackingStat,
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
 * PHASE 2: Select top-level card per game (highest confidence)
 * 
 * Prevents settling duplicate picks for the same game (e.g., both HOME and AWAY on ML).
 * Only the highest-confidence card should count toward the user's record.
 * 
 * @param {Array} cardsForGame - All pending cards for a single game_id
 * @returns {object|null} - The top-level card, or null if no valid cards
 */
function selectTopLevelCard(cardsForGame) {
  // Filter out invalid cards (missing required fields)
  const validCards = cardsForGame.filter(c => 
    c.market_key && 
    c.market_type && 
    c.locked_price !== null
  );
  
  if (validCards.length === 0) {
    console.warn(
      `[SettleCards] Game ${cardsForGame[0]?.game_id}: no valid cards to settle`
    );
    return null;
  }
  
  if (validCards.length === 1) {
    return validCards[0]; // Only one card, auto-select
  }
  
  // SELECTION STRATEGY: Highest confidence
  // Parse confidence from payload_data, default to 0 if missing
  return validCards.reduce((top, curr) => {
    let currConf = 0;
    let topConf = 0;
    
    try {
      const currPayload = typeof curr.payload_data === 'string' 
        ? JSON.parse(curr.payload_data) 
        : curr.payload_data;
      currConf = Number(currPayload?.confidence ?? 0);
    } catch {
      currConf = 0;
    }
    
    try {
      const topPayload = typeof top.payload_data === 'string'
        ? JSON.parse(top.payload_data)
        : top.payload_data;
      topConf = Number(topPayload?.confidence ?? 0);
    } catch {
      topConf = 0;
    }
    
    return currConf > topConf ? curr : top;
  });
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
      console.log('[SettleCards] Recording job start...');
      insertJobRun('settle_pending_cards', jobRunId, jobKey);

      const db = getDatabase();

      // --- Step 1: Settle pending card_results ---

      // Join pending card_results with final game_results and card_payloads
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
          cp.payload_data,
          gr.final_score_home,
          gr.final_score_away
        FROM card_results cr
        INNER JOIN game_results gr ON cr.game_id = gr.game_id
        INNER JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'pending'
          AND cr.market_key IS NOT NULL
          AND gr.status = 'final'
      `);

      const pendingRows = pendingStmt.all();
      console.log(
        `[SettleCards] Found ${pendingRows.length} pending card_results with final game scores`,
      );

      // PHASE 2: Group cards by game_id
      const cardsByGame = {};
      for (const row of pendingRows) {
        if (!cardsByGame[row.game_id]) {
          cardsByGame[row.game_id] = [];
        }
        cardsByGame[row.game_id].push(row);
      }

      console.log(
        `[SettleCards] Grouped into ${Object.keys(cardsByGame).length} unique games`,
      );

      let cardsSettled = 0;
      let cardsErrored = 0;
      let cardsArchived = 0;
      const settledAt = new Date().toISOString();

      // PHASE 2: Process top-level card per game only
      for (const [gameId, cardsForGame] of Object.entries(cardsByGame)) {
        const gameInfo = `${cardsForGame[0].sport} ${gameId}`;
        
        // Select the top-level card (highest confidence)
        const topLevelCard = selectTopLevelCard(cardsForGame);
        
        if (!topLevelCard) {
          console.warn(`[SettleCards] ${gameInfo}: No valid top-level card found`);
          continue;
        }

        // Log selection decision if multiple cards existed
        if (cardsForGame.length > 1) {
          console.log(
            `[SettleCards] ${gameInfo}: Selected card ${topLevelCard.card_id} ` +
            `(highest confidence) from ${cardsForGame.length} candidates`,
          );
        }

        // Parse payload data
        let payloadData;
        try {
          payloadData =
            typeof topLevelCard.payload_data === 'string'
              ? JSON.parse(topLevelCard.payload_data)
              : topLevelCard.payload_data;
        } catch (parseErr) {
          console.warn(
            `[SettleCards] Failed to parse payload_data for card ${topLevelCard.card_id}: ${parseErr.message}`,
          );
          continue;
        }

        const homeScore = Number(topLevelCard.final_score_home) || 0;
        const awayScore = Number(topLevelCard.final_score_away) || 0;
        
        // Settle the top-level card
        try {
          const lockedMarket = assertLockedMarketContext(topLevelCard, payloadData);
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
            WHERE id = ?
          `);
          updateStmt.run(result, settledAt, pnlUnits, topLevelCard.result_id);
          cardsSettled++;
          console.log(
            `[SettleCards] Settled card ${topLevelCard.card_id}: ${lockedMarket.marketType}/${lockedMarket.selection} ` +
              `(${lockedMarket.marketKey}) -> ${result} (pnl: ${pnlUnits})`,
          );
        } catch (settlementErr) {
          cardsErrored++;
          const errorCode = settlementErr?.code || 'SETTLEMENT_CONTRACT_ERROR';
          console.warn(
            `[SettleCards] Contract error for card ${topLevelCard.card_id}: ${errorCode} ${settlementErr.message}`,
          );

          let metadata = {};
          if (typeof topLevelCard.metadata === 'string' && topLevelCard.metadata) {
            try {
              metadata = JSON.parse(topLevelCard.metadata);
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
            WHERE id = ?
          `);
          errorStmt.run(settledAt, JSON.stringify(metadata), topLevelCard.result_id);
        }

        // PHASE 2: Archive non-top-level cards
        const nonTopLevelCards = cardsForGame.filter(
          c => c.result_id !== topLevelCard.result_id
        );
        
        if (nonTopLevelCards.length > 0) {
          const archiveStmt = db.prepare(`
            UPDATE card_results
            SET status = 'archived', 
                result = 'void',
                settled_at = ?,
                metadata = json_insert(
                  COALESCE(metadata, '{}'),
                  '$.archive_reason', 'not_top_level',
                  '$.archived_at', ?
                )
            WHERE id = ?
          `);
          
          for (const card of nonTopLevelCards) {
            archiveStmt.run(settledAt, settledAt, card.result_id);
            cardsArchived++;
            console.log(
              `[SettleCards] Archived card ${card.card_id} (not top-level for ${gameInfo})`,
            );
          }
        }
      }

      console.log(
        `[SettleCards] Step 1 complete — ${cardsSettled} cards settled, ${cardsErrored} cards errored, ${cardsArchived} cards archived`,
      );

      // --- Step 2: Compute and upsert tracking_stats ---

      // Aggregate settled card_results by sport + result
      const aggregateStmt = db.prepare(`
        SELECT
          sport,
          result,
          COUNT(*) AS count,
          SUM(pnl_units) AS total_pnl
        FROM card_results
        WHERE status = 'settled'
        GROUP BY sport, result
      `);

      const aggregateRows = aggregateStmt.all();

      // Build per-sport aggregates
      const sportStats = {};
      for (const row of aggregateRows) {
        const sport = row.sport;
        if (!sportStats[sport]) {
          sportStats[sport] = { wins: 0, losses: 0, pushes: 0, totalPnl: 0 };
        }
        const count = Number(row.count) || 0;
        const pnl = Number(row.total_pnl) || 0;
        if (row.result === 'win') {
          sportStats[sport].wins += count;
          sportStats[sport].totalPnl += pnl;
        } else if (row.result === 'loss') {
          sportStats[sport].losses += count;
          sportStats[sport].totalPnl += pnl;
        } else if (row.result === 'push') {
          sportStats[sport].pushes += count;
          sportStats[sport].totalPnl += pnl;
        }
      }

      let statsUpserted = 0;
      for (const [sport, stats] of Object.entries(sportStats)) {
        const { wins, losses, pushes, totalPnl } = stats;
        const total = wins + losses + pushes;

        upsertTrackingStat({
          id: `stat-${sport}-all-alltime`,
          statKey: `${sport}|moneyline|all|all|all|alltime`,
          sport,
          marketType: 'moneyline',
          direction: 'all',
          confidenceTier: 'all',
          driverKey: 'all',
          timePeriod: 'alltime',
          totalCards: total,
          settledCards: total,
          wins,
          losses,
          pushes,
          totalPnlUnits: totalPnl,
          winRate: wins + losses > 0 ? wins / (wins + losses) : 0,
          avgPnlPerCard: total > 0 ? totalPnl / total : 0,
          confidenceCalibration: null,
          metadata: { computedAt: new Date().toISOString() },
        });

        console.log(
          `[SettleCards] Upserted tracking_stat for ${sport}: ${wins}W / ${losses}L / ${pushes}P (pnl: ${totalPnl.toFixed(3)})`,
        );
        statsUpserted++;
      }

      console.log(
        `[SettleCards] Step 2 complete — ${statsUpserted} tracking_stats upserted`,
      );

      markJobRunSuccess(jobRunId);
      console.log(
        `[SettleCards] Job complete — cardsSettled: ${cardsSettled}, cardsErrored: ${cardsErrored}, cardsArchived: ${cardsArchived}, statsUpserted: ${statsUpserted}`,
      );

      return {
        success: true,
        jobRunId,
        jobKey,
        cardsSettled,
        cardsErrored,
        cardsArchived,
        statsUpserted,
        errors: [],
      };
    } catch (error) {
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
    selectTopLevelCard,
  },
};
