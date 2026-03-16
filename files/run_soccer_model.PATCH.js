/**
 * run_soccer_model.PATCH.js
 *
 * Non-breaking patch for run_soccer_model.js
 *
 * What changes:
 *   Track 1 (odds-backed cards): attach decision_basis_meta when flag on
 *   Track 2 (projection-only):   attach decision_basis_meta, enforce
 *                                 execution_eligible: false
 *
 * What does NOT change:
 *   - Card types, cardType strings, cardTitle
 *   - payloadData.pass_reason, payloadData.projection_only
 *   - validateCardPayload, insertCardPayload calls
 *   - Any existing field in payloadData
 *   - Wire format for /api/games
 */

'use strict';

const { FLAGS } = require('./flags');
const {
  buildDecisionBasisMeta,
  MARKET_LINE_SOURCE,
} = require('./decision-basis.types');

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: build basis meta for a soccer card
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds decision_basis_meta for a soccer card.
 * Returns {} when flag is off (zero effect on existing behavior).
 *
 * @param {object} params
 * @param {'track1'|'track2'} params.track      - Which track produced this card
 * @param {string}  params.canonicalMarket       - Canonical market key
 * @param {object}  params.payloadData           - The card's payloadData (for edge_ev)
 * @returns {object} - { decision_basis_meta: {...} } or {}
 */
function buildSoccerBasisMeta({ track, canonicalMarket, payloadData }) {
  if (!FLAGS.ENABLE_DECISION_BASIS_TAGS) return {};

  const isOddsBacked = track === 'track1' &&
    (canonicalMarket === 'soccer_ml' ||
     canonicalMarket === 'soccer_game_total' ||
     canonicalMarket === 'soccer_double_chance');

  const edgePct = payloadData?.edge_ev != null
    ? Math.round(payloadData.edge_ev * 100 * 10) / 10
    : null;

  const meta = buildDecisionBasisMeta({
    usingRealLine: isOddsBacked,
    edgePct: isOddsBacked ? edgePct : null,
    marketLineSource: isOddsBacked
      ? MARKET_LINE_SOURCE.ODDS_API
      : MARKET_LINE_SOURCE.PROJECTION_FLOOR,
    marketOrPropType: canonicalMarket,
  });

  return { decision_basis_meta: meta };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXACT DIFF: Track 1 cards (buildSoccerOddsBackedCard)
//
// In buildSoccerOddsBackedCard(), the returned card object's payloadData
// needs the basis meta attached. Find the return statement and add:
//
// FIND:
//   return {
//     id: cardId,
//     gameId,
//     sport: 'SOCCER',
//     cardType: canonicalCardType,
//     ...
//     payloadData,
//     modelOutputIds: null,
//   };
//
// REPLACE WITH:
//   // Attach basis meta to payloadData (additive, flag-gated)
//   const basisMeta = buildSoccerBasisMeta({
//     track: 'track1',
//     canonicalMarket: canonicalCardType,
//     payloadData,
//   });
//   if (basisMeta.decision_basis_meta) {
//     payloadData.decision_basis_meta = basisMeta.decision_basis_meta;
//   }
//
//   return {
//     id: cardId,
//     gameId,
//     sport: 'SOCCER',
//     cardType: canonicalCardType,
//     ...
//     payloadData,
//     modelOutputIds: null,
//   };
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// EXACT DIFF: Track 2 projection-only cards (in runSoccerModel)
//
// Find the Track 2 card build block. The existing code already sets:
//   tier1Result.payloadData.projection_only = true;
//
// Add the basis meta right after that line:
//
// FIND:
//   // Mark as projection-only
//   tier1Result.payloadData.projection_only = true;
//
// REPLACE WITH:
//   // Mark as projection-only
//   tier1Result.payloadData.projection_only = true;
//   // Attach basis meta (additive, flag-gated)
//   const track2BasisMeta = buildSoccerBasisMeta({
//     track: 'track2',
//     canonicalMarket: market,
//     payloadData: tier1Result.payloadData,
//   });
//   if (track2BasisMeta.decision_basis_meta) {
//     tier1Result.payloadData.decision_basis_meta = track2BasisMeta.decision_basis_meta;
//   }
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT LINE to add at the top of run_soccer_model.js
// (add after the existing require statements):
//
//   const { buildSoccerBasisMeta } = require('./run_soccer_model.PATCH');
//   // or wherever you place this file in your project structure
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { buildSoccerBasisMeta };
