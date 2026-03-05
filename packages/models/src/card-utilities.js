/**
 * Shared Card Utilities (Consolidated)
 *
 * Originally extracted from:
 * - apps/worker/src/jobs/run_nba_model.js
 * - apps/worker/src/jobs/run_nhl_model.js
 * - apps/worker/src/jobs/run_ncaam_model.js
 *
 * Consolidated 2026-03-04 to eliminate duplication.
 * Functions are sport-agnostic; sport-specific logic
 * is parameterized via the sport argument.
 */

const { marginToWinProbability } = require('./card-model');
const edgeCalculator = require('./edge-calculator');

/**
 * Compute home team win probability from projected margin.
 *
 * Sport-specific sigma defaults:
 * - NBA: sigma=12 (standard deviation of spreads)
 * - NHL: sigma=12 (same as NBA)
 * - NCAAM: sigma=11 (college spreads have tighter variance)
 *
 * @param {number} projectedMargin - Home team projected margin
 * @param {string} sport - Sport code ('NBA', 'NHL', 'NCAAM')
 * @returns {number|null} Win probability (0-1 scale), null if invalid
 */
function computeWinProbHome(projectedMargin, sport) {
  if (!Number.isFinite(projectedMargin)) return null;

  const sigma = edgeCalculator.getSigmaDefaults(sport)?.margin ?? 11;
  const winProb = marginToWinProbability(projectedMargin, sigma);

  return Number.isFinite(winProb) ? Number(winProb.toFixed(4)) : null;
}

/**
 * Build driver summary object showing driver weight impact.
 *
 * Impact = (score - 0.5) * weight
 * - Positive: favors HOME
 * - Negative: favors AWAY
 *
 * @param {object} descriptor - Driver descriptor with driverKey, driverWeight, driverScore, driverStatus
 * @param {object} weightMap - Map of driverKey -> default weight
 * @returns {object} Driver summary with weights array and impact_note
 */
function buildDriverSummary(descriptor, weightMap) {
  const weight =
    descriptor.driverWeight ?? weightMap[descriptor.driverKey] ?? 1;
  const score = descriptor.driverScore ?? null;
  const impact =
    score !== null ? Number(((score - 0.5) * weight).toFixed(3)) : null;

  return {
    weights: [
      {
        driver: descriptor.driverKey,
        weight,
        score,
        impact,
        status: descriptor.driverStatus ?? null,
      },
    ],
    impact_note:
      'Impact = (score - 0.5) * weight. Positive favors HOME, negative favors AWAY.',
  };
}

module.exports = {
  computeWinProbHome,
  buildDriverSummary,
};
