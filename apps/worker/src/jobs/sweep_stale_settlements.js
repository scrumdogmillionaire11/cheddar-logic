/**
 * Sweep Stale Settlements Job
 *
 * Identifies card_results rows permanently stuck in 'pending' because their
 * games (final/cancelled/postponed) will never produce a game_results row,
 * and voids them after a 48-hour grace period.
 *
 * WI-0842: Settlement expiry sweep
 *
 * Usage:
 *   node apps/worker/src/jobs/sweep_stale_settlements.js [--dry-run]
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

'use strict';

require('dotenv').config();

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
} = require('@cheddar-logic/data');

const JOB_NAME = 'sweep_stale_settlements';

/**
 * Identify and optionally void card_results rows that are stuck pending
 * because their game is final/cancelled/postponed but has no game_results row.
 * Only processes rows older than 48 hours (grace period).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ dryRun?: boolean }} [opts]
 * @returns {{ count: number, dryRun: boolean, voided: string[] }}
 */
function sweepStaleSettlements(db, { dryRun = false } = {}) {
  const rows = db.prepare(`
    SELECT cr.id, cr.game_id, g.status AS game_status
    FROM card_results cr
    JOIN games g ON g.game_id = cr.game_id
    LEFT JOIN game_results gr ON gr.game_id = cr.game_id
    WHERE cr.result IS NULL
      AND cr.created_at < datetime('now', '-48 hours')
      AND g.status IN ('final', 'cancelled', 'postponed')
      AND gr.game_id IS NULL
  `).all();

  if (dryRun || rows.length === 0) return { count: rows.length, dryRun, voided: [] };

  const stmt = db.prepare(`
    UPDATE card_results
    SET result = 'void', status = 'settled', pnl_units = 0,
        settled_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?
  `);
  for (const row of rows) stmt.run(row.id);
  return { count: rows.length, dryRun, voided: rows.map(r => r.id) };
}

/**
 * CLI entry point.
 * Reads --dry-run flag from process.argv.
 */
async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let jobRunId;
  let db;

  try {
    db = getDatabase();
    jobRunId = insertJobRun({ job_name: JOB_NAME, status: 'running' });

    const result = sweepStaleSettlements(db, { dryRun });

    if (dryRun) {
      console.log(`[${JOB_NAME}] DRY RUN — ${result.count} rows would be voided (no writes)`);
    } else {
      console.log(`[${JOB_NAME}] Voided ${result.count} stale pending card_results rows`);
      if (result.count > 0) {
        console.log(`[${JOB_NAME}] Voided IDs: ${result.voided.join(', ')}`);
      }
    }

    markJobRunSuccess(jobRunId, { rows_voided: result.count, dry_run: dryRun });
    process.exit(0);
  } catch (err) {
    console.error(`[${JOB_NAME}] Error:`, err);
    if (jobRunId) markJobRunFailure(jobRunId, String(err));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { sweepStaleSettlements, main };
