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

function resolveVolatilityBand(canonicalMarketKey) {
  if (canonicalMarketKey === 'player_shots' || canonicalMarketKey === 'team_totals') {
    return 'LOW';
  }
  if (canonicalMarketKey === 'to_score_or_assist') {
    return 'HIGH';
  }
  return 'MEDIUM';
}

function applySoccerDecisionBasisMeta(payloadData, options = {}) {
  if (!payloadData || typeof payloadData !== 'object') return null;
  if (!isFlagEnabled('ENABLE_DECISION_BASIS_TAGS')) return null;

  const isProjectionOnly = options.isProjectionOnly === true;
  const canonicalMarketKey =
    options.canonicalMarketKey || payloadData.canonical_market_key || 'soccer_ml';

  const decisionBasisMeta = {
    decision_basis: isProjectionOnly ? 'PROJECTION_ONLY' : 'ODDS_BACKED',
    edge_basis: isProjectionOnly
      ? null
      : Number.isFinite(options.edgeBasis)
        ? options.edgeBasis
        : Number.isFinite(payloadData.edge_ev)
          ? payloadData.edge_ev
          : null,
    market_line_source: isProjectionOnly
      ? options.marketLineSource || 'synthetic'
      : options.marketLineSource || 'odds_api',
    execution_eligible: !isProjectionOnly,
    volatility_band: resolveVolatilityBand(canonicalMarketKey),
  };

  payloadData.decision_basis_meta = decisionBasisMeta;
  return decisionBasisMeta;
}

function recordSoccerProjectionTelemetry(recordProjectionEntry, card, payloadData) {
  if (!isFlagEnabled('ENABLE_PROJECTION_PERF_LEDGER')) return;
  if (typeof recordProjectionEntry !== 'function') return;
  if (!card || !payloadData || payloadData.decision_basis_meta?.decision_basis !== 'PROJECTION_ONLY') {
    return;
  }

  const selectionSide = String(payloadData.selection?.side || '').toUpperCase();
  const pickSide = selectionSide === 'UNDER' ? 'UNDER' : 'OVER';

  const projection =
    Number.isFinite(payloadData?.projection?.win_prob_home)
      ? payloadData.projection.win_prob_home
      : Number.isFinite(payloadData?.decision?.projection)
        ? payloadData.decision.projection
        : Number.isFinite(payloadData?.decision?.model_projection)
          ? payloadData.decision.model_projection
          : null;

  if (!Number.isFinite(projection)) return;

  const propLine = Number.isFinite(payloadData.line)
    ? payloadData.line
    : Number.isFinite(payloadData?.decision?.market_line)
      ? payloadData.decision.market_line
      : null;

  recordProjectionEntry({
    id: `proj-${card.id}`,
    cardId: card.id,
    gameId: card.gameId,
    sport: 'SOCCER',
    propType: payloadData.canonical_market_key || card.cardType,
    playerName: payloadData.player_name || null,
    pickSide,
    projection,
    propLine,
    confidence: toTelemetryConfidence(payloadData.confidence),
    volatilityBand: payloadData.decision_basis_meta.volatility_band,
    decisionBasis: 'PROJECTION_ONLY',
  });
}

module.exports = {
  applySoccerDecisionBasisMeta,
  recordSoccerProjectionTelemetry,
};
