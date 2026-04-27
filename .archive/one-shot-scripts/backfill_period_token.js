/**
 * Backfill Period Token Job
 *
 * Updates card_results.metadata with market_period_token ('1P' or 'FULL_GAME')
 * for already-settled rows that are missing the token. Does NOT re-grade any
 * cards or change result/pnl_units/settled_at values.
 *
 * Usage:
 *   node apps/worker/src/jobs/backfill_period_token.js
 *   node apps/worker/src/jobs/backfill_period_token.js --dry-run
 *   node apps/worker/src/jobs/backfill_period_token.js --since 2026-01-01T00:00:00Z
 */

'use strict';

const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  withDb,
} = require('@cheddar-logic/data');

// Inline normalizeSettlementPeriod logic to avoid tight coupling to
// settle_pending_cards.js internals. Mirrors the canonical implementation.
function normalizePeriodToken(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!token) return null;
  if (
    token === '1P' ||
    token === 'P1' ||
    token === 'FIRST_PERIOD' ||
    token === 'FIRST_5_INNINGS' ||
    token === '1ST_PERIOD'
  ) {
    return '1P';
  }
  if (
    token === 'FULL_GAME' ||
    token === 'FULL' ||
    token === 'GAME' ||
    token === 'REGULATION'
  ) {
    return 'FULL_GAME';
  }
  return null;
}

/**
 * Derive the period token from payload data fields and card_type.
 * Mirrors extract logic in settle_pending_cards.js without coupling to it.
 *
 * @param {object|null} payloadData - Parsed payload_data JSON
 * @param {string|null} cardType - card_type value from card_results
 * @returns {'1P'|'FULL_GAME'}
 */
function derivePeriodToken(payloadData, cardType) {
  const rawPeriod =
    payloadData?.period ??
    payloadData?.time_period ??
    payloadData?.market?.period ??
    payloadData?.market_context?.period ??
    payloadData?.market_context?.wager?.period ??
    payloadData?.play?.period ??
    null;

  const fromPayload = normalizePeriodToken(rawPeriod);
  if (fromPayload) return fromPayload;

  const cardTypeToken = String(cardType || '').toUpperCase();
  if (cardTypeToken.includes('1P') || cardTypeToken.includes('FIRST_PERIOD') || cardTypeToken.includes('FIRST_5_INNINGS')) {
    return '1P';
  }

  return 'FULL_GAME';
}

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

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function backfillPeriodToken({
  jobKey = null,
  dryRun = false,
  since = null,
} = {}) {
  const jobRunId = `job-backfill-period-token-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[BackfillPeriodToken] Starting job run: ${jobRunId}`);
  if (dryRun) {
    console.log('[BackfillPeriodToken] DRY_RUN=true — no DB writes will occur');
  }
  if (since) {
    console.log(`[BackfillPeriodToken] Since: ${since}`);
  }

  return withDb(async () => {
    try {
      insertJobRun('backfill_period_token', jobRunId, jobKey);

      const db = getDatabase();

      const sinceClause = since ? 'AND cr.settled_at >= ?' : '';
      const params = since ? [since] : [];

      // Select settled rows that are missing the persisted token.
      const rows = db
        .prepare(
          `
          SELECT cr.id AS result_id, cr.card_type, cr.metadata, cp.payload_data
          FROM card_results cr
          LEFT JOIN card_payloads cp ON cr.card_id = cp.id
          WHERE cr.status = 'settled'
            AND (
              cr.metadata IS NULL
              OR json_extract(cr.metadata, '$.market_period_token') IS NULL
            )
            ${sinceClause}
          ORDER BY cr.settled_at ASC
        `,
        )
        .all(...params);

      const candidates = rows.length;
      console.log(`[BackfillPeriodToken] candidates: ${candidates}`);

      if (dryRun) {
        markJobRunSuccess(jobRunId);
        console.log(`[BackfillPeriodToken] Dry-run complete — candidates: ${candidates}, updated: 0`);
        return { success: true, jobRunId, candidates, updated: 0 };
      }

      const updateStmt = db.prepare(
        'UPDATE card_results SET metadata = ? WHERE id = ?',
      );

      let updated = 0;
      for (const row of rows) {
        const payloadData = parseJsonObject(row.payload_data);
        const token = derivePeriodToken(payloadData, row.card_type);
        const existingMeta = parseJsonObject(row.metadata) || {};
        const newMeta = { ...existingMeta, market_period_token: token };

        updateStmt.run(JSON.stringify(newMeta), row.result_id);
        updated++;
      }

      markJobRunSuccess(jobRunId);
      console.log(`[BackfillPeriodToken] Job complete — candidates: ${candidates}, updated: ${updated}`);

      return { success: true, jobRunId, candidates, updated };
    } catch (error) {
      console.error('[BackfillPeriodToken] Job failed:', error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          '[BackfillPeriodToken] Failed to record error to DB:',
          dbError.message,
        );
      }

      return { success: false, jobRunId, error: error.message };
    }
  });
}

if (require.main === module) {
  require('dotenv').config();
  const args = parseArgs(process.argv.slice(2));
  backfillPeriodToken({ dryRun: args.dryRun, since: args.since })
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { backfillPeriodToken };
