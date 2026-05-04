'use strict';

/**
 * Run Daily Performance Report Job
 *
 * Computes and writes daily per-market performance rows to
 * daily_performance_reports.  Tracks two distinct axes:
 *
 * Firing metrics — did the model generate signals?
 *   eligible_games, model_ok_count, degraded_count, no_bet_count,
 *   bets_placed, bets_blocked_gate
 *
 * Winning metrics — did signals lead to value?
 *   hit_rate, roi, avg_edge_at_placement, avg_clv, brier, ece, max_drawdown
 *
 * Sources:
 *   calibration_predictions  → eligible_games, model_ok_count, degraded_count,
 *                              no_bet_count, avg_edge_at_placement
 *   card_results             → hit_rate, roi, bets_placed, max_drawdown
 *   clv_entries              → avg_clv
 *   calibration_reports      → brier, ece (latest report for the market)
 *
 * Run nightly (03:00 ET) after settle_pending_cards and run_clv_snapshot.
 *
 * WI-0826
 */

require('dotenv').config();

const {
  createJob,
  closeDatabase,
  getDatabase,
  insertJobRun,
  markJobRunFailure,
  markJobRunSuccess,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');
const { randomUUID } = require('crypto');

const REPORT_PERIOD_DAYS = 1; // compute previous calendar day

/**
 * Normalise market_type + sport → market key (e.g. NHL_TOTAL).
 *
 * @param {string|null} sport
 * @param {string|null} marketType
 * @returns {string|null}
 */
function buildMarketKey(sport, marketType) {
  if (!sport || !marketType) return null;
  const s = String(sport).trim().toUpperCase();
  const mt = String(marketType).trim().toUpperCase();
  return `${s}_${mt}`;
}

/**
 * Resolve sport from a market key (e.g. "NHL_TOTAL" → "NHL").
 *
 * @param {string} market
 * @returns {string}
 */
function sportFromMarket(market) {
  return String(market || '').split('_')[0].toUpperCase();
}

/**
 * Compute max drawdown from an ordered list of P&L unit values.
 * Returns 0 when the list is empty or has no drawdown.
 *
 * @param {number[]} pnlList   ordered chronologically
 * @returns {number}
 */
function computeMaxDrawdown(pnlList) {
  if (!Array.isArray(pnlList) || pnlList.length === 0) return 0;
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  for (const pnl of pnlList) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  return Number(maxDrawdown.toFixed(4));
}

/**
 * Firing + model-status counts for a market on a given date.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} market  e.g. 'NHL_TOTAL'
 * @param {string} reportDate  YYYY-MM-DD
 * @returns {object}
 */
function queryFiringMetrics(db, market, reportDate) {
  const emptyMetrics = {
    eligible_games: 0,
    model_ok_count: 0,
    degraded_count: 0,
    no_bet_count: 0,
    avg_edge_at_placement: null,
  };

  const hasCp = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_predictions'",
  ).get();
  if (!hasCp) return emptyMetrics;

  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT game_id)                                                  AS eligible_games,
      COALESCE(SUM(CASE WHEN model_status = 'MODEL_OK'  THEN 1 ELSE 0 END), 0) AS model_ok_count,
      COALESCE(SUM(CASE WHEN model_status = 'DEGRADED'  THEN 1 ELSE 0 END), 0) AS degraded_count,
      COALESCE(SUM(CASE WHEN model_status = 'NO_BET'    THEN 1 ELSE 0 END), 0) AS no_bet_count,
      AVG(
        CASE
          WHEN fair_prob IS NOT NULL AND implied_prob IS NOT NULL
          THEN fair_prob - implied_prob
          ELSE NULL
        END
      ) AS avg_edge_at_placement
    FROM calibration_predictions
    WHERE market = ?
      AND date(created_at) = ?
  `).get(market, reportDate);

  if (!row) return emptyMetrics;

  return {
    eligible_games: Number(row.eligible_games || 0),
    model_ok_count: Number(row.model_ok_count || 0),
    degraded_count: Number(row.degraded_count || 0),
    no_bet_count: Number(row.no_bet_count || 0),
    avg_edge_at_placement:
      row.avg_edge_at_placement !== null && !Number.isNaN(Number(row.avg_edge_at_placement))
        ? Number(Number(row.avg_edge_at_placement).toFixed(4))
        : null,
  };
}

/**
 * Winning metrics from card_results for a market on a given date.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} market  e.g. 'NHL_TOTAL'
 * @param {string} reportDate  YYYY-MM-DD
 * @returns {object}
 */
function queryWinningMetrics(db, market, reportDate) {
  const empty = {
    bets_placed: 0,
    hit_rate: null,
    roi: null,
    max_drawdown: null,
  };

  const hasCr = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_results'",
  ).get();
  if (!hasCr) return empty;

  const sport = sportFromMarket(market);
  // Derive market_type token from the market key (strip sport prefix):
  const marketType = String(market || '').replace(/^[^_]+_/, '').toLowerCase();

  const rows = db.prepare(`
    SELECT result, pnl_units, settled_at
    FROM card_results
    WHERE sport = ?
      AND (market_type = ? OR recommended_bet_type = ?)
      AND status = 'settled'
      AND date(COALESCE(settled_at, created_at)) = ?
      AND is_primary = 1
    ORDER BY COALESCE(settled_at, created_at) ASC
  `).all(sport, marketType, marketType, reportDate);

  if (rows.length === 0) return empty;

  const betsPlaced = rows.length;
  const settled = rows.filter(
    (r) => r.result === 'win' || r.result === 'loss',
  );
  const wins = settled.filter((r) => r.result === 'win').length;
  const hitRate = settled.length > 0 ? Number((wins / settled.length).toFixed(4)) : null;

  const pnlValues = rows
    .map((r) => Number(r.pnl_units ?? 0))
    .filter((v) => Number.isFinite(v));

  const roi = pnlValues.length > 0
    ? Number((pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length).toFixed(4))
    : null;

  const maxDrawdown = computeMaxDrawdown(pnlValues);

  return {
    bets_placed: betsPlaced,
    hit_rate: hitRate,
    roi,
    max_drawdown: maxDrawdown > 0 ? maxDrawdown : null,
  };
}

/**
 * Average CLV for a market on a given date from clv_entries.
 * Returns null if no entries exist (not 0 — null means "not yet resolved").
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} market
 * @param {string} reportDate
 * @returns {number|null}
 */
function queryAvgClv(db, market, reportDate) {
  const hasCe = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='clv_entries'",
  ).get();
  if (!hasCe) return null;

  const row = db.prepare(`
    SELECT AVG(clv) AS avg_clv, COUNT(*) AS entry_count
    FROM clv_entries
    WHERE market = ?
      AND clv IS NOT NULL
      AND date(created_at) = ?
  `).get(market, reportDate);

  if (!row || Number(row.entry_count || 0) === 0) return null;
  const avg = row.avg_clv;
  if (avg === null || avg === undefined) return null;
  return Number(Number(avg).toFixed(4));
}

/**
 * Latest brier + ece from calibration_reports for a market.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} market
 * @returns {{brier: number|null, ece: number|null}}
 */
function queryCalibrationMetrics(db, market) {
  const empty = { brier: null, ece: null };

  const hasCr = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_reports'",
  ).get();
  if (!hasCr) return empty;

  const row = db.prepare(`
    SELECT brier, ece
    FROM calibration_reports
    WHERE market = ?
    ORDER BY computed_at DESC
    LIMIT 1
  `).get(market);

  return {
    brier: row?.brier ?? null,
    ece: row?.ece ?? null,
  };
}

/**
 * Build the list of markets that had activity on this reportDate.
 * Drawn from calibration_predictions for the broadest coverage.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} reportDate
 * @returns {string[]}
 */
function resolveActiveMarkets(db, reportDate) {
  const hasCp = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='calibration_predictions'",
  ).get();
  if (!hasCp) return [];

  const rows = db.prepare(`
    SELECT DISTINCT market
    FROM calibration_predictions
    WHERE date(created_at) = ?
      AND market IS NOT NULL
      AND market != ''
  `).all(reportDate);

  // Also include any clv_entries markets
  const hasCe = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='clv_entries'",
  ).get();
  const clvMarkets = hasCe
    ? db.prepare(`
        SELECT DISTINCT market
        FROM clv_entries
        WHERE date(created_at) = ?
          AND market IS NOT NULL
          AND market != ''
      `).all(reportDate)
    : [];

  const markets = new Set([
    ...rows.map((r) => r.market),
    ...clvMarkets.map((r) => r.market),
  ]);
  return [...markets].sort();
}

/**
 * Main entry point.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db]
 * @param {string} [options.reportDate]  YYYY-MM-DD (defaults to yesterday)
 * @param {string} [options.computedAt]  ISO timestamp override
 * @returns {{ reportDate: string, reports: Array }}
 */
function runDailyPerformanceReport(options = {}) {
  const db = options.db || getDatabase();
  const computedAt = options.computedAt || new Date().toISOString();
  const dryRun =
    options.dryRun === true ||
    process.env.DRY_RUN === 'true' ||
    process.argv.includes('--dry-run');
  const jobKey = options.jobKey || null;
  const jobRunId = jobKey && !dryRun ? randomUUID() : null;

  if (jobKey && !dryRun && !shouldRunJobKey(jobKey)) {
    console.log(`[PERF_REPORT] Skipping (already succeeded or running): ${jobKey}`);
    return { success: true, skipped: true, jobKey };
  }

  if (dryRun) {
    console.log(`[PERF_REPORT] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`);
    return { success: true, dryRun: true, jobKey };
  }

  if (jobRunId) {
    try {
      insertJobRun('run_daily_performance_report', jobRunId, jobKey);
    } catch (error) {
      if (error?.code === 'JOB_RUN_ALREADY_CLAIMED') {
        return { success: true, skipped: true, jobKey };
      }
      throw error;
    }
  }

  // Default to yesterday (this job runs in the early hours after the day ends)
  const reportDate =
    options.reportDate ||
    (() => {
      const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return d.toISOString().slice(0, 10);
    })();

  try {
    const markets = resolveActiveMarkets(db, reportDate);

    if (markets.length === 0) {
      console.log(`[PERF_REPORT] No active markets for ${reportDate}`);
      if (jobRunId) markJobRunSuccess(jobRunId);
      return { success: true, jobKey, reportDate, reports: [] };
    }

    const upsert = db.prepare(`
    INSERT INTO daily_performance_reports (
      report_date, market, sport,
      eligible_games, model_ok_count, degraded_count, no_bet_count,
      bets_placed, bets_blocked_gate,
      hit_rate, roi,
      avg_edge_at_placement, avg_clv,
      brier, ece,
      max_drawdown, computed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(report_date, market, sport) DO UPDATE SET
      eligible_games        = excluded.eligible_games,
      model_ok_count        = excluded.model_ok_count,
      degraded_count        = excluded.degraded_count,
      no_bet_count          = excluded.no_bet_count,
      bets_placed           = excluded.bets_placed,
      bets_blocked_gate     = excluded.bets_blocked_gate,
      hit_rate              = excluded.hit_rate,
      roi                   = excluded.roi,
      avg_edge_at_placement = excluded.avg_edge_at_placement,
      avg_clv               = excluded.avg_clv,
      brier                 = excluded.brier,
      ece                   = excluded.ece,
      max_drawdown          = excluded.max_drawdown,
      computed_at           = excluded.computed_at
  `);

    const reports = [];

    const writeAll = db.transaction((rows) => {
      for (const row of rows) {
        upsert.run(
        row.reportDate,
        row.market,
        row.sport,
        row.eligible_games,
        row.model_ok_count,
        row.degraded_count,
        row.no_bet_count,
        row.bets_placed,
        row.bets_blocked_gate,
        row.hit_rate,
        row.roi,
        row.avg_edge_at_placement,
        row.avg_clv,
        row.brier,
        row.ece,
        row.max_drawdown,
        computedAt,
      );
      }
    });

    for (const market of markets) {
      const sport = sportFromMarket(market);
      const firing = queryFiringMetrics(db, market, reportDate);
      const winning = queryWinningMetrics(db, market, reportDate);
      const avgClv = queryAvgClv(db, market, reportDate);
      const cal = queryCalibrationMetrics(db, market);

    // bets_blocked_gate = games where model said OK but no bet was placed
      const betsBlockedGate = Math.max(
        0,
        firing.model_ok_count - winning.bets_placed,
      );

      const report = {
        reportDate,
        market,
        sport,
        ...firing,
        bets_placed: winning.bets_placed,
        bets_blocked_gate: betsBlockedGate,
        hit_rate: winning.hit_rate,
        roi: winning.roi,
        avg_clv: avgClv,
        brier: cal.brier,
        ece: cal.ece,
        max_drawdown: winning.max_drawdown,
      };

      reports.push(report);
    }

    writeAll(reports);

    console.log(
      `[PERF_REPORT] ${reportDate} — wrote ${reports.length} market report(s): ${markets.join(', ')}`,
    );

    if (jobRunId) markJobRunSuccess(jobRunId);
    return { success: true, jobKey, reportDate, reports };
  } catch (error) {
    if (jobRunId) markJobRunFailure(jobRunId, error.message);
    throw error;
  }
}

module.exports = {
  buildMarketKey,
  computeMaxDrawdown,
  runDailyPerformanceReport,
  queryAvgClv,
};

if (require.main === module) {
  createJob('run_daily_performance_report', ({ dryRun }) => withDb(() => {
    const result = runDailyPerformanceReport({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }));
}
