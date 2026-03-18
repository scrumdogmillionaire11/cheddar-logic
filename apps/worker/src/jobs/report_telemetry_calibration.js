'use strict';

require('dotenv').config();

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
  initDb,
  resolveDatabasePath,
} = require('@cheddar-logic/data');

const DEFAULT_WINDOW_DAYS = 14;
const PROJECTION_MIN_SAMPLE = 100;
const CLV_MIN_SAMPLE = 150;
const PROJECTION_WIN_RATE_FLOOR = 0.48;
const CONFIDENCE_DRIFT_THRESHOLD = 0.03;
const CLV_MEAN_THRESHOLD = -0.02;
const CLV_P25_THRESHOLD = -0.05;
const MAX_DIAGNOSTIC_BUCKETS = 5;

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    help: false,
    enforce: false,
    days: DEFAULT_WINDOW_DAYS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--enforce') {
      options.enforce = true;
      continue;
    }
    if (arg.startsWith('--days=')) {
      options.days = parsePositiveInteger(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--days') {
      options.days = parsePositiveInteger(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isFinite(options.days) || options.days <= 0) {
    options.days = DEFAULT_WINDOW_DAYS;
  }

  return options;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function tableExists(db, tableName) {
  const row = db
    .prepare(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `,
    )
    .get(tableName);
  return Boolean(row?.name);
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toRounded(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function formatPct(value, decimals = 2) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(decimals)}%`;
}

function checkStatus({ gateMet, breached }) {
  if (!gateMet) return 'INSUFFICIENT_DATA';
  return breached ? 'FAIL' : 'PASS';
}

function buildProjectionLedgerReport(db, windowDays) {
  const exists = tableExists(db, 'projection_perf_ledger');
  if (!exists) {
    return {
      table: 'projection_perf_ledger',
      tablePresent: false,
      sampleSize: 0,
      minSample: PROJECTION_MIN_SAMPLE,
      sampleGateMet: false,
      winRate: null,
      highWinRate: null,
      mediumWinRate: null,
      confidenceDrift: null,
      checks: {
        winRateFloor: {
          threshold: `>= ${formatPct(PROJECTION_WIN_RATE_FLOOR)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
        confidenceDrift: {
          threshold: `< ${formatPct(CONFIDENCE_DRIFT_THRESHOLD)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
      },
    };
  }

  const row = db
    .prepare(
      `
      WITH windowed AS (
        SELECT won, confidence
        FROM projection_perf_ledger
        WHERE settled_at IS NOT NULL
          AND datetime(settled_at) >= datetime('now', ?)
      )
      SELECT
        COUNT(*) AS sample_size,
        AVG(CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END) AS win_rate,
        SUM(CASE WHEN UPPER(COALESCE(confidence, '')) = 'HIGH' THEN 1 ELSE 0 END) AS high_sample,
        AVG(
          CASE
            WHEN UPPER(COALESCE(confidence, '')) = 'HIGH'
            THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END
            ELSE NULL
          END
        ) AS high_win_rate,
        SUM(CASE WHEN UPPER(COALESCE(confidence, '')) = 'MEDIUM' THEN 1 ELSE 0 END) AS medium_sample,
        AVG(
          CASE
            WHEN UPPER(COALESCE(confidence, '')) = 'MEDIUM'
            THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END
            ELSE NULL
          END
        ) AS medium_win_rate
      FROM windowed
    `,
    )
    .get(`-${windowDays} days`);

  const sampleSize = toNumber(row?.sample_size, 0);
  const highSample = toNumber(row?.high_sample, 0);
  const mediumSample = toNumber(row?.medium_sample, 0);
  const winRate = toNumber(row?.win_rate);
  const highWinRate = toNumber(row?.high_win_rate);
  const mediumWinRate = toNumber(row?.medium_win_rate);
  const sampleGateMet = sampleSize >= PROJECTION_MIN_SAMPLE;
  const confidencePairAvailable = highSample > 0 && mediumSample > 0;
  const confidenceDrift =
    Number.isFinite(mediumWinRate) && Number.isFinite(highWinRate)
      ? mediumWinRate - highWinRate
      : null;

  const winRateBreached = sampleGateMet && Number.isFinite(winRate)
    ? winRate < PROJECTION_WIN_RATE_FLOOR
    : false;
  const driftBreached =
    sampleGateMet && confidencePairAvailable && Number.isFinite(confidenceDrift)
      ? confidenceDrift >= CONFIDENCE_DRIFT_THRESHOLD
      : false;

  return {
    table: 'projection_perf_ledger',
    tablePresent: true,
    sampleSize,
    minSample: PROJECTION_MIN_SAMPLE,
    sampleGateMet,
    winRate: toRounded(winRate),
    highWinRate: toRounded(highWinRate),
    mediumWinRate: toRounded(mediumWinRate),
    confidenceDrift: toRounded(confidenceDrift),
    checks: {
      winRateFloor: {
        threshold: `>= ${formatPct(PROJECTION_WIN_RATE_FLOOR)}`,
        status: checkStatus({ gateMet: sampleGateMet, breached: winRateBreached }),
        breached: winRateBreached,
      },
      confidenceDrift: {
        threshold: `< ${formatPct(CONFIDENCE_DRIFT_THRESHOLD)}`,
        status: checkStatus({
          gateMet: sampleGateMet && confidencePairAvailable,
          breached: driftBreached,
        }),
        breached: driftBreached,
        details: {
          highSample,
          mediumSample,
        },
      },
    },
  };
}

function buildClvLedgerReport(db, windowDays) {
  const exists = tableExists(db, 'clv_ledger');
  if (!exists) {
    return {
      table: 'clv_ledger',
      tablePresent: false,
      sampleSize: 0,
      minSample: CLV_MIN_SAMPLE,
      sampleGateMet: false,
      meanClv: null,
      p25Clv: null,
      checks: {
        meanClv: {
          threshold: `> ${CLV_MEAN_THRESHOLD.toFixed(3)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
        tailRisk: {
          threshold: `> ${CLV_P25_THRESHOLD.toFixed(3)}`,
          status: 'INSUFFICIENT_DATA',
          breached: false,
          reason: 'TABLE_MISSING',
        },
      },
    };
  }

  const row = db
    .prepare(
      `
      WITH windowed AS (
        SELECT clv_pct
        FROM clv_ledger
        WHERE closed_at IS NOT NULL
          AND clv_pct IS NOT NULL
          AND datetime(closed_at) >= datetime('now', ?)
      ), ranked AS (
        SELECT
          clv_pct,
          ROW_NUMBER() OVER (ORDER BY clv_pct ASC) AS rn,
          COUNT(*) OVER () AS total
        FROM windowed
      )
      SELECT
        (SELECT COUNT(*) FROM windowed) AS sample_size,
        (SELECT AVG(clv_pct) FROM windowed) AS mean_clv,
        (
          SELECT clv_pct
          FROM ranked
          WHERE rn = ((total + 3) / 4)
          LIMIT 1
        ) AS p25_clv
    `,
    )
    .get(`-${windowDays} days`);

  const sampleSize = toNumber(row?.sample_size, 0);
  const sampleGateMet = sampleSize >= CLV_MIN_SAMPLE;
  const meanClv = toNumber(row?.mean_clv);
  const p25Clv = toNumber(row?.p25_clv);

  const meanBreached = sampleGateMet && Number.isFinite(meanClv)
    ? meanClv <= CLV_MEAN_THRESHOLD
    : false;
  const tailBreached = sampleGateMet && Number.isFinite(p25Clv)
    ? p25Clv <= CLV_P25_THRESHOLD
    : false;

  return {
    table: 'clv_ledger',
    tablePresent: true,
    sampleSize,
    minSample: CLV_MIN_SAMPLE,
    sampleGateMet,
    meanClv: toRounded(meanClv),
    p25Clv: toRounded(p25Clv),
    checks: {
      meanClv: {
        threshold: `> ${CLV_MEAN_THRESHOLD.toFixed(3)}`,
        status: checkStatus({ gateMet: sampleGateMet, breached: meanBreached }),
        breached: meanBreached,
      },
      tailRisk: {
        threshold: `> ${CLV_P25_THRESHOLD.toFixed(3)}`,
        status: checkStatus({ gateMet: sampleGateMet, breached: tailBreached }),
        breached: tailBreached,
      },
    },
  };
}

function buildFetchDiagnostics(db, windowDays, projection, clv) {
  const recommendations = [];

  const projectionGaps =
    projection.tablePresent && projection.sampleGateMet === false
      ? db
          .prepare(
            `
            SELECT
              COALESCE(sport, 'UNKNOWN') AS sport,
              COALESCE(prop_type, 'UNKNOWN') AS prop_type,
              COALESCE(confidence, 'UNKNOWN') AS confidence,
              COUNT(*) AS unresolved_count
            FROM projection_perf_ledger
            WHERE settled_at IS NULL
              AND datetime(recorded_at) >= datetime('now', ?)
            GROUP BY sport, prop_type, confidence
            ORDER BY unresolved_count DESC, sport ASC, prop_type ASC, confidence ASC
            LIMIT ${MAX_DIAGNOSTIC_BUCKETS}
          `,
          )
          .all(`-${windowDays} days`)
          .map((row) => ({
            sport: row.sport,
            propType: row.prop_type,
            confidence: row.confidence,
            unresolvedCount: toNumber(row.unresolved_count, 0),
          }))
      : [];

  const clvGaps =
    clv.tablePresent && clv.sampleGateMet === false
      ? db
          .prepare(
            `
            SELECT
              COALESCE(sport, 'UNKNOWN') AS sport,
              COALESCE(market_type, 'UNKNOWN') AS market_type,
              COUNT(*) AS unresolved_count
            FROM clv_ledger
            WHERE closed_at IS NULL
              AND datetime(recorded_at) >= datetime('now', ?)
            GROUP BY sport, market_type
            ORDER BY unresolved_count DESC, sport ASC, market_type ASC
            LIMIT ${MAX_DIAGNOSTIC_BUCKETS}
          `,
          )
          .all(`-${windowDays} days`)
          .map((row) => ({
            sport: row.sport,
            marketType: row.market_type,
            unresolvedCount: toNumber(row.unresolved_count, 0),
          }))
      : [];

  const oddsCoverage = tableExists(db, 'odds_snapshots')
    ? db
        .prepare(
          `
          SELECT
            COALESCE(sport, 'UNKNOWN') AS sport,
            COUNT(*) AS snapshot_count,
            MAX(captured_at) AS last_captured_at
          FROM odds_snapshots
          WHERE datetime(captured_at) >= datetime('now', ?)
          GROUP BY sport
          ORDER BY snapshot_count ASC, sport ASC
          LIMIT ${MAX_DIAGNOSTIC_BUCKETS}
        `,
        )
        .all(`-${windowDays} days`)
        .map((row) => ({
          sport: row.sport,
          snapshotCount: toNumber(row.snapshot_count, 0),
          lastCapturedAt: row.last_captured_at || null,
        }))
    : [];

  if (!projection.sampleGateMet) {
    recommendations.push(
      projectionGaps.length > 0
        ? 'Increase settlement-result fetch cadence for projection buckets with highest unresolved counts before enforcing projection thresholds.'
        : 'Projection sample minimum not met; continue ingest + settlement cycles until at least 100 settled projection rows are available in the last 14 days.',
    );
  }
  if (!clv.sampleGateMet) {
    recommendations.push(
      clvGaps.length > 0
        ? 'Prioritize closing-odds fetch coverage for CLV buckets with unresolved entries so clv_pct can be closed and evaluated.'
        : 'CLV sample minimum not met; continue odds-backed settlement runs until at least 150 closed CLV rows are available in the last 14 days.',
    );
  }
  if (oddsCoverage.length > 0 && oddsCoverage[0].snapshotCount < 10) {
    recommendations.push(
      'Odds snapshot volume appears thin in at least one sport bucket; review pull-odds cadence and bookmaker coverage before enforcing strict gates.',
    );
  }

  return {
    projectionUnresolvedTopBuckets: projectionGaps,
    clvUnresolvedTopBuckets: clvGaps,
    oddsCoverageBySport: oddsCoverage,
    recommendations,
  };
}

function collectChecks(projection, clv) {
  return [
    {
      name: 'projection_win_rate_floor',
      status: projection.checks.winRateFloor.status,
      breached: projection.checks.winRateFloor.breached,
    },
    {
      name: 'projection_confidence_drift',
      status: projection.checks.confidenceDrift.status,
      breached: projection.checks.confidenceDrift.breached,
    },
    {
      name: 'clv_mean_degradation',
      status: clv.checks.meanClv.status,
      breached: clv.checks.meanClv.breached,
    },
    {
      name: 'clv_tail_risk',
      status: clv.checks.tailRisk.status,
      breached: clv.checks.tailRisk.breached,
    },
  ];
}

function determineOverallStatus(checks) {
  const breaches = checks.filter((item) => item.status === 'FAIL' && item.breached);
  if (breaches.length > 0) return 'NO_GO';
  const insufficient = checks.filter((item) => item.status === 'INSUFFICIENT_DATA');
  if (insufficient.length > 0) return 'INSUFFICIENT_DATA';
  return 'GO';
}

function determineExitCode(report, enforce = false) {
  if (!enforce) return 0;
  return report.overallStatus === 'NO_GO' ? 1 : 0;
}

async function generateTelemetryCalibrationReport({
  db = null,
  days = DEFAULT_WINDOW_DAYS,
} = {}) {
  const ownDb = !db;
  let reader = db;
  if (ownDb) {
    await initDb();
    reader = getDatabaseReadOnly();
  }

  try {
    const windowDays = Number.isFinite(days) && days > 0 ? Math.trunc(days) : DEFAULT_WINDOW_DAYS;
    const projection = buildProjectionLedgerReport(reader, windowDays);
    const clv = buildClvLedgerReport(reader, windowDays);
    const checks = collectChecks(projection, clv);
    const diagnostics = buildFetchDiagnostics(reader, windowDays, projection, clv);
    const overallStatus = determineOverallStatus(checks);
    const dbResolution = resolveDatabasePath();

    return {
      generatedAt: new Date().toISOString(),
      database: {
        path: dbResolution.dbPath,
        source: dbResolution.source,
      },
      windowDays,
      thresholds: {
        projectionMinSample: PROJECTION_MIN_SAMPLE,
        projectionWinRateFloor: PROJECTION_WIN_RATE_FLOOR,
        projectionConfidenceDrift: CONFIDENCE_DRIFT_THRESHOLD,
        clvMinSample: CLV_MIN_SAMPLE,
        clvMeanThreshold: CLV_MEAN_THRESHOLD,
        clvP25Threshold: CLV_P25_THRESHOLD,
      },
      ledgers: {
        projection,
        clv,
      },
      checks,
      overallStatus,
      diagnostics,
    };
  } finally {
    if (ownDb && reader) {
      closeReadOnlyInstance(reader);
    }
  }
}

function formatTelemetryCalibrationReport(report, { enforce = false } = {}) {
  const lines = [];
  lines.push('[TelemetryCalibration] Report');
  lines.push(`DB: ${report.database.path} (${report.database.source})`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Window: last ${report.windowDays} day(s)`);
  lines.push(`Enforcement: ${enforce ? 'enabled' : 'disabled'}`);
  lines.push(`Overall status: ${report.overallStatus}`);
  lines.push('');

  lines.push('projection_perf_ledger');
  lines.push(
    `- sample: ${report.ledgers.projection.sampleSize}/${report.ledgers.projection.minSample} (gate ${report.ledgers.projection.sampleGateMet ? 'met' : 'not met'})`,
  );
  lines.push(
    `- win_rate: ${formatPct(report.ledgers.projection.winRate)} | threshold ${report.ledgers.projection.checks.winRateFloor.threshold} | ${report.ledgers.projection.checks.winRateFloor.status}`,
  );
  lines.push(
    `- high_vs_medium_drift: ${formatPct(report.ledgers.projection.confidenceDrift)} (HIGH ${formatPct(report.ledgers.projection.highWinRate)} vs MEDIUM ${formatPct(report.ledgers.projection.mediumWinRate)}) | threshold ${report.ledgers.projection.checks.confidenceDrift.threshold} | ${report.ledgers.projection.checks.confidenceDrift.status}`,
  );
  lines.push('');

  lines.push('clv_ledger');
  lines.push(
    `- sample: ${report.ledgers.clv.sampleSize}/${report.ledgers.clv.minSample} (gate ${report.ledgers.clv.sampleGateMet ? 'met' : 'not met'})`,
  );
  lines.push(
    `- mean_clv: ${Number.isFinite(report.ledgers.clv.meanClv) ? report.ledgers.clv.meanClv.toFixed(4) : 'n/a'} | threshold ${report.ledgers.clv.checks.meanClv.threshold} | ${report.ledgers.clv.checks.meanClv.status}`,
  );
  lines.push(
    `- p25_clv: ${Number.isFinite(report.ledgers.clv.p25Clv) ? report.ledgers.clv.p25Clv.toFixed(4) : 'n/a'} | threshold ${report.ledgers.clv.checks.tailRisk.threshold} | ${report.ledgers.clv.checks.tailRisk.status}`,
  );
  lines.push('');

  lines.push('learning_diagnostics');
  if (report.diagnostics.projectionUnresolvedTopBuckets.length === 0) {
    lines.push('- projection_unresolved: none');
  } else {
    lines.push('- projection_unresolved:');
    for (const bucket of report.diagnostics.projectionUnresolvedTopBuckets) {
      lines.push(
        `  - ${bucket.sport} | ${bucket.propType} | ${bucket.confidence} => ${bucket.unresolvedCount}`,
      );
    }
  }
  if (report.diagnostics.clvUnresolvedTopBuckets.length === 0) {
    lines.push('- clv_unresolved: none');
  } else {
    lines.push('- clv_unresolved:');
    for (const bucket of report.diagnostics.clvUnresolvedTopBuckets) {
      lines.push(
        `  - ${bucket.sport} | ${bucket.marketType} => ${bucket.unresolvedCount}`,
      );
    }
  }
  if (report.diagnostics.recommendations.length === 0) {
    lines.push('- recommendations: none');
  } else {
    lines.push('- recommendations:');
    for (const recommendation of report.diagnostics.recommendations) {
      lines.push(`  - ${recommendation}`);
    }
  }

  return lines.join('\n');
}

function printHelp() {
  console.log(`Telemetry calibration report\n\nOptions:\n  --enforce       Exit non-zero only when threshold breaches are detected\n  --json          Print machine-readable JSON\n  --days <N>      Rolling window in days (default ${DEFAULT_WINDOW_DAYS})\n  --help          Show this help\n`);
}

if (require.main === module) {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  generateTelemetryCalibrationReport({ days: options.days })
    .then((report) => {
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatTelemetryCalibrationReport(report, { enforce: options.enforce }));
      }
      process.exit(determineExitCode(report, options.enforce));
    })
    .catch((error) => {
      console.error('[TelemetryCalibration] Failed to generate report:', error.message);
      process.exit(1);
    });
}

module.exports = {
  DEFAULT_WINDOW_DAYS,
  determineExitCode,
  formatTelemetryCalibrationReport,
  generateTelemetryCalibrationReport,
  parseArgs,
  __private: {
    buildClvLedgerReport,
    buildFetchDiagnostics,
    buildProjectionLedgerReport,
    checkStatus,
    collectChecks,
    determineOverallStatus,
    formatPct,
    parsePositiveInteger,
    tableExists,
    toRounded,
  },
};