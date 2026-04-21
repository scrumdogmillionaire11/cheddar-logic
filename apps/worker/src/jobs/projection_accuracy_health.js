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

function roundMetric(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeBreakdownRows(rows = [], key) {
  const buckets = new Map();
  for (const row of rows) {
    const bucket = String(row?.[key] || 'UNKNOWN').trim() || 'UNKNOWN';
    const error = Number(row?.total_error_raw);
    if (!Number.isFinite(error)) continue;
    if (!buckets.has(bucket)) {
      buckets.set(bucket, { bucket, n: 0, errorSum: 0, squaredErrorSum: 0 });
    }
    const summary = buckets.get(bucket);
    summary.n += 1;
    summary.errorSum += error;
    summary.squaredErrorSum += error ** 2;
  }

  return Array.from(buckets.values())
    .map((summary) => ({
      bucket: summary.bucket,
      n: summary.n,
      bias: summary.n > 0 ? roundMetric(summary.errorSum / summary.n, 3) : null,
      rmse: summary.n > 0 ? roundMetric(Math.sqrt(summary.squaredErrorSum / summary.n), 3) : null,
    }))
    .sort((left, right) => right.n - left.n || left.bucket.localeCompare(right.bucket));
}

function buildNbaTotalContextBreakdowns(db) {
  if (!db || typeof db.prepare !== 'function') {
    return {
      pace_tier: [],
      vol_env: [],
      total_band: [],
    };
  }

  const rows = db.prepare(`
    SELECT
      l.pace_tier,
      l.vol_env,
      l.total_band,
      l.total_error_raw
    FROM projection_accuracy_line_evals l
    JOIN projection_accuracy_evals e ON e.card_id = l.card_id
    WHERE e.market_family = 'NBA_TOTAL'
      AND l.line_role = 'SYNTHETIC'
      AND l.total_error_raw IS NOT NULL
  `).all();

  return {
    pace_tier: summarizeBreakdownRows(rows, 'pace_tier'),
    vol_env: summarizeBreakdownRows(rows, 'vol_env'),
    total_band: summarizeBreakdownRows(rows, 'total_band'),
  };
}

function logNbaTotalContextBreakdowns(breakdowns) {
  for (const row of breakdowns.pace_tier || []) {
    console.log(`[HEALTH] NBA_TOTAL pace_tier=${row.bucket} n=${row.n} bias=${row.bias} rmse=${row.rmse}`);
  }
  for (const row of breakdowns.vol_env || []) {
    console.log(`[HEALTH] NBA_TOTAL vol_env=${row.bucket} n=${row.n} bias=${row.bias} rmse=${row.rmse}`);
  }
  for (const row of breakdowns.total_band || []) {
    console.log(`[HEALTH] NBA_TOTAL total_band=${row.bucket} n=${row.n} bias=${row.bias} rmse=${row.rmse}`);
  }
}

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
        contextBreakdowns: null,
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
        result.contextBreakdowns = {
          nba_total: buildNbaTotalContextBreakdowns(db),
        };
      }

      markJobRunSuccess(jobRunId);
      if (!opts.json) {
        const backfillCount = result.backfill?.updated ?? 0;
        console.log(
          `[${JOB_NAME}] complete backfilled=${backfillCount} market_health=${result.marketHealth.length}`,
        );
        if (result.contextBreakdowns?.nba_total) {
          logNbaTotalContextBreakdowns(result.contextBreakdowns.nba_total);
        }
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
  buildNbaTotalContextBreakdowns,
  parseArgs,
  runProjectionAccuracyHealthJob,
};
