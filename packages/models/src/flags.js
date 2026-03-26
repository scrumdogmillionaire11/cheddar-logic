'use strict';

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const FLAGS = Object.freeze({
  ENABLE_DECISION_BASIS_TAGS: isTruthy(process.env.ENABLE_DECISION_BASIS_TAGS),
  ENABLE_MARKET_THRESHOLDS_V2: process.env.ENABLE_MARKET_THRESHOLDS_V2 !== undefined
    ? isTruthy(process.env.ENABLE_MARKET_THRESHOLDS_V2)
    : true,
  ENABLE_PROJECTION_PERF_LEDGER: isTruthy(process.env.ENABLE_PROJECTION_PERF_LEDGER),
  ENABLE_CLV_LEDGER: isTruthy(process.env.ENABLE_CLV_LEDGER),
  QUARANTINE_NBA_TOTAL: process.env.QUARANTINE_NBA_TOTAL !== undefined
    ? isTruthy(process.env.QUARANTINE_NBA_TOTAL)
    : true,
  // Without Odds Mode: run projections from ESPN-direct ingestion; skip market pricing and settlement.
  // Set ENABLE_WITHOUT_ODDS_MODE=true to activate. All cards in this mode are PROJECTION_ONLY.
  ENABLE_WITHOUT_ODDS_MODE: isTruthy(process.env.ENABLE_WITHOUT_ODDS_MODE),
});

module.exports = {
  isTruthy,
  FLAGS,
};
