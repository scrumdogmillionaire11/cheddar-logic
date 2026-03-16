/**
 * decision-basis.types.js
 *
 * Additive type contract for the decision_basis metadata fields.
 * These fields are OPTIONAL additions to existing play/decision payloads.
 *
 * Rollout: gated behind ENABLE_DECISION_BASIS_TAGS flag.
 * When flag is off → fields are simply absent, all existing consumers unaffected.
 *
 * Do NOT add required fields. Do NOT change existing field names.
 */

'use strict';

/**
 * @typedef {'ODDS_BACKED' | 'PROJECTION_ONLY'} DecisionBasis
 *
 * ODDS_BACKED    — A real market line from The Odds API exists.
 *                  Edge calculation is meaningful. Execution eligible.
 * PROJECTION_ONLY — No real market line, or line is synthetic/floor-derived.
 *                   Card is informational. NOT execution eligible.
 *                   Excluded from CLV and profitability rollups.
 */

/**
 * @typedef {'odds_api' | 'projection_floor' | 'synthetic'} MarketLineSource
 *
 * odds_api        — Line came from The Odds API (real market)
 * projection_floor — Line is a synthetic floor (e.g. NHL_SOG_PROJECTION_LINE env var)
 * synthetic        — Line derived from model projection, no market reference
 */

/**
 * @typedef {'LOW' | 'MEDIUM' | 'HIGH'} VolatilityBand
 *
 * Per-market volatility classification based on research.
 * LOW:    SOG, F5 ML, pitcher K, pace totals, xG-backed home win
 * MEDIUM: receiving yards, game totals, BTTS, AH
 * HIGH:   TDs, home runs, first scorers, raw goals/assists
 */

/**
 * The full optional decision_basis contract.
 * Attach to payloadData.decision_basis_meta when flag is on.
 *
 * @typedef {object} DecisionBasisMeta
 * @property {DecisionBasis}      decision_basis       - ODDS_BACKED | PROJECTION_ONLY
 * @property {number | null}      edge_basis           - Edge pct when ODDS_BACKED; null when PROJECTION_ONLY
 * @property {MarketLineSource}   market_line_source   - Where the line came from
 * @property {boolean}            execution_eligible   - false when PROJECTION_ONLY
 * @property {VolatilityBand}     volatility_band      - LOW | MEDIUM | HIGH
 */

// ── Constants ──────────────────────────────────────────────────────────────

const DECISION_BASIS = Object.freeze({
  ODDS_BACKED:      'ODDS_BACKED',
  PROJECTION_ONLY:  'PROJECTION_ONLY',
});

const MARKET_LINE_SOURCE = Object.freeze({
  ODDS_API:          'odds_api',
  PROJECTION_FLOOR:  'projection_floor',
  SYNTHETIC:         'synthetic',
});

const VOLATILITY_BAND = Object.freeze({
  LOW:    'LOW',
  MEDIUM: 'MEDIUM',
  HIGH:   'HIGH',
});

// ── Per-sport/market volatility lookup ────────────────────────────────────
// Based on research: lower sigma = more predictable = lower volatility band.

const MARKET_VOLATILITY_MAP = {
  // NHL
  shots_on_goal:        VOLATILITY_BAND.LOW,
  goalie_saves:         VOLATILITY_BAND.LOW,
  total_over_bias:      VOLATILITY_BAND.LOW,
  moneyline_incl_ot:    VOLATILITY_BAND.LOW,
  first_period_total:   VOLATILITY_BAND.MEDIUM,
  puck_line:            VOLATILITY_BAND.HIGH,

  // Soccer
  home_win_xg:          VOLATILITY_BAND.LOW,
  goalkeeper_saves:     VOLATILITY_BAND.LOW,
  shots_on_target:      VOLATILITY_BAND.LOW,
  asian_handicap:       VOLATILITY_BAND.MEDIUM,
  btts:                 VOLATILITY_BAND.MEDIUM,
  soccer_ml:            VOLATILITY_BAND.MEDIUM,
  soccer_game_total:    VOLATILITY_BAND.MEDIUM,
  anytime_goalscorer:   VOLATILITY_BAND.HIGH,
  to_score_or_assist:   VOLATILITY_BAND.HIGH,

  // NFL
  situational_total:    VOLATILITY_BAND.LOW,
  divisional_dog_spread:VOLATILITY_BAND.LOW,
  rlm_spread:           VOLATILITY_BAND.MEDIUM,
  rushing_yards:        VOLATILITY_BAND.LOW,
  receiving_yards:      VOLATILITY_BAND.MEDIUM,
  passing_yards:        VOLATILITY_BAND.MEDIUM,
  anytime_td:           VOLATILITY_BAND.HIGH,
  first_td:             VOLATILITY_BAND.HIGH,

  // MLB
  f5_moneyline:         VOLATILITY_BAND.LOW,
  pitcher_strikeouts:   VOLATILITY_BAND.LOW,
  pitcher_outs:         VOLATILITY_BAND.LOW,
  underdog_moneyline:   VOLATILITY_BAND.MEDIUM,
  full_game_total:      VOLATILITY_BAND.MEDIUM,
  runline_dog:          VOLATILITY_BAND.MEDIUM,
  home_run:             VOLATILITY_BAND.HIGH,
  rbi:                  VOLATILITY_BAND.HIGH,

  // NBA
  total_pace:           VOLATILITY_BAND.MEDIUM,
  pra:                  VOLATILITY_BAND.LOW,
  rebounds:             VOLATILITY_BAND.LOW,
  assists:              VOLATILITY_BAND.MEDIUM,
  points:               VOLATILITY_BAND.MEDIUM,
  three_pm:             VOLATILITY_BAND.HIGH,

  // NCAAM
  mid_major_spread:     VOLATILITY_BAND.LOW,
  slight_dog_ml:        VOLATILITY_BAND.MEDIUM,
};

/**
 * Resolve volatility band for a market/prop type.
 * Falls back to MEDIUM if not mapped.
 * @param {string} marketOrPropType
 * @returns {VolatilityBand}
 */
function resolveVolatilityBand(marketOrPropType) {
  if (!marketOrPropType) return VOLATILITY_BAND.MEDIUM;
  const key = String(marketOrPropType).toLowerCase().replace(/[\s-]+/g, '_');
  return MARKET_VOLATILITY_MAP[key] ?? VOLATILITY_BAND.MEDIUM;
}

/**
 * Build the decision_basis_meta block to attach to a payload.
 *
 * @param {object} params
 * @param {boolean}           params.usingRealLine      - true if Odds API line exists
 * @param {number | null}     params.edgePct            - computed edge pct (null if projection-only)
 * @param {string}            params.marketLineSource   - 'odds_api' | 'projection_floor' | 'synthetic'
 * @param {string}            params.marketOrPropType   - market/prop type string for volatility lookup
 * @returns {DecisionBasisMeta}
 */
function buildDecisionBasisMeta({
  usingRealLine,
  edgePct = null,
  marketLineSource,
  marketOrPropType,
}) {
  const basis = usingRealLine
    ? DECISION_BASIS.ODDS_BACKED
    : DECISION_BASIS.PROJECTION_ONLY;

  return {
    decision_basis:      basis,
    edge_basis:          basis === DECISION_BASIS.ODDS_BACKED ? (edgePct ?? null) : null,
    market_line_source:  marketLineSource || (usingRealLine ? MARKET_LINE_SOURCE.ODDS_API : MARKET_LINE_SOURCE.PROJECTION_FLOOR),
    execution_eligible:  basis === DECISION_BASIS.ODDS_BACKED,
    volatility_band:     resolveVolatilityBand(marketOrPropType),
  };
}

/**
 * Returns true if a payload is execution-eligible.
 * Safe to call on any payload — returns false if field absent (flag was off).
 * @param {object} payloadData
 * @returns {boolean}
 */
function isExecutionEligible(payloadData) {
  const meta = payloadData?.decision_basis_meta;
  if (!meta) return true; // flag was off — don't block existing plays
  return meta.execution_eligible === true;
}

/**
 * Returns true if a payload should be excluded from profitability rollups.
 * Projection-only plays are informational only.
 * @param {object} payloadData
 * @returns {boolean}
 */
function isExcludedFromProfitabilityRollup(payloadData) {
  const meta = payloadData?.decision_basis_meta;
  if (!meta) return false; // flag was off — include in existing rollups
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
