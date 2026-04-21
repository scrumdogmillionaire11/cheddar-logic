'use strict';

/**
 * WI-1025: NBA Phase 3B — Objective regime detection with measurable triggers.
 *
 * Tags each NBA game with a single dominant regime label plus supporting tags
 * using only objective, testable triggers from existing data. All trigger paths
 * are explicit boolean tests. Missing data fails open (skip, no throw).
 *
 * Priority (highest → lowest):
 *   INJURY_ROTATION > PLAYOFF_PUSH > TANK_MODE > REST_HEAVY > STANDARD
 */

const REGIME_MODIFIERS = {
  PLAYOFF_PUSH: { paceMultiplier: 1.00, sigmaMultiplier: 0.95, blowoutRiskBoost: -0.10 },
  TANK_MODE: { paceMultiplier: 0.97, sigmaMultiplier: 1.10, blowoutRiskBoost: 0.15 },
  INJURY_ROTATION: { paceMultiplier: 1.03, sigmaMultiplier: 1.15, blowoutRiskBoost: 0.10 },
  REST_HEAVY: { paceMultiplier: 0.98, sigmaMultiplier: 1.05, blowoutRiskBoost: 0.0 },
  STANDARD: { paceMultiplier: 1.00, sigmaMultiplier: 1.00, blowoutRiskBoost: 0.0 },
};

// Strict priority order — index 0 is highest priority
const REGIME_PRIORITY = [
  'INJURY_ROTATION',
  'PLAYOFF_PUSH',
  'TANK_MODE',
  'REST_HEAVY',
];

/**
 * Count wins in an array of recent game results.
 * Accepts strings containing 'W' (case-insensitive) as wins.
 * Returns null if recent_form is not a non-empty array.
 */
function countWinsInLast10(recentForm) {
  if (!Array.isArray(recentForm) || recentForm.length === 0) return null;
  const last10 = recentForm.slice(-10);
  return last10.filter((r) => typeof r === 'string' && r.toUpperCase() === 'W').length;
}

/**
 * Determine whether the game date is after the given month boundary.
 * monthIndex is 0-based (0 = January, 1 = February, 2 = March).
 */
function isAfterMonth(gameDate, monthIndex) {
  if (!gameDate) return false;
  try {
    const d = new Date(gameDate);
    if (isNaN(d.getTime())) return false;
    // "After month X" means the date is in month X+1 or later (same year context)
    return d.getUTCMonth() >= monthIndex;
  } catch {
    return false;
  }
}

/**
 * Check INJURY_ROTATION trigger.
 * Fires when availabilityGate.totalPointImpact >= 15.
 * Fails open if totalPointImpact is not a number.
 */
function checkInjuryRotation(availabilityGate) {
  if (!availabilityGate) return false;
  if (typeof availabilityGate.totalPointImpact !== 'number') return false;
  return availabilityGate.totalPointImpact >= 15;
}

/**
 * Check PLAYOFF_PUSH trigger for a single team.
 * Fires when:
 *   - winPct >= 0.500
 *   - gameDate is after March 1 (UTCMonth >= 2)
 *   - playoff_seed_delta is available AND <= 3
 *
 * If playoff_seed_delta is absent, this trigger is skipped (returns false).
 */
function checkPlayoffPushForTeam(teamMetrics, gameDate) {
  if (!teamMetrics) return false;

  const { wins, losses, playoff_seed_delta } = teamMetrics;

  // Require explicit playoff_seed_delta — do not approximate from season record
  if (typeof playoff_seed_delta !== 'number') return false;

  const totalGames = (wins ?? 0) + (losses ?? 0);
  if (totalGames === 0) return false;

  const winPct = wins / totalGames;
  if (winPct < 0.500) return false;

  // After March 1 (month index 2)
  if (!isAfterMonth(gameDate, 2)) return false;

  // Within 3 games of the 10th seed
  if (playoff_seed_delta > 3) return false;

  return true;
}

/**
 * Check TANK_MODE trigger for a single team.
 * Fires when wins_in_last_10 <= 2 and gameDate is after February 1.
 * Fails open if recent_form is null or non-array.
 */
function checkTankModeForTeam(teamMetrics, gameDate) {
  if (!teamMetrics) return false;

  const winsInLast10 = countWinsInLast10(teamMetrics.recent_form);
  if (winsInLast10 === null) return false; // fail open

  if (winsInLast10 > 2) return false;

  // After February 1 (month index 1)
  if (!isAfterMonth(gameDate, 1)) return false;

  return true;
}

/**
 * Check REST_HEAVY trigger.
 * Fires when both restDaysHome >= 3 and restDaysAway >= 3.
 * Fails open if either value is null/undefined.
 */
function checkRestHeavy(restDaysHome, restDaysAway) {
  if (restDaysHome == null || restDaysAway == null) return false;
  return restDaysHome >= 3 && restDaysAway >= 3;
}

/**
 * detectNbaRegime — main export.
 *
 * @param {object} params
 * @param {string} params.homeTeam
 * @param {string} params.awayTeam
 * @param {number|null} params.restDaysHome
 * @param {number|null} params.restDaysAway
 * @param {object|null} params.availabilityGate
 * @param {object|null} params.teamMetricsHome
 * @param {object|null} params.teamMetricsAway
 * @param {string|null} params.gameDate  ISO 8601 date string
 *
 * @returns {{ regime: string, tags: string[], modifiers: object }}
 */
function detectNbaRegime({
  restDaysHome = null,
  restDaysAway = null,
  availabilityGate = null,
  teamMetricsHome = null,
  teamMetricsAway = null,
  gameDate = null,
} = {}) {
  const matchedTags = [];

  // Evaluate INJURY_ROTATION
  if (checkInjuryRotation(availabilityGate)) {
    matchedTags.push('INJURY_ROTATION');
  }

  // Evaluate PLAYOFF_PUSH (either team qualifies)
  if (
    checkPlayoffPushForTeam(teamMetricsHome, gameDate) ||
    checkPlayoffPushForTeam(teamMetricsAway, gameDate)
  ) {
    matchedTags.push('PLAYOFF_PUSH');
  }

  // Evaluate TANK_MODE (either team qualifies)
  if (
    checkTankModeForTeam(teamMetricsHome, gameDate) ||
    checkTankModeForTeam(teamMetricsAway, gameDate)
  ) {
    matchedTags.push('TANK_MODE');
  }

  // Evaluate REST_HEAVY
  if (checkRestHeavy(restDaysHome, restDaysAway)) {
    matchedTags.push('REST_HEAVY');
  }

  // Select dominant regime by strict priority order
  let dominantRegime = 'STANDARD';
  for (const candidate of REGIME_PRIORITY) {
    if (matchedTags.includes(candidate)) {
      dominantRegime = candidate;
      break;
    }
  }

  // tags: all matched (use STANDARD only when nothing matched)
  const tags = matchedTags.length > 0 ? matchedTags : ['STANDARD'];

  return {
    regime: dominantRegime,
    tags,
    modifiers: { ...REGIME_MODIFIERS[dominantRegime] },
  };
}

module.exports = { detectNbaRegime };
