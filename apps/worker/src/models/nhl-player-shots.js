'use strict';

/**
 * NHL Player Shots (SOG) Model
 *
 * JS port of:
 *   cheddar-nhl/src/nhl_sog/engine/mu.py  (calc_mu, calc_mu_1p)
 *   cheddar-nhl/src/nhl_sog/engine/edge.py (edge classification — simplified)
 *   cheddar-nhl/src/nhl_sog/config.py      (ModelConfig constants)
 *
 * Computes per-player SOG projections (μ) from recency-weighted L5 data
 * with opponent factor, pace factor, home boost, and high-volume regression.
 *
 * Edge classification is a simplified port of edge.py using the backtest-
 * calibrated HOT/WATCH thresholds for the cheddar-logic context (no Poisson
 * distribution required — threshold is raw SOG delta from market line).
 */

// ============================================================================
// Constants (from cheddar-nhl ModelConfig — backtest-calibrated Feb 2026)
// ============================================================================
const RECENCY_DECAY_ALPHA = 0.65;  // Exponential decay for L5 weights (alpha^i, i=0..4)
const L5_WEIGHT = 0.65;            // L5 vs prior blend weight
const PRIOR_WEIGHT = 0.35;         // Prior (season stats) weight
const HOME_ICE_SOG_BOOST = 1.05;   // Home teams shoot ~5% more
const HIGH_VOLUME_THRESHOLD = 4.5; // SOG/game above which regression applies
const HIGH_VOLUME_REGRESSION = 0.90; // Reduce μ by 10% for high-volume projections
const FIRST_PERIOD_SOG_SHARE = 0.32; // ~32% of game shots in 1P
const FIRST_PERIOD_PACE_FACTOR = 1.00; // calibrated to 1.00 to avoid 1P RMSE spike
const FIRST_PERIOD_HOME_ICE_BOOST = 1.03; // 1P home boost (config.first_period_home_ice_boost)

// ============================================================================
// Helpers
// ============================================================================

/**
 * Calculate exponentially decayed L5 weights.
 * Most recent game = index 0 = highest weight (alpha^0 = 1.0).
 * Weights are normalized to sum to 1.0.
 *
 * @returns {number[]} Array of 5 normalized weights
 */
function getL5Weights() {
  const raw = [];
  for (let i = 0; i < 5; i++) {
    raw.push(Math.pow(RECENCY_DECAY_ALPHA, i));
  }
  const total = raw.reduce((s, w) => s + w, 0);
  return raw.map(w => w / total);
}

// ============================================================================
// Main exports
// ============================================================================

/**
 * Calculate expected SOG (μ) for a player.
 *
 * Direct port of calc_mu() from cheddar-nhl/src/nhl_sog/engine/mu.py.
 *
 * @param {object} inputs
 * @param {number[]} inputs.l5Sog         - Array of exactly 5 SOG values, most recent first
 * @param {number|null} inputs.shotsPer60  - Season shots per 60 min (for prior blend)
 * @param {number|null} inputs.projToi     - Projected TOI in minutes (for prior blend)
 * @param {number} inputs.opponentFactor   - Opponent defensive factor (default 1.0)
 * @param {number} inputs.paceFactor       - Game pace factor (default 1.0)
 * @param {boolean|null} inputs.isHome     - Whether player is on home team
 * @returns {number} Expected SOG (μ), minimum 0.0
 */
function calcMu(inputs) {
  const {
    l5Sog,
    shotsPer60 = null,
    projToi = null,
    opponentFactor = 1.0,
    paceFactor = 1.0,
    isHome = null
  } = inputs || {};

  if (!Array.isArray(l5Sog) || l5Sog.length !== 5) {
    throw new Error('calcMu: l5Sog must be an array of exactly 5 values');
  }

  // Recency-weighted L5 mean (most recent = index 0 = highest weight)
  const weights = getL5Weights();
  const muL5 = l5Sog.reduce((sum, sog, i) => sum + sog * weights[i], 0);

  // Prior blend (if both shots_per_60 and proj_toi available)
  let muBase;
  if (shotsPer60 !== null && projToi !== null) {
    const muPrior = (shotsPer60 * projToi) / 60.0;
    muBase = L5_WEIGHT * muL5 + PRIOR_WEIGHT * muPrior;
  } else {
    muBase = muL5;
  }

  // Apply opponent and pace factors
  let muAdj = muBase * opponentFactor * paceFactor;

  // Home ice SOG boost
  if (isHome === true) {
    muAdj *= HOME_ICE_SOG_BOOST;
  }

  // High-volume regression (elite shooters over-project empirically)
  if (muAdj > HIGH_VOLUME_THRESHOLD) {
    muAdj *= HIGH_VOLUME_REGRESSION;
  }

  return Math.max(0.0, muAdj);
}

/**
 * Calculate expected SOG for first period only.
 *
 * Port of calc_mu_1p() from cheddar-nhl/src/nhl_sog/engine/mu.py.
 *
 * @param {object} inputs - Same shape as calcMu inputs
 * @returns {number} Expected 1P SOG (μ), minimum 0.0
 */
function calcMu1p(inputs) {
  const { isHome = null } = inputs || {};

  const muFull = calcMu(inputs);

  // Apply first-period share (~32% of game)
  let mu1p = muFull * FIRST_PERIOD_SOG_SHARE;

  // Apply first-period pace factor (calibrated to 1.00)
  mu1p *= FIRST_PERIOD_PACE_FACTOR;

  // Adjust home ice advantage: remove full-game boost, apply 1P boost
  if (isHome === true) {
    mu1p /= HOME_ICE_SOG_BOOST;            // Remove full-game home boost
    mu1p *= FIRST_PERIOD_HOME_ICE_BOOST;   // Apply 1P home boost (1.03)
  }

  return Math.max(0.0, mu1p);
}

/**
 * Classify edge between model projection and market line.
 *
 * Simplified port of classify_opportunity() from edge.py using backtest-
 * calibrated Feb 2026 HOT/WATCH thresholds. Returns tier and OVER/UNDER
 * direction based on raw SOG delta vs market line (no Poisson required).
 *
 * HOT:  |edge| >= 0.8, confidence >= 0.50
 * WATCH: |edge| >= 0.5, confidence >= 0.50
 * COLD: everything else
 *
 * @param {number} mu          - Expected SOG from calcMu()
 * @param {number} marketLine  - Market O/U line (e.g., 2.5)
 * @param {number} confidence  - Data quality confidence (0-1)
 * @returns {object} { tier, direction, edge, mu }
 */
function classifyEdge(mu, marketLine, confidence) {
  // Degenerate: no projection or no market line
  if (!mu || !marketLine) {
    return { tier: 'COLD', direction: 'NEUTRAL', edge: 0, mu };
  }

  const edge = Math.round((mu - marketLine) * 100) / 100;
  const absEdge = Math.abs(edge);
  const direction = edge >= 0 ? 'OVER' : 'UNDER';

  let tier;
  if (absEdge >= 0.8 && confidence >= 0.50) {
    tier = 'HOT';
  } else if (absEdge >= 0.5 && confidence >= 0.50) {
    tier = 'WATCH';
  } else {
    tier = 'COLD';
  }

  return { tier, direction, edge, mu };
}

module.exports = { calcMu, calcMu1p, classifyEdge };
