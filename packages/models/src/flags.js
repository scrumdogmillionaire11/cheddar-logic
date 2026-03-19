'use strict';

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const FLAGS = Object.freeze({
  ENABLE_DECISION_BASIS_TAGS: isTruthy(process.env.ENABLE_DECISION_BASIS_TAGS),
  ENABLE_MARKET_THRESHOLDS_V2: isTruthy(process.env.ENABLE_MARKET_THRESHOLDS_V2),
  ENABLE_PROJECTION_PERF_LEDGER: isTruthy(process.env.ENABLE_PROJECTION_PERF_LEDGER),
  ENABLE_CLV_LEDGER: isTruthy(process.env.ENABLE_CLV_LEDGER),
});

module.exports = {
  isTruthy,
  FLAGS,
};
