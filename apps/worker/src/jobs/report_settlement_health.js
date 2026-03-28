/**
 * Settlement Health Report
 *
 * Read-only diagnostics for production triage:
 * - Are there unsettled plays in the DB?
 * - Which pending rows are actionable vs blocked?
 * - Which settlement failures happened, and why?
 * - Did settlement jobs recently fail?
 *
 * Usage:
 *   node src/jobs/report_settlement_health.js
 *   node src/jobs/report_settlement_health.js --json --days=7 --limit=5
 *   node src/jobs/report_settlement_health.js --sport=NHL
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
  closeReadOnlyInstance,
  getDatabaseReadOnly,
  resolveDatabasePath,
} = require('@cheddar-logic/data');

const DEFAULT_SAMPLE_LIMIT = 10;
const SETTLEMENT_JOB_NAMES = ['settle_game_results', 'settle_pending_cards'];
const DEFAULT_LOG_DIR = path.resolve(__dirname, '../../../../logs');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    json: false,
    help: false,
    sport: null,
    days: null,
    limit: DEFAULT_SAMPLE_LIMIT,
    writeLog: true,
    logFile: null,
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
    if (arg === '--no-log') {
      options.writeLog = false;
      continue;
    }
    if (arg.startsWith('--log-file=')) {
      options.logFile = normalizeLogFilePath(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--log-file') {
      options.logFile = normalizeLogFilePath(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--sport=')) {
      options.sport = normalizeSportFilter(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--sport') {
      options.sport = normalizeSportFilter(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--days=')) {
      options.days = parsePositiveInteger(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--days') {
      options.days = parsePositiveInteger(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--limit=')) {
      options.limit = parsePositiveInteger(arg.split('=').slice(1).join('='));
      continue;
    }
    if (arg === '--limit') {
      options.limit = parsePositiveInteger(argv[index + 1]);
      index += 1;
    }
  }

  if (!Number.isFinite(options.limit) || options.limit <= 0) {
    options.limit = DEFAULT_SAMPLE_LIMIT;
  }

  return options;
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeLogFilePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

function normalizeSportFilter(value) {
  const token = String(value || '').trim().toUpperCase();
  return token || null;
}

function buildDateRange(days) {
  if (!Number.isFinite(days) || days <= 0) return null;
  return {
    start: new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString(),
    end: new Date().toISOString(),
  };
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

function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildCoverageFilters({
  sport = null,
  dateRange = null,
  sportExpression,
  timestampExpression,
}) {
  const whereClauses = [];
  const params = [];

  if (sport && sportExpression) {
    whereClauses.push(`UPPER(COALESCE(${sportExpression}, '')) = ?`);
    params.push(String(sport).toUpperCase());
  }
  if (dateRange?.start && timestampExpression) {
    whereClauses.push(`datetime(${timestampExpression}) >= datetime(?)`);
    params.push(dateRange.start);
  }
  if (dateRange?.end && timestampExpression) {
    whereClauses.push(`datetime(${timestampExpression}) <= datetime(?)`);
    params.push(dateRange.end);
  }

  return {
    whereSql: whereClauses.length > 0 ? ` AND ${whereClauses.join(' AND ')}` : '',
    params,
  };
}

function collectCoverageDiagnostics(db, sport = null, dateRange = null) {
  const totalPendingFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cr.sport',
    timestampExpression: 'COALESCE(cr.created_at, CURRENT_TIMESTAMP)',
  });
  const totalPendingRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    WHERE cr.status = 'pending'
      ${totalPendingFilters.whereSql}
  `).get(...totalPendingFilters.params);

  const eligiblePendingFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cr.sport',
    timestampExpression: 'COALESCE(cdl.displayed_at, cr.created_at, CURRENT_TIMESTAMP)',
  });
  const eligiblePendingFinalDisplayedRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
    INNER JOIN game_results gr ON gr.game_id = cr.game_id
    WHERE cr.status = 'pending'
      AND cr.market_key IS NOT NULL
      AND gr.status = 'final'
      ${eligiblePendingFilters.whereSql}
  `).get(...eligiblePendingFilters.params);

  const settledDisplayedFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cr.sport',
    timestampExpression: 'COALESCE(cdl.displayed_at, cr.settled_at, CURRENT_TIMESTAMP)',
  });
  const settledDisplayedFinalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
    INNER JOIN game_results gr ON gr.game_id = cr.game_id
    WHERE cr.status = 'settled'
      AND gr.status = 'final'
      ${settledDisplayedFilters.whereSql}
  `).get(...settledDisplayedFilters.params);

  const displayedFinalFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cdl.sport',
    timestampExpression: 'COALESCE(cdl.displayed_at, CURRENT_TIMESTAMP)',
  });
  const displayedFinalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_display_log cdl
    INNER JOIN game_results gr ON gr.game_id = cdl.game_id
    WHERE gr.status = 'final'
      ${displayedFinalFilters.whereSql}
  `).get(...displayedFinalFilters.params);

  const missingResultsFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'COALESCE(cr.sport, cdl.sport)',
    timestampExpression: 'COALESCE(cdl.displayed_at, CURRENT_TIMESTAMP)',
  });
  const finalDisplayedMissingResultsRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_display_log cdl
    LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id
    INNER JOIN game_results gr ON gr.game_id = cdl.game_id
    WHERE cr.id IS NULL
      AND gr.status = 'final'
      ${missingResultsFilters.whereSql}
  `).get(...missingResultsFilters.params);

  const finalDisplayedUnsettledFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'COALESCE(cr.sport, cdl.sport)',
    timestampExpression: 'COALESCE(cdl.displayed_at, CURRENT_TIMESTAMP)',
  });
  const finalDisplayedUnsettledRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_display_log cdl
    LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id
    INNER JOIN game_results gr ON gr.game_id = cdl.game_id
    WHERE gr.status = 'final'
      AND (cr.id IS NULL OR cr.status != 'settled')
      ${finalDisplayedUnsettledFilters.whereSql}
  `).get(...finalDisplayedUnsettledFilters.params);

  const pendingWithFinalNoDisplayFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cr.sport',
    timestampExpression: 'COALESCE(gr.settled_at, cr.created_at, CURRENT_TIMESTAMP)',
  });
  const pendingWithFinalNoDisplayRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    INNER JOIN game_results gr ON gr.game_id = cr.game_id
    LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
    WHERE cr.status = 'pending'
      AND cr.market_key IS NOT NULL
      AND gr.status = 'final'
      AND cdl.pick_id IS NULL
      ${pendingWithFinalNoDisplayFilters.whereSql}
  `).get(...pendingWithFinalNoDisplayFilters.params);

  const pendingWithFinalMissingMarketKeyFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cr.sport',
    timestampExpression: 'COALESCE(gr.settled_at, cr.created_at, CURRENT_TIMESTAMP)',
  });
  const pendingWithFinalMissingMarketKeyRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    INNER JOIN game_results gr ON gr.game_id = cr.game_id
    WHERE cr.status = 'pending'
      AND cr.market_key IS NULL
      AND gr.status = 'final'
      ${pendingWithFinalMissingMarketKeyFilters.whereSql}
  `).get(...pendingWithFinalMissingMarketKeyFilters.params);

  const pendingDisplayedWithoutFinalFilters = buildCoverageFilters({
    sport,
    dateRange,
    sportExpression: 'cr.sport',
    timestampExpression: 'COALESCE(cdl.displayed_at, cr.created_at, CURRENT_TIMESTAMP)',
  });
  const pendingDisplayedWithoutFinalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
    LEFT JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
    WHERE cr.status = 'pending'
      AND gr.game_id IS NULL
      ${pendingDisplayedWithoutFinalFilters.whereSql}
  `).get(...pendingDisplayedWithoutFinalFilters.params);

  return {
    totalPending: toCount(totalPendingRow?.count),
    eligiblePendingFinalDisplayed: toCount(
      eligiblePendingFinalDisplayedRow?.count,
    ),
    settledDisplayedFinal: toCount(settledDisplayedFinalRow?.count),
    displayedFinal: toCount(displayedFinalRow?.count),
    finalDisplayedMissingResults: toCount(finalDisplayedMissingResultsRow?.count),
    finalDisplayedUnsettled: toCount(finalDisplayedUnsettledRow?.count),
    pendingWithFinalNoDisplay: toCount(pendingWithFinalNoDisplayRow?.count),
    pendingWithFinalButNotDisplayed: toCount(pendingWithFinalNoDisplayRow?.count),
    pendingWithFinalMissingMarketKey: toCount(
      pendingWithFinalMissingMarketKeyRow?.count,
    ),
    pendingDisplayedWithoutFinal: toCount(pendingDisplayedWithoutFinalRow?.count),
  };
}

function buildCardResultFilters({
  sport = null,
  dateRange = null,
  tableAlias = 'cr',
  timestampColumn = 'settled_at',
}) {
  const whereClauses = [];
  const params = [];

  if (sport) {
    whereClauses.push(`UPPER(COALESCE(${tableAlias}.sport, '')) = ?`);
    params.push(String(sport).toUpperCase());
  }
  if (dateRange?.start) {
    whereClauses.push(
      `datetime(COALESCE(${tableAlias}.${timestampColumn}, ${tableAlias}.created_at, CURRENT_TIMESTAMP)) >= datetime(?)`,
    );
    params.push(dateRange.start);
  }
  if (dateRange?.end) {
    whereClauses.push(
      `datetime(COALESCE(${tableAlias}.${timestampColumn}, ${tableAlias}.created_at, CURRENT_TIMESTAMP)) <= datetime(?)`,
    );
    params.push(dateRange.end);
  }

  return {
    whereSql: whereClauses.length > 0 ? ` AND ${whereClauses.join(' AND ')}` : '',
    params,
  };
}

function collectPendingSamples(db, {
  sport = null,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
  queryKind,
}) {
  const limit = Number.isFinite(sampleLimit) && sampleLimit > 0
    ? Math.trunc(sampleLimit)
    : DEFAULT_SAMPLE_LIMIT;
  const params = [];
  const sportSql = sport ? ` AND UPPER(COALESCE(cr.sport, '')) = ?` : '';
  if (sport) params.push(String(sport).toUpperCase());

  let sql = '';
  if (queryKind === 'eligiblePendingFinalDisplayed') {
    sql = `
      SELECT
        cr.card_id,
        cr.game_id,
        cr.sport,
        cr.market_type,
        cr.selection,
        cr.market_key,
        cdl.displayed_at,
        gr.settled_at AS game_result_settled_at,
        gr.final_score_home,
        gr.final_score_away
      FROM card_results cr
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      WHERE cr.status = 'pending'
        AND cr.market_key IS NOT NULL
        AND gr.status = 'final'
        ${sportSql}
      ORDER BY datetime(COALESCE(cdl.displayed_at, gr.settled_at, cr.created_at)) DESC
      LIMIT ?
    `;
  } else if (queryKind === 'pendingWithFinalNoDisplay') {
    sql = `
      SELECT
        cr.card_id,
        cr.game_id,
        cr.sport,
        cr.market_type,
        cr.selection,
        cr.market_key,
        gr.settled_at AS game_result_settled_at,
        gr.final_score_home,
        gr.final_score_away
      FROM card_results cr
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE cr.status = 'pending'
        AND cr.market_key IS NOT NULL
        AND gr.status = 'final'
        AND cdl.pick_id IS NULL
        ${sportSql}
      ORDER BY datetime(COALESCE(gr.settled_at, cr.created_at)) DESC
      LIMIT ?
    `;
  } else if (queryKind === 'pendingWithFinalMissingMarketKey') {
    sql = `
      SELECT
        cr.card_id,
        cr.game_id,
        cr.sport,
        cr.market_type,
        cr.selection,
        cr.market_key,
        gr.settled_at AS game_result_settled_at,
        gr.final_score_home,
        gr.final_score_away
      FROM card_results cr
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      WHERE cr.status = 'pending'
        AND cr.market_key IS NULL
        AND gr.status = 'final'
        ${sportSql}
      ORDER BY datetime(COALESCE(gr.settled_at, cr.created_at)) DESC
      LIMIT ?
    `;
  } else if (queryKind === 'pendingDisplayedWithoutFinal') {
    sql = `
      SELECT
        cr.card_id,
        cr.game_id,
        cr.sport,
        cr.market_type,
        cr.selection,
        cr.market_key,
        cdl.displayed_at
      FROM card_results cr
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      LEFT JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
      WHERE cr.status = 'pending'
        AND gr.game_id IS NULL
        ${sportSql}
      ORDER BY datetime(COALESCE(cdl.displayed_at, cr.created_at)) DESC
      LIMIT ?
    `;
  } else {
    return [];
  }

  return db.prepare(sql).all(...params, limit).map((row) => ({
    cardId: row.card_id,
    gameId: row.game_id,
    sport: row.sport,
    marketType: row.market_type,
    selection: row.selection,
    marketKey: row.market_key,
    displayedAt: row.displayed_at || null,
    gameResultSettledAt: row.game_result_settled_at || null,
    finalScoreHome:
      row.final_score_home === null || row.final_score_home === undefined
        ? null
        : Number(row.final_score_home),
    finalScoreAway:
      row.final_score_away === null || row.final_score_away === undefined
        ? null
        : Number(row.final_score_away),
  }));
}

function collectFailureDiagnostics(db, {
  sport = null,
  dateRange = null,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
}) {
  const limit = Number.isFinite(sampleLimit) && sampleLimit > 0
    ? Math.trunc(sampleLimit)
    : DEFAULT_SAMPLE_LIMIT;
  const filters = buildCardResultFilters({
    sport,
    dateRange,
    tableAlias: 'cr',
    timestampColumn: 'settled_at',
  });

  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM card_results cr
    WHERE cr.status = 'error'
      AND cr.result = 'void'
      ${filters.whereSql}
  `).get(...filters.params);

  const byCodeRows = db.prepare(`
    SELECT
      COALESCE(json_extract(cr.metadata, '$.settlement_error.code'), 'UNKNOWN') AS code,
      COUNT(*) AS count,
      MAX(cr.settled_at) AS latest_at
    FROM card_results cr
    WHERE cr.status = 'error'
      AND cr.result = 'void'
      ${filters.whereSql}
    GROUP BY COALESCE(json_extract(cr.metadata, '$.settlement_error.code'), 'UNKNOWN')
    ORDER BY COUNT(*) DESC, latest_at DESC, code ASC
  `).all(...filters.params);

  const sampleRows = db.prepare(`
    SELECT
      cr.card_id,
      cr.game_id,
      cr.sport,
      cr.market_type,
      cr.selection,
      cr.settled_at,
      cr.metadata,
      cp.card_title
    FROM card_results cr
    LEFT JOIN card_payloads cp ON cp.id = cr.card_id
    WHERE cr.status = 'error'
      AND cr.result = 'void'
      ${filters.whereSql}
    ORDER BY datetime(COALESCE(cr.settled_at, cr.created_at)) DESC, cr.card_id ASC
    LIMIT ?
  `).all(...filters.params, limit);

  return {
    totalErrored: toCount(totalRow?.count),
    byCode: byCodeRows.map((row) => ({
      code: row.code || 'UNKNOWN',
      count: toCount(row.count),
      latestAt: row.latest_at || null,
    })),
    samples: sampleRows.map((row) => {
      const metadata = parseJsonObject(row.metadata) || {};
      return {
        cardId: row.card_id,
        gameId: row.game_id,
        sport: row.sport,
        marketType: row.market_type,
        selection: row.selection,
        cardTitle: row.card_title || null,
        settledAt: row.settled_at || null,
        error: metadata.settlement_error || null,
      };
    }),
  };
}

function collectSettlementJobRuns(db, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
  const limit = Number.isFinite(sampleLimit) && sampleLimit > 0
    ? Math.trunc(sampleLimit)
    : DEFAULT_SAMPLE_LIMIT;
  const placeholders = SETTLEMENT_JOB_NAMES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT id, job_name, job_key, status, started_at, ended_at, error_message
    FROM job_runs
    WHERE job_name IN (${placeholders})
    ORDER BY datetime(COALESCE(ended_at, started_at)) DESC, started_at DESC
  `).all(...SETTLEMENT_JOB_NAMES);

  const grouped = {};
  for (const jobName of SETTLEMENT_JOB_NAMES) {
    const jobRows = rows.filter((row) => row.job_name === jobName);
    grouped[jobName] = {
      latest: jobRows[0]
        ? {
            id: jobRows[0].id,
            jobKey: jobRows[0].job_key || null,
            status: jobRows[0].status,
            startedAt: jobRows[0].started_at,
            endedAt: jobRows[0].ended_at || null,
            errorMessage: jobRows[0].error_message || null,
          }
        : null,
      latestSuccess: mapJobRun(jobRows.find((row) => row.status === 'success') || null),
      latestFailure: mapJobRun(jobRows.find((row) => row.status === 'failed') || null),
      recentFailures: jobRows
        .filter((row) => row.status === 'failed')
        .slice(0, limit)
        .map(mapJobRun),
    };
  }

  return grouped;
}

function mapJobRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobKey: row.job_key || null,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at || null,
    errorMessage: row.error_message || null,
  };
}

function toLogTimestamp(isoString) {
  return String(isoString || new Date().toISOString())
    .replace(/[:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-]/g, '')
    .replace('T', '-')
    .replace(/Z$/, '');
}

function resolveSettlementHealthLogPath(report, explicitPath = null) {
  if (explicitPath) return explicitPath;
  const timestamp = toLogTimestamp(report?.generatedAt);
  return path.join(DEFAULT_LOG_DIR, `settlement-health-${timestamp}.json`);
}

function writeSettlementHealthLog(report, explicitPath = null) {
  const outputPath = resolveSettlementHealthLogPath(report, explicitPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outputPath;
}

async function generateSettlementHealthReport({
  db = null,
  sport = null,
  days = null,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
} = {}) {
  const ownDb = !db;
  const dateRange = buildDateRange(days);
  const resolvedSport = normalizeSportFilter(sport);
  let reader = db;

  if (ownDb) {
    reader = getDatabaseReadOnly();
  }

  try {
    const coverage = collectCoverageDiagnostics(reader, resolvedSport, dateRange);
    const failures = collectFailureDiagnostics(reader, {
      sport: resolvedSport,
      dateRange,
      sampleLimit,
    });
    const blockedSamples = {
      actionablePendingFinalDisplayed: collectPendingSamples(reader, {
        sport: resolvedSport,
        sampleLimit,
        queryKind: 'eligiblePendingFinalDisplayed',
      }),
      pendingWithFinalNoDisplay: collectPendingSamples(reader, {
        sport: resolvedSport,
        sampleLimit,
        queryKind: 'pendingWithFinalNoDisplay',
      }),
      pendingWithFinalMissingMarketKey: collectPendingSamples(reader, {
        sport: resolvedSport,
        sampleLimit,
        queryKind: 'pendingWithFinalMissingMarketKey',
      }),
      pendingDisplayedWithoutFinal: collectPendingSamples(reader, {
        sport: resolvedSport,
        sampleLimit,
        queryKind: 'pendingDisplayedWithoutFinal',
      }),
    };
    const jobRuns = collectSettlementJobRuns(reader, sampleLimit);
    const dbResolution = resolveDatabasePath();

    return {
      generatedAt: new Date().toISOString(),
      filters: {
        sport: resolvedSport,
        days: Number.isFinite(days) ? days : null,
        sampleLimit:
          Number.isFinite(sampleLimit) && sampleLimit > 0
            ? Math.trunc(sampleLimit)
            : DEFAULT_SAMPLE_LIMIT,
        dateRange,
      },
      database: {
        path: dbResolution.dbPath,
        source: dbResolution.source,
      },
      summary: {
        hasUnsettledPlays: coverage.totalPending > 0,
        hasActionableUnsettledFinalDisplayed:
          coverage.eligiblePendingFinalDisplayed > 0,
        hasFailedSettlements: failures.totalErrored > 0,
        pendingTotal: coverage.totalPending,
        pendingActionableFinalDisplayed: coverage.eligiblePendingFinalDisplayed,
        finalDisplayedUnsettled: coverage.finalDisplayedUnsettled,
        failedSettlementRows: failures.totalErrored,
      },
      coverage,
      failures,
      samples: blockedSamples,
      jobRuns,
    };
  } finally {
    if (ownDb && reader) {
      closeReadOnlyInstance(reader);
    }
  }
}

function formatSettlementHealthReport(report) {
  const lines = [];
  lines.push('[SettlementHealth] Read-only report');
  if (report.logFile) {
    lines.push(`Log file: ${report.logFile}`);
  }
  lines.push(`DB: ${report.database.path} (${report.database.source})`);
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.filters.sport) {
    lines.push(`Sport filter: ${report.filters.sport}`);
  }
  if (report.filters.days) {
    lines.push(`Window: last ${report.filters.days} day(s)`);
  }
  lines.push('');
  lines.push('Summary');
  lines.push(`- Unsettled plays present: ${report.summary.hasUnsettledPlays ? 'yes' : 'no'}`);
  lines.push(
    `- Actionable pending with final+display: ${report.summary.pendingActionableFinalDisplayed}`,
  );
  lines.push(`- Final displayed unsettled: ${report.summary.finalDisplayedUnsettled}`);
  lines.push(`- Failed settlement rows: ${report.summary.failedSettlementRows}`);
  lines.push('');
  lines.push('Coverage');
  lines.push(`- totalPending: ${report.coverage.totalPending}`);
  lines.push(`- eligiblePendingFinalDisplayed: ${report.coverage.eligiblePendingFinalDisplayed}`);
  lines.push(`- settledDisplayedFinal: ${report.coverage.settledDisplayedFinal}`);
  lines.push(`- finalDisplayedMissingResults: ${report.coverage.finalDisplayedMissingResults}`);
  lines.push(`- pendingWithFinalNoDisplay: ${report.coverage.pendingWithFinalNoDisplay}`);
  lines.push(`- pendingWithFinalMissingMarketKey: ${report.coverage.pendingWithFinalMissingMarketKey}`);
  lines.push(`- pendingDisplayedWithoutFinal: ${report.coverage.pendingDisplayedWithoutFinal}`);

  lines.push('');
  lines.push('Failed settlements by code');
  if (report.failures.byCode.length === 0) {
    lines.push('- none');
  } else {
    for (const item of report.failures.byCode) {
      lines.push(`- ${item.code}: ${item.count}${item.latestAt ? ` (latest ${item.latestAt})` : ''}`);
    }
  }

  lines.push('');
  lines.push('Recent settlement job failures');
  for (const jobName of SETTLEMENT_JOB_NAMES) {
    const failures = report.jobRuns[jobName]?.recentFailures || [];
    if (failures.length === 0) {
      lines.push(`- ${jobName}: none`);
      continue;
    }
    lines.push(`- ${jobName}:`);
    for (const failure of failures) {
      lines.push(
        `  - ${failure.startedAt} | ${failure.errorMessage || 'unknown error'}${failure.jobKey ? ` | jobKey=${failure.jobKey}` : ''}`,
      );
    }
  }

  return lines.join('\n');
}

function printHelp() {
  console.log(`Settlement health report\n\nOptions:\n  --json             Print machine-readable JSON\n  --sport <SPORT>    Filter by sport (e.g. NHL, NBA, NCAAM)\n  --days <N>         Limit failures to the last N days\n  --limit <N>        Sample row count per section (default ${DEFAULT_SAMPLE_LIMIT})\n  --log-file <PATH>  Override the saved JSON log path\n  --no-log           Skip writing the JSON log artifact\n  --help             Show this help\n`);
}

if (require.main === module) {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    process.exit(0);
  }

  generateSettlementHealthReport({
    sport: options.sport,
    days: options.days,
    sampleLimit: options.limit,
  })
    .then((report) => {
      const logFile = options.writeLog
        ? writeSettlementHealthLog(report, options.logFile)
        : null;
      const outputReport = logFile ? { ...report, logFile } : report;
      if (options.json) {
        console.log(JSON.stringify(outputReport, null, 2));
      } else {
        console.log(formatSettlementHealthReport(outputReport));
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error('[SettlementHealth] Failed to generate report:', error.message);
      process.exit(1);
    });
}

module.exports = {
  collectFailureDiagnostics,
  collectPendingSamples,
  collectSettlementJobRuns,
  formatSettlementHealthReport,
  generateSettlementHealthReport,
  parseArgs,
  resolveSettlementHealthLogPath,
  writeSettlementHealthLog,
  __private: {
    collectCoverageDiagnostics,
    buildCardResultFilters,
    buildCoverageFilters,
    buildDateRange,
    normalizeSportFilter,
    normalizeLogFilePath,
    parseJsonObject,
    parsePositiveInteger,
    toLogTimestamp,
  },
};
