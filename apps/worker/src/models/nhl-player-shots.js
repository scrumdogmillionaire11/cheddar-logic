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
const RECENCY_DECAY_ALPHA = 0.65; // Exponential decay for L5 weights (alpha^i, i=0..4)
const L5_WEIGHT = 0.65; // L5 vs prior blend weight
const PRIOR_WEIGHT = 0.35; // Prior (season stats) weight
const HOME_ICE_SOG_BOOST = 1.05; // Home teams shoot ~5% more
const HIGH_VOLUME_THRESHOLD = 4.5; // SOG/game above which regression applies
const HIGH_VOLUME_REGRESSION = 0.9; // Reduce μ by 10% for high-volume projections
const FIRST_PERIOD_SOG_SHARE = 0.32; // ~32% of game shots in 1P
const FIRST_PERIOD_PACE_FACTOR = 1.0; // calibrated to 1.00 to avoid 1P RMSE spike
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
  return raw.map((w) => w / total);
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
    isHome = null,
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
    mu1p /= HOME_ICE_SOG_BOOST; // Remove full-game home boost
    mu1p *= FIRST_PERIOD_HOME_ICE_BOOST; // Apply 1P home boost (1.03)
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
  if (absEdge >= 0.8 && confidence >= 0.5) {
    tier = 'HOT';
  } else if (absEdge >= 0.5 && confidence >= 0.5) {
    tier = 'WATCH';
  } else {
    tier = 'COLD';
  }

  return { tier, direction, edge, mu };
}

/**
 * Calculate the L5-based fair line for a player — no matchup adjustments.
 * This is the consistency baseline: what the player "should" be priced at
 * based solely on recent history. The market typically anchors here.
 *
 * opponentFactor, paceFactor, and isHome are intentionally excluded so that
 * calcMu(fairLine inputs) vs calcMu(full inputs) = pure matchup edge.
 *
 * @param {object} inputs - l5Sog, shotsPer60, projToi (matchup fields ignored)
 * @returns {number} L5 fair value (un-rounded)
 */
function calcFairLine(inputs) {
  return calcMu({
    l5Sog: inputs.l5Sog,
    shotsPer60: inputs.shotsPer60 ?? null,
    projToi: inputs.projToi ?? null,
    opponentFactor: 1.0,
    paceFactor: 1.0,
    isHome: null,
  });
}

/**
 * Calculate the L5-based fair line for the first period.
 * Applies the same 1P share/pace as calcMu1p, but without matchup adjustments.
 *
 * @param {object} inputs - l5Sog, shotsPer60, projToi (matchup fields ignored)
 * @returns {number} L5 fair value for 1P (un-rounded)
 */
function calcFairLine1p(inputs) {
  return Math.max(
    0.0,
    calcFairLine(inputs) * FIRST_PERIOD_SOG_SHARE * FIRST_PERIOD_PACE_FACTOR,
  );
}

// ============================================================================
// Two-Stage SOG Model — projectSogV2
// ============================================================================

/**
 * Clamp a value between min and max.
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(val, min, max) {
  return Math.min(Math.max(val, min), max);
}

/**
 * Weighted rate blend from season, L10, L5 values.
 * Weights: 0.35 season + 0.35 L10 + 0.30 L5
 * If any value is null, redistribute weight equally among present values.
 * If all null, return 0.
 *
 * @param {number|null} season
 * @param {number|null} l10
 * @param {number|null} l5
 * @returns {number}
 */
function weightedRateBlend(season, l10, l5) {
  const values = [season, l10, l5];
  const weights = [0.35, 0.35, 0.30];
  const present = values.map((v, i) => (v !== null && v !== undefined ? { v, w: weights[i] } : null)).filter(Boolean);
  if (present.length === 0) return 0;
  const totalW = present.reduce((s, x) => s + x.w, 0);
  return present.reduce((s, x) => s + (x.v * x.w) / totalW, 0);
}

/**
 * Weighted blend for PP shot rates with recency emphasis.
 * Weights: season=0.40, L10=0.35, L5=0.25 (per WI-0531 spec).
 * Null/undefined slots are excluded and remaining weights renormalized.
 * @param {number|null} season
 * @param {number|null} l10
 * @param {number|null} l5
 * @returns {number}
 */
function weightedRateBlendPP(season, l10, l5) {
  const values = [season, l10, l5];
  const weights = [0.40, 0.35, 0.25];
  const present = values
    .map((v, i) => (v !== null && v !== undefined ? { v, w: weights[i] } : null))
    .filter(Boolean);
  if (present.length === 0) return 0;
  const totalW = present.reduce((s, x) => s + x.w, 0);
  return present.reduce((s, x) => s + (x.v * x.w) / totalW, 0);
}

/**
 * Convert American odds to implied probability (raw, no vig removal).
 * @param {number} americanOdds
 * @returns {number}
 */
function americanToImplied(americanOdds) {
  if (americanOdds >= 0) {
    return 100 / (americanOdds + 100);
  }
  return Math.abs(americanOdds) / (Math.abs(americanOdds) + 100);
}

/**
 * Convert fair probability to American odds (rounded to nearest integer).
 * @param {number} prob
 * @returns {number}
 */
function probToAmerican(prob) {
  if (prob <= 0) return 99999;
  if (prob >= 1) return -99999;
  if (prob >= 0.5) {
    return Math.round(-(prob / (1 - prob)) * 100);
  }
  return Math.round(((1 - prob) / prob) * 100);
}

/**
 * Compute Poisson CDF: P(X <= k) for given lambda.
 * @param {number} lambda
 * @param {number} k  (integer)
 * @returns {number}
 */
function poissonCDF(lambda, k) {
  if (lambda <= 0) return k >= 0 ? 1 : 0;
  let cdf = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term *= lambda / (i + 1);
  }
  return cdf;
}

/**
 * P(X > line) where line is a half-integer (e.g. 2.5 → floor = 2).
 * @param {number} lambda
 * @param {number} line
 * @returns {number}
 */
function poissonOverProb(lambda, line) {
  const k = Math.floor(line);
  return 1 - poissonCDF(lambda, k);
}

/**
 * P(X < line) where line is a half-integer (e.g. 2.5 → floor = 2, P(X<=1)).
 * @param {number} lambda
 * @param {number} line
 * @returns {number}
 */
function poissonUnderProb(lambda, line) {
  const k = Math.floor(line);
  return poissonCDF(lambda, k - 1);
}

/**
 * Compute trend_factor from role_stability and EV shot rates.
 *
 * @param {string} roleStability  'HIGH' | 'MEDIUM' | 'LOW'
 * @param {number|null} l5EvRate
 * @param {number|null} seasonEvRate
 * @returns {number}
 */
function computeTrendFactor(roleStability, l5EvRate, seasonEvRate) {
  if (roleStability === 'LOW') return 1.0;
  if (!seasonEvRate || seasonEvRate === 0 || l5EvRate === null || l5EvRate === undefined) return 1.0;
  const weight = roleStability === 'HIGH' ? 1.0 : 0.5;
  const raw = 1 + ((l5EvRate / seasonEvRate - 1) * 0.35 * weight);
  return clamp(raw, 0.93, 1.07);
}

/**
 * Two-stage NHL SOG projection model.
 *
 * Stage 1: Compute sog_mu from EV+PP rate blends, TOI projections, and a
 *          chain of bounded multipliers.
 * Stage 2: Convert sog_mu to fair Poisson probabilities for each market line
 *          and compute edge/EV when prices are present.
 *
 * @param {object} inputs
 * @returns {NhlShotsProjection}
 */
function projectSogV2(inputs) {
  const {
    player_id,
    game_id,
    ev_shots_season_per60,
    ev_shots_l10_per60,
    ev_shots_l5_per60,
    pp_shots_season_per60,
    pp_shots_l10_per60,
    pp_shots_l5_per60,
    toi_proj_ev = 0,
    toi_proj_pp = 0,
    pp_matchup_factor: rawPpMatchupFactor = 1.0,
    shot_env_factor: rawShotEnvFactor = 1.0,
    opponent_suppression_factor: rawOppSuppression = 1.0,
    goalie_rebound_factor: rawGoalieRebound = 1.0,
    trailing_script_factor: rawTrailingScript = 1.0,
    role_stability = 'HIGH',
    market_line = null,
    market_price_over = null,
    market_price_under = null,
    lines_to_price = [],
    play_direction = 'OVER',
  } = inputs || {};

  // ---- Flags ----
  const flags = [];

  // LOW_SAMPLE: any EV shot rate null
  if (
    ev_shots_season_per60 === null || ev_shots_season_per60 === undefined ||
    ev_shots_l10_per60 === null || ev_shots_l10_per60 === undefined ||
    ev_shots_l5_per60 === null || ev_shots_l5_per60 === undefined
  ) {
    flags.push('LOW_SAMPLE');
  }

  if (role_stability === 'LOW') {
    flags.push('ROLE_IN_FLUX');
  }

  if (market_line !== null && market_line !== undefined &&
      (market_price_over === null || market_price_over === undefined ||
       market_price_under === null || market_price_under === undefined)) {
    flags.push('MISSING_PRICE');
  }

  // ---- Stage 1: SOG_mu ----
  const ev_rate = weightedRateBlend(ev_shots_season_per60, ev_shots_l10_per60, ev_shots_l5_per60);
  const pp_rate = weightedRateBlendPP(pp_shots_season_per60, pp_shots_l10_per60, pp_shots_l5_per60);

  const shot_env_factor = clamp(rawShotEnvFactor ?? 1.0, 0.92, 1.08);
  const opp_sup_factor = clamp(rawOppSuppression ?? 1.0, 0.90, 1.10);
  const goalie_factor = clamp(rawGoalieRebound ?? 1.0, 0.97, 1.03);
  const trailing_factor = clamp(rawTrailingScript ?? 1.0, 0.95, 1.08);
  const trend_factor = computeTrendFactor(role_stability, ev_shots_l5_per60, ev_shots_season_per60);
  const pp_matchup_factor = clamp(rawPpMatchupFactor ?? 1.0, 0.5, 1.8);

  const ev_component = ev_rate * toi_proj_ev / 60;
  const pp_component = pp_rate * toi_proj_pp / 60 * pp_matchup_factor;
  let raw_sog_mu = ev_component + pp_component;

  // WI-0530: PP sanity cap — PP contribution must not exceed 45% of total projection.
  // Prevents NST outlier rates from dominating projections for elite PP players.
  const PP_CAP_FRACTION = 0.45;
  if (pp_component > PP_CAP_FRACTION * raw_sog_mu && raw_sog_mu > 0) {
    flags.push('PP_CONTRIBUTION_CAPPED');
    // Solve: pp_capped = PP_CAP_FRACTION * (ev_component + pp_capped)
    // → pp_capped = PP_CAP_FRACTION * ev_component / (1 - PP_CAP_FRACTION)
    const pp_capped = (PP_CAP_FRACTION * ev_component) / (1 - PP_CAP_FRACTION);
    raw_sog_mu = ev_component + pp_capped;
  }
  const sog_mu = Math.max(
    0.0,
    raw_sog_mu * shot_env_factor * opp_sup_factor * goalie_factor * trailing_factor * trend_factor,
  );

  const sog_sigma = Math.sqrt(sog_mu);

  // trend_score: l5/season_rate - 1 (raw, before weight)
  const trend_score = (ev_shots_season_per60 && ev_shots_season_per60 !== 0 && ev_shots_l5_per60 !== null && ev_shots_l5_per60 !== undefined)
    ? (ev_shots_l5_per60 / ev_shots_season_per60 - 1)
    : 0;

  // ---- Stage 2: Fair probabilities per line ----
  // Combine lines_to_price with market_line (deduplicated)
  const allLines = [...new Set([
    ...lines_to_price,
    ...(market_line !== null && market_line !== undefined ? [market_line] : []),
  ])];

  const fair_over_prob_by_line = {};
  const fair_under_prob_by_line = {};
  const fair_price_over_by_line = {};
  const fair_price_under_by_line = {};

  for (const line of allLines) {
    const overProb = poissonOverProb(sog_mu, line);
    const underProb = poissonUnderProb(sog_mu, line);
    const key = String(line);
    fair_over_prob_by_line[key] = overProb;
    fair_under_prob_by_line[key] = underProb;
    fair_price_over_by_line[key] = probToAmerican(overProb);
    fair_price_under_by_line[key] = probToAmerican(underProb);
  }

  // ---- Edge and EV (only when prices present) ----
  let edge_over_pp = null;
  let edge_under_pp = null;
  let ev_over = null;
  let ev_under = null;

  if (market_price_over !== null && market_price_over !== undefined && market_line !== null && market_line !== undefined) {
    const fairOverProb = fair_over_prob_by_line[String(market_line)];
    const impliedOverProb = americanToImplied(market_price_over);
    edge_over_pp = fairOverProb - impliedOverProb;
    const payoutDm1Over = market_price_over >= 0
      ? market_price_over / 100
      : 100 / Math.abs(market_price_over);
    ev_over = fairOverProb * payoutDm1Over - (1 - fairOverProb);
  }

  if (market_price_under !== null && market_price_under !== undefined && market_line !== null && market_line !== undefined) {
    const fairUnderProb = fair_under_prob_by_line[String(market_line)];
    const impliedUnderProb = americanToImplied(market_price_under);
    edge_under_pp = fairUnderProb - impliedUnderProb;
    const payoutDm1Under = market_price_under >= 0
      ? market_price_under / 100
      : 100 / Math.abs(market_price_under);
    ev_under = fairUnderProb * payoutDm1Under - (1 - fairUnderProb);
  }

  // ---- OpportunityScore (direction-aware, WI-0575) ----
  let opportunity_score = null;
  const shot_env_adj = (rawShotEnvFactor ?? 1.0) - 1.0;
  if (play_direction === 'UNDER') {
    if (
      market_line !== null && market_line !== undefined &&
      market_price_under !== null && market_price_under !== undefined &&
      edge_under_pp !== null && ev_under !== null
    ) {
      opportunity_score =
        0.45 * edge_under_pp +
        0.20 * ev_under +
        0.20 * (market_line - sog_mu) +
        0.10 * trend_score +
        0.05 * shot_env_adj;
    }
  } else {
    // Default: OVER direction
    if (
      market_line !== null && market_line !== undefined &&
      market_price_over !== null && market_price_over !== undefined &&
      edge_over_pp !== null && ev_over !== null
    ) {
      opportunity_score =
        0.45 * edge_over_pp +
        0.20 * ev_over +
        0.20 * (sog_mu - market_line) +
        0.10 * trend_score +
        0.05 * shot_env_adj;
    }
  }

  return {
    player_id,
    game_id,
    sog_mu,
    sog_sigma,
    toi_proj: toi_proj_ev + toi_proj_pp,
    shot_rate_ev_per60: ev_rate,
    shot_rate_pp_per60: pp_rate,
    pp_matchup_factor,
    shot_env_factor,
    role_stability,
    trend_score,
    fair_over_prob_by_line,
    fair_under_prob_by_line,
    fair_price_over_by_line,
    fair_price_under_by_line,
    market_line: market_line ?? null,
    market_price_over: market_price_over ?? null,
    market_price_under: market_price_under ?? null,
    edge_over_pp,
    edge_under_pp,
    ev_over,
    ev_under,
    opportunity_score,
    flags,
  };
}

// ============================================================================
// Two-Stage BLK Model — projectBlkV1
// ============================================================================

/**
 * Compute trend_factor for blocked shots.
 * Capped narrower than SOG (0.94–1.06) and weight 0.30 (not 0.35).
 * BLK is a role/burden market — hot-hand bias is weaker signal here.
 *
 * @param {string} roleStability  'HIGH' | 'MEDIUM' | 'LOW'
 * @param {number|null} l5EvBlkRate
 * @param {number|null} seasonEvBlkRate
 * @returns {number}
 */
function computeBlkTrendFactor(roleStability, l5EvBlkRate, seasonEvBlkRate) {
  if (roleStability === 'LOW') return 1.0;
  if (!seasonEvBlkRate || seasonEvBlkRate === 0 || l5EvBlkRate === null || l5EvBlkRate === undefined) return 1.0;
  const weight = roleStability === 'HIGH' ? 1.0 : 0.5;
  const raw = 1 + ((l5EvBlkRate / seasonEvBlkRate - 1) * 0.30 * weight);
  return clamp(raw, 0.94, 1.06);
}

/**
 * Two-stage NHL Blocked Shots projection model.
 *
 * Stage 1: Compute blk_mu from EV+PK rate blends, TOI projections, and a
 *          chain of five bounded multipliers specific to the block market.
 * Stage 2: Convert blk_mu to fair Poisson probabilities for each market line
 *          and compute edge/EV when prices are present.
 *
 * Multiplier ranges (different from SOG — block market is role/burden driven):
 *   opponent_attempt_factor    [0.90 – 1.12]
 *   defensive_zone_factor      [0.95 – 1.08]
 *   underdog_script_factor     [0.95 – 1.10]
 *   playoff_tightening_factor  [1.00 – 1.08]
 *   trend_factor               [0.94 – 1.06]  (computed internally)
 *
 * @param {object} inputs
 * @returns {NhlBlockedShotsProjection}
 */
function projectBlkV1(inputs) {
  const {
    player_id,
    game_id,
    ev_blocks_season_per60,
    ev_blocks_l10_per60,
    ev_blocks_l5_per60,
    pk_blocks_season_per60,
    pk_blocks_l10_per60,
    pk_blocks_l5_per60,
    toi_proj_ev = 0,
    toi_proj_pk = 0,
    opponent_attempt_factor: rawOppAttempt = 1.0,
    defensive_zone_factor: rawDzFactor = 1.0,
    underdog_script_factor: rawUnderdogScript = 1.0,
    playoff_tightening_factor: rawPlayoffTightening = 1.0,
    role_stability = 'HIGH',
    market_line = null,
    market_price_over = null,
    market_price_under = null,
    lines_to_price = [],
    play_direction = 'OVER',
  } = inputs || {};

  // ---- Flags ----
  const flags = [];

  if (
    ev_blocks_season_per60 === null || ev_blocks_season_per60 === undefined ||
    ev_blocks_l10_per60 === null || ev_blocks_l10_per60 === undefined ||
    ev_blocks_l5_per60 === null || ev_blocks_l5_per60 === undefined
  ) {
    flags.push('LOW_SAMPLE');
  }

  if (role_stability === 'LOW') {
    flags.push('ROLE_IN_FLUX');
  }

  if (market_line !== null && market_line !== undefined &&
      (market_price_over === null || market_price_over === undefined ||
       market_price_under === null || market_price_under === undefined)) {
    flags.push('MISSING_PRICE');
  }

  // ---- Stage 1: BLK_mu ----
  const ev_rate = weightedRateBlend(ev_blocks_season_per60, ev_blocks_l10_per60, ev_blocks_l5_per60);
  const pk_rate = weightedRateBlend(pk_blocks_season_per60, pk_blocks_l10_per60, pk_blocks_l5_per60);

  const opp_attempt_factor = clamp(rawOppAttempt ?? 1.0, 0.90, 1.12);
  const dz_factor = clamp(rawDzFactor ?? 1.0, 0.95, 1.08);
  const underdog_script_factor = clamp(rawUnderdogScript ?? 1.0, 0.95, 1.10);
  const playoff_tightening_factor = clamp(rawPlayoffTightening ?? 1.0, 1.00, 1.08);
  const trend_factor = computeBlkTrendFactor(role_stability, ev_blocks_l5_per60, ev_blocks_season_per60);

  const raw_blk_mu =
    (ev_rate * toi_proj_ev / 60) +
    (pk_rate * toi_proj_pk / 60);

  const blk_mu = Math.max(
    0.0,
    raw_blk_mu *
      opp_attempt_factor *
      dz_factor *
      underdog_script_factor *
      playoff_tightening_factor *
      trend_factor,
  );

  const blk_sigma = Math.sqrt(blk_mu);

  const trend_score = (ev_blocks_season_per60 && ev_blocks_season_per60 !== 0 &&
    ev_blocks_l5_per60 !== null && ev_blocks_l5_per60 !== undefined)
    ? (ev_blocks_l5_per60 / ev_blocks_season_per60 - 1)
    : 0;

  // ---- Stage 2: Fair probabilities per line ----
  const allLines = [...new Set([
    ...lines_to_price,
    ...(market_line !== null && market_line !== undefined ? [market_line] : []),
  ])];

  const fair_over_prob_by_line = {};
  const fair_under_prob_by_line = {};
  const fair_price_over_by_line = {};
  const fair_price_under_by_line = {};

  for (const line of allLines) {
    const overProb = poissonOverProb(blk_mu, line);
    const underProb = poissonUnderProb(blk_mu, line);
    const key = String(line);
    fair_over_prob_by_line[key] = overProb;
    fair_under_prob_by_line[key] = underProb;
    fair_price_over_by_line[key] = probToAmerican(overProb);
    fair_price_under_by_line[key] = probToAmerican(underProb);
  }

  // ---- Edge and EV ----
  let edge_over_pp = null;
  let edge_under_pp = null;
  let ev_over = null;
  let ev_under = null;

  if (market_price_over !== null && market_price_over !== undefined &&
      market_line !== null && market_line !== undefined) {
    const fairOverProb = fair_over_prob_by_line[String(market_line)];
    const impliedOverProb = americanToImplied(market_price_over);
    edge_over_pp = fairOverProb - impliedOverProb;
    const payoutDm1 = market_price_over >= 0
      ? market_price_over / 100
      : 100 / Math.abs(market_price_over);
    ev_over = fairOverProb * payoutDm1 - (1 - fairOverProb);
  }

  if (market_price_under !== null && market_price_under !== undefined &&
      market_line !== null && market_line !== undefined) {
    const fairUnderProb = fair_under_prob_by_line[String(market_line)];
    const impliedUnderProb = americanToImplied(market_price_under);
    edge_under_pp = fairUnderProb - impliedUnderProb;
    const payoutDm1 = market_price_under >= 0
      ? market_price_under / 100
      : 100 / Math.abs(market_price_under);
    ev_under = fairUnderProb * payoutDm1 - (1 - fairUnderProb);
  }

  // ---- OpportunityScore (direction-aware, WI-0575) ----
  // Weights reflect that blocked shots is a role/environment market.
  // opponent_attempt_factor and playoff_tightening replace trend/env from SOG.
  let opportunity_score = null;
  if (play_direction === 'UNDER') {
    if (
      market_line !== null && market_line !== undefined &&
      market_price_under !== null && market_price_under !== undefined &&
      edge_under_pp !== null && ev_under !== null
    ) {
      opportunity_score =
        0.40 * edge_under_pp +
        0.20 * ev_under +
        0.20 * (market_line - blk_mu) +
        0.10 * (opp_attempt_factor - 1.0) +
        0.10 * (playoff_tightening_factor - 1.0);
    }
  } else {
    if (
      market_line !== null && market_line !== undefined &&
      market_price_over !== null && market_price_over !== undefined &&
      edge_over_pp !== null && ev_over !== null
    ) {
      opportunity_score =
        0.40 * edge_over_pp +
        0.20 * ev_over +
        0.20 * (blk_mu - market_line) +
        0.10 * (opp_attempt_factor - 1.0) +
        0.10 * (playoff_tightening_factor - 1.0);
    }
  }

  return {
    player_id,
    game_id,
    blk_mu,
    blk_sigma,
    toi_proj_ev,
    toi_proj_pk,
    block_rate_ev_per60: ev_rate,
    block_rate_pk_per60: pk_rate,
    opponent_attempt_factor: opp_attempt_factor,
    defensive_zone_factor: dz_factor,
    underdog_script_factor,
    playoff_tightening_factor,
    role_stability,
    trend_score,
    fair_over_prob_by_line,
    fair_under_prob_by_line,
    fair_price_over_by_line,
    fair_price_under_by_line,
    market_line: market_line ?? null,
    market_price_over: market_price_over ?? null,
    market_price_under: market_price_under ?? null,
    edge_over_pp,
    edge_under_pp,
    ev_over,
    ev_under,
    opportunity_score,
    flags,
  };
}

module.exports = { calcMu, calcMu1p, classifyEdge, calcFairLine, calcFairLine1p, projectSogV2, projectBlkV1 };
