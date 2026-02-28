/**
 * Projections Module
 *
 * Core scoring formulas imported from personal-dashboard projections.
 * Provides base projections for NBA, NCAAM, NHL with pace/rest/confidence adjustments.
 */

/**
 * Convert to number, return null if invalid
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Calculate NBA base projection
 * @param {number} homeOffense - avgPoints
 * @param {number} homeDefense - avgPointsAllowed
 * @param {number} awayOffense - avgPoints
 * @param {number} awayDefense - avgPointsAllowed
 * @param {number} homePace - possessions per game
 * @param {number} awayPace - possessions per game
 * @param {number} homeRest - days since last game
 * @param {number} awayRest - days since last game
 * @returns {object} { homeProjected, awayProjected, confidence }
 */
function projectNBA(homeOffense, homeDefense, awayOffense, awayDefense, homePace, awayPace, homeRest, awayRest) {
  // Validate inputs
  if (!homeOffense || !awayDefense || !awayOffense || !homeDefense) {
    return { homeProjected: null, awayProjected: null, confidence: 0.50, reasoning: 'Missing offense/defense data' };
  }

  // Pace multiplier matrix (from dashboard)
  const paceMap = {
    'Fast|Fast': 1.04,
    'Fast|Avg': 1.02,
    'Avg|Fast': 1.02,
    'Avg|Avg': 1.00,
    'Avg|Slow': 0.98,
    'Slow|Avg': 0.98,
    'Slow|Slow': 0.96
  };

  // Categorize pace (avg NBA ~100 poss/game)
  const categorizePace = (pace) => {
    if (pace > 102) return 'Fast';
    if (pace < 98) return 'Slow';
    return 'Avg';
  };

  const homePaceCategory = categorizePace(homePace || 100);
  const awayPaceCategory = categorizePace(awayPace || 100);
  const paceMultiplier = paceMap[`${homePaceCategory}|${awayPaceCategory}`] || 1.00;

  // Rest adjustments (days since last game)
  const restAdjustment = (rest) => {
    if (rest === 0) return -4;    // Back-to-back
    if (rest === 1) return 0;
    if (rest === 2) return 0;
    if (rest >= 3) return 2;      // Well-rested
    return 0;
  };

  const homeRestAdj = restAdjustment(homeRest);
  const awayRestAdj = restAdjustment(awayRest);

  // Base projection
  const homeProjected = ((homeOffense + awayDefense) / 2) * paceMultiplier + homeRestAdj;
  const awayProjected = ((awayOffense + homeDefense) / 2) * paceMultiplier + awayRestAdj;

  // Confidence calculation (base 50)
  let confidence = 50;

  // Rest difference signal
  const restDiff = Math.abs(homeRest - awayRest);
  if (homeRest === 0 && awayRest > 0) {
    confidence -= 12;  // Home exhausted
  } else if (awayRest === 0 && homeRest > 0) {
    confidence += 12;  // Away exhausted
  } else if (restDiff >= 2) {
    confidence += 8;
  }

  // Net rating gap signal
  const homeNetRating = homeOffense - homeDefense;
  const awayNetRating = awayOffense - awayDefense;
  const netRatingGap = Math.abs(homeNetRating - awayNetRating);
  if (netRatingGap >= 5) {
    confidence += 10;
  } else if (netRatingGap >= 3) {
    confidence += 7;
  }

  // Spread clarity signal (margin of victory confidence)
  const projectedMargin = Math.abs(homeProjected - awayProjected);
  if (projectedMargin >= 10) {
    confidence += 15;  // Clear winner
  } else if (projectedMargin >= 5) {
    confidence += 10;
  } else if (projectedMargin < 3) {
    confidence -= 5;   // Toss-up
  }

  // Clamp confidence
  confidence = Math.max(25, Math.min(90, confidence));

  return {
    homeProjected: Math.round(homeProjected * 10) / 10,
    awayProjected: Math.round(awayProjected * 10) / 10,
    confidence: Math.round(confidence) / 100,
    paceMultiplier,
    homeRestAdj,
    awayRestAdj,
    netRatingGap
  };
}

/**
 * Calculate NCAAM base projection with 2.5pt HCA
 * @param {number} homeOffense - avgPoints
 * @param {number} homeDefense - avgPointsAllowed
 * @param {number} awayOffense - avgPoints
 * @param {number} awayDefense - avgPointsAllowed
 * @returns {object} { homeProjected, awayProjected, projectedMargin }
 */
function projectNCAAM(homeOffense, homeDefense, awayOffense, awayDefense) {
  if (!homeOffense || !awayDefense || !awayOffense || !homeDefense) {
    return { homeProjected: null, awayProjected: null, projectedMargin: null };
  }

  const HCA = 2.5;  // Home court advantage
  const homeProjected = (homeOffense + awayDefense) / 2 + HCA;
  const awayProjected = (awayOffense + homeDefense) / 2;

  return {
    homeProjected: Math.round(homeProjected * 10) / 10,
    awayProjected: Math.round(awayProjected * 10) / 10,
    projectedMargin: Math.round((homeProjected - awayProjected) * 10) / 10
  };
}

/**
 * Calculate NHL base projection
 * @param {number} homeGoalsFor - avg goals per game
 * @param {number} homeGoalsAgainst - avg goals allowed
 * @param {number} awayGoalsFor - avg goals per game
 * @param {number} awayGoalsAgainst - avg goals allowed
 * @param {boolean} homeGoalieConfirmed - is goalie known
 * @param {boolean} awayGoalieConfirmed - is goalie known
 * @returns {object} { homeProjected, awayProjected, confidence }
 */
function projectNHL(homeGoalsFor, homeGoalsAgainst, awayGoalsFor, awayGoalsAgainst, homeGoalieConfirmed = true, awayGoalieConfirmed = true) {
  if (!homeGoalsFor || !homeGoalsAgainst || !awayGoalsFor || !awayGoalsAgainst) {
    return { homeProjected: null, awayProjected: null, confidence: 0.45, reasoning: 'Missing goals data' };
  }

  // Base projection
  let homeProjected = (homeGoalsFor + awayGoalsAgainst) / 2;
  let awayProjected = (awayGoalsFor + homeGoalsAgainst) / 2;

  // Goalie uncertainty penalty (0.98x multiplier = 2% reduction)
  if (!homeGoalieConfirmed) homeProjected *= 0.98;
  if (!awayGoalieConfirmed) awayProjected *= 0.98;

  // Confidence calculation (base 45 — lower than NBA due to variance)
  let confidence = 45;

  // Goal differential gap signal
  const homeGoalDiff = homeGoalsFor - homeGoalsAgainst;
  const awayGoalDiff = awayGoalsFor - awayGoalsAgainst;
  const goalDiffGap = Math.abs(homeGoalDiff - awayGoalDiff);
  
  if (goalDiffGap >= 1.5) {
    confidence += 10;
  } else if (goalDiffGap >= 0.8) {
    confidence += 6;
  }

  // Spread clarity signal (tighter margins than NBA)
  const projectedMargin = Math.abs(homeProjected - awayProjected);
  if (projectedMargin >= 1.0) {
    confidence += 10;
  } else if (projectedMargin >= 0.5) {
    confidence += 6;
  } else {
    confidence -= 3;
  }

  // Scoring environment signals
  const totalProjected = homeProjected + awayProjected;
  if (totalProjected > 7) {
    confidence += 3;   // High-scoring = more variance but clearer signals
  } else if (totalProjected < 5) {
    confidence -= 6;   // Low-scoring = defensive duel, hard to predict
  }

  // Goalie unconfirmed penalty
  if (!homeGoalieConfirmed || !awayGoalieConfirmed) {
    confidence -= 10;
  }

  // Clamp confidence (lower bounds than NBA)
  confidence = Math.max(15, Math.min(75, confidence));

  return {
    homeProjected: Math.round(homeProjected * 100) / 100,
    awayProjected: Math.round(awayProjected * 100) / 100,
    confidence: Math.round(confidence) / 100,
    goalDiffGap,
    totalProjected: Math.round(totalProjected * 100) / 100,
    goalieConfirmedPenalty: (!homeGoalieConfirmed || !awayGoalieConfirmed) ? -10 : 0
  };
}

module.exports = {
  projectNBA,
  projectNCAAM,
  projectNHL
};
