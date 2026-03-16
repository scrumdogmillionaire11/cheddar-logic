/**
 * PATCH for decision-pipeline-v2.js
 *
 * What changes (all additive, all flag-gated):
 *
 * 1. getSupportThresholds() → extended with sport+market aware lookup
 *    when ENABLE_MARKET_THRESHOLDS_V2=true. Falls back to existing
 *    constants when flag off or sport/market not in map.
 *
 * 2. buildDecisionV2() → attaches decision_basis_meta to the returned
 *    object when ENABLE_DECISION_BASIS_TAGS=true.
 *
 * What does NOT change:
 * - PLAY_EDGE_MIN, LEAN_EDGE_MIN constants
 * - official_status, play_tier, edge_pct, sharp_price_status
 * - Any existing output field names
 * - WAVE1_SPORTS, WAVE1_MARKETS sets
 * - All existing exports
 *
 * Apply this as a diff to your existing decision-pipeline-v2.js.
 * Search for each REPLACE block and substitute.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// REPLACE: getSupportThresholds() function
// Find the existing getSupportThresholds function and replace its body with this.
// ─────────────────────────────────────────────────────────────────────────────

const { FLAGS } = require('./flags');
const {
  buildDecisionBasisMeta,
  MARKET_LINE_SOURCE,
} = require('./decision-basis.types');

/**
 * Sport + market aware support thresholds.
 * Only active when ENABLE_MARKET_THRESHOLDS_V2=true.
 * Key format: `${SPORT}:${MARKET_TYPE}` — all uppercase.
 *
 * Research basis:
 *   - NHL/Soccer totals: lower sigma → lower support threshold needed
 *   - NCAAM mid-major: market inefficiency → lower threshold
 *   - NBA standard_spread: most efficient market → higher threshold required
 */
const SPORT_MARKET_THRESHOLDS = {
  // NHL — low-sigma markets
  'NHL:TOTAL':         { play: 0.50, lean: 0.42 },
  'NHL:FIRST_PERIOD':  { play: 0.50, lean: 0.42 },
  'NHL:MONEYLINE':     { play: 0.55, lean: 0.44 },
  'NHL:PUCKLINE':      { play: 0.62, lean: 0.50 },

  // EPL/MLS/Soccer — xG-backed, tight variance
  'SOCCER:MONEYLINE':  { play: 0.52, lean: 0.43 },
  'SOCCER:TOTAL':      { play: 0.52, lean: 0.43 },

  // NBA — most efficient market, higher bar
  'NBA:SPREAD':        { play: 0.70, lean: 0.58 },
  'NBA:MONEYLINE':     { play: 0.65, lean: 0.52 },
  'NBA:TOTAL':         { play: 0.58, lean: 0.47 },

  // NFL — situational, moderate bar
  'NFL:TOTAL':         { play: 0.58, lean: 0.46 },
  'NFL:SPREAD':        { play: 0.63, lean: 0.50 },
  'NFL:MONEYLINE':     { play: 0.60, lean: 0.48 },

  // MLB — F5/moneyline low variance
  'MLB:MONEYLINE':     { play: 0.55, lean: 0.44 },
  'MLB:TOTAL':         { play: 0.56, lean: 0.45 },

  // NCAAM — softest lines
  'NCAAM:SPREAD':      { play: 0.56, lean: 0.44 },
  'NCAAM:TOTAL':       { play: 0.54, lean: 0.43 },
  'NCAAM:MONEYLINE':   { play: 0.55, lean: 0.44 },
};

/**
 * Get support thresholds for a market, optionally sport-aware.
 * Drop-in replacement for the existing getSupportThresholds().
 *
 * @param {string} marketType - Canonical market type (SPREAD, TOTAL, MONEYLINE, etc.)
 * @param {string} [sport]    - Optional sport code for V2 lookup
 * @returns {{ play: number, lean: number }}
 */
function getSupportThresholdsV2(marketType, sport) {
  // V2 sport+market lookup — only when flag is on AND sport provided
  if (FLAGS.ENABLE_MARKET_THRESHOLDS_V2 && sport) {
    const key = `${String(sport).toUpperCase()}:${String(marketType).toUpperCase()}`;
    if (SPORT_MARKET_THRESHOLDS[key]) {
      return SPORT_MARKET_THRESHOLDS[key];
    }
  }

  // Fallback: existing behavior (unchanged constants)
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    return { play: 0.65, lean: 0.5 };
  }
  if (
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
  ) {
    return { play: 0.55, lean: 0.45 };
  }
  return { play: 0.6, lean: 0.45 };
}

// ─────────────────────────────────────────────────────────────────────────────
// PATCH INSTRUCTIONS for buildDecisionV2():
//
// 1. At the top of buildDecisionV2(), add sport extraction:
//      const sport = normalizeSport(payload?.sport);
//    (sport is already computed locally in the existing function — just ensure
//     it's in scope before the getSupportThresholds calls)
//
// 2. Replace all calls to getSupportThresholds(market_type) with:
//      getSupportThresholdsV2(market_type, sport)
//    There are 3 occurrences:
//      - in computeOfficialStatus()
//      - in resolvePrimaryReason()
//      - in computeWatchdog() (via getSupportThresholds used in getDirection checks)
//    Only the direct calls in buildDecisionV2 need updating; helper functions
//    that take marketType can receive sport as a second arg if needed.
//
// 3. At the END of the try block in buildDecisionV2(), before the return statement,
//    add the decision_basis_meta attachment:
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the decision_basis_meta block to attach to buildDecisionV2 output.
 * Call this inside buildDecisionV2's try block, just before the final return.
 *
 * @param {object} payload     - The raw payload passed to buildDecisionV2
 * @param {string} market_type - Normalized market type
 * @param {number|null} edge_pct - Computed edge pct
 * @returns {object|null}      - decision_basis_meta or null if flag off
 */
function buildDecisionBasisBlock(payload, market_type, edge_pct) {
  if (!FLAGS.ENABLE_DECISION_BASIS_TAGS) return null;

  // Determine if a real market line exists
  const rawLineSource =
    payload?.pricing_trace?.line_source ||
    payload?.line_source ||
    payload?.decision?.market_line_source ||
    null;

  const usingRealLine =
    rawLineSource === 'odds_api' ||
    rawLineSource === MARKET_LINE_SOURCE.ODDS_API ||
    (
      // Fallback: infer from proxy_used — if proxy is NOT used and we have
      // a real price, it came from a real market line
      !payload?.proxy_used &&
      payload?.price != null &&
      rawLineSource !== 'projection_floor' &&
      rawLineSource !== 'synthetic'
    );

  const marketLineSource = rawLineSource ||
    (usingRealLine ? MARKET_LINE_SOURCE.ODDS_API : MARKET_LINE_SOURCE.PROJECTION_FLOOR);

  return buildDecisionBasisMeta({
    usingRealLine,
    edgePct: edge_pct,
    marketLineSource,
    marketOrPropType: market_type,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXACT DIFF to apply in buildDecisionV2's return statement:
//
// BEFORE (existing return in the try block):
//   return {
//     direction,
//     support_score,
//     ...
//     pipeline_version: PIPELINE_VERSION,
//     decided_at: new Date().toISOString(),
//   };
//
// AFTER:
//   const decision_basis_meta = buildDecisionBasisBlock(payload, market_type, edge_pct);
//   return {
//     direction,
//     support_score,
//     ...
//     pipeline_version: PIPELINE_VERSION,
//     decided_at: new Date().toISOString(),
//     // Additive — undefined when flag off, safely ignored by all consumers
//     ...(decision_basis_meta ? { decision_basis_meta } : {}),
//   };
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getSupportThresholdsV2,
  SPORT_MARKET_THRESHOLDS,
  buildDecisionBasisBlock,
};
