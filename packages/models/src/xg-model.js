'use strict';

/**
 * xG (Expected Goals) Poisson Model — Phase 1 Foundation
 *
 * Pure functions only. No I/O, no state mutations, no file reads.
 * All functions are fully testable in isolation.
 *
 * Spec: docs/SOCCER_MODEL_SPECIFICATION.md §2.2–2.3
 *
 * League keys used throughout:
 *   'EPL' | 'MLS' | 'UCL'
 */

// Home advantage adjustments (additive xG per game, per spec §2.2.3)
const HOME_ADJ = {
  EPL: 0.12,
  MLS: 0.09,
  UCL: 0.10,
};

// League sigma values (goals std dev, per spec §2.3)
const LEAGUE_SIGMA = {
  EPL: 1.18,
  MLS: 1.24,
  UCL: 1.15,
};

// Poisson summation upper bound (goals per team)
const GOALS_MAX = 7;

// Safe fallbacks for unknown leagues
const DEFAULT_HOME_ADJ = 0.10;
const DEFAULT_SIGMA = 1.20;

/**
 * Poisson probability mass function.
 * P(X = k) = (e^-λ × λ^k) / k!
 *
 * @param {number} k - Number of goals (non-negative integer)
 * @param {number} lambda - Expected goals (λ > 0)
 * @returns {number} Probability, accurate to 4 decimal places
 */
function poissonPmf(k, lambda) {
  if (!Number.isFinite(lambda) || lambda <= 0) return 0;
  if (!Number.isFinite(k) || k < 0 || !Number.isInteger(k)) return 0;

  // Use log-space computation to avoid overflow/underflow for large k or λ
  let logFactorial = 0;
  for (let i = 2; i <= k; i++) {
    logFactorial += Math.log(i);
  }
  const logPmf = -lambda + k * Math.log(lambda) - logFactorial;
  return Math.exp(logPmf);
}

/**
 * Apply league-specific home advantage adjustment to xG.
 * Adjustment is additive (not multiplicative), per spec §2.2.3.
 *
 * @param {number} xg - Base xG value
 * @param {string} league - 'EPL' | 'MLS' | 'UCL'
 * @returns {number} Adjusted xG
 */
function applyLeagueHomeAdj(xg, league) {
  if (!Number.isFinite(xg)) return xg;
  const adj = HOME_ADJ[String(league || '').toUpperCase()] ?? DEFAULT_HOME_ADJ;
  return xg + adj;
}

/**
 * Get league-specific sigma (goals standard deviation) for edge normalization.
 *
 * @param {string} league - 'EPL' | 'MLS' | 'UCL'
 * @returns {number} Sigma value
 */
function getLeagueSigma(league) {
  return LEAGUE_SIGMA[String(league || '').toUpperCase()] ?? DEFAULT_SIGMA;
}

/**
 * Compute xG-based win probabilities using the Poisson model.
 *
 * homeXg and awayXg are the rolling average expected goals (pre-adjustment).
 * Home advantage is applied inside this function.
 *
 * Formula (spec §2.2.2):
 *   λ_home = homeXg + HOME_ADJ[league]
 *   λ_away = awayXg
 *   P(home_win) = Σ P(home=i) × P(away=j) for all i > j
 *   P(draw)     = Σ P(home=i) × P(away=i)
 *   P(away_win) = Σ P(home=i) × P(away=j) for all j > i
 *
 * @param {object} params
 * @param {number} params.homeXg - Home team rolling xG (pre-adj)
 * @param {number} params.awayXg - Away team rolling xG
 * @param {string} params.league - 'EPL' | 'MLS' | 'UCL'
 * @returns {{ homeWin: number, draw: number, awayWin: number }}
 *          Three probabilities summing to 1.0 (within 0.001 tolerance)
 */
function computeXgWinProbs({ homeXg, awayXg, league }) {
  if (!Number.isFinite(homeXg) || !Number.isFinite(awayXg)) {
    return { homeWin: null, draw: null, awayWin: null };
  }

  const lambdaHome = applyLeagueHomeAdj(Math.max(0.1, homeXg), league);
  const lambdaAway = Math.max(0.1, awayXg);

  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let i = 0; i <= GOALS_MAX; i++) {
    const pHome = poissonPmf(i, lambdaHome);
    for (let j = 0; j <= GOALS_MAX; j++) {
      const pAway = poissonPmf(j, lambdaAway);
      const joint = pHome * pAway;
      if (i > j) homeWin += joint;
      else if (i === j) draw += joint;
      else awayWin += joint;
    }
  }

  // Normalize to ensure sum = 1.0 exactly (handles floating-point truncation
  // from GOALS_MAX cutoff)
  const total = homeWin + draw + awayWin;
  if (total <= 0) return { homeWin: null, draw: null, awayWin: null };

  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
  };
}

/**
 * Compute xG-based over/under total probability.
 *
 * @param {object} params
 * @param {number} params.homeXg - Home team rolling xG (pre-adj)
 * @param {number} params.awayXg - Away team rolling xG
 * @param {number} params.totalLine - The over/under line (e.g., 2.5)
 * @param {string} params.direction - 'over' | 'under'
 * @param {string} [params.league] - Used to apply home adjustment
 * @returns {number|null} Probability for the specified direction
 */
function computeXgTotalProb({ homeXg, awayXg, totalLine, direction, league }) {
  if (
    !Number.isFinite(homeXg) ||
    !Number.isFinite(awayXg) ||
    !Number.isFinite(totalLine)
  ) {
    return null;
  }

  const lambdaHome = applyLeagueHomeAdj(Math.max(0.1, homeXg), league);
  const lambdaAway = Math.max(0.1, awayXg);

  let pOver = 0;
  let pUnder = 0;

  for (let i = 0; i <= GOALS_MAX; i++) {
    const pHome = poissonPmf(i, lambdaHome);
    for (let j = 0; j <= GOALS_MAX; j++) {
      const pAway = poissonPmf(j, lambdaAway);
      const joint = pHome * pAway;
      const totalGoals = i + j;
      if (totalGoals > totalLine) pOver += joint;
      else pUnder += joint;
    }
  }

  const total = pOver + pUnder;
  if (total <= 0) return null;

  const dir = String(direction || '').toLowerCase();
  if (dir === 'over') return pOver / total;
  if (dir === 'under') return pUnder / total;
  return null;
}

module.exports = {
  poissonPmf,
  applyLeagueHomeAdj,
  getLeagueSigma,
  computeXgWinProbs,
  computeXgTotalProb,
};
