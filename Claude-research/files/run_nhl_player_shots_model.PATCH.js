/**
 * run_nhl_player_shots_model.PATCH.js
 *
 * Non-breaking patch for run_nhl_player_shots_model.js
 *
 * What changes:
 *   - payloadData.decision object gets 3 new optional fields:
 *       decision_basis, execution_eligible, volatility_band
 *   - These fields are only added when ENABLE_DECISION_BASIS_TAGS=true
 *   - All existing fields (tier, edge_pct, model_projection, etc.) unchanged
 *   - Card rendering, insertCardPayload, DB schema: no changes needed
 *
 * Apply: replace the decision block inside the full-game card payload
 * and the 1P card payload with the versions below.
 *
 * The helper buildNhlShotsBasisMeta() handles all the logic —
 * just call it and spread the result into the existing decision object.
 */

'use strict';

const { FLAGS } = require('./flags');
const {
  buildDecisionBasisMeta,
  MARKET_LINE_SOURCE,
  VOLATILITY_BAND,
} = require('./decision-basis.types');

/**
 * Build the additive decision_basis fields for an NHL shots card.
 *
 * @param {boolean} usingRealLine - true if prop line came from Odds API
 * @param {number}  mu            - model projection
 * @param {number}  marketLine    - the line used for edge calculation
 * @param {string}  propType      - 'shots_on_goal' or 'shots_on_goal_1p'
 * @returns {object} fields to spread into the existing decision object
 */
function buildNhlShotsBasisMeta(usingRealLine, mu, marketLine, propType) {
  if (!FLAGS.ENABLE_DECISION_BASIS_TAGS) return {};

  const edgePct = marketLine > 0
    ? Math.round(((mu - marketLine) / marketLine) * 100 * 10) / 10
    : null;

  const meta = buildDecisionBasisMeta({
    usingRealLine,
    edgePct,
    marketLineSource: usingRealLine
      ? MARKET_LINE_SOURCE.ODDS_API
      : MARKET_LINE_SOURCE.PROJECTION_FLOOR,
    marketOrPropType: propType || 'shots_on_goal',
  });

  return {
    decision_basis:    meta.decision_basis,
    execution_eligible: meta.execution_eligible,
    volatility_band:   meta.volatility_band,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXACT DIFF: Full-game card decision block
//
// FIND in run_nhl_player_shots_model.js (inside the full-game card payload):
//
//   decision: {
//     edge_pct:
//       Math.round(
//         ((mu - syntheticLine) / syntheticLine) * 100 * 10,
//       ) / 10,
//     model_projection: mu,
//     market_line: syntheticLine,
//     direction: fullGameEdge.direction,
//     confidence: confidence,
//     market_line_source: usingRealLine ? 'odds_api' : 'projection_floor',
//   },
//
// REPLACE WITH:
//
//   decision: {
//     edge_pct:
//       Math.round(
//         ((mu - syntheticLine) / syntheticLine) * 100 * 10,
//       ) / 10,
//     model_projection: mu,
//     market_line: syntheticLine,
//     direction: fullGameEdge.direction,
//     confidence: confidence,
//     market_line_source: usingRealLine ? 'odds_api' : 'projection_floor',
//     // Additive — present only when ENABLE_DECISION_BASIS_TAGS=true
//     ...buildNhlShotsBasisMeta(usingRealLine, mu, syntheticLine, 'shots_on_goal'),
//   },
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// EXACT DIFF: 1P card decision block
//
// FIND in run_nhl_player_shots_model.js (inside the 1P card payload):
//
//   decision: {
//     edge_pct:
//       Math.round(
//         ((mu1p - syntheticLine1p) / syntheticLine1p) * 100 * 10,
//       ) / 10,
//     model_projection: mu1p,
//     market_line: syntheticLine1p,
//     direction: firstPeriodEdge.direction,
//     confidence: confidence,
//     market_line_source: realPropLine1p ? 'odds_api' : 'projection_floor',
//   },
//
// REPLACE WITH:
//
//   decision: {
//     edge_pct:
//       Math.round(
//         ((mu1p - syntheticLine1p) / syntheticLine1p) * 100 * 10,
//       ) / 10,
//     model_projection: mu1p,
//     market_line: syntheticLine1p,
//     direction: firstPeriodEdge.direction,
//     confidence: confidence,
//     market_line_source: realPropLine1p ? 'odds_api' : 'projection_floor',
//     // Additive — present only when ENABLE_DECISION_BASIS_TAGS=true
//     ...buildNhlShotsBasisMeta(!!realPropLine1p, mu1p, syntheticLine1p, 'shots_on_goal_1p'),
//   },
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { buildNhlShotsBasisMeta };
