/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Backfill Card Results Job
 *
 * Ensures every card_payloads row has a corresponding card_results row.
 * This is a safety net for migrations or wipes so settlement can run
 * deterministically without manual intervention.
 *
 * Usage:
 *   node apps/worker/src/jobs/backfill_card_results.js
 *   node apps/worker/src/jobs/backfill_card_results.js --dry-run
 *   node apps/worker/src/jobs/backfill_card_results.js --since 2026-01-01T00:00:00Z
 */

'use strict';

const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertCardResult,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb
} = require('@cheddar-logic/data');

function parseArgs(argv) {
  const args = { dryRun: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--since') {
      args.since = argv[i + 1] || null;
      i++;
    }
  }
  return args;
}

async function backfillCardResults({ jobKey = null, dryRun = false, since = null } = {}) {
  const jobRunId = `job-backfill-card-results-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[BackfillCardResults] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[BackfillCardResults] Job key: ${jobKey}`);
  }
  if (since) {
    console.log(`[BackfillCardResults] Since: ${since}`);
  }

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[BackfillCardResults] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log('[BackfillCardResults] DRY_RUN=true — no DB writes will occur');
    }

    try {
      insertJobRun('backfill_card_results', jobRunId, jobKey);

      const db = getDatabase();
      const sinceClause = since ? 'AND cp.created_at >= ?' : '';
      const params = since ? [since] : [];

      const rows = db.prepare(`
        SELECT
          cp.id AS card_id,
          cp.game_id,
          cp.sport,
          cp.card_type,
          COALESCE(json_extract(cp.payload_data, '$.recommended_bet_type'), 'unknown') AS recommended_bet_type
        FROM card_payloads cp
        LEFT JOIN card_results cr ON cr.card_id = cp.id
        WHERE cr.card_id IS NULL
          ${sinceClause}
        ORDER BY cp.created_at ASC
      `).all(...params);

      console.log(`[BackfillCardResults] Missing card_results rows: ${rows.length}`);

      let inserted = 0;
      for (const row of rows) {
        if (dryRun) {
          inserted++;
          continue;
        }

        insertCardResult({
          id: `card-result-${row.card_id}`,
          cardId: row.card_id,
          gameId: row.game_id,
          sport: row.sport,
          cardType: row.card_type,
          recommendedBetType: row.recommended_bet_type || 'unknown',
          status: 'pending',
          result: null,
          settledAt: null,
          pnlUnits: null,
          metadata: { backfilledAt: new Date().toISOString() }
        });

        inserted++;
      }

      markJobRunSuccess(jobRunId);
      console.log(`[BackfillCardResults] Job complete — inserted: ${inserted}`);

      return { success: true, jobRunId, jobKey, inserted };
    } catch (error) {
      console.error('[BackfillCardResults] Job failed:', error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error('[BackfillCardResults] Failed to record error to DB:', dbError.message);
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  backfillCardResults({ dryRun: args.dryRun, since: args.since })
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { backfillCardResults };
