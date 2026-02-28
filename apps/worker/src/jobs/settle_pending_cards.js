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

const {
  upsertTrackingStat,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb
} = require('@cheddar-logic/data');

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

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[SettleCards] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(`[SettleCards] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
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
          cp.payload_data,
          gr.final_score_home,
          gr.final_score_away
        FROM card_results cr
        INNER JOIN game_results gr ON cr.game_id = gr.game_id
        INNER JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'pending'
          AND gr.status = 'final'
      `);

      const pendingRows = pendingStmt.all();
      console.log(`[SettleCards] Found ${pendingRows.length} pending card_results with final game scores`);

      let cardsSettled = 0;
      const settledAt = new Date().toISOString();

      for (const row of pendingRows) {
        let payloadData;
        try {
          payloadData = typeof row.payload_data === 'string'
            ? JSON.parse(row.payload_data)
            : row.payload_data;
        } catch (parseErr) {
          console.warn(`[SettleCards] Failed to parse payload_data for card ${row.card_id}: ${parseErr.message}`);
          continue;
        }

        const prediction = payloadData?.prediction;

        // NEUTRAL predictions are informational only — do not settle
        if (!prediction || prediction === 'NEUTRAL') {
          console.log(`[SettleCards] Skipping NEUTRAL/missing prediction for card ${row.card_id}`);
          continue;
        }

        const homeScore = Number(row.final_score_home) || 0;
        const awayScore = Number(row.final_score_away) || 0;

        let result;
        let pnlUnits;

        if (prediction === 'HOME') {
          if (homeScore > awayScore) {
            result = 'win';
            pnlUnits = 0.909;
          } else if (homeScore < awayScore) {
            result = 'loss';
            pnlUnits = -1.0;
          } else {
            result = 'push';
            pnlUnits = 0.0;
          }
        } else if (prediction === 'AWAY') {
          if (awayScore > homeScore) {
            result = 'win';
            pnlUnits = 0.909;
          } else if (awayScore < homeScore) {
            result = 'loss';
            pnlUnits = -1.0;
          } else {
            result = 'push';
            pnlUnits = 0.0;
          }
        } else {
          console.warn(`[SettleCards] Unknown prediction value "${prediction}" for card ${row.card_id} — skipping`);
          continue;
        }

        // Prepare fresh statement per row — sql.js does not reliably support re-binding
        // the same prepared statement after a saveDatabase() flush within a loop
        const updateStmt = db.prepare(`
          UPDATE card_results
          SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?
          WHERE id = ?
        `);
        updateStmt.run(result, settledAt, pnlUnits, row.result_id);
        cardsSettled++;
        console.log(`[SettleCards] Settled card ${row.card_id}: ${prediction} -> ${result} (pnl: ${pnlUnits})`);
      }

      console.log(`[SettleCards] Step 1 complete — ${cardsSettled} cards settled`);

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
          winRate: (wins + losses) > 0 ? wins / (wins + losses) : 0,
          avgPnlPerCard: total > 0 ? totalPnl / total : 0,
          confidenceCalibration: null,
          metadata: { computedAt: new Date().toISOString() }
        });

        console.log(`[SettleCards] Upserted tracking_stat for ${sport}: ${wins}W / ${losses}L / ${pushes}P (pnl: ${totalPnl.toFixed(3)})`);
        statsUpserted++;
      }

      console.log(`[SettleCards] Step 2 complete — ${statsUpserted} tracking_stats upserted`);

      markJobRunSuccess(jobRunId);
      console.log(`[SettleCards] Job complete — cardsSettled: ${cardsSettled}, statsUpserted: ${statsUpserted}`);

      return { success: true, jobRunId, jobKey, cardsSettled, statsUpserted, errors: [] };

    } catch (error) {
      console.error(`[SettleCards] Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[SettleCards] Failed to record error to DB:`, dbError.message);
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  settlePendingCards()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { settlePendingCards };
