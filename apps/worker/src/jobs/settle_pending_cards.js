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

function parseAmericanOdds(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function pickMoneylineOdds(payloadData, prediction) {
  const oddsContext = payloadData?.odds_context || null;
  const market = payloadData?.market || null;

  const homeOdds = parseAmericanOdds(oddsContext?.h2h_home ?? oddsContext?.moneyline_home ?? null)
    ?? parseAmericanOdds(market?.moneyline_home ?? null);
  const awayOdds = parseAmericanOdds(oddsContext?.h2h_away ?? oddsContext?.moneyline_away ?? null)
    ?? parseAmericanOdds(market?.moneyline_away ?? null);

  if (prediction === 'HOME') return homeOdds;
  if (prediction === 'AWAY') return awayOdds;
  return null;
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
          } else if (homeScore < awayScore) {
            result = 'loss';
          } else {
            result = 'push';
          }
        } else if (prediction === 'AWAY') {
          if (awayScore > homeScore) {
            result = 'win';
          } else if (awayScore < homeScore) {
            result = 'loss';
          } else {
            result = 'push';
          }
        } else if (prediction === 'OVER' || prediction === 'UNDER') {
          const marketTotal = payloadData?.odds_context?.total
            ?? payloadData?.driver?.inputs?.market_total
            ?? null;

          if (!Number.isFinite(Number(marketTotal))) {
            console.warn(`[SettleCards] No market total for card ${row.card_id} — skipping`);
            continue;
          }

          const line = Number(marketTotal);
          const actualTotal = homeScore + awayScore;

          if (actualTotal > line) {
            result = prediction === 'OVER' ? 'win' : 'loss';
          } else if (actualTotal < line) {
            result = prediction === 'UNDER' ? 'win' : 'loss';
          } else {
            result = 'push';
          }

          // Total bet odds not stored per-card; assume standard -110 juice
          pnlUnits = computePnlUnits(result, -110);
        } else {
          console.warn(`[SettleCards] Unknown prediction value "${prediction}" for card ${row.card_id} — skipping`);
          continue;
        }

        if (prediction === 'HOME' || prediction === 'AWAY') {
          const odds = pickMoneylineOdds(payloadData, prediction);
          pnlUnits = computePnlUnits(result, odds);
          if (pnlUnits === null) {
            console.warn(`[SettleCards] Missing/invalid moneyline odds for card ${row.card_id} — pnl_units will be null`);
          }
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
