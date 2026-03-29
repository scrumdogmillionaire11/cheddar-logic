'use strict';

const DECISION_BASIS = Object.freeze({
  ODDS_BACKED: 'ODDS_BACKED',
  PROJECTION_ONLY: 'PROJECTION_ONLY',
});

const MARKET_LINE_SOURCE = Object.freeze({
  ODDS_API: 'odds_api',
  PROJECTION_FLOOR: 'projection_floor',
  SYNTHETIC: 'synthetic',
});

const VOLATILITY_BAND = Object.freeze({
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
});

const MARKET_VOLATILITY_MAP = Object.freeze({
  shots_on_goal: VOLATILITY_BAND.LOW,
  goalie_saves: VOLATILITY_BAND.LOW,
  home_win_xg: VOLATILITY_BAND.LOW,
  f5_moneyline: VOLATILITY_BAND.LOW,
  pitcher_strikeouts: VOLATILITY_BAND.LOW,
  rushing_yards: VOLATILITY_BAND.LOW,
  total_pace: VOLATILITY_BAND.MEDIUM,
  passing_yards: VOLATILITY_BAND.MEDIUM,
  receiving_yards: VOLATILITY_BAND.MEDIUM,
  asian_handicap: VOLATILITY_BAND.MEDIUM,
  btts: VOLATILITY_BAND.MEDIUM,
  home_run: VOLATILITY_BAND.HIGH,
  anytime_td: VOLATILITY_BAND.HIGH,
  anytime_goalscorer: VOLATILITY_BAND.HIGH,
});

function resolveVolatilityBand(marketOrPropType) {
  if (!marketOrPropType) return VOLATILITY_BAND.MEDIUM;
  const normalized = String(marketOrPropType)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return MARKET_VOLATILITY_MAP[normalized] || VOLATILITY_BAND.MEDIUM;
}

function buildDecisionBasisMeta({
  usingRealLine,
  edgePct = null,
  marketLineSource,
  marketOrPropType,
} = {}) {
  const decisionBasis = usingRealLine
    ? DECISION_BASIS.ODDS_BACKED
    : DECISION_BASIS.PROJECTION_ONLY;

  return {
    decision_basis: decisionBasis,
    edge_basis:
      decisionBasis === DECISION_BASIS.ODDS_BACKED && Number.isFinite(edgePct)
        ? edgePct
        : null,
    market_line_source:
      marketLineSource ||
      (usingRealLine
        ? MARKET_LINE_SOURCE.ODDS_API
        : MARKET_LINE_SOURCE.PROJECTION_FLOOR),
    execution_eligible: decisionBasis === DECISION_BASIS.ODDS_BACKED,
    volatility_band: resolveVolatilityBand(marketOrPropType),
  };
}

function isExecutionEligible(payloadData) {
  const meta = payloadData && payloadData.decision_basis_meta;
  if (!meta) return true;
  return meta.execution_eligible === true;
}

function isExcludedFromProfitabilityRollup(payloadData) {
  const meta = payloadData && payloadData.decision_basis_meta;
  if (!meta) return false;
  return meta.decision_basis === DECISION_BASIS.PROJECTION_ONLY;
}

module.exports = {
  DECISION_BASIS,
  MARKET_LINE_SOURCE,
  VOLATILITY_BAND,
  MARKET_VOLATILITY_MAP,
  resolveVolatilityBand,
  buildDecisionBasisMeta,
  isExecutionEligible,
  isExcludedFromProfitabilityRollup,
};
