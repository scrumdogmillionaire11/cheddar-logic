'use strict';

/**
 * settlement-roi-report.js
 *
 * Read-only cross-market settlement ROI report.
 * Queries card_results (with optional clv_ledger join) to produce per-market
 * win-rate, ROI, and recommendation output.
 *
 * Gates all future model promotion and quarantine decisions.
 *
 * Usage:
 *   CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/settlement-roi-report.js
 *   node scripts/settlement-roi-report.js --sport=NBA
 *   node scripts/settlement-roi-report.js --min-settled=10
 *   node scripts/settlement-roi-report.js --help
 */

const {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} = require('../packages/data/src/db.js');
const { resolveDatabasePath } = require('../packages/data/src/db-path.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
Cross-Market Settlement ROI Report
===================================

Usage:
  CHEDDAR_DB_PATH=<path> node scripts/settlement-roi-report.js [options]

Options:
  --sport=NBA       Filter output to a single sport (e.g. NBA, NHL, MLB, NCAAM)
  --min-settled=N   Override the minimum settled cards threshold (default: 20)
  --help, -h        Show this help message

Environment:
  CHEDDAR_DB_PATH   Path to the SQLite database file

Recommendation thresholds (for markets with >= min-settled cards):
  PROMOTE           win_rate > 54%
  WATCH             win_rate >= 50%
  QUARANTINE        win_rate < 50%
  INSUFFICIENT_DATA win_rate null OR settled_count < min-settled
`);
  process.exit(0);
}

function parseFlag(name, defaultValue) {
  const prefix = `--${name}=`;
  const match = args.find((a) => a.startsWith(prefix));
  if (!match) return defaultValue;
  return match.slice(prefix.length);
}

const SPORT_FILTER = parseFlag('sport', null);
const MIN_SETTLED = parseInt(parseFlag('min-settled', '20'), 10);

// ---------------------------------------------------------------------------
// Recommendation logic
// ---------------------------------------------------------------------------

/**
 * @param {number|null} win_rate  Fractional win rate (e.g. 0.55), or null
 * @param {number} settled_count  Total settled cards in the group
 * @returns {string}
 */
function deriveRecommendation(win_rate, settled_count) {
  if (settled_count < MIN_SETTLED || win_rate === null || win_rate === undefined) {
    return 'INSUFFICIENT_DATA';
  }
  if (win_rate > 0.54) return 'PROMOTE';
  if (win_rate >= 0.50) return 'WATCH';
  return 'QUARANTINE';
}

// ---------------------------------------------------------------------------
// Table formatting helpers
// ---------------------------------------------------------------------------

function pad(value, width, align = 'left') {
  const str = value === null || value === undefined ? '' : String(value);
  if (align === 'right') return str.padStart(width);
  return str.padEnd(width);
}

function fmtPct(value) {
  if (value === null || value === undefined) return 'n/a';
  return (value * 100).toFixed(1) + '%';
}

function fmtNum(value, decimals = 2) {
  if (value === null || value === undefined) return 'n/a';
  return Number(value).toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const resolvedPath = (() => {
    try {
      const result = resolveDatabasePath();
      // resolveDatabasePath() returns { dbPath, source, isExplicitFile }
      return (result && result.dbPath) ? result.dbPath : String(result);
    } catch {
      return process.env.CHEDDAR_DB_PATH || '(unknown)';
    }
  })();

  let db;
  try {
    db = getDatabaseReadOnly();
  } catch (err) {
    process.stderr.write(
      `[settlement-roi-report] ERROR: Cannot open database.\n` +
        `  Message: ${err.message}\n` +
        `  Hint: Set CHEDDAR_DB_PATH to the full path of your SQLite database file.\n` +
        `  Example: CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/settlement-roi-report.js\n`,
    );
    process.exit(1);
  }

  try {
    // -----------------------------------------------------------------------
    // Detect clv_ledger presence
    // -----------------------------------------------------------------------
    const clvRow = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='clv_ledger'`,
      )
      .get();
    const hasClvLedger = Boolean(clvRow);

    // -----------------------------------------------------------------------
    // Build per-market ROI query dynamically
    // -----------------------------------------------------------------------
    const clvSelect = hasClvLedger
      ? 'ROUND(AVG(clv.clv_pct), 4)'
      : 'NULL';
    const clvJoin = hasClvLedger
      ? 'LEFT JOIN clv_ledger clv ON clv.card_id = cr.card_id'
      : '';

    const sportFilter = SPORT_FILTER
      ? `AND cr.sport = ?`
      : '';
    const queryParams = SPORT_FILTER ? [SPORT_FILTER] : [];

    const sql = `
      SELECT
        cr.sport,
        cr.market_key,
        CASE
          WHEN json_extract(cr.metadata, '$.market_period_token') IS NOT NULL
            THEN json_extract(cr.metadata, '$.market_period_token')
          ELSE 'FULL_GAME'
        END AS period,
        COUNT(*) AS settled_count,
        SUM(CASE WHEN cr.result = 'win'  THEN 1 ELSE 0 END) AS win_count,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS loss_count,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS push_count,
        ROUND(
          SUM(CASE WHEN cr.result = 'win' THEN 1.0 ELSE 0 END)
          / NULLIF(SUM(CASE WHEN cr.result IN ('win','loss') THEN 1 ELSE 0 END), 0),
          4
        ) AS win_rate,
        ${clvSelect} AS avg_clv,
        ROUND(SUM(COALESCE(cr.pnl_units, 0)), 2) AS units_won
      FROM card_results cr
      ${clvJoin}
      WHERE cr.status = 'settled'
        AND cr.settled_at >= '2026-01-01'
        AND cr.market_key IS NOT NULL
        ${sportFilter}
      GROUP BY cr.sport, cr.market_key, period
      ORDER BY cr.sport, units_won DESC
    `;

    const rows = db.prepare(sql).all(...queryParams);

    // -----------------------------------------------------------------------
    // Add recommendation to each row
    // -----------------------------------------------------------------------
    const enriched = rows.map((row) => ({
      ...row,
      recommendation: deriveRecommendation(row.win_rate, row.settled_count),
    }));

    // -----------------------------------------------------------------------
    // Print header
    // -----------------------------------------------------------------------
    const generated = new Date().toISOString();
    const clvStatus = hasClvLedger ? 'yes' : 'no';

    console.log('');
    console.log('=== Cross-Market Settlement ROI Report ===');
    console.log(
      `Generated: ${generated}  |  DB: ${resolvedPath}  |  CLV data: ${clvStatus}`,
    );
    console.log('');

    // -----------------------------------------------------------------------
    // Per-market table
    // -----------------------------------------------------------------------
    console.log('--- Per-Market Breakdown ---');

    // Column widths
    const W = {
      sport: 12,
      market_key: 28,
      period: 10,
      settled: 8,
      win: 5,
      loss: 5,
      push: 5,
      win_rate: 9,
      avg_clv: 9,
      units: 9,
      recommendation: 18,
    };

    const header =
      pad('SPORT', W.sport) +
      pad('MARKET_KEY', W.market_key) +
      pad('PERIOD', W.period) +
      pad('SETTLED', W.settled, 'right') +
      pad('WIN', W.win, 'right') +
      pad('LOSS', W.loss, 'right') +
      pad('PUSH', W.push, 'right') +
      pad('WIN_RATE', W.win_rate, 'right') +
      pad('AVG_CLV', W.avg_clv, 'right') +
      pad('UNITS', W.units, 'right') +
      '  ' +
      pad('RECOMMENDATION', W.recommendation);

    console.log(header);
    console.log('-'.repeat(header.length));

    if (enriched.length === 0) {
      console.log('  (no settled cards found matching filter criteria)');
    } else {
      for (const row of enriched) {
        const line =
          pad(row.sport || '', W.sport) +
          pad(row.market_key || '', W.market_key) +
          pad(row.period || 'FULL_GAME', W.period) +
          pad(String(row.settled_count), W.settled, 'right') +
          pad(String(row.win_count), W.win, 'right') +
          pad(String(row.loss_count), W.loss, 'right') +
          pad(String(row.push_count), W.push, 'right') +
          pad(fmtPct(row.win_rate), W.win_rate, 'right') +
          pad(fmtPct(row.avg_clv), W.avg_clv, 'right') +
          pad(fmtNum(row.units_won), W.units, 'right') +
          '  ' +
          pad(row.recommendation, W.recommendation);
        console.log(line);
      }
    }

    // -----------------------------------------------------------------------
    // Per-sport rollup
    // -----------------------------------------------------------------------
    console.log('');
    console.log('--- Per-Sport Rollup ---');

    /** @type {Map<string, {settled:number,win:number,loss:number,push:number,units:number,topMarket:string|null,topMarketUnits:number}>} */
    const sportMap = new Map();
    for (const row of enriched) {
      const sport = row.sport || '(unknown)';
      if (!sportMap.has(sport)) {
        sportMap.set(sport, {
          settled: 0,
          win: 0,
          loss: 0,
          push: 0,
          units: 0,
          topMarket: null,
          topMarketUnits: -Infinity,
        });
      }
      const s = sportMap.get(sport);
      s.settled += row.settled_count || 0;
      s.win += row.win_count || 0;
      s.loss += row.loss_count || 0;
      s.push += row.push_count || 0;
      s.units += row.units_won || 0;
      if ((row.units_won || 0) > s.topMarketUnits) {
        s.topMarketUnits = row.units_won || 0;
        s.topMarket = row.market_key;
      }
    }

    const RW = {
      sport: 12,
      settled: 8,
      win_rate: 9,
      units: 9,
      top_market: 28,
    };

    const rollupHeader =
      pad('SPORT', RW.sport) +
      pad('SETTLED', RW.settled, 'right') +
      pad('WIN_RATE', RW.win_rate, 'right') +
      pad('UNITS', RW.units, 'right') +
      '  ' +
      pad('TOP_MARKET', RW.top_market);

    console.log(rollupHeader);
    console.log('-'.repeat(rollupHeader.length));

    if (sportMap.size === 0) {
      console.log('  (no data)');
    } else {
      for (const [sport, s] of sportMap) {
        const decidable = s.win + s.loss;
        const win_rate = decidable > 0 ? s.win / decidable : null;
        const line =
          pad(sport, RW.sport) +
          pad(String(s.settled), RW.settled, 'right') +
          pad(fmtPct(win_rate), RW.win_rate, 'right') +
          pad(fmtNum(s.units), RW.units, 'right') +
          '  ' +
          pad(s.topMarket || '', RW.top_market);
        console.log(line);
      }
    }

    console.log('');
  } finally {
    closeReadOnlyInstance(db);
  }
}

main();
