'use strict';

require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  getDatabase,
} = require('@cheddar-logic/data');

const JOB_NAME = 'mirror_potd_settlement';

function normalizeResult(result) {
  const token = String(result || '').trim().toLowerCase();
  if (token === 'won' || token === 'win') return 'win';
  if (token === 'lost' || token === 'loss') return 'loss';
  if (token === 'push' || token === 'pushed') return 'push';
  return null;
}

function computePnlDollars({ result, pnlUnits, lockedPrice, wagerAmount }) {
  if (!Number.isFinite(Number(wagerAmount)) || Number(wagerAmount) <= 0) return 0;
  if (pnlUnits !== null && pnlUnits !== undefined && pnlUnits !== '' && Number.isFinite(Number(pnlUnits))) {
    return Number((Number(wagerAmount) * Number(pnlUnits)).toFixed(2));
  }

  const normalizedResult = normalizeResult(result);
  if (normalizedResult === 'push') return 0;
  if (normalizedResult === 'loss') return Number((-Number(wagerAmount)).toFixed(2));
  if (normalizedResult !== 'win') return 0;

  const price = Number(lockedPrice);
  if (!Number.isFinite(price) || price === 0) return 0;
  if (price > 0) return Number((Number(wagerAmount) * (price / 100)).toFixed(2));
  return Number((Number(wagerAmount) * (100 / Math.abs(price))).toFixed(2));
}

async function mirrorPotdSettlement({ jobKey = null, dryRun = false } = {}) {
  const nowIso = new Date().toISOString();
  const jobRunId = `job-potd-settlement-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
      return { success: true, dryRun: true, jobKey };
    }

    insertJobRun(JOB_NAME, jobRunId, jobKey);

    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT
             p.id AS play_id,
             p.card_id,
             p.play_date,
             p.wager_amount,
             cr.result,
             cr.pnl_units,
             cr.locked_price,
             cr.settled_at
           FROM potd_plays p
           JOIN card_results cr ON cr.card_id = p.card_id
           WHERE p.result IS NULL
             AND p.settled_at IS NULL
             AND LOWER(COALESCE(cr.status, '')) = 'settled'
           ORDER BY datetime(COALESCE(cr.settled_at, p.posted_at)) ASC, p.id ASC`,
        )
        .all();

      if (rows.length === 0) {
        markJobRunSuccess(jobRunId, { settled: 0 });
        return { success: true, jobRunId, settled: 0 };
      }

      let settled = 0;
      const transaction = db.transaction(() => {
        for (const row of rows) {
          const normalizedResult = normalizeResult(row.result);
          if (!normalizedResult) continue;

          const existingLedger = db
            .prepare(
              `SELECT id FROM potd_bankroll
               WHERE play_id = ? AND event_type = 'result_settled'
               LIMIT 1`,
            )
            .get(row.play_id);
          if (existingLedger) continue;

          const latestLedger = db
            .prepare(
              `SELECT amount_after
               FROM potd_bankroll
               ORDER BY datetime(created_at) DESC, id DESC
               LIMIT 1`,
            )
            .get();
          const amountBefore = Number(latestLedger?.amount_after || 0);
          const pnlDollars = computePnlDollars({
            result: normalizedResult,
            pnlUnits: row.pnl_units,
            lockedPrice: row.locked_price,
            wagerAmount: row.wager_amount,
          });
          const amountAfter = Number((amountBefore + pnlDollars).toFixed(2));
          const settledAt = row.settled_at || nowIso;

          db.prepare(
            `UPDATE potd_plays
             SET result = ?, settled_at = ?, pnl_dollars = ?
             WHERE id = ?`,
          ).run(normalizedResult, settledAt, pnlDollars, row.play_id);

          db.prepare(
            `INSERT INTO potd_bankroll (
              id, event_date, event_type, play_id, card_id,
              amount_before, amount_change, amount_after, notes, created_at
            ) VALUES (?, ?, 'result_settled', ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            `potd-bankroll-settled-${row.play_id}`,
            row.play_date,
            row.play_id,
            row.card_id,
            amountBefore,
            pnlDollars,
            amountAfter,
            `Settled ${normalizedResult}`,
            settledAt,
          );

          settled += 1;
        }
      });

      transaction();
      markJobRunSuccess(jobRunId, { settled });
      return { success: true, jobRunId, settled };
    } catch (error) {
      markJobRunFailure(jobRunId, error.message);
      throw error;
    }
  });
}

if (require.main === module) {
  mirrorPotdSettlement().then(console.log).catch(console.error);
}

module.exports = {
  mirrorPotdSettlement,
  __private: {
    computePnlDollars,
    normalizeResult,
  },
};
