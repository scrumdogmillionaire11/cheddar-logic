'use strict';

const { getDatabase } = require('@cheddar-logic/data');

const CACHE_TTL_MS = 60 * 1000;
const THRESHOLDS = Object.freeze({
  NHL_TOTAL: Object.freeze({ ece: 0.06, minSamples: 50 }),
  NBA_TOTAL: Object.freeze({ ece: 0.06, minSamples: 50 }),
  MLB_F5_TOTAL: Object.freeze({ ece: 0.07, minSamples: 30 }),
  SPREAD: Object.freeze({ ece: 0.07, minSamples: 50 }),
  ML: Object.freeze({ ece: 0.08, minSamples: 50 }),
});

const reportCache = new Map();

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

function getThresholdForMarket(marketKey, context = {}) {
  const resolvedKey = resolveCalibrationMarketKey(marketKey, context);
  if (!resolvedKey) return null;
  return {
    market: resolvedKey,
    ...THRESHOLDS[resolvedKey],
  };
}

function clearCalibrationGateCache() {
  reportCache.clear();
}

function isMarketCalibrationEnabled(marketKey, context = {}) {
  const resolvedKey = resolveCalibrationMarketKey(marketKey, context);
  if (!resolvedKey) return true;

  const nowMs = Number.isFinite(context.nowMs) ? context.nowMs : Date.now();
  const cached = reportCache.get(resolvedKey);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.enabled;
  }

  try {
    const db = context.db || getDatabase();
    const row = db.prepare(`
      SELECT kill_switch_active
      FROM calibration_reports
      WHERE market = ?
      ORDER BY datetime(computed_at) DESC, id DESC
      LIMIT 1
    `).get(resolvedKey);

    const enabled = !row || Number(row.kill_switch_active || 0) === 0;
    reportCache.set(resolvedKey, {
      enabled,
      expiresAtMs: nowMs + CACHE_TTL_MS,
    });
    return enabled;
  } catch (_error) {
    return true;
  }
}

module.exports = {
  CACHE_TTL_MS,
  THRESHOLDS,
  clearCalibrationGateCache,
  getThresholdForMarket,
  isMarketCalibrationEnabled,
  resolveCalibrationMarketKey,
};
