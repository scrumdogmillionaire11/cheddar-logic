'use strict';

/**
 * pull_nst_blk_rates — Scheduled wrapper for NST block-rate CSV ingest.
 *
 * Fetches season/L10/L5 block-rate CSVs from Natural Stat Trick export URLs
 * and upserts results into player_blk_rates via ingestNstBlkRates.
 *
 * Runs on a weekly cadence (registered in schedulers/player-props.js).
 * NST block-rate data is meaningful at weekly resolution — daily pulls are
 * redundant and the exports are only updated after games run.
 *
 * Env vars required (see env.example for format):
 *   NHL_BLK_NST_SEASON_CSV_URL
 *   NHL_BLK_NST_L10_CSV_URL
 *   NHL_BLK_NST_L5_CSV_URL
 *
 * If any URL is missing this job logs a WARN and exits cleanly (exit 0).
 * The downstream shots model will emit WARN per-player and flag blk_rates_stale
 * on card payloads until data is populated.
 */

require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const { ingestNstBlkRates } = require('./ingest_nst_blk_rates');

const JOB_NAME = 'pull_nst_blk_rates';

/**
 * Automated NST block-rate ingest job.
 *
 * @param {object}  [opts]
 * @param {string}  [opts.jobKey]   - Scheduler-supplied idempotency key
 * @param {boolean} [opts.dryRun]   - If true, skip network fetch and DB writes
 * @returns {Promise<{success: boolean, inserted?: number, skipped?: number, error?: string}>}
 */
async function pullNstBlkRates({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDbSafe(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] Skipping — already ran for key ${jobKey}`);
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[${JOB_NAME}] DRY_RUN — would fetch NST BLK CSV rates`);
      return { success: true, dryRun: true };
    }

    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      const result = await ingestNstBlkRates();

      if (result.error === 'missing_urls') {
        console.warn(
          `[${JOB_NAME}] WARN: NHL_BLK_NST_SEASON/L10/L5_CSV_URL not set — ` +
            `player_blk_rates not updated. Set env vars to enable automated block-rate refresh.`,
        );
      } else {
        console.log(
          `[${JOB_NAME}] NST BLK rates ingested: inserted=${result.inserted}, skipped=${result.skipped}`,
        );
      }

      markJobRunSuccess(jobRunId);
      return { success: true, jobRunId, ...result };
    } catch (err) {
      if (/SCHEMA_DRIFT/i.test(String(err?.message || ''))) {
        console.error(`[${JOB_NAME}] SOURCE_INTEGRITY_FAIL: ${err.message}`);
      }
      console.error(`[${JOB_NAME}] Failed: ${err.message}`);
      try {
        markJobRunFailure(jobRunId, err.message);
      } catch (dbErr) {
        console.error(`[${JOB_NAME}] Failed to record failure: ${dbErr.message}`);
      }
      return { success: false, error: err.message };
    }
  });
}

// Run directly for smoke tests: node src/jobs/pull_nst_blk_rates.js
if (require.main === module) {
  pullNstBlkRates()
    .then((result) => {
      console.log(`[${JOB_NAME}] Result: ${JSON.stringify(result)}`);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(`[${JOB_NAME}] Fatal: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { pullNstBlkRates };
