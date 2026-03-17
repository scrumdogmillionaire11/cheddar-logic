'use strict';

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isFlagEnabled(flagName) {
  return isTruthy(process.env[flagName]);
}

function toTelemetryConfidence(confidence) {
  if (!Number.isFinite(confidence)) return null;
  if (confidence >= 0.75) return 'HIGH';
  if (confidence >= 0.6) return 'MEDIUM';
  return 'LOW';
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

function recordNhlProjectionTelemetry(recordProjectionEntry, card) {
  if (!isFlagEnabled('ENABLE_PROJECTION_PERF_LEDGER')) return;
  if (typeof recordProjectionEntry !== 'function') return;
  if (!card || !card.payloadData) return;

  const meta = card.payloadData.decision_basis_meta;
  if (!meta || meta.decision_basis !== 'PROJECTION_ONLY') return;

  const projection = Number.isFinite(card.payloadData?.decision?.projection)
    ? card.payloadData.decision.projection
    : Number.isFinite(card.payloadData?.decision?.model_projection)
      ? card.payloadData.decision.model_projection
      : null;

  if (!Number.isFinite(projection)) return;

  const selectionSide = String(card.payloadData?.play?.selection?.side || '').toUpperCase();
  const pickSide = selectionSide === 'UNDER' ? 'UNDER' : 'OVER';

  recordProjectionEntry({
    id: `proj-${card.id}`,
    cardId: card.id,
    gameId: card.gameId,
    sport: 'NHL',
    propType: card.payloadData?.play?.prop_type || 'shots_on_goal',
    playerName: card.payloadData?.play?.player_name || null,
    pickSide,
    projection,
    propLine: Number.isFinite(card.payloadData?.play?.selection?.line)
      ? card.payloadData.play.selection.line
      : null,
    confidence: toTelemetryConfidence(card.payloadData.confidence),
    volatilityBand: meta.volatility_band,
    decisionBasis: 'PROJECTION_ONLY',
  });
}

module.exports = {
  applyNhlDecisionBasisMeta,
  recordNhlProjectionTelemetry,
};
