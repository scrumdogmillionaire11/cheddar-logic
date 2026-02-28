'use strict';

/**
 * NHL Pace / Totals Model
 *
 * JS port of TotalsPredictor.predict_game() from cheddar-nhl
 * (src/nhl_sog/engine/totals_predictor.py) and ModelConfig constants
 * (src/nhl_sog/config.py).
 *
 * Provides a stateless `predictNHLGame()` that computes expected goals for
 * both teams using:
 *   - L5 recency-blended offensive/defensive ratings
 *   - Combined pace dampening
 *   - Defensive crossover adjustment
 *   - PP/PK matchup edge
 *   - Home ice advantage
 *   - B2B penalty and extended rest boost
 *   - Goalie save-pct adjustment (opponent goals)
 *   - 1P total factoring (30% of game)
 *
 * All constants match cheddar-nhl ModelConfig (2024-25 season benchmarks).
 */

// ============================================================================
// Constants (from cheddar-nhl ModelConfig, 2024-25 season benchmarks)
// ============================================================================
const LEAGUE_AVG_GOALS_PER_GAME = 3.0;    // Per team per game
const LEAGUE_AVG_SAVE_PCT = 0.900;
const LEAGUE_AVG_PP_PCT = 0.22;
const LEAGUE_AVG_PK_PCT = 0.80;

const HOME_ICE_ADVANTAGE = 1.03;           // CALIBRATED: Was 1.05, reduced to address UNDER bias
const REST_B2B_PENALTY = 0.95;             // goals * 0.95 for B2B team
const REST_EXTENDED_BOOST = 1.02;          // 3+ days rest
const PACE_DAMPENING = 0.5;               // dampened multiplicative: 1 + (raw-1)*0.5
const DEFENSE_DAMPENING = 0.5;
const PP_GOAL_SCALE = 0.035;
const GOALIE_ADJ_SCALE = 5.0;
const GOALIE_ADJ_MIN = 0.75;
const GOALIE_ADJ_MAX = 1.25;
const FIRST_PERIOD_FACTOR = 0.30;          // 30% of full game goals in 1P
const GOALS_L5_WEIGHT = 0.30;             // 30% recent, 70% season

// ============================================================================
// Helpers
// ============================================================================

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute goalie adjustment factor from save percentage.
 * A better goalie reduces the opponent's scoring:
 *   adjustment < 1.0 → fewer goals allowed
 *   adjustment > 1.0 → more goals allowed
 *
 * @param {number} savePct
 * @returns {number}
 */
function goalieAdjFactor(savePct) {
  const svDiff = savePct - LEAGUE_AVG_SAVE_PCT;
  return clamp(1.0 - svDiff * GOALIE_ADJ_SCALE, GOALIE_ADJ_MIN, GOALIE_ADJ_MAX);
}

// ============================================================================
// Main export
// ============================================================================

/**
 * Predict NHL game expected goals from team stats snapshot.
 *
 * Inputs mirror what cheddar-logic already stores via enrichOddsSnapshotWithEspnMetrics
 * and raw_data fields used by existing NHL drivers in index.js.
 *
 * @param {object} opts
 * @param {number|null} opts.homeGoalsFor   - home team goals scored per game (season avg)
 * @param {number|null} opts.homeGoalsAgainst - home team goals allowed per game
 * @param {number|null} opts.awayGoalsFor
 * @param {number|null} opts.awayGoalsAgainst
 * @param {number|null} opts.homePaceFactor  - pace_factor (ratio vs league avg, default 1.0)
 * @param {number|null} opts.awayPaceFactor
 * @param {number|null} opts.homePpPct       - power play % (0-1 scale, e.g. 0.22)
 * @param {number|null} opts.awayPpPct
 * @param {number|null} opts.homePkPct       - penalty kill % (0-1 scale, e.g. 0.80)
 * @param {number|null} opts.awayPkPct
 * @param {number|null} opts.homeGoalieSavePct - home goalie save % (e.g. 0.912)
 * @param {number|null} opts.awayGoalieSavePct
 * @param {boolean}     opts.homeGoalieConfirmed
 * @param {boolean}     opts.awayGoalieConfirmed
 * @param {boolean}     opts.homeB2B         - home team on back-to-back
 * @param {boolean}     opts.awayB2B
 * @param {number|null} opts.restDaysHome    - days since last game (3+ = extended rest)
 * @param {number|null} opts.restDaysAway
 * @param {number|null} opts.homeGoalsForL5  - L5 goals for per game (optional recency blend)
 * @param {number|null} opts.awayGoalsForL5
 * @param {number|null} opts.homeGoalsAgainstL5
 * @param {number|null} opts.awayGoalsAgainstL5
 * @returns {object|null} { homeExpected, awayExpected, expectedTotal, expected1pTotal, adjustments, confidence }
 *                         Returns null if base offensive data is unavailable.
 */
function predictNHLGame(opts) {
  const {
    homeGoalsFor = null,
    homeGoalsAgainst = null,
    awayGoalsFor = null,
    awayGoalsAgainst = null,
    homePaceFactor = null,
    awayPaceFactor = null,
    homePpPct = null,
    awayPpPct = null,
    homePkPct = null,
    awayPkPct = null,
    homeGoalieSavePct = null,
    awayGoalieSavePct = null,
    homeGoalieConfirmed = false,
    awayGoalieConfirmed = false,
    homeB2B = false,
    awayB2B = false,
    restDaysHome = null,
    restDaysAway = null,
    homeGoalsForL5 = null,
    awayGoalsForL5 = null,
    homeGoalsAgainstL5 = null,
    awayGoalsAgainstL5 = null
  } = opts || {};

  // Cannot compute without base offensive/defensive stats
  if (homeGoalsFor === null || awayGoalsFor === null) {
    return null;
  }

  const adjustments = { home: {}, away: {} };

  // ---- 1. Base offensive ratings — blend L5 with season (if L5 > 0.5) ----
  let homeOffRating = homeGoalsFor;
  if (homeGoalsForL5 !== null && homeGoalsForL5 > 0.5) {
    homeOffRating = (GOALS_L5_WEIGHT * homeGoalsForL5) + ((1 - GOALS_L5_WEIGHT) * homeGoalsFor);
  }

  let awayOffRating = awayGoalsFor;
  if (awayGoalsForL5 !== null && awayGoalsForL5 > 0.5) {
    awayOffRating = (GOALS_L5_WEIGHT * awayGoalsForL5) + ((1 - GOALS_L5_WEIGHT) * awayGoalsFor);
  }

  let homeDefRating = homeGoalsAgainst !== null ? homeGoalsAgainst : LEAGUE_AVG_GOALS_PER_GAME;
  if (homeGoalsAgainstL5 !== null && homeGoalsAgainstL5 > 0.5 && homeGoalsAgainst !== null) {
    homeDefRating = (GOALS_L5_WEIGHT * homeGoalsAgainstL5) + ((1 - GOALS_L5_WEIGHT) * homeGoalsAgainst);
  }

  let awayDefRating = awayGoalsAgainst !== null ? awayGoalsAgainst : LEAGUE_AVG_GOALS_PER_GAME;
  if (awayGoalsAgainstL5 !== null && awayGoalsAgainstL5 > 0.5 && awayGoalsAgainst !== null) {
    awayDefRating = (GOALS_L5_WEIGHT * awayGoalsAgainstL5) + ((1 - GOALS_L5_WEIGHT) * awayGoalsAgainst);
  }

  const l5Blended = (
    (homeGoalsForL5 !== null && homeGoalsForL5 > 0.5) ||
    (awayGoalsForL5 !== null && awayGoalsForL5 > 0.5)
  );

  // ---- 2. Combined pace (dampened multiplicative) ----
  const hPace = homePaceFactor !== null ? homePaceFactor : 1.0;
  const aPace = awayPaceFactor !== null ? awayPaceFactor : 1.0;
  const rawCombinedPace = hPace * aPace;
  const combinedPace = 1.0 + (rawCombinedPace - 1.0) * PACE_DAMPENING;

  let homeGoals = homeOffRating * combinedPace;
  let awayGoals = awayOffRating * combinedPace;
  adjustments.home.combined_pace = combinedPace;
  adjustments.away.combined_pace = combinedPace;

  // ---- 3. Defensive crossover (dampened ratio adjustment) ----
  if (LEAGUE_AVG_GOALS_PER_GAME > 0) {
    if (awayDefRating > 0) {
      const rawHomeDefAdj = awayDefRating / LEAGUE_AVG_GOALS_PER_GAME;
      const homeDefAdj = 1.0 + (rawHomeDefAdj - 1.0) * DEFENSE_DAMPENING;
      homeGoals *= homeDefAdj;
      adjustments.home.opponent_defense = homeDefAdj;
    }
    if (homeDefRating > 0) {
      const rawAwayDefAdj = homeDefRating / LEAGUE_AVG_GOALS_PER_GAME;
      const awayDefAdj = 1.0 + (rawAwayDefAdj - 1.0) * DEFENSE_DAMPENING;
      awayGoals *= awayDefAdj;
      adjustments.away.opponent_defense = awayDefAdj;
    }
  }

  // ---- 4. PP/PK matchup (only when all 4 values present) ----
  const hasPpPk = homePpPct !== null && awayPpPct !== null &&
                  homePkPct !== null && awayPkPct !== null;
  if (hasPpPk) {
    const homePpEdge = (homePpPct - LEAGUE_AVG_PP_PCT) + ((1 - awayPkPct) - (1 - LEAGUE_AVG_PK_PCT));
    const awayPpEdge = (awayPpPct - LEAGUE_AVG_PP_PCT) + ((1 - homePkPct) - (1 - LEAGUE_AVG_PK_PCT));

    if (homePpEdge > 0) {
      const homePpBoost = 1.0 + homePpEdge * PP_GOAL_SCALE;
      homeGoals *= homePpBoost;
      adjustments.home.pp_pk_matchup = homePpBoost;
    }
    if (awayPpEdge > 0) {
      const awayPpBoost = 1.0 + awayPpEdge * PP_GOAL_SCALE;
      awayGoals *= awayPpBoost;
      adjustments.away.pp_pk_matchup = awayPpBoost;
    }
  }

  // ---- 5. Home ice advantage ----
  homeGoals *= HOME_ICE_ADVANTAGE;
  adjustments.home.home_ice = HOME_ICE_ADVANTAGE;

  // ---- 6. B2B penalty ----
  if (homeB2B) {
    homeGoals *= REST_B2B_PENALTY;
    adjustments.home.back_to_back = REST_B2B_PENALTY;
  }
  if (awayB2B) {
    awayGoals *= REST_B2B_PENALTY;
    adjustments.away.back_to_back = REST_B2B_PENALTY;
  }

  // ---- 7. Extended rest boost (3+ days) ----
  if (restDaysHome !== null && restDaysHome >= 3) {
    homeGoals *= REST_EXTENDED_BOOST;
    adjustments.home.extended_rest = REST_EXTENDED_BOOST;
  }
  if (restDaysAway !== null && restDaysAway >= 3) {
    awayGoals *= REST_EXTENDED_BOOST;
    adjustments.away.extended_rest = REST_EXTENDED_BOOST;
  }

  // ---- 8. Goalie adjustment (goalie affects OPPONENT's goals) ----
  if (homeGoalieSavePct !== null) {
    const factor = goalieAdjFactor(homeGoalieSavePct);
    awayGoals *= factor;   // home goalie reduces away scoring
    adjustments.away.opponent_goalie = factor;
  }
  if (awayGoalieSavePct !== null) {
    const factor = goalieAdjFactor(awayGoalieSavePct);
    homeGoals *= factor;   // away goalie reduces home scoring
    adjustments.home.opponent_goalie = factor;
  }

  // ---- 9. Expected total + 1P ----
  const homeExpected = Math.round(homeGoals * 1000) / 1000;
  const awayExpected = Math.round(awayGoals * 1000) / 1000;
  const expectedTotal = Math.round((homeGoals + awayGoals) * 1000) / 1000;
  const expected1pTotal = Math.round((homeGoals + awayGoals) * FIRST_PERIOD_FACTOR * 1000) / 1000;

  // ---- 10. Confidence (0.55–0.80) ----
  let confidence = 0.60;
  if (homeGoalieConfirmed && awayGoalieConfirmed) confidence += 0.05;
  if (hasPpPk)   confidence += 0.05;
  if (l5Blended) confidence += 0.03;
  confidence = clamp(confidence, 0.55, 0.80);

  return {
    homeExpected,
    awayExpected,
    expectedTotal,
    expected1pTotal,
    homeGoalieConfirmed,
    awayGoalieConfirmed,
    adjustments,
    confidence
  };
}

module.exports = { predictNHLGame };
