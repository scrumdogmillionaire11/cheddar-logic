/**
 * Refresh NCAAM FT CSV Job
 *
 * Pulls TeamRankings FT% table and updates local CSV used by NCAAM FT model.
 * Intended to run as a pre-step before NCAAM model windows.
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

const {
  refreshTeamRankingsNcaamFtCsv,
} = require('../../../../scripts/refresh-teamrankings-ncaam-ft');

async function runRefreshNcaamFtCsv({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-refresh-ncaam-ft-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[RefreshNCAAMFT] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[RefreshNCAAMFT] Job key: ${jobKey}`);
  if (dryRun) {
    console.log('[RefreshNCAAMFT] DRY_RUN=true — skipping write');
    return { success: true, jobRunId: null, dryRun: true, jobKey };
  }

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[RefreshNCAAMFT] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    insertJobRun('refresh_ncaam_ft_csv', jobRunId, jobKey);

    try {
      const summary = await refreshTeamRankingsNcaamFtCsv();
      console.log(
        `[RefreshNCAAMFT] Updated ${summary.rows} rows (season=${summary.season})`,
      );

      markJobRunSuccess(jobRunId, summary);
      return { success: true, jobRunId, summary };
    } catch (error) {
      markJobRunFailure(jobRunId, error.message);
      console.error(`[RefreshNCAAMFT] Failed: ${error.message}`);
      throw error;
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const jobKeyArg = process.argv.find((arg) => arg.startsWith('--job-key='));
  const jobKey = jobKeyArg ? jobKeyArg.split('=').slice(1).join('=') : null;

  runRefreshNcaamFtCsv({ jobKey, dryRun })
    .then((result) => {
      console.log('[RefreshNCAAMFT] Result:', JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error('[RefreshNCAAMFT] Uncaught error:', error.message);
      process.exit(1);
    });
}

module.exports = {
  runRefreshNcaamFtCsv,
};
