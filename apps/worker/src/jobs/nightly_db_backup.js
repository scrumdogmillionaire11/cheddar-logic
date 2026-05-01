'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  wasJobKeyRecentlySuccessful,
} = require('@cheddar-logic/data');
const dbBackup = require('../utils/db-backup');

const JOB_NAME = 'nightly_db_backup';
const DEDUPE_MINUTES = 1200; // 20 hours

async function nightlyDbBackup({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  console.log(`[${JOB_NAME}] Starting: jobRunId=${jobRunId} dryRun=${dryRun}`);
  if (jobKey) console.log(`[${JOB_NAME}] jobKey=${jobKey}`);

  if (jobKey && wasJobKeyRecentlySuccessful(jobKey, DEDUPE_MINUTES)) {
    console.log(`[${JOB_NAME}] Skipping — already succeeded within ${DEDUPE_MINUTES}m: ${jobKey}`);
    return { success: true, skipped: true, reason: 'recently_succeeded', jobKey };
  }

  if (jobKey && !shouldRunJobKey(jobKey)) {
    console.log(`[${JOB_NAME}] Skipping (already succeeded or running): ${jobKey}`);
    return { success: true, skipped: true, reason: 'already_running', jobKey };
  }

  if (dryRun) {
    console.log(`[${JOB_NAME}] DRY_RUN=true — would call backupDatabase('nightly')`);
    return { success: true, dryRun: true, jobKey };
  }

  insertJobRun(JOB_NAME, jobRunId, jobKey);

  try {
    const backupPath = dbBackup.backupDatabase('nightly');
    if (!backupPath) {
      const msg = 'backupDatabase returned null (DB missing or write failed)';
      console.error(`[${JOB_NAME}] ${msg}`);
      markJobRunFailure(jobRunId, msg);
      return { success: false, jobRunId, jobKey, error: msg };
    }
    console.log(`[${JOB_NAME}] Backup complete: ${backupPath}`);
    markJobRunSuccess(jobRunId);
    return { success: true, jobRunId, jobKey, backupPath };
  } catch (err) {
    console.error(`[${JOB_NAME}] Backup failed: ${err.message}`);
    markJobRunFailure(jobRunId, err.message);
    return { success: false, jobRunId, jobKey, error: err.message };
  }
}

module.exports = { nightlyDbBackup };

if (require.main === module) {
  const { DateTime } = require('luxon');
  const nowEt = DateTime.now().setZone('America/New_York');
  const jobKey = `nightly_db_backup|${nowEt.toISODate()}`;
  nightlyDbBackup({ jobKey })
    .then((result) => {
      console.log(`[${JOB_NAME}] Result:`, JSON.stringify(result));
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error(`[${JOB_NAME}] Uncaught error:`, err);
      process.exit(1);
    });
}
