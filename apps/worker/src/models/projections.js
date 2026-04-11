/**
 * Projections Module
 *
 * Core scoring formulas imported from personal-dashboard projections.
 * Provides base projections for NBA and NHL with pace/rest/confidence adjustments.
 */

const { classifyModelStatus, buildNoBetResult, DEGRADED_CONSTRAINTS } = require('./input-gate');
const { buildModelOutput } = require('./model-output');
const scoreEngine = require('../utils/score-engine');


/**
 * Convert to number, return null if invalid
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawData(rawData) {
  if (!rawData) return {};
  if (typeof rawData === 'string') {
    try {
      return JSON.parse(rawData);
    } catch {
      return {};
    }
  }
  return rawData;
}

function hasNumeric(value) {
  return toNumber(value) !== null;
}

function hasNumericMetricSet(metrics) {
  if (!metrics || typeof metrics !== 'object') return false;
  return [
    metrics.avgPoints,
    metrics.avgPointsAllowed,
    metrics.avgGoalsFor,
    metrics.avgGoalsAgainst,
  ].some((value) => hasNumeric(value));
}

function assessProjectionInputs(sport, oddsSnapshot) {
  const normalizedSport = String(sport || '').toUpperCase();
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const missingInputs = [];

  if (normalizedSport === 'NBA') {
    const homeAvgPoints =
      raw?.espn_metrics?.home?.metrics?.avgPoints ??
      raw?.avg_points_home ??
      raw?.home?.avg_points;
    const awayAvgPoints =
      raw?.espn_metrics?.away?.metrics?.avgPoints ??
      raw?.avg_points_away ??
      raw?.away?.avg_points;
    const homeAvgPointsAllowed =
      raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ??
      raw?.avg_points_allowed_home ??
      raw?.home?.avg_points_allowed;
    const awayAvgPointsAllowed =
      raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ??
      raw?.avg_points_allowed_away ??
      raw?.away?.avg_points_allowed;

    if (!hasNumeric(homeAvgPoints)) missingInputs.push('home_avg_points');
    if (!hasNumeric(awayAvgPoints)) missingInputs.push('away_avg_points');
    if (!hasNumeric(homeAvgPointsAllowed)) {
      missingInputs.push('home_avg_points_allowed');
    }
    if (!hasNumeric(awayAvgPointsAllowed)) {
      missingInputs.push('away_avg_points_allowed');
    }
  } else if (normalizedSport === 'NHL') {
    const homeGoalsFor =
      raw?.espn_metrics?.home?.metrics?.avgGoalsFor ??
      raw?.avg_goals_for_home ??
      raw?.home?.avg_goals_for;
    const awayGoalsFor =
      raw?.espn_metrics?.away?.metrics?.avgGoalsFor ??
      raw?.avg_goals_for_away ??
      raw?.away?.avg_goals_for;
    const homeGoalsAgainst =
      raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst ??
      raw?.avg_goals_against_home ??
      raw?.home?.avg_goals_against;
    const awayGoalsAgainst =
      raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst ??
      raw?.avg_goals_against_away ??
      raw?.away?.avg_goals_against;

    if (!hasNumeric(homeGoalsFor)) missingInputs.push('home_avg_goals_for');
    if (!hasNumeric(awayGoalsFor)) missingInputs.push('away_avg_goals_for');
    if (!hasNumeric(homeGoalsAgainst)) {
      missingInputs.push('home_avg_goals_against');
    }
    if (!hasNumeric(awayGoalsAgainst)) {
      missingInputs.push('away_avg_goals_against');
    }
  }

  return {
    projection_inputs_complete: missingInputs.length === 0,
    missing_inputs: missingInputs,
  };
}

function buildProjectionNullDiagnostic(
  sport,
  oddsSnapshot,
  projectionGate = null,
) {
  const gate = projectionGate || assessProjectionInputs(sport, oddsSnapshot);
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const espnMetrics = raw?.espn_metrics || {};
  const sourceContract = espnMetrics?.source_contract || {};

  return {
    sport: String(sport || '').toUpperCase(),
    gameId: oddsSnapshot?.game_id || null,
    homeTeam: oddsSnapshot?.home_team || null,
    awayTeam: oddsSnapshot?.away_team || null,
    missingInputs: Array.isArray(gate.missing_inputs)
      ? gate.missing_inputs
      : [],
    projectionInputsComplete: Boolean(gate.projection_inputs_complete),
    hasHomeMetrics: hasNumericMetricSet(espnMetrics?.home?.metrics),
    hasAwayMetrics: hasNumericMetricSet(espnMetrics?.away?.metrics),
    sourceContractMappingOk:
      typeof sourceContract.mapping_ok === 'boolean'
        ? sourceContract.mapping_ok
        : null,
    sourceContractFailures: Array.isArray(sourceContract.mapping_failures)
      ? sourceContract.mapping_failures
      : [],
  };
}

/**
 * Calculate NBA base projection
 * @deprecated Use projectNBACanonical + analyzePaceSynergy instead.
 *   projectNBACanonical corrects the pace double-counting present in this function.
 *   This function is retained only for legacy callers (e.g. nba-base-projection driver card).
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
function projectNBA(
  homeOffense,
  homeDefense,
  awayOffense,
  awayDefense,
  homePace,
  awayPace,
  homeRest,
  awayRest,
) {
  // Gate: all six core inputs required; rest is optional/DEGRADED
  const nbaGate = classifyModelStatus(
    {
      homeOffRtg: homeOffense ?? null,
      awayOffRtg: awayOffense ?? null,
      homeDefRtg: homeDefense ?? null,
      awayDefRtg: awayDefense ?? null,
      homePace: homePace ?? null,
      awayPace: awayPace ?? null,
      homeRest: homeRest ?? null,
      awayRest: awayRest ?? null,
    },
    ['homeOffRtg', 'awayOffRtg', 'homeDefRtg', 'awayDefRtg', 'homePace', 'awayPace'],
    ['homeRest', 'awayRest'],
  );
  if (nbaGate.status === 'NO_BET') {
    return buildNoBetResult(nbaGate.missingCritical, {
      projection_source: 'NO_BET',
      sport: 'nba',
      market: 'total',
    });
  }

  // Pace multiplier matrix (from dashboard)
  const paceMap = {
    'Fast|Fast': 1.04,
    'Fast|Avg': 1.02,
    'Avg|Fast': 1.02,
    'Avg|Avg': 1.0,
    'Avg|Slow': 0.98,
    'Slow|Avg': 0.98,
    'Slow|Slow': 0.96,
  };

  // Categorize pace (avg NBA ~100 poss/game)
  const categorizePace = (pace) => {
    if (pace > 102) return 'Fast';
    if (pace < 98) return 'Slow';
    return 'Avg';
  };

  const homePaceCategory = categorizePace(homePace);
  const awayPaceCategory = categorizePace(awayPace);
  const paceMultiplier =
    paceMap[`${homePaceCategory}|${awayPaceCategory}`] || 1.0;

  // Rest adjustments (days since last game)
  const restAdjustment = (rest) => {
    if (rest === 0) return -4; // Back-to-back
    if (rest === 1) return 0;
    if (rest === 2) return 0;
    if (rest >= 3) return 2; // Well-rested
    return 0;
  };

  const homeRestAdj = restAdjustment(homeRest);
  const awayRestAdj = restAdjustment(awayRest);

  // Base projection
  const homeProjected =
    ((homeOffense + awayDefense) / 2) * paceMultiplier + homeRestAdj;
  const awayProjected =
    ((awayOffense + homeDefense) / 2) * paceMultiplier + awayRestAdj;

  // Confidence calculation (base 50)
  let confidence = 50;

  // Rest difference signal
  const restDiff = Math.abs(homeRest - awayRest);
  if (homeRest === 0 && awayRest > 0) {
    confidence -= 12; // Home exhausted
  } else if (awayRest === 0 && homeRest > 0) {
    confidence += 12; // Away exhausted
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
    confidence += 15; // Clear winner
  } else if (projectedMargin >= 5) {
    confidence += 10;
  } else if (projectedMargin < 3) {
    confidence -= 5; // Toss-up
  }

  // Clamp confidence
  confidence = Math.max(25, Math.min(90, confidence));
  if (nbaGate.status === 'DEGRADED') {
    confidence = Math.min(confidence, DEGRADED_CONSTRAINTS.MAX_CONFIDENCE * 100); // scale to 0-100 range
  }

  return {
    homeProjected: Math.round(homeProjected * 10) / 10,
    awayProjected: Math.round(awayProjected * 10) / 10,
    confidence: Math.round(confidence) / 100,
    paceMultiplier,
    homeRestAdj,
    awayRestAdj,
    netRatingGap,
    model_status: nbaGate.status,
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
function projectNHL(
  homeGoalsFor,
  homeGoalsAgainst,
  awayGoalsFor,
  awayGoalsAgainst,
  homeGoalieConfirmed = true,
  awayGoalieConfirmed = true,
  homeRest = 1,
  awayRest = 1,
) {
  if (
    !homeGoalsFor ||
    !homeGoalsAgainst ||
    !awayGoalsFor ||
    !awayGoalsAgainst
  ) {
    return {
      homeProjected: null,
      awayProjected: null,
      confidence: 0.45,
      reasoning: 'Missing goals data',
    };
  }

  // Base projection
  let homeProjected = (homeGoalsFor + awayGoalsAgainst) / 2;
  let awayProjected = (awayGoalsFor + homeGoalsAgainst) / 2;

  // Goalie uncertainty penalty (0.98x multiplier = 2% reduction)
  if (!homeGoalieConfirmed) homeProjected *= 0.98;
  if (!awayGoalieConfirmed) awayProjected *= 0.98;

  // Rest adjustments (days since last game) — scaled for goals (not pts)
  const restAdjustment = (rest) => {
    if (rest === 0) return -0.25; // Back-to-back penalty
    if (rest === 1) return 0;
    if (rest === 2) return 0;
    if (rest >= 3) return 0.12; // Well-rested bonus
    return 0;
  };
  const homeRestAdj = restAdjustment(homeRest);
  const awayRestAdj = restAdjustment(awayRest);
  homeProjected += homeRestAdj;
  awayProjected += awayRestAdj;

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
    confidence += 3; // High-scoring = more variance but clearer signals
  } else if (totalProjected < 5) {
    confidence -= 6; // Low-scoring = defensive duel, hard to predict
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
    goalieConfirmedPenalty:
      !homeGoalieConfirmed || !awayGoalieConfirmed ? -10 : 0,
    homeRestAdj: homeRestAdj ?? 0,
    awayRestAdj: awayRestAdj ?? 0,
  };
}

/**
 * Canonical NBA total projection using PPP × pace formula.
 *
 * Ported from cheddar-nba-2.0/src/services/projection_math.py
 * (build_projection_canonical + calculate_projected_total_from_values)
 *
 * Formula:
 *   base_home_ppp = (homeOffRtg + awayDefRtg) / 200
 *   base_away_ppp = (awayOffRtg + homeDefRtg) / 200
 *   expected_pace = (homePace + awayPace) / 2
 *   adjusted_pace = expected_pace + paceAdjustment  ← pace synergy baked in
 *   home_pts = base_home_ppp * adjusted_pace
 *   away_pts = base_away_ppp * adjusted_pace
 *   projected_total = home_pts + away_pts
 *
 * Normalizes avgPoints to per-100-possession ORtg before PPP computation.
 * offRtg = (avgPoints / teamPace) * 100 — removes pace contamination so that
 * pace is applied exactly once via adjustedPace, not twice.
 *
 * @param {number} homeOffRtg - Home team avg points (normalized to ORtg internally)
 * @param {number} homeDefRtg - Home team avg points allowed (normalized to DRtg internally)
 * @param {number} homePace   - Home team possessions per game
 * @param {number} awayOffRtg - Away team avg points (normalized to ORtg internally)
 * @param {number} awayDefRtg - Away team avg points allowed (normalized to DRtg internally)
 * @param {number} awayPace   - Away team possessions per game
 * @param {number} paceAdjustment - Synergy pace delta (from PaceSynergyService)
 * @returns {object|null}
 */
function projectNBACanonical(
  homeOffRtg,
  homeDefRtg,
  homePace,
  awayOffRtg,
  awayDefRtg,
  awayPace,
  paceAdjustment = 0,
) {
  const canonicalGate = classifyModelStatus(
    {
      homeOffRtg: homeOffRtg ?? null,
      homeDefRtg: homeDefRtg ?? null,
      homePace: homePace ?? null,
      awayOffRtg: awayOffRtg ?? null,
      awayDefRtg: awayDefRtg ?? null,
      awayPace: awayPace ?? null,
    },
    ['homeOffRtg', 'homeDefRtg', 'homePace', 'awayOffRtg', 'awayDefRtg', 'awayPace'],
  );
  if (canonicalGate.status === 'NO_BET') {
    return buildNoBetResult(canonicalGate.missingCritical, {
      projection_source: 'NO_BET',
      sport: 'nba',
      market: 'canonical_total',
    });
  }

  // Normalize raw avgPoints to per-100-possession ORtg/DRtg.
  // avgPoints already embeds pace; dividing by own-team pace removes that contamination.
  const homeOffRtgNorm = homePace > 0 ? (homeOffRtg / homePace) * 100 : homeOffRtg;
  const homeDefRtgNorm = homePace > 0 ? (homeDefRtg / homePace) * 100 : homeDefRtg;
  const awayOffRtgNorm = awayPace > 0 ? (awayOffRtg / awayPace) * 100 : awayOffRtg;
  const awayDefRtgNorm = awayPace > 0 ? (awayDefRtg / awayPace) * 100 : awayDefRtg;

  // PPP (points per possession) for each team using normalized ratings
  const baseHomePPP = (homeOffRtgNorm + awayDefRtgNorm) / 200;
  const baseAwayPPP = (awayOffRtgNorm + homeDefRtgNorm) / 200;

  // WI-0830: scoreEngine for offense signal metadata (informational; does not alter adjustedPace).
  // League-average per-100 ORtg ≈ 110 (2024-25 empirical), std ≈ 4.0.
  // At avg teams (ORtgNorm ≈ 110), score ≈ 0.5 → no adjustment (near-identity preserved).
  const NBA_LEAGUE_AVG_ORTG = 110.0;
  const NBA_LEAGUE_ORTG_SD  = 4.0;
  const { score: internalOffenseScore, contributions: offenseContributions, zScores: offenseZScores } = scoreEngine.aggregate([
    { name: 'homeOffRtgNorm', value: homeOffRtgNorm, mean: NBA_LEAGUE_AVG_ORTG, std: NBA_LEAGUE_ORTG_SD, weight: 0.5 },
    { name: 'awayOffRtgNorm', value: awayOffRtgNorm, mean: NBA_LEAGUE_AVG_ORTG, std: NBA_LEAGUE_ORTG_SD, weight: 0.5 },
  ]);
  // Pace: average then apply synergy adjustment (adjustedPace formula unchanged from prior)
  const expectedPace = (homePace + awayPace) / 2;
  const adjustedPace = Math.max(expectedPace + paceAdjustment, 85); // 85 poss/game floor

  // Points = PPP × possessions
  const homeProjected = baseHomePPP * adjustedPace;
  const awayProjected = baseAwayPPP * adjustedPace;
  const projectedTotal = homeProjected + awayProjected;

  return buildModelOutput({
    market: 'NBA_TOTAL',
    model_status: 'MODEL_OK',
    fairProb: null,
    fairLine: Math.round(projectedTotal * 10) / 10,
    confidence: 0,
    featuresUsed: {
      homeOffRtg,
      homeDefRtg,
      homePace,
      awayOffRtg,
      awayDefRtg,
      awayPace,
      paceAdjustment,
      homeOffRtgNorm: Math.round(homeOffRtgNorm * 1000) / 1000,
      homeDefRtgNorm: Math.round(homeDefRtgNorm * 1000) / 1000,
      awayOffRtgNorm: Math.round(awayOffRtgNorm * 1000) / 1000,
      awayDefRtgNorm: Math.round(awayDefRtgNorm * 1000) / 1000,
    },
    missingOptional: [],
    missingCritical: [],
    diagnostics: {
      projection_source: 'CANONICAL',
    },
    homeProjected: Math.round(homeProjected * 10) / 10,
    awayProjected: Math.round(awayProjected * 10) / 10,
    projectedTotal: Math.round(projectedTotal * 10) / 10,
    // WI-0829: expose fairLine for residual projection layer
    fairLine: Math.round(projectedTotal * 10) / 10,
    expectedPace: Math.round(expectedPace * 10) / 10,
    adjustedPace: Math.round(adjustedPace * 10) / 10,
    paceAdjustment,
    baseHomePPP: Math.round(baseHomePPP * 1000) / 1000,
    baseAwayPPP: Math.round(baseAwayPPP * 1000) / 1000,
    // WI-0830: offense signal from scoreEngine (metadata; does not alter projection)
    internalOffenseScore: Math.round(internalOffenseScore * 1000) / 1000,
    offenseContributions: offenseContributions ?? null,
    offenseZScores: offenseZScores ?? null,
  });
}

module.exports = {
  assessProjectionInputs,
  buildProjectionNullDiagnostic,
  projectNBA,
  projectNBACanonical,
  projectNHL,
};
