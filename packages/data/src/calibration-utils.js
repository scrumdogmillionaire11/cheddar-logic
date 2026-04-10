'use strict';

/**
 * Calibration utilities extracted from apps/worker/src/calibration/ to break
 * the circular dependency:  packages/data → apps/worker → @cheddar-logic/data
 *
 * This file intentionally has no imports from @cheddar-logic/data.
 * The `db` handle must always be passed explicitly (never resolved lazily here).
 */

const THRESHOLDS = Object.freeze({
  NHL_TOTAL: Object.freeze({ ece: 0.06, minSamples: 50 }),
  NBA_TOTAL: Object.freeze({ ece: 0.06, minSamples: 50 }),
  MLB_F5_TOTAL: Object.freeze({ ece: 0.07, minSamples: 30 }),
  SPREAD: Object.freeze({ ece: 0.07, minSamples: 50 }),
  ML: Object.freeze({ ece: 0.08, minSamples: 50 }),
});

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeBetType(value) {
  const token = toUpperToken(value);
  if (!token) return '';
  if (token === 'MONEYLINE' || token === 'H2H' || token === 'ML') return 'MONEYLINE';
  if (token === 'SPREAD' || token === 'PUCKLINE' || token === 'PUCK_LINE' || token === 'ATS') {
    return 'SPREAD';
  }
  if (
    token === 'TOTAL' ||
    token === 'TOTALS' ||
    token === 'OVER_UNDER' ||
    token === 'OU'
  ) {
    return 'TOTAL';
  }
  return token;
}

function normalizePeriod(value) {
  const token = toUpperToken(value);
  if (!token) return '';
  if (
    token === '1P' ||
    token === 'P1' ||
    token === 'FIRST_PERIOD' ||
    token === 'FIRST_5' ||
    token === 'F5'
  ) {
    return '1P';
  }
  return token;
}

function resolveCalibrationMarketKey(marketKey, context = {}) {
  const directToken = toUpperToken(marketKey);
  if (THRESHOLDS[directToken]) {
    return directToken;
  }

  const sport = toUpperToken(context.sport);
  const cardType = toUpperToken(context.cardType);
  const marketType = normalizeBetType(context.marketType);
  let betType = normalizeBetType(context.recommendedBetType);
  let period = normalizePeriod(context.period);

  if (!betType) {
    if (directToken.includes(':MONEYLINE:') || directToken.includes(':ML:')) {
      betType = 'MONEYLINE';
    } else if (directToken.includes(':SPREAD:')) {
      betType = 'SPREAD';
    } else if (directToken.includes(':TOTAL:')) {
      betType = 'TOTAL';
    }
  }

  if (!period && directToken.includes(':1P:')) {
    period = '1P';
  }

  if (betType === 'TOTAL' && sport === 'MLB') {
    const marketTypeToken = toUpperToken(context.marketType);
    if (
      period === '1P' ||
      cardType.includes('MLB_F5') ||
      directToken.includes('F5') ||
      marketTypeToken === 'FIRST_PERIOD'
    ) {
      return 'MLB_F5_TOTAL';
    }
  }

  if (betType === 'TOTAL' && sport === 'NHL') return 'NHL_TOTAL';
  if (betType === 'TOTAL' && sport === 'NBA') return 'NBA_TOTAL';
  if (betType === 'SPREAD') return 'SPREAD';
  if (betType === 'MONEYLINE') return 'ML';

  if (marketType === 'SPREAD') return 'SPREAD';

  return null;
}

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

/**
 * Write a calibration prediction row.
 * `entry.db` MUST be provided — this function never calls getDatabase().
 */
function recordPrediction(entry) {
  if (!entry || typeof entry !== 'object') return false;

  const fairProb = toFiniteProbability(entry.fairProb ?? entry.fair_prob ?? entry.model_prob);
  if (fairProb === null) return false;

  const market = resolveCalibrationMarketKey(entry.market, entry);
  if (!market) return false;

  const side = String(entry.side || '').trim().toUpperCase();
  if (!side) return false;

  if (!entry.db) return false;

  entry.db.prepare(`
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

module.exports = {
  THRESHOLDS,
  resolveCalibrationMarketKey,
  recordPrediction,
};
