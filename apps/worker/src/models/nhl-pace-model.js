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
 *   - 1P projection model (pass-first classification)
 *
 * All constants match cheddar-nhl ModelConfig (2024-25 season benchmarks).
 */

// ============================================================================
// Constants (from cheddar-nhl ModelConfig, 2024-25 season benchmarks)
// ============================================================================
const LEAGUE_AVG_GOALS_PER_GAME = 3.0; // Per team per game
const LEAGUE_AVG_SAVE_PCT = 0.9;
const LEAGUE_AVG_PP_PCT = 0.22;
const LEAGUE_AVG_PK_PCT = 0.8;

const HOME_ICE_ADVANTAGE = 1.03; // CALIBRATED: Was 1.05, reduced to address UNDER bias
const REST_B2B_PENALTY = 0.95; // goals * 0.95 for B2B team
const REST_EXTENDED_BOOST = 1.02; // 3+ days rest
const PACE_DAMPENING = 0.5; // dampened multiplicative: 1 + (raw-1)*0.5
const DEFENSE_DAMPENING = 0.5;
const PP_GOAL_SCALE = 0.02;
const GOALIE_ADJ_SCALE = 2.5; // Balanced to preserve playable separation without runaway inflation
const GOALIE_ADJ_MIN = 0.85;
const GOALIE_ADJ_MAX = 1.15;
const GOALS_L5_WEIGHT = 0.3; // 30% recent, 70% season
const NHL_TOTAL_BASELINE = 6.05;
const TOTAL_REGRESSION_K = 0.7;
const TOTAL_FLOOR = 5.0;
const TOTAL_CEILING = 7.6;
const MODIFIER_CAP_ABS = 0.7;
const ONE_P_TOTAL_FLOOR = 1.2;
const ONE_P_TOTAL_CEILING = 2.25;
const ONE_P_BASE_INTERCEPT = 0.18;
const ONE_P_BASE_MULTIPLIER = 0.275;
const ONE_P_PACE_CAP = 0.12;
const ONE_P_SPECIAL_TEAMS_CAP = 0.08;
const ONE_P_GOALIE_CAP = 0.1;
const ONE_P_REST_CAP = 0.05;
const ONE_P_TOTAL_ADJ_CAP = 0.18;

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

function normalizeGoalieCertainty(certainty, confirmedFallback) {
  const token = String(certainty || '').toUpperCase();
  if (token === 'CONFIRMED') return 'CONFIRMED';
  if (token === 'EXPECTED' || token === 'PROJECTED' || token === 'LIKELY') {
    return 'UNKNOWN';
  }
  if (token === 'UNKNOWN') return 'UNKNOWN';
  return confirmedFallback ? 'CONFIRMED' : 'UNKNOWN';
}

function goalieCertaintyMultiplier(certainty) {
  if (certainty === 'CONFIRMED') return 1.0;
  return 0.0;
}

function classifyFirstPeriodProjection(projection) {
  if (projection <= 1.42) return 'BEST_UNDER';
  if (projection <= 1.5) return 'PLAY_UNDER';
  if (projection <= 1.58) return 'LEAN_UNDER';
  if (projection < 2.0) return 'PASS';
  if (projection < 2.15) return 'LEAN_OVER';
  if (projection < 2.25) return 'PLAY_OVER';
  return 'BEST_OVER';
}

function resolveEnvironmentTag(totalAdj) {
  if (totalAdj <= -0.08) return 'UNDER_1P';
  if (totalAdj >= 0.08) return 'OVER_1P';
  return 'NEUTRAL_1P';
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
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
 * @param {'CONFIRMED'|'UNKNOWN'|null} opts.homeGoalieCertainty
 * @param {'CONFIRMED'|'UNKNOWN'|null} opts.awayGoalieCertainty
 * @param {boolean}     opts.homeB2B         - home team on back-to-back
 * @param {boolean}     opts.awayB2B
 * @param {number|null} opts.restDaysHome    - days since last game (3+ = extended rest)
 * @param {number|null} opts.restDaysAway
 * @param {number|null} opts.homeGoalsForL5  - L5 goals for per game (optional recency blend)
 * @param {number|null} opts.awayGoalsForL5
 * @param {number|null} opts.homeGoalsAgainstL5
 * @param {number|null} opts.awayGoalsAgainstL5
 * @returns {object|null} { homeExpected, awayExpected, expectedTotal, expected1pTotal, first_period_model, adjustments, confidence }
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
    homeGoalieCertainty = null,
    awayGoalieCertainty = null,
    homeB2B = false,
    awayB2B = false,
    restDaysHome = null,
    restDaysAway = null,
    homeGoalsForL5 = null,
    awayGoalsForL5 = null,
    homeGoalsAgainstL5 = null,
    awayGoalsAgainstL5 = null,
  } = opts || {};

  // Cannot compute without base offensive/defensive stats
  if (homeGoalsFor === null || awayGoalsFor === null) {
    return null;
  }

  const adjustments = { home: {}, away: {} };
  const homeCertainty = normalizeGoalieCertainty(
    homeGoalieCertainty,
    homeGoalieConfirmed,
  );
  const awayCertainty = normalizeGoalieCertainty(
    awayGoalieCertainty,
    awayGoalieConfirmed,
  );

  // ---- 1. Base offensive ratings — blend L5 with season (if L5 > 0.5) ----
  let homeOffRating = homeGoalsFor;
  if (homeGoalsForL5 !== null && homeGoalsForL5 > 0.5) {
    homeOffRating =
      GOALS_L5_WEIGHT * homeGoalsForL5 + (1 - GOALS_L5_WEIGHT) * homeGoalsFor;
  }

  let awayOffRating = awayGoalsFor;
  if (awayGoalsForL5 !== null && awayGoalsForL5 > 0.5) {
    awayOffRating =
      GOALS_L5_WEIGHT * awayGoalsForL5 + (1 - GOALS_L5_WEIGHT) * awayGoalsFor;
  }

  let homeDefRating =
    homeGoalsAgainst !== null ? homeGoalsAgainst : LEAGUE_AVG_GOALS_PER_GAME;
  if (
    homeGoalsAgainstL5 !== null &&
    homeGoalsAgainstL5 > 0.5 &&
    homeGoalsAgainst !== null
  ) {
    homeDefRating =
      GOALS_L5_WEIGHT * homeGoalsAgainstL5 +
      (1 - GOALS_L5_WEIGHT) * homeGoalsAgainst;
  }

  let awayDefRating =
    awayGoalsAgainst !== null ? awayGoalsAgainst : LEAGUE_AVG_GOALS_PER_GAME;
  if (
    awayGoalsAgainstL5 !== null &&
    awayGoalsAgainstL5 > 0.5 &&
    awayGoalsAgainst !== null
  ) {
    awayDefRating =
      GOALS_L5_WEIGHT * awayGoalsAgainstL5 +
      (1 - GOALS_L5_WEIGHT) * awayGoalsAgainst;
  }

  const l5Blended =
    (homeGoalsForL5 !== null && homeGoalsForL5 > 0.5) ||
    (awayGoalsForL5 !== null && awayGoalsForL5 > 0.5);

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

  // Keep a strict 5v5/base checkpoint before additive modifiers.
  const baseHomeGoals = homeGoals;
  const baseAwayGoals = awayGoals;
  const base5v5Total = baseHomeGoals + baseAwayGoals;

  let specialTeamsDelta = 0;
  let homeIceDelta = 0;
  let restDelta = 0;
  let goalieDeltaRaw = 0;
  let goalieDeltaApplied = 0;

  // ---- 4. PP/PK matchup (only when all 4 values present) ----
  const hasPpPk =
    homePpPct !== null &&
    awayPpPct !== null &&
    homePkPct !== null &&
    awayPkPct !== null;
  if (hasPpPk) {
    const beforePp = homeGoals + awayGoals;
    const homePpEdge =
      homePpPct - LEAGUE_AVG_PP_PCT + (1 - awayPkPct - (1 - LEAGUE_AVG_PK_PCT));
    const awayPpEdge =
      awayPpPct - LEAGUE_AVG_PP_PCT + (1 - homePkPct - (1 - LEAGUE_AVG_PK_PCT));

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
    specialTeamsDelta = homeGoals + awayGoals - beforePp;
  }

  // ---- 5. Home ice advantage ----
  const beforeHomeIce = homeGoals + awayGoals;
  homeGoals *= HOME_ICE_ADVANTAGE;
  adjustments.home.home_ice = HOME_ICE_ADVANTAGE;
  homeIceDelta = homeGoals + awayGoals - beforeHomeIce;

  // ---- 6. B2B penalty ----
  const beforeRest = homeGoals + awayGoals;
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
  restDelta = homeGoals + awayGoals - beforeRest;

  // ---- 8. Goalie adjustment (goalie affects OPPONENT's goals) ----
  // Unknown = no directional effect. Only CONFIRMED contributes.
  const homeGoalieMultiplier = goalieCertaintyMultiplier(homeCertainty);
  if (homeGoalieSavePct !== null && homeGoalieMultiplier > 0) {
    const rawFactor = goalieAdjFactor(homeGoalieSavePct);
    const appliedFactor = 1 + (rawFactor - 1) * homeGoalieMultiplier;
    const beforeAway = awayGoals;
    goalieDeltaRaw += beforeAway * (rawFactor - 1);
    goalieDeltaApplied += beforeAway * (appliedFactor - 1);
    awayGoals *= appliedFactor; // home goalie reduces away scoring
    adjustments.away.opponent_goalie = appliedFactor;
  }
  const awayGoalieMultiplier = goalieCertaintyMultiplier(awayCertainty);
  if (awayGoalieSavePct !== null && awayGoalieMultiplier > 0) {
    const rawFactor = goalieAdjFactor(awayGoalieSavePct);
    const appliedFactor = 1 + (rawFactor - 1) * awayGoalieMultiplier;
    const beforeHome = homeGoals;
    goalieDeltaRaw += beforeHome * (rawFactor - 1);
    goalieDeltaApplied += beforeHome * (appliedFactor - 1);
    homeGoals *= appliedFactor; // away goalie reduces home scoring
    adjustments.home.opponent_goalie = appliedFactor;
  }

  // ---- 8b. Cap stacked modifier impact to prevent additive runaway ----
  const rawModifiedTotal = homeGoals + awayGoals;
  const rawModifierTotal = rawModifiedTotal - base5v5Total;
  const cappedModifierTotal = clamp(
    rawModifierTotal,
    -MODIFIER_CAP_ABS,
    MODIFIER_CAP_ABS,
  );
  const modifierCapApplied = cappedModifierTotal !== rawModifierTotal;
  if (modifierCapApplied && rawModifiedTotal > 0) {
    const cappedTotal = base5v5Total + cappedModifierTotal;
    const scaleToCapped = cappedTotal / rawModifiedTotal;
    homeGoals *= scaleToCapped;
    awayGoals *= scaleToCapped;
  }

  // ---- 9. Regress + clamp full-game total to sane NHL range ----
  const rawTotalModel = homeGoals + awayGoals;
  const regressedTotalModel =
    NHL_TOTAL_BASELINE +
    TOTAL_REGRESSION_K * (rawTotalModel - NHL_TOTAL_BASELINE);
  const finalTotalPreMarket = clamp(
    regressedTotalModel,
    TOTAL_FLOOR,
    TOTAL_CEILING,
  );
  const totalClampedHigh = finalTotalPreMarket >= TOTAL_CEILING;
  const totalClampedLow = finalTotalPreMarket <= TOTAL_FLOOR;
  const scaleToFinalTotal =
    rawTotalModel > 0 ? finalTotalPreMarket / rawTotalModel : 1;
  homeGoals *= scaleToFinalTotal;
  awayGoals *= scaleToFinalTotal;

  // ---- 10. Expected total + 1P ----
  const homeExpected = Math.round(homeGoals * 1000) / 1000;
  const awayExpected = Math.round(awayGoals * 1000) / 1000;
  const expectedTotal = Math.round((homeGoals + awayGoals) * 1000) / 1000;

  const firstPeriodPaceScore = clamp(
    (base5v5Total - NHL_TOTAL_BASELINE) * 0.08,
    -ONE_P_PACE_CAP,
    ONE_P_PACE_CAP,
  );
  const firstPeriodPenaltyPressureScore = clamp(
    specialTeamsDelta * 2.0,
    -ONE_P_SPECIAL_TEAMS_CAP,
    ONE_P_SPECIAL_TEAMS_CAP,
  );
  const rawGoalie1pDelta = goalieDeltaApplied * 0.35;
  const goalieCertaintyScale = Math.min(
    goalieCertaintyMultiplier(homeCertainty),
    goalieCertaintyMultiplier(awayCertainty),
  );
  const firstPeriodGoalieAdj = clamp(
    rawGoalie1pDelta * goalieCertaintyScale,
    -ONE_P_GOALIE_CAP,
    ONE_P_GOALIE_CAP,
  );
  const firstPeriodRestDelta = clamp(
    restDelta * 0.25,
    -ONE_P_REST_CAP,
    ONE_P_REST_CAP,
  );

  const base1p =
    ONE_P_BASE_INTERCEPT + ONE_P_BASE_MULTIPLIER * finalTotalPreMarket;
  const totalAdjRaw =
    firstPeriodPaceScore +
    firstPeriodPenaltyPressureScore +
    firstPeriodGoalieAdj +
    firstPeriodRestDelta;
  const totalAdj = clamp(
    totalAdjRaw,
    -ONE_P_TOTAL_ADJ_CAP,
    ONE_P_TOTAL_ADJ_CAP,
  );

  const raw1pProjection = base1p + totalAdj;
  const final1pProjection = clamp(
    raw1pProjection,
    ONE_P_TOTAL_FLOOR,
    ONE_P_TOTAL_CEILING,
  );
  const final1pProjectionRounded = round3(final1pProjection);
  const clampLow = final1pProjectionRounded <= ONE_P_TOTAL_FLOOR;
  const clampHigh = final1pProjectionRounded >= ONE_P_TOTAL_CEILING;

  let onePClassification = classifyFirstPeriodProjection(
    final1pProjectionRounded,
  );
  const goalieUncertain =
    homeCertainty === 'UNKNOWN' || awayCertainty === 'UNKNOWN';

  // Force PASS when goalie certainty is uncertain
  if (goalieUncertain) {
    onePClassification = 'PASS';
  }

  const onePReasonCodes = [];
  if (onePClassification === 'PASS') {
    onePReasonCodes.push('NHL_1P_PASS_DEAD_ZONE');
  } else if (onePClassification === 'LEAN_OVER') {
    onePReasonCodes.push('NHL_1P_OVER_LEAN');
  } else if (onePClassification === 'PLAY_OVER') {
    onePReasonCodes.push('NHL_1P_OVER_PLAY');
  } else if (onePClassification === 'BEST_OVER') {
    onePReasonCodes.push('NHL_1P_OVER_BEST');
  } else if (onePClassification === 'LEAN_UNDER') {
    onePReasonCodes.push('NHL_1P_UNDER_LEAN');
  } else if (onePClassification === 'PLAY_UNDER') {
    onePReasonCodes.push('NHL_1P_UNDER_PLAY');
  } else if (onePClassification === 'BEST_UNDER') {
    onePReasonCodes.push('NHL_1P_UNDER_BEST');
  }

  if (goalieUncertain) {
    onePReasonCodes.push('NHL_1P_GOALIE_UNCERTAIN');
  }
  if (clampLow) {
    onePReasonCodes.push('NHL_1P_CLAMP_LOW');
  }
  if (clampHigh) {
    onePReasonCodes.push('NHL_1P_CLAMP_HIGH');
  }
  if (totalClampedHigh) {
    onePReasonCodes.push('NHL_1P_MODEL_HOT_CAP');
  }

  const first_period_model = {
    projection_raw: round3(raw1pProjection),
    projection_final: final1pProjectionRounded,
    pace_1p: round3(firstPeriodPaceScore),
    suppressor_1p: round3(Math.min(0, totalAdj)),
    accelerant_1p: round3(Math.max(0, totalAdj)),
    goalie_confidence:
      homeCertainty === 'CONFIRMED' && awayCertainty === 'CONFIRMED'
        ? 'HIGH'
        : homeCertainty === 'UNKNOWN' || awayCertainty === 'UNKNOWN'
          ? 'LOW'
          : 'MEDIUM',
    environment_tag: resolveEnvironmentTag(totalAdj),
    fair_over_1_5_prob: null,
    fair_under_1_5_prob: null,
    market_line_ref: 1.5,
    market_price_over: null,
    market_price_under: null,
    classification: onePClassification,
    reason_codes: onePReasonCodes,
    clamp_low: clampLow,
    clamp_high: clampHigh,
  };
  const expected1pTotal = first_period_model.projection_final;

  // ---- 11. Confidence (0.55–0.80) ----
  let confidence = 0.6;
  if (homeCertainty === 'CONFIRMED' && awayCertainty === 'CONFIRMED') {
    confidence += 0.05;
  } else if (homeCertainty === 'EXPECTED' || awayCertainty === 'EXPECTED') {
    confidence += 0.02;
  }
  if (hasPpPk) confidence += 0.05;
  if (l5Blended) confidence += 0.03;
  confidence = clamp(confidence, 0.55, 0.8);
  const goalieConfidenceCapped =
    homeCertainty === 'UNKNOWN' || awayCertainty === 'UNKNOWN';
  if (goalieConfidenceCapped) {
    confidence = Math.min(confidence, 0.35);
  } else if (homeCertainty !== 'CONFIRMED' || awayCertainty !== 'CONFIRMED') {
    confidence = Math.min(confidence, 0.5);
  }

  return {
    homeExpected,
    awayExpected,
    expectedTotal,
    expected1pTotal,
    first_period_model,
    homeGoalieConfirmed: homeCertainty === 'CONFIRMED',
    awayGoalieConfirmed: awayCertainty === 'CONFIRMED',
    homeGoalieCertainty: homeCertainty,
    awayGoalieCertainty: awayCertainty,
    goalieConfidenceCapped,
    rawTotalModel: Math.round(rawTotalModel * 1000) / 1000,
    regressedTotalModel: Math.round(regressedTotalModel * 1000) / 1000,
    totalClampedHigh,
    totalClampedLow,
    modifierCapApplied,
    modifierBreakdown: {
      base_5v5_total: Math.round(base5v5Total * 1000) / 1000,
      special_teams_delta: Math.round(specialTeamsDelta * 1000) / 1000,
      home_ice_delta: Math.round(homeIceDelta * 1000) / 1000,
      rest_delta: Math.round(restDelta * 1000) / 1000,
      goalie_delta_raw: Math.round(goalieDeltaRaw * 1000) / 1000,
      goalie_delta_applied: Math.round(goalieDeltaApplied * 1000) / 1000,
      raw_modifier_total: Math.round(rawModifierTotal * 1000) / 1000,
      capped_modifier_total: Math.round(cappedModifierTotal * 1000) / 1000,
      modifier_cap_applied: modifierCapApplied,
    },
    adjustments,
    confidence,
  };
}

module.exports = { predictNHLGame };
