'use strict';

require('dotenv').config();

const {
  backfillProjectionAccuracyEvals,
  insertJobRun,
  markJobRunFailure,
  markJobRunSuccess,
  materializeProjectionAccuracyMarketHealth,
  withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'projection_accuracy_health';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    backfill: true,
    health: true,
    json: false,
    limit: 1000,
    jobKey: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--backfill-only') {
      opts.backfill = true;
      opts.health = false;
    } else if (arg === '--health-only') {
      opts.backfill = false;
      opts.health = true;
    } else if (arg === '--limit') {
      opts.limit = Number.parseInt(argv[index + 1], 10);
      index += 1;
    } else if (arg.startsWith('--limit=')) {
      opts.limit = Number.parseInt(arg.split('=').slice(1).join('='), 10);
    } else if (arg === '--job-key') {
      opts.jobKey = argv[index + 1] || null;
      index += 1;
    } else if (arg.startsWith('--job-key=')) {
      opts.jobKey = arg.split('=').slice(1).join('=') || null;
    }
  }

  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = 1000;
  opts.limit = Math.min(opts.limit, 10000);
  return opts;
}

async function runProjectionAccuracyHealthJob(options = {}) {
  const opts = { ...parseArgs([]), ...options };
  const startedAt = new Date().toISOString();
  const jobRunId = `${JOB_NAME}-${startedAt.replace(/[:.]/g, '-')}`;

  return withDb(async (db) => {
    try {
      insertJobRun(JOB_NAME, jobRunId, opts.jobKey ?? null);
      const result = {
        success: true,
        jobRunId,
        generatedAt: startedAt,
        backfill: null,
        marketHealth: [],
      };

      if (opts.backfill) {
        result.backfill = backfillProjectionAccuracyEvals(db, {
          limit: opts.limit,
          now: startedAt,
        });
      }

      if (opts.health) {
        result.marketHealth = materializeProjectionAccuracyMarketHealth(db, {
          generatedAt: startedAt,
        });
      }

      markJobRunSuccess(jobRunId);
      if (!opts.json) {
        const backfillCount = result.backfill?.updated ?? 0;
        console.log(
          `[${JOB_NAME}] complete backfilled=${backfillCount} market_health=${result.marketHealth.length}`,
        );
      }
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      try {
        markJobRunFailure(jobRunId, message);
      } catch {
        // Preserve the original failure.
      }
      return {
        success: false,
        jobRunId,
        error: message,
      };
    }
  });
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  runProjectionAccuracyHealthJob(opts)
    .then((result) => {
      if (opts.json) console.log(JSON.stringify(result, null, 2));
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error(`[${JOB_NAME}] unhandled error`, error);
      process.exit(1);
    });
}

module.exports = {
  parseArgs,
  runProjectionAccuracyHealthJob,
};
