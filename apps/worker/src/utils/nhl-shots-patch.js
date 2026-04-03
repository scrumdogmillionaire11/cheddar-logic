'use strict';

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isFlagEnabled(flagName) {
  return isTruthy(process.env[flagName]);
}

function applyNhlDecisionBasisMeta(payloadData, { usingRealLine, edgePct }) {
  if (!payloadData || typeof payloadData !== 'object') return null;
  if (!isFlagEnabled('ENABLE_DECISION_BASIS_TAGS')) return null;

  const isProjectionOnly = !usingRealLine;
  const decisionBasisMeta = {
    decision_basis: isProjectionOnly ? 'PROJECTION_ONLY' : 'ODDS_BACKED',
    edge_basis: isProjectionOnly ? null : Number.isFinite(edgePct) ? edgePct : null,
    market_line_source: usingRealLine ? 'odds_api' : 'projection_floor',
    execution_eligible: usingRealLine === true,
    volatility_band: 'LOW',
  };
  payloadData.decision_basis_meta = decisionBasisMeta;
  return decisionBasisMeta;
}

module.exports = {
  applyNhlDecisionBasisMeta,
};
