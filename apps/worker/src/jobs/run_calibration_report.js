'use strict';

require('dotenv').config();

const {
  closeDatabase,
  getDatabase,
} = require('@cheddar-logic/data');
const {
  getCalibrationReport,
} = require('../calibration/calibration-tracker');
const {
  THRESHOLDS,
  clearCalibrationGateCache,
  resolveCalibrationMarketKey,
} = require('../calibration/calibration-gate');

const PERIOD_DAYS = 30;

function parseMetadata(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function toOutcome(result) {
  const token = String(result || '').trim().toLowerCase();
  if (token === 'win') return 1;
  if (token === 'loss') return 0;
  return null;
}

function resolveRowPeriod(row) {
  const metadata = parseMetadata(row?.metadata);
  return (
    metadata?.lockedMarket?.period ??
    metadata?.period ??
    null
  );
}

function syncResolvedPredictionOutcomes(db, periodDays = PERIOD_DAYS) {
  const settledRows = db.prepare(`
    SELECT
      game_id,
      sport,
      card_type,
      recommended_bet_type,
      market_type,
      selection,
      result,
      metadata
    FROM card_results
    WHERE status = 'settled'
      AND result IN ('win', 'loss')
      AND datetime(COALESCE(settled_at, CURRENT_TIMESTAMP)) >= datetime('now', ?)
    ORDER BY datetime(COALESCE(settled_at, CURRENT_TIMESTAMP)) DESC, id DESC
  `).all(`-${periodDays} days`);

  const updatePrediction = db.prepare(`
    UPDATE calibration_predictions
    SET outcome = ?
    WHERE game_id = ?
      AND market = ?
      AND side = ?
      AND outcome IS NULL
  `);

  let updated = 0;
  for (const row of settledRows) {
    const market = resolveCalibrationMarketKey(null, {
      sport: row.sport,
      recommendedBetType: row.recommended_bet_type,
      marketType: row.market_type,
      period: resolveRowPeriod(row),
      cardType: row.card_type,
    });
    const outcome = toOutcome(row.result);
    const side = String(row.selection || '').trim().toUpperCase();
    if (!market || outcome === null || !side) {
      continue;
    }
    updated += updatePrediction.run(
      outcome,
      row.game_id,
      market,
      side,
    ).changes;
  }

  return updated;
}

function runCalibrationReport(options = {}) {
  const db = options.db || getDatabase();
  const periodDays = Number.isFinite(options.periodDays)
    ? Math.trunc(options.periodDays)
    : PERIOD_DAYS;
  const computedAt = options.computedAt || new Date().toISOString();
  const periodStart = new Date(Date.now() - (periodDays * 24 * 60 * 60 * 1000)).toISOString();

  const updatedPredictions = syncResolvedPredictionOutcomes(db, periodDays);
  const activeMarkets = db.prepare(`
    SELECT DISTINCT market
    FROM calibration_predictions
    WHERE outcome IS NOT NULL
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY market ASC
  `).all(`-${periodDays} days`);

  const insertReport = db.prepare(`
    INSERT INTO calibration_reports (
      market,
      period_start,
      period_days,
      brier,
      ece,
      n_samples,
      kill_switch_active,
      computed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const reports = [];
  const writeReports = db.transaction((rows) => {
    for (const row of rows) {
      insertReport.run(
        row.market,
        periodStart,
        periodDays,
        row.brier,
        row.ece,
        row.nSamples,
        row.killSwitchActive ? 1 : 0,
        computedAt,
      );
    }
  });

  for (const marketRow of activeMarkets) {
    const market = String(marketRow.market || '').trim().toUpperCase();
    const threshold = THRESHOLDS[market];
    if (!threshold) {
      continue;
    }

    const report = getCalibrationReport(market, {
      db,
      minSamples: 0,
      periodDays,
    });
    if (!report) {
      continue;
    }

    const killSwitchActive = (
      report.nSamples >= threshold.minSamples &&
      Number.isFinite(report.ece) &&
      report.ece > threshold.ece
    );

    reports.push({
      ...report,
      killSwitchActive,
    });
  }

  writeReports(reports);
  clearCalibrationGateCache();

  return {
    updatedPredictions,
    reports,
  };
}

module.exports = {
  PERIOD_DAYS,
  runCalibrationReport,
  syncResolvedPredictionOutcomes,
};

if (require.main === module) {
  try {
    const result = runCalibrationReport();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('[CALIBRATION] run_calibration_report failed:', error);
    process.exitCode = 1;
  } finally {
    closeDatabase();
  }
}
