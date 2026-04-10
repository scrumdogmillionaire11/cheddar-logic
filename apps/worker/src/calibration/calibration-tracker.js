'use strict';

const { resolveCalibrationMarketKey } = require('./calibration-gate');

function toFiniteProbability(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed < 0 || parsed > 1) return null;
  return parsed;
}

function toOutcome(value) {
  const parsed = Number(value);
  if (parsed !== 0 && parsed !== 1) return null;
  return parsed;
}

function normalizeSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const prob = toFiniteProbability(
    sample.prob ?? sample.fair_prob ?? sample.fairProb ?? sample.model_prob,
  );
  const outcome = toOutcome(sample.outcome);
  if (prob === null || outcome === null) return null;
  return { prob, outcome };
}

function getDatabaseHandle(db) {
  if (db) return db;
  return require('@cheddar-logic/data').getDatabase();
}

function recordPrediction(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const fairProb = toFiniteProbability(entry.fairProb ?? entry.fair_prob ?? entry.model_prob);
  if (fairProb === null) return false;

  const market = resolveCalibrationMarketKey(entry.market, entry);
  if (!market) return false;

  const side = String(entry.side || '').trim().toUpperCase();
  if (!side) return false;

  const db = getDatabaseHandle(entry.db);
  db.prepare(`
    INSERT INTO calibration_predictions (
      game_id,
      market,
      side,
      fair_prob,
      implied_prob,
      outcome,
      model_status,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.gameId,
    market,
    side,
    fairProb,
    toFiniteProbability(entry.impliedProb ?? entry.implied_prob),
    toOutcome(entry.outcome),
    String(entry.modelStatus || entry.model_status || 'MODEL_OK').trim().toUpperCase() || 'MODEL_OK',
    entry.createdAt || new Date().toISOString(),
  );

  return true;
}

function computeBrier(predictions) {
  const samples = Array.isArray(predictions)
    ? predictions.map(normalizeSample).filter(Boolean)
    : [];
  if (samples.length === 0) return null;

  const total = samples.reduce((sum, sample) => {
    return sum + ((sample.prob - sample.outcome) ** 2);
  }, 0);

  return total / samples.length;
}

function computeECE(predictions, nBins = 10) {
  const samples = Array.isArray(predictions)
    ? predictions.map(normalizeSample).filter(Boolean)
    : [];
  if (samples.length === 0) return null;

  const binCount = Number.isFinite(nBins) && nBins > 0 ? Math.trunc(nBins) : 10;
  const bins = Array.from({ length: binCount }, () => ({
    count: 0,
    probSum: 0,
    outcomeSum: 0,
  }));

  for (const sample of samples) {
    const index = Math.min(Math.floor(sample.prob * binCount), binCount - 1);
    bins[index].count += 1;
    bins[index].probSum += sample.prob;
    bins[index].outcomeSum += sample.outcome;
  }

  return bins.reduce((ece, bin) => {
    if (bin.count === 0) return ece;
    const avgProb = bin.probSum / bin.count;
    const avgOutcome = bin.outcomeSum / bin.count;
    return ece + ((bin.count / samples.length) * Math.abs(avgProb - avgOutcome));
  }, 0);
}

function getCalibrationReport(market, options = {}) {
  const periodDays = Number.isFinite(options.periodDays) ? Math.trunc(options.periodDays) : 30;
  const minSamples = Number.isFinite(options.minSamples) ? Math.trunc(options.minSamples) : 0;
  const resolvedMarket = resolveCalibrationMarketKey(market, options);
  if (!resolvedMarket) return null;

  const db = getDatabaseHandle(options.db);
  const rows = db.prepare(`
    SELECT fair_prob, outcome
    FROM calibration_predictions
    WHERE market = ?
      AND outcome IS NOT NULL
      AND datetime(created_at) >= datetime('now', ?)
    ORDER BY datetime(created_at) DESC, id DESC
  `).all(resolvedMarket, `-${periodDays} days`);

  if (rows.length < minSamples) {
    return null;
  }

  return {
    market: resolvedMarket,
    periodDays,
    brier: computeBrier(rows),
    ece: computeECE(rows),
    nSamples: rows.length,
  };
}

module.exports = {
  computeBrier,
  computeECE,
  getCalibrationReport,
  recordPrediction,
};
