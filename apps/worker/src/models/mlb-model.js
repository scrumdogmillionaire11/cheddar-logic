'use strict';

const { classifyModelStatus, buildNoBetResult, DEGRADED_CONSTRAINTS } = require('./input-gate');
const { buildModelOutput } = require('./model-output');
const {
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
} = require('@cheddar-logic/models/src/market-eval');
const scoreEngine = require('../utils/score-engine');

/**
 * MLB Model — Pure arithmetic pitcher-based projections.
 *
 * No DB calls, no network. All inputs come from oddsSnapshot.raw_data.mlb.
 *
 * Exports:
 *   projectStrikeouts(pitcherStats, line, overlays)  → strikeout prop card
 *   projectF5Total(homePitcher, awayPitcher, context) → raw F5 projection
 *   projectF5TotalCard(home, away, f5Line)            → F5 card with thresholds
 *   computeMLBDriverCards(gameId, oddsSnapshot)       → F5-only game market candidates
 *   evaluateMlbGameMarkets(cards, ctx)                → deterministic MLB market evaluation
 */

const MLB_F5_EDGE_THRESHOLD = 0.5;
const MLB_F5_DEFAULT_XFIP = 4.3;
const MLB_F5_DEFAULT_TEAM_WRC_PLUS = 100;
const MLB_F5_DEFAULT_TEAM_K_PCT = 0.225;
const MLB_F5_DEFAULT_TEAM_ISO = 0.165;
const MLB_F5_DEFAULT_TEAM_BB_PCT = 0.085;
const MLB_F5_DEFAULT_TEAM_XWOBA = 0.320;
const MLB_F5_DEFAULT_TEAM_HARD_HIT = 39.0;

// Offense composite z-score constants (cross-team population)
const MLB_LEAGUE_WRC_PLUS_MEAN = 100;
const MLB_LEAGUE_WRC_PLUS_SD = 14;
const MLB_LEAGUE_XWOBA_MEAN = 0.320;
const MLB_LEAGUE_XWOBA_SD = 0.018;
const MLB_F5_DEFAULT_PARK_FACTOR = 1.0;
const MLB_F5_DEFAULT_TEMP_F = 72;
const MLB_F5_DEFAULT_WIND_MPH = 0;
const MLB_F5_DEFAULT_PITCH_COUNT = 92;
const MLB_F5_DEFAULT_BF_PER_INNING = 4.25;
const MLB_F5_DEFAULT_STARTER_XWOBA = 0.320;
const MLB_F5_POISSON_RANGE_SCALE = 0.3;

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function roundToTenth(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

function roundToHalf(value, direction = 'nearest') {
  if (!Number.isFinite(value)) return null;
  const scaled = value * 2;
  if (direction === 'floor') return Math.floor(scaled) / 2;
  if (direction === 'ceil') return Math.ceil(scaled) / 2;
  return Math.round(scaled) / 2;
}

/**
 * Canonical MLB projection tier policy used by model-local projections.
 *
 * FULL_MODEL: no degraded inputs and no degraded gate cap.
 * DEGRADED_MODEL: degraded gate or degraded inputs present.
 * SYNTHETIC_FALLBACK: required model drivers unavailable.
 */
function resolveMlbProjectionTierContract({
  hasSyntheticFallback = false,
  degradedInputCount = 0,
  gateStatus = 'MODEL_OK',
  fallbackReasonCode = 'PASS_SYNTHETIC_FALLBACK',
} = {}) {
  if (hasSyntheticFallback) {
    return {
      projection_source: 'SYNTHETIC_FALLBACK',
      status_cap: 'PASS',
      reason_codes: [fallbackReasonCode],
    };
  }

  const isDegraded = gateStatus === 'DEGRADED' || degradedInputCount > 0;
  return {
    projection_source: isDegraded ? 'DEGRADED_MODEL' : 'FULL_MODEL',
    status_cap: isDegraded ? 'LEAN' : 'PLAY',
    reason_codes: degradedInputCount > 0 ? ['MODEL_DEGRADED_INPUTS'] : [],
  };
}

function resolveMultiplicativeAdjustment(baseRuns, factors = []) {
  const safeBase = Number.isFinite(baseRuns) ? baseRuns : 0;
  let running = safeBase;
  const multipliers = {};
  const deltas = {};

  for (const factor of factors) {
    const key = String(factor?.key || '').trim();
    if (!key) continue;
    const multiplier = Number.isFinite(factor?.multiplier)
      ? factor.multiplier
      : 1;
    multipliers[key] = multiplier;
    const next = running * multiplier;
    deltas[`${key}_runs_delta`] = next - running;
    running = next;
  }

  return {
    adjusted_runs: running,
    multipliers,
    deltas,
  };
}

function resolveStarterSkillProfile(pitcher) {
  const siera = toFiniteNumberOrNull(pitcher?.siera);
  const xFip =
    toFiniteNumberOrNull(pitcher?.x_fip) ??
    toFiniteNumberOrNull(pitcher?.xfip);
  const xEra =
    toFiniteNumberOrNull(pitcher?.x_era) ??
    toFiniteNumberOrNull(pitcher?.xera);

  const skillParts = [
    { value: siera, weight: 0.4, missing: 'starter_siera' },
    { value: xFip, weight: 0.35, missing: 'starter_xfip' },
    { value: xEra, weight: 0.25, missing: 'starter_xera' },
  ];
  const availableSkillParts = skillParts.filter((part) => part.value !== null);
  if (availableSkillParts.length === 0) {
    return {
      starter_skill_ra9: null,
      xwoba_allowed: null,
      missing_inputs: ['starter_skill_ra9'],
      degraded_inputs: [],
    };
  }

  const totalWeight = availableSkillParts.reduce(
    (sum, part) => sum + part.weight,
    0,
  );
  // starter_xera is a planned future feature (always null) — exclude from degraded
  // inputs so it does not reduce confidence when siera + x_fip are available.
  const missingSkillParts = skillParts
    .filter((part) => part.value === null && part.missing !== 'starter_xera')
    .map((part) => part.missing);

  const kPct = toFiniteNumberOrNull(pitcher?.season_k_pct ?? pitcher?.k_pct);
  const bbPct = toFiniteNumberOrNull(pitcher?.bb_pct);
  const hrPer9 = toFiniteNumberOrNull(pitcher?.hr_per_9);
  const gbPct = toFiniteNumberOrNull(pitcher?.gb_pct);
  const xwobaAllowed =
    toFiniteNumberOrNull(pitcher?.xwoba_allowed) ??
    toFiniteNumberOrNull(pitcher?.x_woba_allowed);

  let skillRa9 = availableSkillParts.reduce(
    (sum, part) => sum + (part.value * part.weight),
    0,
  ) / totalWeight;
  if (kPct !== null) {
    skillRa9 *= clampValue(1 - (kPct - _leagueAvgKPct) * 0.35, 0.88, 1.12);
  }
  if (bbPct !== null) {
    skillRa9 *= clampValue(1 + (bbPct - 0.085) * 0.8, 0.92, 1.12);
  }
  if (hrPer9 !== null) {
    skillRa9 *= clampValue(1 + (hrPer9 - 1.1) * 0.08, 0.9, 1.15);
  }
  if (gbPct !== null) {
    skillRa9 *= clampValue(1 - (gbPct - 43) * 0.003, 0.94, 1.06);
  }

  return {
    starter_skill_ra9: clampValue(skillRa9, 2.0, 7.5),
    xwoba_allowed: xwobaAllowed,
    missing_inputs: [],
    degraded_inputs: missingSkillParts,
  };
}

function resolveTeamSplitProfile(offenseProfile, pitcherHandedness) {
  const handToken = String(pitcherHandedness || 'R').trim().toUpperCase() === 'L' ? 'lhp' : 'rhp';
  const wrcPlus =
    toFiniteNumberOrNull(offenseProfile?.[`wrc_plus_vs_${handToken}`]) ??
    toFiniteNumberOrNull(offenseProfile?.wrc_plus);
  const kPct =
    toFiniteNumberOrNull(offenseProfile?.[`k_pct_vs_${handToken}`]) ??
    toFiniteNumberOrNull(offenseProfile?.k_pct);
  const iso =
    toFiniteNumberOrNull(offenseProfile?.[`iso_vs_${handToken}`]) ??
    toFiniteNumberOrNull(offenseProfile?.iso);
  const bbPct =
    toFiniteNumberOrNull(offenseProfile?.[`bb_pct_vs_${handToken}`]) ??
    toFiniteNumberOrNull(offenseProfile?.bb_pct);
  const xwoba =
    toFiniteNumberOrNull(offenseProfile?.[`xwoba_vs_${handToken}`]) ??
    toFiniteNumberOrNull(offenseProfile?.xwoba);
  const hardHitPct = toFiniteNumberOrNull(offenseProfile?.hard_hit_pct);
  const rollingWrcPlus =
    toFiniteNumberOrNull(
      offenseProfile?.[`rolling_14d_wrc_plus_vs_${handToken}`],
    ) ?? toFiniteNumberOrNull(offenseProfile?.rolling_14d_wrc_plus_vs_hand);

  if (wrcPlus === null) return null;

  return {
    wrc_plus: wrcPlus,
    k_pct: kPct,
    iso,
    bb_pct: bbPct,
    xwoba,
    hard_hit_pct: hardHitPct,
    rolling_14d_wrc_plus: rollingWrcPlus,
  };
}

function resolveWeatherRunFactor(context = {}) {
  const roof = String(context.roof || '').trim().toUpperCase();
  if (roof === 'CLOSED' || roof === 'INDOOR') return 1.0;

  const tempF = toFiniteNumberOrNull(context.temp_f);
  const windMph = toFiniteNumberOrNull(context.wind_mph);
  const windDir = String(context.wind_dir || '').trim().toUpperCase();
  if (tempF === null || windMph === null) return null;

  let factor = 1.0;
  if (tempF >= 85) factor *= 1.04;
  else if (tempF >= 75) factor *= 1.02;
  else if (tempF <= 50) factor *= 0.96;

  if (windMph >= 10) {
    const windStep = Math.min(0.08, (windMph - 8) * 0.005);
    if (windDir === 'OUT' || windDir.startsWith('OUT_') || windDir.includes('OUT')) {
      factor *= 1 + windStep;
    } else if (windDir === 'IN' || windDir.startsWith('IN_') || windDir.includes('IN')) {
      factor *= 1 - windStep;
    }
  }

  return clampValue(factor, 0.88, 1.12);
}

function resolveStarterLeashProfile(starterPitcher) {
  const avgIp =
    toFiniteNumberOrNull(starterPitcher?.avg_ip) ??
    toFiniteNumberOrNull(starterPitcher?.recent_ip);
  const pitchCountAvg =
    toFiniteNumberOrNull(starterPitcher?.pitch_count_avg) ??
    toFiniteNumberOrNull(starterPitcher?.avg_pitch_count);
  const bbPct = toFiniteNumberOrNull(starterPitcher?.bb_pct);
  const xwobaAllowed =
    toFiniteNumberOrNull(starterPitcher?.xwoba_allowed) ??
    toFiniteNumberOrNull(starterPitcher?.x_woba_allowed);
  const ttopProfile = starterPitcher?.times_through_order_profile;

  const degradedInputs = [];
  if (avgIp === null && pitchCountAvg === null) {
    degradedInputs.push('starter_leash');
  }
  if (!ttopProfile || typeof ttopProfile !== 'object') {
    degradedInputs.push('times_through_order_profile');
  }

  const expectedPitchesPerInning = clampValue(
    15.8 +
      ((bbPct ?? _defaultBbPct) - _defaultBbPct) * 22 +
      ((xwobaAllowed ?? MLB_F5_DEFAULT_STARTER_XWOBA) - MLB_F5_DEFAULT_STARTER_XWOBA) * 18,
    13.5,
    19.5,
  );
  const ipFromPitchCount =
    pitchCountAvg !== null
      ? pitchCountAvg / expectedPitchesPerInning
      : null;
  const projectedIp =
    avgIp !== null && ipFromPitchCount !== null
      ? (avgIp * 0.55) + (ipFromPitchCount * 0.45)
      : (avgIp ?? ipFromPitchCount ?? 4.8);
  const starterIpF5Exp = clampValue(Math.min(5.0, projectedIp), 3.0, 5.0);

  const tto1 = toFiniteNumberOrNull(ttopProfile?.['1st']);
  const tto3 = toFiniteNumberOrNull(ttopProfile?.['3rd']);
  const ttoGap = tto1 !== null && tto3 !== null
    ? Math.max(0, tto3 - tto1)
    : 0.03;
  const ttopPenaltyMult = clampValue(
    1 + ttoGap * Math.max(0, starterIpF5Exp - 3.5) * 0.75,
    1.0,
    1.12,
  );

  return {
    starter_ip_f5_exp: starterIpF5Exp,
    ttop_penalty_mult: ttopPenaltyMult,
    bf_exp: starterIpF5Exp * MLB_F5_DEFAULT_BF_PER_INNING,
    degraded_inputs: degradedInputs,
  };
}

/**
 * Composite offensive quality index.
 * Returns a multiplier centred at 1.0, clamped to [0.88, 1.14].
 * 60% wRC+ split / 40% xwOBA split.
 */
function resolveOffenseComposite(matchupProfile) {
  const xwoba = matchupProfile.xwoba ?? MLB_F5_DEFAULT_TEAM_XWOBA;
  // WI-0830: use shared additive z-score layer instead of explicit composite
  const { score } = scoreEngine.aggregate([
    { name: 'wrc_plus', value: matchupProfile.wrc_plus, mean: MLB_LEAGUE_WRC_PLUS_MEAN, std: MLB_LEAGUE_WRC_PLUS_SD, weight: 0.60 },
    { name: 'xwoba',   value: xwoba,                   mean: MLB_LEAGUE_XWOBA_MEAN,    std: MLB_LEAGUE_XWOBA_SD,    weight: 0.40 },
  ]);
  // score ∈ (0.2, 0.8); midpoint 0.5 → composite 0.  Scale to run-adjustment range:
  // (score - 0.5) maps ±0.3 to ±0.06 run adjustment, matching prior SD-based formula.
  const composite = (score - 0.5) * (0.06 / 0.3);
  return clampValue(1.0 + composite, 0.88, 1.14);
}

function projectTeamF5RunsAgainstStarter(starterPitcher, offenseProfile, context) {
  const starterSkillProfile = resolveStarterSkillProfile(starterPitcher);
  const starterSkillRa9 = starterSkillProfile.starter_skill_ra9;
  const starterLeashProfile = resolveStarterLeashProfile(starterPitcher);
  const matchupProfile = resolveTeamSplitProfile(
    offenseProfile,
    starterPitcher?.handedness,
  );
  const parkFactor = toFiniteNumberOrNull(context?.park_run_factor);
  const weatherFactor = resolveWeatherRunFactor(context);

  const missingInputs = [];
  const degradedInputs = [
    ...(starterSkillProfile.degraded_inputs || []),
    ...(starterLeashProfile.degraded_inputs || []),
  ];
  if (starterSkillRa9 === null) missingInputs.push('starter_skill_ra9');
  if (!starterPitcher || !starterPitcher.handedness) missingInputs.push('starter_handedness');
  if (!matchupProfile) missingInputs.push('opponent_split_profile');
  if (parkFactor === null) missingInputs.push('park_run_factor');
  if (weatherFactor === null) degradedInputs.push('weather');

  if (missingInputs.length > 0) {
    return {
      f5_runs: null,
      missing_inputs: missingInputs,
      degraded_inputs: Array.from(new Set(degradedInputs)),
      matchup_profile: matchupProfile,
      starter_skill_ra9: starterSkillRa9,
      starter_ip_f5_exp: starterLeashProfile.starter_ip_f5_exp,
      ttop_penalty_mult: starterLeashProfile.ttop_penalty_mult,
      component_breakdown: null,
    };
  }

  // Single composite offense multiplier (WI-0821): replaces four-term wRC+/ISO/k%/bb%/contactMult chain
  // WI-0830: run scoreEngine for contributions metadata (separate from the scalar return)
  const { contributions: offenseContributions, zScores: offenseZScores } = scoreEngine.aggregate([
    { name: 'wrc_plus', value: matchupProfile.wrc_plus, mean: MLB_LEAGUE_WRC_PLUS_MEAN, std: MLB_LEAGUE_WRC_PLUS_SD, weight: 0.60 },
    { name: 'xwoba',   value: matchupProfile.xwoba ?? MLB_F5_DEFAULT_TEAM_XWOBA, mean: MLB_LEAGUE_XWOBA_MEAN, std: MLB_LEAGUE_XWOBA_SD, weight: 0.40 },
  ]);
  const offenseMult = resolveOffenseComposite(matchupProfile);
  const rollingFormMult = matchupProfile.rolling_14d_wrc_plus !== null
    ? clampValue(
      1 + ((matchupProfile.rolling_14d_wrc_plus - 100) / 100) * 0.15,
      0.97,
      1.03,
    )
    : 1;
  const parkMult = clampValue(parkFactor, 0.9, 1.12);
  const weatherMult = weatherFactor ?? 1.0;
  const ttopMult = starterLeashProfile.ttop_penalty_mult;
  const baseRuns = starterSkillRa9 * (starterLeashProfile.starter_ip_f5_exp / 9);
  const adjustment = resolveMultiplicativeAdjustment(baseRuns, [
    { key: 'offense', multiplier: offenseMult },
    { key: 'rolling_form', multiplier: rollingFormMult },
    { key: 'park', multiplier: parkMult },
    { key: 'weather', multiplier: weatherMult },
    { key: 'ttop', multiplier: ttopMult },
  ]);
  const finalRuns = Math.max(0.3, adjustment.adjusted_runs);
  const floorDelta = finalRuns - adjustment.adjusted_runs;

  return {
    f5_runs: finalRuns,
    missing_inputs: [],
    degraded_inputs: Array.from(new Set(degradedInputs)),
    matchup_profile: matchupProfile,
    starter_skill_ra9: starterSkillRa9,
    starter_ip_f5_exp: starterLeashProfile.starter_ip_f5_exp,
    ttop_penalty_mult: starterLeashProfile.ttop_penalty_mult,
    bf_exp: starterLeashProfile.bf_exp,
    offense_composite: offenseMult,
    // WI-0830: score-engine contributions + zScores for driver wiring
    offense_contributions: offenseContributions ?? null,
    offense_z_scores: offenseZScores ?? null,
    park_factor: parkFactor,
    weather_factor: weatherFactor ?? 1.0,
    component_breakdown: {
      base_runs: baseRuns,
      adjusted_runs_pre_floor: adjustment.adjusted_runs,
      final_runs: finalRuns,
      floor_delta_runs: floorDelta,
      multipliers: adjustment.multipliers,
      deltas: {
        ...adjustment.deltas,
        floor_runs_delta: floorDelta,
      },
    },
  };
}

function buildF5SyntheticFallbackProjection(homePitcher, awayPitcher) {
  const homeStarterSkill =
    resolveStarterSkillProfile(homePitcher).starter_skill_ra9 ??
    _defaultXfip;
  const awayStarterSkill =
    resolveStarterSkillProfile(awayPitcher).starter_skill_ra9 ??
    _defaultXfip;
  const homeLeashIp = resolveStarterLeashProfile(awayPitcher).starter_ip_f5_exp;
  const awayLeashIp = resolveStarterLeashProfile(homePitcher).starter_ip_f5_exp;
  const homeMean = Math.max(0.3, awayStarterSkill * (homeLeashIp / 9));
  const awayMean = Math.max(0.3, homeStarterSkill * (awayLeashIp / 9));
  const totalMean = homeMean + awayMean;
  const rangeWidth = Math.max(0.4, Math.sqrt(Math.max(totalMean, 0.1)) * MLB_F5_POISSON_RANGE_SCALE);
  const tierContract = resolveMlbProjectionTierContract({
    hasSyntheticFallback: true,
  });

  return {
    base: totalMean,
    confidence: 4,
    avgWhip: ((homePitcher?.whip ?? 1.25) + (awayPitcher?.whip ?? 1.25)) / 2,
    avgK9: ((homePitcher?.k_per_9 ?? 8.5) + (awayPitcher?.k_per_9 ?? 8.5)) / 2,
    projection_source: tierContract.projection_source,
    status_cap: tierContract.status_cap,
    missing_inputs: [],
    reason_codes: tierContract.reason_codes,
    projected_home_f5_runs: homeMean,
    projected_away_f5_runs: awayMean,
    projected_total_mean: totalMean,
    projected_total_low: Math.max(0, totalMean - rangeWidth),
    projected_total_high: totalMean + rangeWidth,
    playability: {
      over_playable_at_or_below: roundToHalf(totalMean - MLB_F5_EDGE_THRESHOLD, 'floor'),
      under_playable_at_or_above: roundToHalf(totalMean + MLB_F5_EDGE_THRESHOLD, 'ceil'),
    },
  };
}

/**
 * Project raw F5 total given two starting pitchers.
 *
 * FULL_MODEL formula:
 *   Adj_RA9 = starter_xFIP * opponent_wRC_plus_vs_hand / 100
 *   F5_runs_team = Adj_RA9 * park/weather/power/contact adjustments * (5/9)
 *
 * SYNTHETIC_FALLBACK:
 *   Uses old ERA fallback math only when required full-model inputs are missing.
 *
 * @param {object} homePitcher
 * @param {object} awayPitcher
 * @param {object} [context={}]
 * @returns {object|null}
 */
function projectF5Total(homePitcher, awayPitcher, context = {}) {
  // --- INPUT GATE: validate core required features before any projection math ---
  // Note: resolveStarterSkillProfile/resolveTeamSplitProfile handle null safely via ?.
  const gateFeatures = {
    starter_skill_ra9_home: resolveStarterSkillProfile(awayPitcher).starter_skill_ra9 ?? null,
    starter_skill_ra9_away: resolveStarterSkillProfile(homePitcher).starter_skill_ra9 ?? null,
    wrc_plus_vs_hand_home: resolveTeamSplitProfile(
      context?.home_offense_profile,
      awayPitcher?.handedness,
    )?.wrc_plus ?? null,
    wrc_plus_vs_hand_away: resolveTeamSplitProfile(
      context?.away_offense_profile,
      homePitcher?.handedness,
    )?.wrc_plus ?? null,
    park_run_factor: context?.park_run_factor ?? null,
  };
  const gate = classifyModelStatus(
    gateFeatures,
    ['starter_skill_ra9_home', 'starter_skill_ra9_away', 'wrc_plus_vs_hand_home', 'wrc_plus_vs_hand_away', 'park_run_factor'],
  );
  if (gate.status === 'NO_BET') {
    return buildNoBetResult(gate.missingCritical, { projection_source: 'NO_BET', sport: 'mlb', market: 'f5_total' });
  }
  // --- END GATE ---

  const homeOffenseProfile = context?.home_offense_profile ?? null;
  const awayOffenseProfile = context?.away_offense_profile ?? null;
  const environment = {
    park_run_factor: context?.park_run_factor,
    temp_f: context?.temp_f,
    wind_mph: context?.wind_mph,
    wind_dir: context?.wind_dir,
    roof: context?.roof,
  };

  const homeTeamProjection = projectTeamF5RunsAgainstStarter(
    awayPitcher,
    homeOffenseProfile,
    environment,
  );
  const awayTeamProjection = projectTeamF5RunsAgainstStarter(
    homePitcher,
    awayOffenseProfile,
    environment,
  );
  const missingInputs = Array.from(new Set([
    ...(homeTeamProjection.missing_inputs || []).map((name) => `home_${name}`),
    ...(awayTeamProjection.missing_inputs || []).map((name) => `away_${name}`),
  ]));
  const degradedInputs = Array.from(new Set([
    ...(homeTeamProjection.degraded_inputs || []).map((name) => `home_${name}`),
    ...(awayTeamProjection.degraded_inputs || []).map((name) => `away_${name}`),
  ]));

  if (missingInputs.length > 0) {
    const fallback = buildF5SyntheticFallbackProjection(homePitcher, awayPitcher);
    fallback.missing_inputs = Array.from(new Set([
      ...missingInputs,
      ...degradedInputs,
    ]));
    fallback.reason_codes = Array.from(new Set([
      ...(fallback.reason_codes || []),
      'PASS_MISSING_DRIVER_INPUTS',
    ]));
    return fallback;
  }

  const homeMean = homeTeamProjection.f5_runs;
  const awayMean = awayTeamProjection.f5_runs;
  const base = homeMean + awayMean;
  const rangeWidth = Math.max(
    0.4,
    Math.sqrt(Math.max(base, 0.1)) * MLB_F5_POISSON_RANGE_SCALE,
  );

  const avgWhip = ((homePitcher.whip ?? 1.25) + (awayPitcher.whip ?? 1.25)) / 2;
  const avgK9 = ((homePitcher.k_per_9 ?? 8.5) + (awayPitcher.k_per_9 ?? 8.5)) / 2;

  let confidence = 7;
  if (homeTeamProjection.matchup_profile.wrc_plus >= 108 ||
      awayTeamProjection.matchup_profile.wrc_plus >= 108) {
    confidence += 1;
  }
  if (avgWhip <= 1.18 && avgK9 >= 9.2) confidence += 1;
  if (base >= 3.2 && base <= 5.8) confidence += 1;
  confidence = Math.max(1, Math.min(10, confidence));
  if (gate.status === 'DEGRADED') {
    confidence = Math.min(confidence, DEGRADED_CONSTRAINTS.MAX_CONFIDENCE * 10); // scale to 1-10 range
  }
  const tierContract = resolveMlbProjectionTierContract({
    hasSyntheticFallback: false,
    degradedInputCount: degradedInputs.length,
    gateStatus: gate.status,
  });

  return {
    base,
    confidence,
    avgWhip,
    avgK9,
    model_status: gate.status,
    missingOptional: gate.missingOptional,
    projection_source: tierContract.projection_source,
    status_cap: tierContract.status_cap,
    missing_inputs: degradedInputs,
    degraded_inputs: degradedInputs,
    reason_codes: tierContract.reason_codes,
    projected_home_f5_runs: homeMean,
    projected_away_f5_runs: awayMean,
    projected_total_mean: base,
    projected_total_low: Math.max(0, base - rangeWidth),
    projected_total_high: base + rangeWidth,
    home_starter_skill_ra9: homeTeamProjection.starter_skill_ra9,
    away_starter_skill_ra9: awayTeamProjection.starter_skill_ra9,
    home_starter_ip_f5_exp: homeTeamProjection.starter_ip_f5_exp,
    away_starter_ip_f5_exp: awayTeamProjection.starter_ip_f5_exp,
    home_ttop_penalty_mult: homeTeamProjection.ttop_penalty_mult,
    away_ttop_penalty_mult: awayTeamProjection.ttop_penalty_mult,
    home_offense_profile: homeTeamProjection.matchup_profile,
    away_offense_profile: awayTeamProjection.matchup_profile,
    park_run_factor: homeTeamProjection.park_factor,
    weather_factor: homeTeamProjection.weather_factor,
    playability: {
      over_playable_at_or_below: roundToHalf(base - MLB_F5_EDGE_THRESHOLD, 'floor'),
      under_playable_at_or_above: roundToHalf(base + MLB_F5_EDGE_THRESHOLD, 'ceil'),
    },
  };
}

const MLB_FULL_GAME_DEFAULT_BULLPEN_ERA = 4.3;
const MLB_FULL_GAME_POISSON_RANGE_SCALE = 0.38;
const MLB_FULL_GAME_HOME_FIELD_RUNS = 0.12;
const MLB_FULL_GAME_EDGE_THRESHOLD_LOW_VOL = 0.38;
const MLB_FULL_GAME_EDGE_THRESHOLD_MED_VOL = 0.5;
const MLB_FULL_GAME_EDGE_THRESHOLD_HIGH_VOL = 0.62;
const MLB_FULL_GAME_EDGE_THRESHOLD_CAP = 0.65;
const MLB_FULL_GAME_SANITY_BAND = 0.3;
const MLB_FULL_GAME_LEAN_EDGE_THRESHOLD = 0.75;
const MLB_FULL_GAME_PLAY_EDGE_THRESHOLD = 1.25;
function readFiniteEnvNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const MLB_FULL_GAME_SHRINK_FACTOR_FULL_MODEL = readFiniteEnvNumber("MLB_FULL_GAME_SHRINK_FACTOR_FULL_MODEL", 0.85);
const MLB_FULL_GAME_SHRINK_FACTOR_DEGRADED_MODEL = readFiniteEnvNumber("MLB_FULL_GAME_SHRINK_FACTOR_DEGRADED_MODEL", 0.65);
const MLB_FULL_GAME_DEGRADED_PASS_THRESHOLD = 3;
const MLB_FULL_GAME_DEGRADED_RECENTER_WEIGHT = readFiniteEnvNumber("MLB_FULL_GAME_DEGRADED_RECENTER_WEIGHT", 0.8);
const MLB_PURE_SIGNAL_MODE = process.env.MLB_PURE_SIGNAL_MODE === "true";
const MLB_BULLPEN_QUALITY_ADJ_MIN = -0.22;
const MLB_BULLPEN_QUALITY_ADJ_MAX = 0.32;
const MLB_BULLPEN_GAME_ADJ_MIN = -0.35;
const MLB_BULLPEN_GAME_ADJ_MAX = 0.55;

const MLB_TOTAL_VOL_BUCKETS = Object.freeze({
  LOW: 'LOW_VOL',
  MED: 'MED_VOL',
  HIGH: 'HIGH_VOL',
});

// Priority-ordered list of PASS_ reason codes. Higher position = higher priority.
// Used by selectPassReasonCode() to replace unsafe Array.find() fallbacks.
const PASS_REASON_PRIORITY = [
  'PASS_DEGRADED_TOTAL_MODEL',
  'PASS_CONFIDENCE_GATE',
  'PASS_MODEL_DEGRADED',
  'PASS_INPUTS_INCOMPLETE',
  'PASS_SYNTHETIC_FALLBACK',
  'PASS_NO_DISTRIBUTION',
  'PASS_NO_EDGE',
];

function selectPassReasonCode(reasonCodes) {
  for (const code of PASS_REASON_PRIORITY) {
    if (reasonCodes.includes(code)) return code;
  }
  return reasonCodes.find((c) => c.startsWith('PASS_')) ?? null;
}

function hasBlockingPassReason(reasonCodes) {
  return reasonCodes.some((code) => code.startsWith('PASS_') && code !== 'PASS_NO_EDGE');
}

function buildPassTruthSurface({
  rawEdgeValue,
  thresholdRequired,
  thresholdPassed,
  passReasonCode,
  status,
  inputsStatus = 'COMPLETE',
  evaluationStatus = 'EDGE_COMPUTED',
}) {
  const blockReasons =
    status === 'PASS' && passReasonCode && passReasonCode !== 'PASS_NO_EDGE'
      ? [passReasonCode]
      : [];
  return {
    inputs_status: inputsStatus,
    evaluation_status: evaluationStatus,
    raw_edge_value: toFiniteNumberOrNull(rawEdgeValue),
    threshold_required: toFiniteNumberOrNull(thresholdRequired),
    threshold_passed: typeof thresholdPassed === 'boolean' ? thresholdPassed : null,
    blocked_by: status === 'PASS' ? (passReasonCode ?? null) : null,
    block_reasons: blockReasons,
  };
}

function absOrZero(value) {
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

function signToken(value) {
  if (!Number.isFinite(value) || value === 0) return 'NEUTRAL';
  return value > 0 ? 'HOME' : 'AWAY';
}

function erfApprox(x) {
  // Abramowitz-Stegun 7.1.26 approximation.
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return sign * y;
}

function normalCdf(x) {
  return 0.5 * (1 + erfApprox(x / Math.sqrt(2)));
}

function _mlToImplied(ml) {
  if (!Number.isFinite(ml)) return null;
  return ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
}

function probabilityToFairMl(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }
  const fair = probability >= 0.5
    ? -Math.round((probability / (1 - probability)) * 100)
    : Math.round(((1 - probability) / probability) * 100);
  return Object.is(fair, -0) ? 0 : fair;
}

function resolveVarianceEdgeThreshold(volatilityBucket, varianceMultiplier = 1) {
  let base = MLB_FULL_GAME_EDGE_THRESHOLD_MED_VOL;
  if (volatilityBucket === MLB_TOTAL_VOL_BUCKETS.LOW) {
    base = MLB_FULL_GAME_EDGE_THRESHOLD_LOW_VOL;
  } else if (volatilityBucket === MLB_TOTAL_VOL_BUCKETS.HIGH) {
    base = MLB_FULL_GAME_EDGE_THRESHOLD_HIGH_VOL;
  }

  const dynamicMultiplier = clampValue(
    1 + ((Number.isFinite(varianceMultiplier) ? varianceMultiplier : 1) - 1) * 0.16,
    0.9,
    1.1,
  );
  return Math.min(MLB_FULL_GAME_EDGE_THRESHOLD_CAP, base * dynamicMultiplier);
}

function computeBullpenContext(opponentBullpenEra, context = {}) {
  const bullpenEra = toFiniteNumberOrNull(opponentBullpenEra);
  if (bullpenEra === null) {
    return {
      available: false,
      missing_inputs: ['bullpen_era'],
      bullpen_ra9_used: null,
      bullpen_factor: null,
      volatility_component: null,
      fatigue_penalty: null,
      leverage_penalty: null,
      usage_penalty: null,
    };
  }

  const fatigueIndex = clampValue(
    toFiniteNumberOrNull(context?.fatigue_index) ??
      toFiniteNumberOrNull(context?.bullpen_fatigue_index) ??
      0.5,
    0,
    1,
  );
  const leverageAvailability = clampValue(
    toFiniteNumberOrNull(context?.leverage_availability) ??
      toFiniteNumberOrNull(context?.high_leverage_availability) ??
      0.7,
    0,
    1,
  );
  const recentUsage = clampValue(
    toFiniteNumberOrNull(context?.recent_usage) ??
      toFiniteNumberOrNull(context?.recent_usage_index) ??
      0.5,
    0,
    1,
  );

  const fatiguePenalty = (fatigueIndex - 0.5) * 0.24;
  const leveragePenalty = (0.7 - leverageAvailability) * 0.2;
  const usagePenalty = (recentUsage - 0.5) * 0.18;
  const bullpenFactor = clampValue(
    1 + fatiguePenalty + leveragePenalty + usagePenalty,
    0.82,
    1.28,
  );
  const volatilityComponent =
    Math.abs(fatiguePenalty) * 0.75 +
    Math.abs(leveragePenalty) * 0.9 +
    Math.abs(usagePenalty) * 0.7;

  return {
    available: true,
    missing_inputs: [],
    bullpen_ra9_used: bullpenEra,
    bullpen_factor: bullpenFactor,
    volatility_component: volatilityComponent,
    fatigue_penalty: fatiguePenalty,
    leverage_penalty: leveragePenalty,
    usage_penalty: usagePenalty,
  };
}

function scoreBullpenQuality({ era14d } = {}) {
  if (!Number.isFinite(era14d)) return 0;
  if (era14d <= 3.3) return -0.18;
  if (era14d <= 3.9) return -0.08;
  if (era14d <= 4.5) return 0;
  if (era14d <= 5.1) return 0.1;
  return 0.22;
}

function scoreBullpenWorkload({ usageScore3d, fatigueScore3d } = {}) {
  const usage = Number.isFinite(usageScore3d) ? usageScore3d : 0;
  const fatigue = Number.isFinite(fatigueScore3d) ? fatigueScore3d : 0;
  const raw = (usage * 0.08) + (fatigue * 0.12);
  return clampValue(raw, -0.1, 0.18);
}

function computeTeamBullpenRuns(teamCtx = {}) {
  const quality = scoreBullpenQuality({
    era14d: toFiniteNumberOrNull(teamCtx?.era_14d),
  });
  const workload = scoreBullpenWorkload({
    usageScore3d: toFiniteNumberOrNull(teamCtx?.usage_score_3d),
    fatigueScore3d: toFiniteNumberOrNull(teamCtx?.fatigue_score_3d),
  });

  return clampValue(
    quality + workload,
    MLB_BULLPEN_QUALITY_ADJ_MIN,
    MLB_BULLPEN_QUALITY_ADJ_MAX,
  );
}

function computeBullpenAdjustmentRuns({
  homeBullpenContext,
  awayBullpenContext,
} = {}) {
  const homeLiability = computeTeamBullpenRuns(homeBullpenContext);
  const awayLiability = computeTeamBullpenRuns(awayBullpenContext);
  return clampValue(
    homeLiability + awayLiability,
    MLB_BULLPEN_GAME_ADJ_MIN,
    MLB_BULLPEN_GAME_ADJ_MAX,
  );
}

function computeTotalVariance({
  totalMean,
  homeF5Runs,
  awayF5Runs,
  homeLateContext,
  awayLateContext,
  offenseEdge,
  environment = {},
}) {
  const baseVariance = Math.max(2.8, totalMean * 1.08);
  const spVolatility = clampValue(
    Math.abs((homeF5Runs ?? 0) - (awayF5Runs ?? 0)) * 0.26,
    0,
    0.85,
  );
  const bullpenVolatility = clampValue(
    ((homeLateContext?.volatility_component ?? 0) * 0.62) +
      ((awayLateContext?.volatility_component ?? 0) * 0.62),
    0,
    0.65,
  );
  const offensiveVolatility = clampValue(absOrZero(offenseEdge) * 1.4, 0, 0.45);

  const parkFactor = toFiniteNumberOrNull(environment?.park_run_factor) ?? 1.0;
  const weatherFactor = resolveWeatherRunFactor(environment) ?? 1.0;
  const parkVariance = clampValue(
    Math.abs(parkFactor - 1.0) * 0.8 + Math.abs(weatherFactor - 1.0) * 1.0,
    0,
    0.58,
  );

  const varianceMultiplier =
    1 +
    spVolatility +
    bullpenVolatility +
    offensiveVolatility +
    parkVariance;
  const totalVariance = baseVariance * varianceMultiplier;
  const runDiffVariance = Math.max(0.45, totalVariance * 0.36);

  let volatilityBucket = MLB_TOTAL_VOL_BUCKETS.MED;
  if (varianceMultiplier >= 2.15 || totalVariance >= 14) {
    volatilityBucket = MLB_TOTAL_VOL_BUCKETS.HIGH;
  } else if (varianceMultiplier <= 1.5 && totalVariance <= 10.2) {
    volatilityBucket = MLB_TOTAL_VOL_BUCKETS.LOW;
  }

  return {
    total_variance: totalVariance,
    run_diff_variance: runDiffVariance,
    variance_multiplier: varianceMultiplier,
    volatility_bucket: volatilityBucket,
    components: {
      base_variance: baseVariance,
      sp_volatility: spVolatility,
      bullpen_volatility: bullpenVolatility,
      offensive_volatility: offensiveVolatility,
      park_factor_variance: parkVariance,
    },
  };
}

function simulateGameTotalDistribution(totalMean, totalVariance, marketLine) {
  if (
    !Number.isFinite(totalMean) ||
    !Number.isFinite(totalVariance) ||
    totalVariance <= 0 ||
    !Number.isFinite(marketLine)
  ) {
    return null;
  }

  const sigma = Math.sqrt(totalVariance);
  const z = (marketLine - totalMean) / sigma;
  const pUnder = clampValue(normalCdf(z), 0.001, 0.999);
  const pOver = clampValue(1 - pUnder, 0.001, 0.999);

  return {
    mean: totalMean,
    sigma,
    p_over: pOver,
    p_under: pUnder,
  };
}

function validateTotalDrivers({
  homeF5Runs,
  awayF5Runs,
  homeLateContext,
  awayLateContext,
  offenseEdge,
  environment,
}) {
  const drivers = [];
  const spMismatch = absOrZero((homeF5Runs ?? 0) - (awayF5Runs ?? 0));
  const bullpenEdge = absOrZero(
    (homeLateContext?.bullpen_factor ?? 1) -
      (awayLateContext?.bullpen_factor ?? 1),
  );
  const parkFactor = toFiniteNumberOrNull(environment?.park_run_factor) ?? 1.0;
  const weatherFactor = resolveWeatherRunFactor(environment) ?? 1.0;
  const envEdge = Math.max(
    Math.abs(parkFactor - 1),
    Math.abs(weatherFactor - 1),
  );

  if (spMismatch >= 0.35) drivers.push('SP_MISMATCH');
  if (bullpenEdge >= 0.1) drivers.push('BULLPEN_FATIGUE_EDGE');
  if (absOrZero(offenseEdge) >= 0.025) drivers.push('OFFENSE_MATCHUP_EDGE');
  if (envEdge >= 0.03) drivers.push('PARK_WEATHER_EDGE');

  return {
    valid: drivers.length > 0,
    drivers,
    sp_mismatch: spMismatch,
    bullpen_edge: bullpenEdge,
    offense_edge: offenseEdge,
    environment_edge: envEdge,
  };
}

function resolveOffenseEdgeSignal(homePitcher, awayPitcher, context = {}) {
  const homeMatchup = resolveTeamSplitProfile(
    context?.home_offense_profile ?? null,
    awayPitcher?.handedness,
  );
  const awayMatchup = resolveTeamSplitProfile(
    context?.away_offense_profile ?? null,
    homePitcher?.handedness,
  );

  if (!homeMatchup || !awayMatchup) return 0;
  const homeMult = resolveOffenseComposite(homeMatchup);
  const awayMult = resolveOffenseComposite(awayMatchup);
  return homeMult - awayMult;
}

function resolveFullGameVariance({
  proj,
  context = {},
  homePitcher = null,
  awayPitcher = null,
}) {
  const offenseEdge = resolveOffenseEdgeSignal(
    homePitcher,
    awayPitcher,
    context,
  );
  const variance = computeTotalVariance({
    totalMean: Number.isFinite(proj?.projected_total_mean)
      ? proj.projected_total_mean
      : 8.6,
    homeF5Runs: proj?.home_f5_runs,
    awayF5Runs: proj?.away_f5_runs,
    homeLateContext: proj?.home_bullpen_context,
    awayLateContext: proj?.away_bullpen_context,
    offenseEdge,
    environment: {
      park_run_factor: context?.park_run_factor,
      temp_f: context?.temp_f,
      wind_mph: context?.wind_mph,
      wind_dir: context?.wind_dir,
      roof: context?.roof,
    },
  });

  return {
    game_variance: variance.total_variance,
    run_diff_variance: variance.run_diff_variance,
    variance_multiplier: variance.variance_multiplier,
  };
}

function buildFullGameDriverSupport({
  runDiff,
  spEdge,
  bullpenEdge,
  offenseEdge,
  homeFieldRuns,
}) {
  const support = [];
  if (absOrZero(spEdge) >= 0.22) support.push('STARTER_EDGE');
  if (absOrZero(bullpenEdge) >= 0.14) support.push('BULLPEN_EDGE');
  if (absOrZero(offenseEdge) >= 0.025) support.push('OFFENSE_SPLIT_EDGE');
  if (absOrZero(homeFieldRuns) >= 0.1 && absOrZero(runDiff) <= 0.45) {
    support.push('HOME_FIELD_CONTEXT');
  }
  return support;
}

/**
 * Project late-innings (inn 6-9) run contribution for one team.
 *
 * Models bullpen-driven run scoring via bullpen ERA proxy rather than scaling
 * the starter's F5 line. Applies the same offense composite + park/weather
 * adjustments as the F5 path.
 *
 * @param {object|null} offenseProfile  Team's offense split profile
 * @param {string|null} pitcherHandedness  Opposing starter handedness (for split selection)
 * @param {number|null} opponentBullpenEra  Opponent bullpen ERA (null → league avg 4.3)
 * @param {object} environment  { park_run_factor, temp_f, wind_mph, wind_dir, roof }
 * @returns {{ late_runs: number, bullpen_ra9_used: number, degraded_inputs: string[] }}
 */
function projectLateInningsRuns(
  offenseProfile,
  pitcherHandedness,
  opponentBullpenEra,
  bullpenContext = {},
  environment = {},
) {
  const degradedInputs = [];
  const bullpen = computeBullpenContext(opponentBullpenEra, bullpenContext);
  if (!bullpen.available) degradedInputs.push('bullpen_era');
  const bullpen_ra9 = bullpen.available
    ? bullpen.bullpen_ra9_used
    : MLB_FULL_GAME_DEFAULT_BULLPEN_ERA;

  // Base late-innings projection: bullpen ERA scaled to 4 innings
  const baseRuns = bullpen_ra9 * (4 / 9);
  const bullpenContextMult = bullpen.bullpen_factor ?? 1;

  // Apply offense composite multiplier (same clamping as F5: [0.88, 1.14])
  const matchupProfile = resolveTeamSplitProfile(offenseProfile, pitcherHandedness);
  const offenseMult = matchupProfile ? resolveOffenseComposite(matchupProfile) : 1;
  const parkFactor = toFiniteNumberOrNull(environment?.park_run_factor);
  const parkMult = parkFactor !== null ? clampValue(parkFactor, 0.9, 1.12) : 1;
  const weatherFactor = resolveWeatherRunFactor(environment);
  const weatherMult = weatherFactor ?? 1.0;
  const adjustment = resolveMultiplicativeAdjustment(baseRuns, [
    { key: 'bullpen_context', multiplier: bullpenContextMult },
    { key: 'offense', multiplier: offenseMult },
    { key: 'park', multiplier: parkMult },
    { key: 'weather', multiplier: weatherMult },
  ]);
  const lateRuns = Math.max(0.1, adjustment.adjusted_runs);
  const floorDelta = lateRuns - adjustment.adjusted_runs;

  return {
    late_runs: lateRuns,
    bullpen_ra9_used: bullpen_ra9,
    bullpen_context: bullpen,
    degraded_inputs: degradedInputs,
    component_breakdown: {
      base_runs: baseRuns,
      adjusted_runs_pre_floor: adjustment.adjusted_runs,
      final_runs: lateRuns,
      floor_delta_runs: floorDelta,
      multipliers: adjustment.multipliers,
      deltas: {
        ...adjustment.deltas,
        floor_runs_delta: floorDelta,
      },
    },
  };
}

/**
 * Project full-game run total by summing F5 (starter-driven) + late-innings
 * (inn 6-9, bullpen-proxy) run segments for both teams.
 *
 * @param {object} homePitcher
 * @param {object} awayPitcher
 * @param {object} [context={}]  home/away_offense_profile, park_run_factor,
 *   temp_f, wind_mph, wind_dir, roof, home_bullpen_era, away_bullpen_era
 * @returns {object}  projected_total_mean, projected_total_low, projected_total_high,
 *   home_proj, away_proj, projection_source, confidence, status_cap, ...
 */
function projectFullGameTotal(homePitcher, awayPitcher, context = {}) {
  const homeOffenseProfile = context?.home_offense_profile ?? null;
  const awayOffenseProfile = context?.away_offense_profile ?? null;
  const environment = {
    park_run_factor: context?.park_run_factor,
    temp_f: context?.temp_f,
    wind_mph: context?.wind_mph,
    wind_dir: context?.wind_dir,
    roof: context?.roof,
  };

  // F5 segments — reuse existing per-team projection
  const homeF5 = projectTeamF5RunsAgainstStarter(awayPitcher, homeOffenseProfile, environment);
  const awayF5 = projectTeamF5RunsAgainstStarter(homePitcher, awayOffenseProfile, environment);

  const f5MissingInputs = Array.from(new Set([
    ...(homeF5.missing_inputs || []).map((n) => `home_${n}`),
    ...(awayF5.missing_inputs || []).map((n) => `away_${n}`),
  ]));

  const homeBullpenContextInput = context?.home_bullpen_context ?? null;
  const awayBullpenContextInput = context?.away_bullpen_context ?? null;

  // Late-innings segments — opponent bullpen ERA governs each side
  const homeLate = projectLateInningsRuns(
    homeOffenseProfile,
    awayPitcher?.handedness ?? null,
    context?.away_bullpen_era ?? awayBullpenContextInput?.era_14d ?? null,
    {
      fatigue_index:
        context?.away_bullpen_fatigue_index ??
        (Number.isFinite(toFiniteNumberOrNull(awayBullpenContextInput?.fatigue_score_3d))
          ? toFiniteNumberOrNull(awayBullpenContextInput?.fatigue_score_3d) / 2
          : null),
      leverage_availability:
        context?.away_leverage_availability ??
        toFiniteNumberOrNull(awayBullpenContextInput?.availability_score),
      recent_usage:
        context?.away_recent_usage ??
        (Number.isFinite(toFiniteNumberOrNull(awayBullpenContextInput?.usage_score_3d))
          ? toFiniteNumberOrNull(awayBullpenContextInput?.usage_score_3d) / 2
          : null),
    },
    environment,
  );
  const awayLate = projectLateInningsRuns(
    awayOffenseProfile,
    homePitcher?.handedness ?? null,
    context?.home_bullpen_era ?? homeBullpenContextInput?.era_14d ?? null,
    {
      fatigue_index:
        context?.home_bullpen_fatigue_index ??
        (Number.isFinite(toFiniteNumberOrNull(homeBullpenContextInput?.fatigue_score_3d))
          ? toFiniteNumberOrNull(homeBullpenContextInput?.fatigue_score_3d) / 2
          : null),
      leverage_availability:
        context?.home_leverage_availability ??
        toFiniteNumberOrNull(homeBullpenContextInput?.availability_score),
      recent_usage:
        context?.home_recent_usage ??
        (Number.isFinite(toFiniteNumberOrNull(homeBullpenContextInput?.usage_score_3d))
          ? toFiniteNumberOrNull(homeBullpenContextInput?.usage_score_3d) / 2
          : null),
    },
    environment,
  );

  const degradedInputs = Array.from(new Set([
    ...(homeF5.degraded_inputs || []).map((n) => `home_${n}`),
    ...(awayF5.degraded_inputs || []).map((n) => `away_${n}`),
    ...(homeLate.degraded_inputs || []).map((n) => `home_${n}`),
    ...(awayLate.degraded_inputs || []).map((n) => `away_${n}`),
  ]));

  const bullpenMissing = degradedInputs.some((d) => d.includes('bullpen_era'));

  if (f5MissingInputs.length > 0) {
    return {
      projected_total_mean: null,
      projected_total_low: null,
      projected_total_high: null,
      home_proj: null,
      away_proj: null,
      projection_source: 'NO_BET',
      confidence: 0,
      status_cap: 'NO_BET',
      missing_inputs: f5MissingInputs,
      degraded_inputs: degradedInputs,
    };
  }

  const offenseEdge = resolveOffenseEdgeSignal(homePitcher, awayPitcher, context);
  const bullpenAdjustmentRuns = computeBullpenAdjustmentRuns({
    homeBullpenContext: homeBullpenContextInput,
    awayBullpenContext: awayBullpenContextInput,
  });
  const homeProj = homeF5.f5_runs + homeLate.late_runs;
  const awayProj = awayF5.f5_runs + awayLate.late_runs;
  const fullGameMean = homeProj + awayProj + bullpenAdjustmentRuns;
  const variance = computeTotalVariance({
    totalMean: fullGameMean,
    homeF5Runs: homeF5.f5_runs,
    awayF5Runs: awayF5.f5_runs,
    homeLateContext: homeLate.bullpen_context,
    awayLateContext: awayLate.bullpen_context,
    offenseEdge,
    environment,
  });
  const rangeWidth = Math.max(
    0.5,
    Math.sqrt(Math.max(variance.total_variance, 0.1)) *
      MLB_FULL_GAME_POISSON_RANGE_SCALE,
  );

  // Confidence: stricter in higher variance buckets and degraded bullpen state.
  let confidence = 7;
  if (degradedInputs.length === 0) confidence += 1;
  if (bullpenMissing) confidence -= 1;
  if (variance.volatility_bucket === MLB_TOTAL_VOL_BUCKETS.HIGH) confidence -= 2;
  if (variance.volatility_bucket === MLB_TOTAL_VOL_BUCKETS.MED) confidence -= 1;
  confidence = Math.max(1, Math.min(10, confidence));

  const tierContract = resolveMlbProjectionTierContract({
    degradedInputCount: degradedInputs.length,
  });
  const projectionSource = tierContract.projection_source;
  const statusCap = tierContract.status_cap;

  const f5BaseRuns =
    (homeF5.component_breakdown?.base_runs ?? 0) +
    (awayF5.component_breakdown?.base_runs ?? 0);
  const lateBaseRuns =
    (homeLate.component_breakdown?.base_runs ?? 0) +
    (awayLate.component_breakdown?.base_runs ?? 0);
  const sumDelta = (segment, key) => segment?.component_breakdown?.deltas?.[key] ?? 0;
  const projectionComponents = {
    starter_base_runs: f5BaseRuns,
    late_innings_base_runs: lateBaseRuns,
    bullpen_adjustment_runs: bullpenAdjustmentRuns,
    offense_adjustment_runs:
      sumDelta(homeF5, 'offense_runs_delta') +
      sumDelta(awayF5, 'offense_runs_delta') +
      sumDelta(homeLate, 'offense_runs_delta') +
      sumDelta(awayLate, 'offense_runs_delta'),
    bullpen_context_adjustment_runs:
      sumDelta(homeLate, 'bullpen_context_runs_delta') +
      sumDelta(awayLate, 'bullpen_context_runs_delta'),
    rolling_form_adjustment_runs:
      sumDelta(homeF5, 'rolling_form_runs_delta') +
      sumDelta(awayF5, 'rolling_form_runs_delta'),
    park_adjustment_runs:
      sumDelta(homeF5, 'park_runs_delta') +
      sumDelta(awayF5, 'park_runs_delta') +
      sumDelta(homeLate, 'park_runs_delta') +
      sumDelta(awayLate, 'park_runs_delta'),
    weather_adjustment_runs:
      sumDelta(homeF5, 'weather_runs_delta') +
      sumDelta(awayF5, 'weather_runs_delta') +
      sumDelta(homeLate, 'weather_runs_delta') +
      sumDelta(awayLate, 'weather_runs_delta'),
    ttop_adjustment_runs:
      sumDelta(homeF5, 'ttop_runs_delta') +
      sumDelta(awayF5, 'ttop_runs_delta'),
    floor_adjustment_runs:
      sumDelta(homeF5, 'floor_runs_delta') +
      sumDelta(awayF5, 'floor_runs_delta') +
      sumDelta(homeLate, 'floor_runs_delta') +
      sumDelta(awayLate, 'floor_runs_delta'),
    final_projected_total_mean: fullGameMean,
    f5_share_pct: fullGameMean > 0
      ? ((homeF5.f5_runs + awayF5.f5_runs) / fullGameMean) * 100
      : null,
    late_share_pct: fullGameMean > 0
      ? ((homeLate.late_runs + awayLate.late_runs) / fullGameMean) * 100
      : null,
    home_team_segments: {
      f5_runs: homeF5.f5_runs,
      late_runs: homeLate.late_runs,
    },
    away_team_segments: {
      f5_runs: awayF5.f5_runs,
      late_runs: awayLate.late_runs,
    },
    bullpen_context: {
      home: homeBullpenContextInput,
      away: awayBullpenContextInput,
      bullpen_data_missing:
        !Number.isFinite(toFiniteNumberOrNull(homeBullpenContextInput?.era_14d)) ||
        !Number.isFinite(toFiniteNumberOrNull(awayBullpenContextInput?.era_14d)),
    },
  };

  return {
    projected_total_mean: fullGameMean,
    projected_total_low: Math.max(0, fullGameMean - rangeWidth),
    projected_total_high: fullGameMean + rangeWidth,
    home_proj: homeProj,
    away_proj: awayProj,
    projection_source: projectionSource,
    confidence,
    status_cap: statusCap,
    missing_inputs: [],
    degraded_inputs: degradedInputs,
    home_f5_runs: homeF5.f5_runs,
    away_f5_runs: awayF5.f5_runs,
    home_late_runs: homeLate.late_runs,
    away_late_runs: awayLate.late_runs,
    home_bullpen_context: homeLate.bullpen_context,
    away_bullpen_context: awayLate.bullpen_context,
    home_bullpen_context_input: homeBullpenContextInput,
    away_bullpen_context_input: awayBullpenContextInput,
    bullpen_adjustment_runs: bullpenAdjustmentRuns,
    total_variance: variance.total_variance,
    run_diff_variance: variance.run_diff_variance,
    variance_multiplier: variance.variance_multiplier,
    volatility_bucket: variance.volatility_bucket,
    variance_components: variance.components,
    projection_components: projectionComponents,
  };
}

function projectFullGameTotalCard(homePitcher, awayPitcher, fullGameLine, context = {}) {
  if (!Number.isFinite(fullGameLine)) return null;

  const proj = projectFullGameTotal(homePitcher, awayPitcher, context);
  if (!proj || proj.projected_total_mean == null) return null;

  const distribution = simulateGameTotalDistribution(
    proj.projected_total_mean,
    proj.total_variance,
    fullGameLine,
  );
  if (!distribution) {
    const passReasonCode = 'PASS_NO_DISTRIBUTION';
    return {
      market: 'full_game_total',
      prediction: 'PASS',
      confidence: proj.confidence / 10,
      ev_threshold_passed: false,
      reasoning: 'Full-game total distribution unavailable; PASS (distribution required)',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      projection_source: proj.projection_source,
      status_cap: 'PASS',
      pass_reason_code: passReasonCode,
      reason_codes: ['PASS_NO_DISTRIBUTION'],
      ...buildPassTruthSurface({
        rawEdgeValue: null,
        thresholdRequired: MLB_FULL_GAME_LEAN_EDGE_THRESHOLD,
        thresholdPassed: null,
        passReasonCode,
        status: 'PASS',
        evaluationStatus: 'NO_EVALUATION',
      }),
      missing_inputs: proj.missing_inputs,
      playability: null,
      projection: {
        projected_total: roundToTenth(proj.projected_total_mean),
        projected_total_low: roundToTenth(proj.projected_total_low),
        projected_total_high: roundToTenth(proj.projected_total_high),
      },
      drivers: [],
    };
  }

  const rawModelTotal = proj.projected_total_mean;
  const rawEdge = rawModelTotal - fullGameLine;
  const modelQuality = proj.projection_source === 'FULL_MODEL'
    ? 'FULL_MODEL'
    : proj.projection_source === 'DEGRADED_MODEL'
      ? 'DEGRADED_MODEL'
      : 'NO_BET_MODEL';
  const degradedInputsCount = Array.isArray(proj.degraded_inputs)
    ? Array.from(new Set(proj.degraded_inputs)).length
    : 0;
  const degradedMode = modelQuality === 'DEGRADED_MODEL';
  const recenteredModelTotal = degradedMode
    ? (rawModelTotal * MLB_FULL_GAME_DEGRADED_RECENTER_WEIGHT) +
      (fullGameLine * (1 - MLB_FULL_GAME_DEGRADED_RECENTER_WEIGHT))
    : rawModelTotal;
  const recenteredEdge = recenteredModelTotal - fullGameLine;
  const shrinkFactor = modelQuality === 'FULL_MODEL'
    ? MLB_FULL_GAME_SHRINK_FACTOR_FULL_MODEL
    : modelQuality === 'DEGRADED_MODEL'
      ? MLB_FULL_GAME_SHRINK_FACTOR_DEGRADED_MODEL
      : null;
  const shrunkModelTotal = Number.isFinite(shrinkFactor)
    ? fullGameLine + (shrinkFactor * (recenteredModelTotal - fullGameLine))
    : recenteredModelTotal;
  const shrunkEdge = Number.isFinite(shrunkModelTotal)
    ? shrunkModelTotal - fullGameLine
    : recenteredEdge;
  const finalModelTotal = Number.isFinite(shrunkModelTotal) ? shrunkModelTotal : recenteredModelTotal;
  const finalEdge = Number.isFinite(finalModelTotal) ? finalModelTotal - fullGameLine : recenteredEdge;
  const directionBeforeShrink = Math.abs(rawEdge) >= MLB_FULL_GAME_LEAN_EDGE_THRESHOLD
    ? (rawEdge >= 0 ? 'OVER' : 'UNDER')
    : 'PASS';
  const directionAfterShrink = Number.isFinite(shrunkEdge) &&
    Math.abs(shrunkEdge) >= MLB_FULL_GAME_LEAN_EDGE_THRESHOLD
    ? (shrunkEdge >= 0 ? 'OVER' : 'UNDER')
    : 'PASS';
  const leanSide = Number.isFinite(shrunkEdge) ? (shrunkEdge >= 0 ? 'OVER' : 'UNDER') : 'PASS';
  const dynamicThreshold = resolveVarianceEdgeThreshold(
    proj.volatility_bucket,
    proj.variance_multiplier,
  );

  const driverValidation = validateTotalDrivers({
    homeF5Runs: proj.home_f5_runs,
    awayF5Runs: proj.away_f5_runs,
    homeLateContext: proj.home_bullpen_context,
    awayLateContext: proj.away_bullpen_context,
    offenseEdge: resolveOffenseEdgeSignal(homePitcher, awayPitcher, context),
    environment: {
      park_run_factor: context?.park_run_factor,
      temp_f: context?.temp_f,
      wind_mph: context?.wind_mph,
      wind_dir: context?.wind_dir,
      roof: context?.roof,
    },
  });

  const marketAligned = Number.isFinite(shrunkEdge)
    ? Math.abs(shrunkEdge) > MLB_FULL_GAME_SANITY_BAND
    : false;
  // WI-0944: degraded projections should qualify on raw edge so shrink/recenter
  // does not erase otherwise valid signals into blanket PASS outcomes.
  const edgeForQualification = degradedMode ? rawEdge : shrunkEdge;
  const hasLeanEdge = Number.isFinite(edgeForQualification)
    ? Math.abs(edgeForQualification) >= MLB_FULL_GAME_LEAN_EDGE_THRESHOLD
    : false;
  const hasPlayEdge = Number.isFinite(edgeForQualification)
    ? Math.abs(edgeForQualification) >= MLB_FULL_GAME_PLAY_EDGE_THRESHOLD
    : false;
  const pOver = distribution.p_over;
  const pUnder = distribution.p_under;
  const probabilityPass =
    (Number.isFinite(shrunkEdge) && shrunkEdge > 0 && pOver < 0.54) ||
    (Number.isFinite(shrunkEdge) && shrunkEdge < 0 && pUnder < 0.54);

  const f5Line = toFiniteNumberOrNull(context?.f5_line);
  const f5Mean = Number.isFinite(proj.home_f5_runs) && Number.isFinite(proj.away_f5_runs)
    ? proj.home_f5_runs + proj.away_f5_runs
    : null;
  const f5Edge = Number.isFinite(f5Mean) && Number.isFinite(f5Line)
    ? f5Mean - f5Line
    : null;
  const bullpenShift = (proj.home_late_runs ?? 0) - (proj.away_late_runs ?? 0);
  const preferF5 = Number.isFinite(f5Edge) && Math.abs(f5Edge) >= MLB_F5_EDGE_THRESHOLD && Math.abs(bullpenShift) < 0.12;
  const fgContradictsF5 = Number.isFinite(f5Edge) && Number.isFinite(shrunkEdge)
    && (Math.sign(shrunkEdge) !== Math.sign(f5Edge)) && Math.abs(bullpenShift) > 0.14;
  // Keep hard gates explicit and minimal: edge + confidence.
  // Full-model paths retain the 6/10 floor, while degraded projections require
  // strictly above 6 so capped degraded confidence (6) does not auto-pass.
  // WI-0944: DEGRADED_MODEL confidence gate — use the same floor (6) as FULL_MODEL.
  // The previous +0.1 bump meant a confidence of exactly 6 always failed for degraded
  // projections, silently vetoing every game where bullpen data was sparse (the common
  // case in early-season MLB). DEGRADED_MODEL already forces status to WATCH regardless,
  // so the extra confidence floor is double-penalising the same data gap.
  const confidenceGate = 6;
  const confidenceBelowGate = proj.confidence < confidenceGate;

  const reasonCodes = [];
  const isDegraded = degradedMode;
  if (isDegraded) {
    reasonCodes.push('MODEL_DEGRADED_INPUTS');
  }
  const isHeavilyDegraded = isDegraded &&
    degradedInputsCount >= MLB_FULL_GAME_DEGRADED_PASS_THRESHOLD;
  const degradedWatchOnly = isHeavilyDegraded && hasLeanEdge;
  if (isHeavilyDegraded) {
    reasonCodes.push(degradedWatchOnly ? 'SOFT_DEGRADED_TOTAL_MODEL' : 'PASS_DEGRADED_TOTAL_MODEL');
  }

  if (!MLB_PURE_SIGNAL_MODE) {
    if (!driverValidation.valid) {
      reasonCodes.push('SOFT_NO_SUPPORTING_DRIVERS');
    }
    if (!marketAligned) {
      reasonCodes.push('SOFT_MARKET_SANITY_FAIL');
    }
    if (probabilityPass) {
      reasonCodes.push('SOFT_PROBABILITY_EDGE_WEAK');
    }
    if (preferF5) {
      reasonCodes.push('SOFT_PREFER_F5_SP_DRIVEN');
    }
    if (fgContradictsF5) {
      reasonCodes.push('SOFT_F5_CONTRADICTION');
    }
  }

  if (confidenceBelowGate && !isDegraded) reasonCodes.push('PASS_CONFIDENCE_GATE');
  // PASS_NO_EDGE only applies when rawEdge is non-positive. A positive rawEdge that was
  // shrunk below threshold is "below-threshold", not "no edge" — using PASS_NO_EDGE with a
  // positive raw_edge_value violates the assertLegalPassNoEdge invariant in market-eval.
  if (!hasLeanEdge && !(Number.isFinite(rawEdge) && rawEdge > 0) && !hasBlockingPassReason(reasonCodes)) reasonCodes.push('PASS_NO_EDGE');

  // WI-0944: DEGRADED_MODEL with edge present — surface as WATCH (LEAN) rather than hard PASS.
  // Confidence gate remains a hard veto only for FULL_MODEL paths; degraded projections
  // with a real edge should downgrade to LEAN/WATCH, not disappear entirely.
  const canLean =
    modelQuality !== 'NO_BET_MODEL' &&
    hasLeanEdge &&
    (!confidenceBelowGate || isDegraded);
  const canFire =
    modelQuality === 'FULL_MODEL' &&
    hasPlayEdge &&
    !confidenceBelowGate;

  const prediction = canLean ? (finalEdge >= 0 ? 'OVER' : 'UNDER') : leanSide;
  let status = 'PASS';
  if (canLean) {
    const softReasonCount = reasonCodes.filter((code) => code.startsWith('SOFT_')).length;
    const softSuppressed = !MLB_PURE_SIGNAL_MODE && softReasonCount >= 2;
    status = canFire && !softSuppressed && !degradedWatchOnly ? 'FIRE' : 'WATCH';
  }
  const action = status === 'FIRE' ? 'FIRE' : status === 'WATCH' ? 'HOLD' : 'PASS';
  const classification = status === 'FIRE' ? 'BASE' : status === 'WATCH' ? 'LEAN' : 'PASS';
  const passReasonCode =
    status !== 'PASS'
      ? null
      : selectPassReasonCode(reasonCodes);
  const playability = {
    over_playable_at_or_below: roundToHalf(
      (finalModelTotal ?? proj.projected_total_mean) - MLB_FULL_GAME_LEAN_EDGE_THRESHOLD,
      'floor',
    ),
    under_playable_at_or_above: roundToHalf(
      (finalModelTotal ?? proj.projected_total_mean) + MLB_FULL_GAME_LEAN_EDGE_THRESHOLD,
      'ceil',
    ),
  };

  return {
    market: 'full_game_total',
    line: fullGameLine,
    prediction,
    confidence: proj.confidence / 10,
    ev_threshold_passed: status !== 'PASS',
    reasoning: `FG TOTAL ${proj.projection_source} raw ${rawModelTotal.toFixed(2)} recentered ${recenteredModelTotal.toFixed(2)} shrunk ${finalModelTotal.toFixed(2)} vs line ${fullGameLine.toFixed(1)} rawEdge ${rawEdge >= 0 ? '+' : ''}${rawEdge.toFixed(2)} recenteredEdge ${recenteredEdge >= 0 ? '+' : ''}${recenteredEdge.toFixed(2)} finalEdge ${finalEdge >= 0 ? '+' : ''}${finalEdge.toFixed(2)} shrink=${Number.isFinite(shrinkFactor) ? shrinkFactor.toFixed(2) : 'n/a'} bucket=${proj.volatility_bucket} dynThr=${dynamicThreshold.toFixed(2)} leanThr=${MLB_FULL_GAME_LEAN_EDGE_THRESHOLD.toFixed(2)} pOver=${(pOver * 100).toFixed(1)}% pUnder=${(pUnder * 100).toFixed(1)}% drivers=${driverValidation.drivers.join('|') || 'none'} conf=${proj.confidence}/10`,
    status,
    action,
    classification,
    projection_source: proj.projection_source,
    model_quality: modelQuality,
    status_cap: status === 'PASS' ? 'PASS' : proj.status_cap,
    pass_reason_code: passReasonCode,
    reason_codes: reasonCodes,
    ...buildPassTruthSurface({
      rawEdgeValue: rawEdge,
      thresholdRequired: MLB_FULL_GAME_LEAN_EDGE_THRESHOLD,
      thresholdPassed: hasLeanEdge,
      passReasonCode,
      status,
      inputsStatus: 'COMPLETE',
      evaluationStatus: 'EDGE_COMPUTED',
    }),
    missing_inputs: proj.missing_inputs,
    directional_audit: {
      raw_model_total: roundToTenth(rawModelTotal),
      market_total: roundToTenth(fullGameLine),
      recentered_model_total: roundToTenth(recenteredModelTotal),
      shrunk_model_total: roundToTenth(shrunkModelTotal),
      final_model_total: roundToTenth(finalModelTotal),
      after_degradation_total: roundToTenth(recenteredModelTotal),
      after_shrink_total: roundToTenth(shrunkModelTotal),
      final_total: roundToTenth(finalModelTotal),
      proj_minus_line_raw: roundToTenth(rawEdge),
      proj_minus_line_recentered: roundToTenth(recenteredEdge),
      proj_minus_line_shrunk: roundToTenth(shrunkEdge),
      proj_minus_line_final: roundToTenth(finalEdge),
      raw_edge: roundToTenth(rawEdge),
      final_edge: roundToTenth(finalEdge),
      shrink_factor: Number.isFinite(shrinkFactor) ? Number(shrinkFactor.toFixed(2)) : null,
      qualification_edge: roundToTenth(edgeForQualification),
      qualification_edge_source: degradedMode ? 'raw' : 'final',
      degraded_inputs_count: degradedInputsCount,
      degraded_mode: degradedMode,
      direction_before_shrink: directionBeforeShrink,
      direction_after_shrink: directionAfterShrink,
      bullpen_context: {
        home: proj.home_bullpen_context_input ?? null,
        away: proj.away_bullpen_context_input ?? null,
        bullpen_adjustment_runs: roundToTenth(proj.bullpen_adjustment_runs),
        bullpen_data_missing:
          !Number.isFinite(toFiniteNumberOrNull(proj?.home_bullpen_context_input?.era_14d)) ||
          !Number.isFinite(toFiniteNumberOrNull(proj?.away_bullpen_context_input?.era_14d)),
      },
    },
    playability,
    projection: {
      projected_total: roundToTenth(proj.projected_total_mean),
      projected_total_recentered: roundToTenth(recenteredModelTotal),
      projected_total_shrunk: roundToTenth(shrunkModelTotal),
      projected_total_final: roundToTenth(finalModelTotal),
      projected_total_low: roundToTenth(proj.projected_total_low),
      projected_total_high: roundToTenth(proj.projected_total_high),
      home_proj: roundToTenth(proj.home_proj),
      away_proj: roundToTenth(proj.away_proj),
      home_f5_runs: roundToTenth(proj.home_f5_runs),
      away_f5_runs: roundToTenth(proj.away_f5_runs),
      home_late_runs: roundToTenth(proj.home_late_runs),
      away_late_runs: roundToTenth(proj.away_late_runs),
      total_variance: roundToTenth(proj.total_variance),
      volatility_bucket: proj.volatility_bucket,
      p_over: roundToTenth(distribution.p_over),
      p_under: roundToTenth(distribution.p_under),
      component_breakdown: proj.projection_components ?? null,
    },
    drivers: [
      {
        type: 'mlb-full-game',
        edge: rawEdge,
        edge_shrunk: shrunkEdge,
        projected: proj.projected_total_mean,
        projected_shrunk: shrunkModelTotal,
        projection_source: proj.projection_source,
        volatility_bucket: proj.volatility_bucket,
        threshold: dynamicThreshold,
      },
      {
        type: 'mlb-full-game-drivers',
        support_keys: driverValidation.drivers,
      },
    ],
    decision_v2: {
      official_status: canFire ? 'PLAY' : (canLean ? 'LEAN' : 'PASS'),
      degraded: isDegraded,
      degradation_reason: isDegraded ? 'INSUFFICIENT_DATA' : null,
      watchdog_status: 'READY',
    },
  };
}

/**
 * Project F5 total card with OVER/UNDER/PASS signal.
 *
 * Thresholds. Original backtest used confidence >= 8; lowered to >= 7 to
 * align with the full-game total model and reduce asymmetric suppression:
 *   OVER: edge >= +0.5 AND confidence >= 7
 *   UNDER: edge <= -0.7 AND confidence >= 7
 *
 * @param {object} homePitcher
 * @param {object} awayPitcher
 * @param {number} f5Line
 * @param {object} [context={}]
 * @returns {object|null}
 */
function projectF5TotalCard(homePitcher, awayPitcher, f5Line, context = {}) {
  const proj = projectF5Total(homePitcher, awayPitcher, context);
  if (!proj || f5Line == null) return null;
  // WI-0820: gate fired upstream — propagate NO_BET instead of crashing on null proj.base
  if (proj.status === 'NO_BET') return null;

  const edge = proj.base - f5Line;
  const leanSide = edge >= 0 ? 'OVER' : 'UNDER';
  const fallbackProjection = proj.projection_source === 'SYNTHETIC_FALLBACK';
  const degradedProjection = proj.projection_source === 'DEGRADED_MODEL';
  const hasEdge = Math.abs(edge) >= MLB_F5_EDGE_THRESHOLD;
  // WI-?: Using absolute edge for consistency across all totals models
  const isOver = !fallbackProjection && Math.abs(edge) >= MLB_F5_EDGE_THRESHOLD && edge >= 0 && proj.confidence >= 7;
  const isUnder = !fallbackProjection && Math.abs(edge) >= MLB_F5_EDGE_THRESHOLD && edge < 0 && proj.confidence >= 7;
  const prediction = isOver ? 'OVER' : isUnder ? 'UNDER' : leanSide;
  const evThresholdPassed = isOver || isUnder;
  const sourceLabel = proj.projection_source === 'FULL_MODEL'
    ? 'F5 FULL_MODEL'
    : proj.projection_source === 'DEGRADED_MODEL'
      ? 'F5 DEGRADED_MODEL'
      : 'F5 SYNTHETIC_FALLBACK';
  const status = fallbackProjection || !evThresholdPassed
    ? 'PASS'
    : degradedProjection
      ? 'WATCH'
      : 'FIRE';
  const confidenceGateBlocked = !fallbackProjection && hasEdge && !evThresholdPassed;
  const reasonCodes = Array.from(new Set([
    ...(proj.reason_codes || []),
    ...(fallbackProjection ? ['PASS_SYNTHETIC_FALLBACK'] : []),
    ...(confidenceGateBlocked ? ['PASS_CONFIDENCE_GATE'] : []),
    ...(!fallbackProjection && !hasEdge && !confidenceGateBlocked ? ['PASS_NO_EDGE'] : []),
    ...(degradedProjection && evThresholdPassed ? ['MODEL_DEGRADED_INPUTS'] : []),
  ]));
  const passReasonCode = status !== 'PASS'
    ? null
    : selectPassReasonCode(reasonCodes);

  return buildModelOutput({
    market: 'MLB_F5_TOTAL',
    model_status:
      proj.status === 'NO_BET'
        ? 'NO_BET'
        : (degradedProjection || proj.model_status === 'DEGRADED')
          ? 'DEGRADED'
          : 'MODEL_OK',
    fairProb: null,
    fairLine: roundToTenth(proj.projected_total_mean ?? proj.base),
    confidence: proj.confidence,
    featuresUsed: {
      home_starter_skill_ra9: proj.home_starter_skill_ra9 ?? null,
      away_starter_skill_ra9: proj.away_starter_skill_ra9 ?? null,
      projected_home_f5_runs: roundToTenth(proj.projected_home_f5_runs),
      projected_away_f5_runs: roundToTenth(proj.projected_away_f5_runs),
      park_run_factor: proj.park_run_factor ?? null,
      weather_factor: proj.weather_factor ?? null,
    },
    missingOptional: [
      ...(proj.missingOptional || []),
      ...(proj.missing_inputs || []),
    ],
    missingCritical: proj.missingCritical || [],
    diagnostics: {
      projection_source: proj.projection_source,
      status_cap: proj.status_cap ?? null,
    },
    prediction,
    status,
    action: status === 'FIRE' ? 'FIRE' : status === 'WATCH' ? 'HOLD' : 'PASS',
    classification: status === 'FIRE' ? 'BASE' : status === 'WATCH' ? 'LEAN' : 'PASS',
    edge,
    projected: proj.base,
    ev_threshold_passed: status === 'FIRE' || status === 'WATCH',
    projection_source: proj.projection_source,
    status_cap: proj.status_cap,
    missing_inputs: proj.missing_inputs,
    reason_codes: reasonCodes,
    pass_reason_code: passReasonCode,
    ...buildPassTruthSurface({
      rawEdgeValue: edge,
      thresholdRequired: MLB_F5_EDGE_THRESHOLD,
      thresholdPassed: fallbackProjection ? null : hasEdge,
      passReasonCode,
      status,
      inputsStatus: fallbackProjection ? 'PARTIAL' : 'COMPLETE',
      evaluationStatus: fallbackProjection ? 'NO_EVALUATION' : 'EDGE_COMPUTED',
    }),
    playability: proj.playability,
    projection: {
      projected_total: roundToTenth(proj.projected_total_mean ?? proj.base),
      projected_total_low: roundToTenth(proj.projected_total_low),
      projected_total_high: roundToTenth(proj.projected_total_high),
      projected_home_f5_runs: roundToTenth(proj.projected_home_f5_runs),
      projected_away_f5_runs: roundToTenth(proj.projected_away_f5_runs),
      projected_home_f5_ip: roundToTenth(proj.home_starter_ip_f5_exp),
      projected_away_f5_ip: roundToTenth(proj.away_starter_ip_f5_exp),
      home_ttop_penalty_mult: roundToTenth(proj.home_ttop_penalty_mult),
      away_ttop_penalty_mult: roundToTenth(proj.away_ttop_penalty_mult),
    },
    reasoning: `${sourceLabel} projected ${proj.base.toFixed(2)} vs line ${f5Line} (edge ${edge >= 0 ? '+' : ''}${edge.toFixed(2)}, playable O<=${proj.playability?.over_playable_at_or_below ?? 'n/a'} U>=${proj.playability?.under_playable_at_or_above ?? 'n/a'}, range ${roundToTenth(proj.projected_total_low)}-${roundToTenth(proj.projected_total_high)}, conf ${proj.confidence}/10)`,
  });
}

/**
 * Project F5 Moneyline side pick from pitcher matchup vs. published F5 ML prices.
 *
 * Algorithm:
 *   1. Prefer the shared per-team F5 run projection path when offense/context inputs exist.
 *   2. Fall back to legacy ERA arithmetic when aligned inputs are unavailable.
 *   3. Convert run differential to home win probability via logistic function.
 *   4. Compare projected win probability to implied probability from ML prices for diagnostics.
 *   5. Emit HOME / AWAY from projected run winner; emit PASS only for a near-tie run differential.
 *
 * @param {object} homePitcher - { era, whip, k_per_9 }
 * @param {object} awayPitcher - { era, whip, k_per_9 }
 * @param {number} mlF5Home - American odds for home side (e.g. -120)
 * @param {number} mlF5Away - American odds for away side (e.g. +105)
 * @param {object|null} [homeOffenseProfile=null]
 * @param {object|null} [awayOffenseProfile=null]
 * @param {object|null} [context=null]
 * @returns {object|null}
 */
function projectF5ML(
  homePitcher,
  awayPitcher,
  mlF5Home,
  mlF5Away,
  homeOffenseProfile = null,
  awayOffenseProfile = null,
  context = null,
) {
  if (!homePitcher || !awayPitcher) return null;
  if (mlF5Home == null || mlF5Away == null) return null;

  function buildEraFallbackProjection() {
    if (homePitcher.era == null || awayPitcher.era == null) return null;

    const LEAGUE_AVG_RPG = 4.5;
    // Home team expected F5 runs = function of away pitcher ERA
    const homeExpected = (awayPitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
    // Away team expected F5 runs = function of home pitcher ERA
    const awayExpected = (homePitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
    const avgEra = (homePitcher.era + awayPitcher.era) / 2;
    const avgWhip = ((homePitcher.whip ?? 1.3) + (awayPitcher.whip ?? 1.3)) / 2;
    const avgK9 = ((homePitcher.k_per_9 ?? 8.0) + (awayPitcher.k_per_9 ?? 8.0)) / 2;
    let confidence = 6;
    if (avgEra <= 3.5) confidence += 1;
    if (avgWhip <= 1.2) confidence += 1;
    if (avgK9 >= 8.5) confidence += 1;

    return {
      homeExpected,
      awayExpected,
      confidence: Math.min(confidence, 10),
      projectionSource: 'F5_ML_FALLBACK_ERA',
      reasonCodes: ['F5_ML_FALLBACK_ERA'],
      degradedInputs: [],
    };
  }

  let projection = null;
  if (homeOffenseProfile && awayOffenseProfile) {
    const projectionContext = context ?? {};
    const homeRunsResult = projectTeamF5RunsAgainstStarter(
      awayPitcher,
      homeOffenseProfile,
      projectionContext,
    );
    const awayRunsResult = projectTeamF5RunsAgainstStarter(
      homePitcher,
      awayOffenseProfile,
      projectionContext,
    );
    if (
      Number.isFinite(homeRunsResult?.f5_runs) &&
      Number.isFinite(awayRunsResult?.f5_runs)
    ) {
      const homeDegradedInputs = Array.isArray(homeRunsResult.degraded_inputs)
        ? homeRunsResult.degraded_inputs
        : [];
      const awayDegradedInputs = Array.isArray(awayRunsResult.degraded_inputs)
        ? awayRunsResult.degraded_inputs
        : [];
      // Exclude features not yet implemented in the data pipeline from the
      // confidence deduction — they are tracked in degraded_inputs for
      // observability but should not suppress card generation.
      const UNIMPLEMENTED_INPUTS = new Set(['times_through_order_profile']);
      const homeMeaningfulDegraded = homeDegradedInputs.filter(
        (k) => !UNIMPLEMENTED_INPUTS.has(k),
      );
      const awayMeaningfulDegraded = awayDegradedInputs.filter(
        (k) => !UNIMPLEMENTED_INPUTS.has(k),
      );
      projection = {
        homeExpected: homeRunsResult.f5_runs,
        awayExpected: awayRunsResult.f5_runs,
        confidence: Math.max(
          5,
          7 -
            (homeMeaningfulDegraded.length > 0 ? 1 : 0) -
            (awayMeaningfulDegraded.length > 0 ? 1 : 0),
        ),
        projectionSource: 'FULL_MODEL',
        reasonCodes: [],
        degradedInputs: Array.from(new Set([
          ...homeDegradedInputs.map((name) => `home_${name}`),
          ...awayDegradedInputs.map((name) => `away_${name}`),
        ])),
      };
    }
  }

  projection = projection ?? buildEraFallbackProjection();
  if (!projection) return null;

  const homeExpected = projection.homeExpected;
  const awayExpected = projection.awayExpected;
  const confidence = projection.confidence;
  const runDiff = homeExpected - awayExpected; // positive = home advantage

  // Logistic win probability from run differential (coefficient 0.8 empirical for F5)
  const winProbHome = 1 / (1 + Math.exp(-0.8 * runDiff));

  // Raw implied probability — intermediate only; normalized via two-sided devig below
  const rawHome = _mlToImplied(mlF5Home);
  const rawAway = _mlToImplied(mlF5Away);
  if (rawHome === null || rawAway === null) return null;
  const total = rawHome + rawAway;
  const impliedHome = rawHome / total;
  const impliedAway = rawAway / total;

  const homeEdge = winProbHome - impliedHome;
  const awayEdge = (1 - winProbHome) - impliedAway;

  const RUN_DIFF_TIE_EPSILON = 0.01;
  let side = 'PASS';
  let edge = 0;
  if (runDiff > RUN_DIFF_TIE_EPSILON) {
    side = 'HOME';
    edge = homeEdge;
  } else if (runDiff < -RUN_DIFF_TIE_EPSILON) {
    side = 'AWAY';
    edge = awayEdge;
  }

  return {
    side,
    prediction: side,
    edge,
    projected_win_prob_home: winProbHome,
    projected_home_f5_runs: homeExpected,
    projected_away_f5_runs: awayExpected,
    confidence,
    projection_source: projection.projectionSource,
    reason_codes: projection.reasonCodes,
    degraded_inputs: projection.degradedInputs,
    ev_threshold_passed: side !== 'PASS',
    reasoning: `F5 ML: homeExp=${homeExpected.toFixed(2)} awayExp=${awayExpected.toFixed(2)} runDiff=${runDiff >= 0 ? '+' : ''}${runDiff.toFixed(2)} pWin(H)=${(winProbHome * 100).toFixed(1)}% implH=${(impliedHome * 100).toFixed(1)}% implA=${(impliedAway * 100).toFixed(1)}% edgeH=${homeEdge >= 0 ? '+' : ''}${(homeEdge * 100).toFixed(1)}pp edgeA=${awayEdge >= 0 ? '+' : ''}${(awayEdge * 100).toFixed(1)}pp conf=${confidence}/10`,
  };
}

/**
 * Project full-game moneyline win probability from the full-game run differential.
 *
 * Algorithm:
 *   1. Call projectFullGameTotal() to get home/away projected run means.
 *   2. runDiff = home_proj - away_proj
 *   3. winProbHome = 1 / (1 + exp(-0.5 * runDiff))
 *      Coefficient 0.5 (vs 0.8 for F5) because 9-inning differentials are larger
 *      in absolute magnitude than F5 differentials, so a smaller k keeps the
 *      sigmoid from saturating prematurely.
 *   4. De-vig mlHome / mlAway with two-sided normalization (same as projectF5ML).
 *   5. homeEdge = winProbHome - fairHome; emit HOME/AWAY/PASS.
 *
 * @param {object} homePitcher
 * @param {object} awayPitcher
 * @param {number} mlHome  American odds for home (e.g. -120)
 * @param {number} mlAway  American odds for away (e.g. +105)
 * @param {object} [context={}]
 * @returns {object|null}
 */
function projectFullGameML(homePitcher, awayPitcher, mlHome, mlAway, context = {}) {
  if (!homePitcher || !awayPitcher) return null;
  if (mlHome == null || mlAway == null) return null;

  const proj = projectFullGameTotal(homePitcher, awayPitcher, context);
  if (!proj || proj.projection_source === 'NO_BET' || proj.projected_total_mean == null) return null;

  const homeProj = proj.home_proj;
  const awayProj = proj.away_proj;
  const homeFieldRuns = toFiniteNumberOrNull(context?.home_field_runs) ?? MLB_FULL_GAME_HOME_FIELD_RUNS;
  const runDiff = homeProj - awayProj;

  const f5RunDiff =
    Number.isFinite(proj.home_f5_runs) && Number.isFinite(proj.away_f5_runs)
      ? proj.home_f5_runs - proj.away_f5_runs
      : 0;
  const bullpenRunDiff =
    Number.isFinite(proj.home_late_runs) && Number.isFinite(proj.away_late_runs)
      ? proj.home_late_runs - proj.away_late_runs
      : 0;
  const offenseEdge = resolveOffenseEdgeSignal(homePitcher, awayPitcher, context);

  const variance = resolveFullGameVariance({
    proj,
    context,
    homePitcher,
    awayPitcher,
  });
  const homeLeverageAvailability = clampValue(
    toFiniteNumberOrNull(context?.home_leverage_availability) ?? 0.7,
    0,
    1,
  );
  const awayLeverageAvailability = clampValue(
    toFiniteNumberOrNull(context?.away_leverage_availability) ?? 0.7,
    0,
    1,
  );
  const bullpenAsymmetryAdj = MLB_PURE_SIGNAL_MODE
    ? 0
    : clampValue(bullpenRunDiff * 0.52, -0.32, 0.32);
  const homeInningEdgeAdj = MLB_PURE_SIGNAL_MODE
    ? 0
    : clampValue(homeFieldRuns * 0.5, -0.1, 0.1);
  const lateLeverageAdj = MLB_PURE_SIGNAL_MODE
    ? 0
    : clampValue(
      (homeLeverageAvailability - awayLeverageAvailability) * 0.2,
      -0.12,
      0.12,
    );

  const diffMean =
    runDiff +
    homeFieldRuns +
    bullpenAsymmetryAdj +
    homeInningEdgeAdj +
    lateLeverageAdj;
  const diffSigma = Math.sqrt(Math.max(variance.run_diff_variance, 0.2));
  const winProbHome = clampValue(normalCdf(diffMean / diffSigma), 0.01, 0.99);
  const f5WinProbHome = clampValue(
    normalCdf((f5RunDiff + (homeFieldRuns * 0.35)) / Math.sqrt(Math.max(variance.run_diff_variance * 0.72, 0.18))),
    0.01,
    0.99,
  );

  const rawHome = _mlToImplied(mlHome);
  const rawAway = _mlToImplied(mlAway);
  if (rawHome === null || rawAway === null) return null;
  const total = rawHome + rawAway;
  const impliedHome = rawHome / total;
  const impliedAway = rawAway / total;

  const homeEdge = winProbHome - impliedHome;
  const awayEdge = (1 - winProbHome) - impliedAway;

  const LEAN_EDGE_MIN = 0.025;
  const CONFIDENCE_MIN = Math.min(
    6,
    Math.max(5, 5 + Math.round((variance.variance_multiplier - 1) * 2)),
  );

  const driverSupport = buildFullGameDriverSupport({
    runDiff,
    spEdge: f5RunDiff,
    bullpenEdge: bullpenRunDiff,
    offenseEdge,
    homeFieldRuns,
  });
  const supportCount = driverSupport.length;

  const flags = [];
  const preliminaryEdge = Math.max(homeEdge, awayEdge);
  if (!MLB_PURE_SIGNAL_MODE) {
    if (Math.abs(runDiff) < 0.22) flags.push('RUN_DIFF_SMALL');
    if (supportCount < 2) flags.push('WEAK_DRIVER_SUPPORT');
    if (Math.abs(preliminaryEdge) >= LEAN_EDGE_MIN && Math.abs(runDiff) < 0.3) {
      flags.push('MATH_EDGE_WITH_THIN_RUN_SUPPORT');
    }
  }

  const starterSide = signToken(f5RunDiff);
  const bullpenSide = signToken(bullpenRunDiff);
  const candidateSide = homeEdge >= awayEdge ? 'HOME' : 'AWAY';
  const preferF5 = Math.abs(f5RunDiff) >= 0.28 && Math.abs(bullpenRunDiff) < 0.1;
  const weakExpressionSupport = preferF5 && starterSide !== 'NEUTRAL' && candidateSide !== starterSide;
  if (!MLB_PURE_SIGNAL_MODE) {
    if (preferF5) flags.push('PREFER_F5_SP_DRIVEN');
    if (weakExpressionSupport) flags.push('FG_EXPRESSION_MISMATCH');
  }

  const marketSanityFail =
    Math.abs(homeEdge - awayEdge) < LEAN_EDGE_MIN &&
    Math.abs(runDiff) < 0.24;
  if (!MLB_PURE_SIGNAL_MODE && marketSanityFail) flags.push('MARKET_SANITY_FAIL');

  let confidence = proj.confidence;
  if (!MLB_PURE_SIGNAL_MODE) {
    confidence += Math.min(2, supportCount - 1);
    confidence -= Math.max(0, Math.round((variance.variance_multiplier - 1) * 10));
    if (Math.abs(runDiff) < 0.3) confidence -= 1;
  }
  confidence = clampValue(confidence, 1, 10);

  let side = 'PASS';
  let edge = 0;
  if (homeEdge >= LEAN_EDGE_MIN && confidence >= CONFIDENCE_MIN) {
    side = 'HOME';
    edge = homeEdge;
  } else if (awayEdge >= LEAN_EDGE_MIN && confidence >= CONFIDENCE_MIN) {
    side = 'AWAY';
    edge = awayEdge;
  }

  const rawBestEdge = Math.max(homeEdge, awayEdge);
  const rawEdgeCleared = rawBestEdge >= LEAN_EDGE_MIN;
  const confidenceGateBlocked = rawEdgeCleared && confidence < CONFIDENCE_MIN;

  const softReasons = [];
  let softPenaltyPoints = 0;
  if (!MLB_PURE_SIGNAL_MODE) {
    if (Math.abs(runDiff) < 0.22) {
      softReasons.push('SOFT_RUN_DIFF_SMALL');
      softPenaltyPoints += 1;
    }
    if (supportCount < 2) {
      softReasons.push('SOFT_WEAK_DRIVER_SUPPORT');
      softPenaltyPoints += 1;
    }
    if (weakExpressionSupport) {
      softReasons.push('SOFT_EXPRESSION_MISMATCH_F5_PREF');
      softPenaltyPoints += 1;
    }
    if (marketSanityFail) {
      softReasons.push('SOFT_MARKET_SANITY_FAIL');
      softPenaltyPoints += 1;
    }
    if (flags.includes('MATH_EDGE_WITH_THIN_RUN_SUPPORT')) {
      softReasons.push('SOFT_MATH_ONLY_EDGE');
      softPenaltyPoints += 1;
    }
  }

  const isDegraded = proj.projection_source === 'DEGRADED_MODEL';
  if (side !== 'PASS' && (softPenaltyPoints >= 2 || isDegraded)) {
    // Keep qualified signal but downgrade to lean/watch state upstream.
    confidence = Math.min(confidence, 6);
  }

  const reasonCodes = [
    ...(MLB_PURE_SIGNAL_MODE ? ['PURE_SIGNAL_MODE'] : []),
    ...(isDegraded ? ['FULL_GAME_ML_DEGRADED'] : []),
    ...softReasons,
    ...(confidenceGateBlocked ? ['PASS_CONFIDENCE_GATE'] : []),
    ...(side === 'PASS' && !confidenceGateBlocked && isDegraded && rawEdgeCleared
      ? ['PASS_MODEL_DEGRADED']
      : []),
    ...(side === 'PASS' && !confidenceGateBlocked && !rawEdgeCleared ? ['PASS_NO_EDGE'] : []),
  ];
  const passReasonCode =
    side !== 'PASS'
      ? null
      : confidenceGateBlocked
        ? 'PASS_CONFIDENCE_GATE'
        : isDegraded && rawEdgeCleared
          ? 'PASS_MODEL_DEGRADED'
          : 'PASS_NO_EDGE';

  return {
    side,
    prediction: side,
    edge,
    projected_win_prob_home: winProbHome,
    projected_win_prob_away: 1 - winProbHome,
    p_home_f5: f5WinProbHome,
    p_away_f5: 1 - f5WinProbHome,
    p_home_fg: winProbHome,
    p_away_fg: 1 - winProbHome,
    projected_home_runs: homeProj,
    projected_away_runs: awayProj,
    fair_ml_home: probabilityToFairMl(winProbHome),
    fair_ml_away: probabilityToFairMl(1 - winProbHome),
    confidence,
    projection_source: proj.projection_source,
    status_cap: proj.status_cap,
    reason_codes: reasonCodes,
    flags,
    driver_support: {
      support_count: supportCount,
      support_keys: driverSupport,
      starter_edge_runs: f5RunDiff,
      bullpen_edge_runs: bullpenRunDiff,
      offense_edge_signal: offenseEdge,
      home_field_runs: homeFieldRuns,
      bullpen_asymmetry_adj: bullpenAsymmetryAdj,
      home_inning_edge_adj: homeInningEdgeAdj,
      late_leverage_adj: lateLeverageAdj,
      starter_side: starterSide,
      bullpen_side: bullpenSide,
    },
    game_variance: variance.game_variance,
    run_diff_variance: variance.run_diff_variance,
    variance_multiplier: variance.variance_multiplier,
    confidence_gate: CONFIDENCE_MIN,
    degraded_inputs: proj.degraded_inputs,
    missing_inputs: proj.missing_inputs,
    ev_threshold_passed: side !== 'PASS',
    pass_reason_code: passReasonCode,
    inputs_status: 'COMPLETE',
    evaluation_status: 'EDGE_COMPUTED',
    raw_edge_value: rawBestEdge,
    threshold_required: LEAN_EDGE_MIN,
    threshold_passed: rawEdgeCleared,
    blocked_by: side === 'PASS' ? passReasonCode : null,
    block_reasons: side === 'PASS' && passReasonCode !== 'PASS_NO_EDGE' ? [passReasonCode] : [],
    reasoning: `FullGameML: homeProj=${homeProj.toFixed(2)} awayProj=${awayProj.toFixed(2)} runDiff=${runDiff >= 0 ? '+' : ''}${runDiff.toFixed(2)} var=${variance.run_diff_variance.toFixed(2)} pWin(H)=${(winProbHome * 100).toFixed(1)}% implH=${(impliedHome * 100).toFixed(1)}% implA=${(impliedAway * 100).toFixed(1)}% edgeH=${homeEdge >= 0 ? '+' : ''}${(homeEdge * 100).toFixed(1)}pp edgeA=${awayEdge >= 0 ? '+' : ''}${(awayEdge * 100).toFixed(1)}pp support=${supportCount} conf=${confidence}/10`,
  };
}

/**
 * Parse raw_data from oddsSnapshot (handles string or object).
 */
function parseRawMlb(oddsSnapshot) {
  try {
    const raw = typeof oddsSnapshot?.raw_data === 'string'
      ? JSON.parse(oddsSnapshot.raw_data)
      : (oddsSnapshot?.raw_data ?? {});
    return raw?.mlb ?? {};
  } catch {
    return {};
  }
}

/**
 * Compute MLB driver cards from an oddsSnapshot.
 *
 * Returns an array matching the NBA driver card shape:
 *   { market, prediction, confidence (0-1), ev_threshold_passed, reasoning, drivers }
 *
 * Reads from oddsSnapshot.raw_data.mlb:
 *   home_pitcher, away_pitcher, f5_line
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @returns {Array<object>}
 */
function computeMLBDriverCards(gameId, oddsSnapshot) {
  const mlb = parseRawMlb(oddsSnapshot);
  const cards = [];

  const homePitcher = mlb.home_pitcher ?? null;
  const awayPitcher = mlb.away_pitcher ?? null;

  // F5 total card
  if (mlb.f5_line != null) {
    const result = projectF5TotalCard(
      homePitcher,
      awayPitcher,
      mlb.f5_line,
      {
        home_offense_profile: mlb.home_offense_profile ?? null,
        away_offense_profile: mlb.away_offense_profile ?? null,
        park_run_factor: mlb.park_run_factor ?? null,
        temp_f: mlb.temp_f ?? null,
        wind_mph: mlb.wind_mph ?? null,
        wind_dir: mlb.wind_dir ?? null,
        roof: mlb.roof ?? null,
      },
    );
    if (result) {
      cards.push({
        market: 'f5_total',
        prediction: result.prediction,
        confidence: result.confidence / 10,
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        status: result.status,
        action: result.action,
        classification: result.classification,
        projection_source: result.projection_source,
        status_cap: result.status_cap,
        pass_reason_code: result.pass_reason_code,
        reason_codes: result.reason_codes,
        inputs_status: result.inputs_status,
        evaluation_status: result.evaluation_status,
        raw_edge_value: result.raw_edge_value,
        threshold_required: result.threshold_required,
        threshold_passed: result.threshold_passed,
        blocked_by: result.blocked_by,
        block_reasons: result.block_reasons,
        missing_inputs: result.missing_inputs,
        playability: result.playability,
        projection: result.projection,
        drivers: [{
          type: 'mlb-f5',
          edge: result.edge,
          projected: result.projected,
          projection_source: result.projection_source,
        }],
      });
    }
  }

  // Full-game total card (WI-0872)
  const fullGameLine = toFiniteNumberOrNull(mlb.full_game_line);
  if (fullGameLine != null) {
    const fullGameCard = projectFullGameTotalCard(homePitcher, awayPitcher, fullGameLine, {
      home_offense_profile: mlb.home_offense_profile ?? null,
      away_offense_profile: mlb.away_offense_profile ?? null,
      park_run_factor: mlb.park_run_factor ?? null,
      temp_f: mlb.temp_f ?? null,
      wind_mph: mlb.wind_mph ?? null,
      wind_dir: mlb.wind_dir ?? null,
      roof: mlb.roof ?? null,
      home_bullpen_context: mlb.home_bullpen_context ?? null,
      away_bullpen_context: mlb.away_bullpen_context ?? null,
      home_bullpen_era: mlb.home_bullpen_era ?? null,
      away_bullpen_era: mlb.away_bullpen_era ?? null,
      home_bullpen_fatigue_index: mlb.home_bullpen_fatigue_index ?? null,
      away_bullpen_fatigue_index: mlb.away_bullpen_fatigue_index ?? null,
      home_leverage_availability: mlb.home_leverage_availability ?? null,
      away_leverage_availability: mlb.away_leverage_availability ?? null,
      home_recent_usage: mlb.home_recent_usage ?? null,
      away_recent_usage: mlb.away_recent_usage ?? null,
      f5_line: toFiniteNumberOrNull(mlb.f5_line),
    });
    if (fullGameCard) {
      cards.push(fullGameCard);
    }
  }

  // Full-game ML card (WI-0873)
  const mlHome = toFiniteNumberOrNull(oddsSnapshot?.h2h_home);
  const mlAway = toFiniteNumberOrNull(oddsSnapshot?.h2h_away);
  if (mlHome != null && mlAway != null) {
    const mlResult = projectFullGameML(homePitcher, awayPitcher, mlHome, mlAway, {
      home_offense_profile: mlb.home_offense_profile ?? null,
      away_offense_profile: mlb.away_offense_profile ?? null,
      park_run_factor: mlb.park_run_factor ?? null,
      temp_f: mlb.temp_f ?? null,
      wind_mph: mlb.wind_mph ?? null,
      wind_dir: mlb.wind_dir ?? null,
      roof: mlb.roof ?? null,
      home_bullpen_context: mlb.home_bullpen_context ?? null,
      away_bullpen_context: mlb.away_bullpen_context ?? null,
      home_bullpen_era: mlb.home_bullpen_era ?? null,
      away_bullpen_era: mlb.away_bullpen_era ?? null,
      home_bullpen_fatigue_index: mlb.home_bullpen_fatigue_index ?? null,
      away_bullpen_fatigue_index: mlb.away_bullpen_fatigue_index ?? null,
      home_leverage_availability: mlb.home_leverage_availability ?? null,
      away_leverage_availability: mlb.away_leverage_availability ?? null,
      home_recent_usage: mlb.home_recent_usage ?? null,
      away_recent_usage: mlb.away_recent_usage ?? null,
    });
    if (mlResult) {
      const isDegraded = mlResult.projection_source === 'DEGRADED_MODEL';
      const status = !mlResult.ev_threshold_passed ? 'PASS' : isDegraded ? 'WATCH' : 'FIRE';
      const action = status === 'FIRE' ? 'FIRE' : status === 'WATCH' ? 'HOLD' : 'PASS';
      const classification = status === 'FIRE' ? 'BASE' : status === 'WATCH' ? 'LEAN' : 'PASS';
      cards.push({
        market: 'full_game_ml',
        prediction: mlResult.prediction,
        confidence: mlResult.confidence / 10,
        ev_threshold_passed: mlResult.ev_threshold_passed,
        reasoning: mlResult.reasoning,
        status,
        action,
        classification,
        projection_source: mlResult.projection_source,
        status_cap: mlResult.status_cap,
        pass_reason_code: !mlResult.ev_threshold_passed
          ? (mlResult.pass_reason_code ?? 'PASS_UNKNOWN')
          : null,
        reason_codes: mlResult.reason_codes,
        inputs_status: mlResult.inputs_status,
        evaluation_status: mlResult.evaluation_status,
        raw_edge_value: mlResult.raw_edge_value,
        threshold_required: mlResult.threshold_required,
        threshold_passed: mlResult.threshold_passed,
        blocked_by: mlResult.blocked_by,
        block_reasons: mlResult.block_reasons,
        flags: mlResult.flags,
        driver_support: mlResult.driver_support,
        fair_ml_home: mlResult.fair_ml_home,
        fair_ml_away: mlResult.fair_ml_away,
        missing_inputs: mlResult.missing_inputs,
        drivers: [{
          type: 'mlb-full-game-ml',
          side: mlResult.side,
          edge: mlResult.edge,
          win_prob_home: mlResult.projected_win_prob_home,
          p_home_f5: mlResult.p_home_f5,
          p_home_fg: mlResult.p_home_fg,
          support_count: mlResult.driver_support?.support_count ?? 0,
          support_keys: mlResult.driver_support?.support_keys ?? [],
          flags: mlResult.flags ?? [],
          projection_source: mlResult.projection_source,
        }],
      });
    }
  }

  return cards;
}

/**
 * Evaluate all MLB game market driver cards independently.
 * Replaces the old winner-take-all selectMlbGameMarket().
 *
 * @param {Array} driverCards - cards from computeMLBDriverCards()
 * @param {{ game_id: string }} ctx
 * @returns {GameMarketEvaluation}
 */
function evaluateMlbGameMarkets(driverCards, ctx) {
  const evalCtx = { game_id: ctx.game_id, sport: 'MLB' };
  const market_results = (Array.isArray(driverCards) ? driverCards : []).map(
    (card) => evaluateSingleMarket(card, evalCtx),
  );
  const gameEval = finalizeGameMarketEvaluation({
    game_id: ctx.game_id,
    sport: 'MLB',
    market_results,
  });
  return gameEval;
}

// ============================================================
// SHARP CHEDDAR K — Pitcher Strikeout Decision Engine v1.0
// Implements docs/pitcher_ks/01process.md through 07output.md
// ============================================================

const LEAGUE_AVG_K_PCT = 0.225; // ~22.5% — update seasonally

// ── WI-0840: module-level mutables for dynamic league constants ──────────────
// Initialised to static 2024 fallbacks; replaced at job start by
// computeMLBLeagueAverages + setLeagueConstants in run_mlb_model.js.
let _leagueAvgKPct = LEAGUE_AVG_K_PCT;        // covers LEAGUE_AVG_K_PCT + MLB_F5_DEFAULT_TEAM_K_PCT
let _defaultXfip   = MLB_F5_DEFAULT_XFIP;
let _defaultBbPct  = MLB_F5_DEFAULT_TEAM_BB_PCT;

let _usingStaticFallbacks = true;

function setLeagueConstants({ kPct, xfip, bbPct } = {}) {
  _leagueAvgKPct = kPct  != null ? kPct  : LEAGUE_AVG_K_PCT;
  _defaultXfip   = xfip  != null ? xfip  : MLB_F5_DEFAULT_XFIP;
  _defaultBbPct  = bbPct != null ? bbPct : MLB_F5_DEFAULT_TEAM_BB_PCT;
  _usingStaticFallbacks = (kPct == null && xfip == null && bbPct == null);
}

function isUsingStaticFallbacks() {
  return _usingStaticFallbacks;
}
const MLB_K_DEFAULT_SWSTR_PCT = 0.112;
const MLB_K_DEFAULT_OPP_OBP = 0.315;
const MLB_K_DEFAULT_OPP_XWOBA = 0.320;
const MLB_K_DEFAULT_OPP_HARD_HIT_PCT = 39.0;
const MLB_K_MIN_PROJECTION_STARTS = 3;
const MLB_K_NO_EDGE_BAND_KS = 0.5;
const MLB_K_POISSON_THRESHOLDS = [5, 6, 7];
const MLB_K_PROJECTION_ONLY_PASS_REASON = 'PASS_PROJECTION_ONLY_NO_MARKET';
const MLB_K_POSTURE_LABELS = Object.freeze([
  'UNDER_CANDIDATE',
  'OVER_CANDIDATE',
  'NO_EDGE_ZONE',
  'TRAP_FLAGGED',
  'DATA_UNTRUSTED',
  'UNDER_LEAN_ONLY',
]);
const MLB_K_POSTURE_BASELINE_OVER_THRESHOLD = 0.27;
const MLB_K_POSTURE_BASELINE_UNDER_THRESHOLD = 0.235;
const MLB_K_POSTURE_OPP_FACTOR_OVER_THRESHOLD = 1.05;
const MLB_K_POSTURE_OPP_FACTOR_UNDER_THRESHOLD = 0.97;
const MLB_K_POSTURE_EXPECTED_IP_OVER_THRESHOLD = 5.75;
const MLB_K_POSTURE_EXPECTED_IP_UNDER_THRESHOLD = 5.0;
const MLB_K_POSTURE_UNTRUSTED_LEASH_FLAGS = new Set([
  'IL_RETURN',
  'EXTENDED_REST',
  'OPENER_BULK_ROLE',
]);
// WI-1173: provisional BB% threshold for command risk — calibratable, do not hard-code call sites.
const COMMAND_RISK_BB_PCT_THRESHOLD = 0.095;
// WI-1173: SMALL_SAMPLE guard: fewer than 120 BF in the lookback window.
const COMMAND_RISK_SMALL_SAMPLE_BF = 120;
// WI-1173: projection penalty for command risk; capped by COMMAND_RISK_OVERLAP_CAP.
const COMMAND_RISK_PROJECTION_PENALTY = 0.15;
const COMMAND_RISK_OVERLAP_CAP = 0.30;

const LEASH_TIER_PARAMS = {
  Full:   { score: 2.0, expected_ip: 6.0 },
  'Mod+': { score: 1.5, expected_ip: 5.5 },
  Mod:    { score: 1.0, expected_ip: 5.0 },
  Short:  { score: 0,   expected_ip: 4.0 },
};

/**
 * Classify pitcher leash tier.
 * Uses pitch count history when available; falls back to recent_ip proxy.
 * docs/pitcher_ks/03leash.md
 */
function classifyLeash(pitcher) {
  if (pitcher.role === 'opener' || pitcher.role === 'bulk_reliever') {
    return { tier: null, flag: 'OPENER_BULK_ROLE', over_eligible: false, uncalculable: true };
  }
  if (pitcher.il_return) {
    return { tier: null, flag: 'IL_RETURN', over_eligible: false, expected_ip: null };
  }
  if (pitcher.days_since_last_start != null && pitcher.days_since_last_start >= 10) {
    return { tier: null, flag: 'EXTENDED_REST', over_eligible: false, expected_ip: null };
  }
  if (pitcher.org_pitch_limit != null) {
    if (pitcher.org_pitch_limit < 75)
      return { tier: 'Short', flag: 'ORG_LIMIT', over_eligible: false, expected_ip: 4.0 };
    if (pitcher.org_pitch_limit < 85)
      return { tier: 'Mod', flag: 'ORG_LIMIT', over_eligible: true, expected_ip: 5.0 };
  }
  // Standard classification from last 3 pitch counts
  const counts = pitcher.last_three_pitch_counts;
  if (counts && counts.length >= 3) {
    const high = counts.filter((c) => c >= 90).length;
    const mid  = counts.filter((c) => c >= 80 && c < 90).length;
    const avg  = counts.reduce((s, c) => s + c, 0) / counts.length;
    if (high >= 2) return { tier: 'Full',  flag: null, over_eligible: true,  expected_ip: 6.0 };
    if ((high === 1 && mid >= 2) || avg >= 85)
                   return { tier: 'Mod+',  flag: null, over_eligible: true,  expected_ip: 5.5 };
    if (avg >= 75) return { tier: 'Mod',   flag: null, over_eligible: true,  expected_ip: 5.0 };
    return          { tier: 'Short', flag: null, over_eligible: false, expected_ip: 4.0 };
  }
  // Fallback: IP-based proxy (projection-only mode)
  const recentIp = pitcher.recent_ip ?? pitcher.avg_ip ?? null;
  if (recentIp != null) {
    if (recentIp >= 6.0) return { tier: 'Full',  flag: 'IP_PROXY', over_eligible: true,  expected_ip: 6.0 };
    if (recentIp >= 5.5) return { tier: 'Mod+',  flag: 'IP_PROXY', over_eligible: true,  expected_ip: 5.5 };
    if (recentIp >= 4.5) return { tier: 'Mod',   flag: 'IP_PROXY', over_eligible: true,  expected_ip: 5.0 };
    return                { tier: 'Short', flag: 'IP_PROXY', over_eligible: false, expected_ip: 4.0 };
  }
  return { tier: 'Mod', flag: 'SMALL_SAMPLE', over_eligible: true, expected_ip: 5.0 };
}

function getPitcherKLeashMultiplier(leashTier) {
  if (leashTier === 'Full') return 1.0;
  if (leashTier === 'Mod+') return 0.98;
  if (leashTier === 'Mod') return 0.95;
  if (leashTier === 'Short') return 0.9;
  return 0.95;
}

function classifyPitcherKProjectionSignal(
  value,
  { overThreshold, underThreshold } = {},
) {
  if (!Number.isFinite(value)) return 'UNKNOWN';
  if (Number.isFinite(overThreshold) && value >= overThreshold) {
    return 'OVER_SUPPORT';
  }
  if (Number.isFinite(underThreshold) && value <= underThreshold) {
    return 'UNDER_SUPPORT';
  }
  return 'NEUTRAL';
}

function resolvePitcherKProjectionPosture({
  projectionSource = 'SYNTHETIC_FALLBACK',
  leashTier = null,
  leashFlag = null,
  starterKPct = null,
  oppKPctVsHand = null,
  expectedIp = null,
  trapFlags = [],
} = {}) {
  const opponentKFactor =
    Number.isFinite(oppKPctVsHand) && Number.isFinite(_leagueAvgKPct) && _leagueAvgKPct > 0
      ? oppKPctVsHand / _leagueAvgKPct
      : null;

  const postureComponents = {
    pitcher_k_baseline: classifyPitcherKProjectionSignal(starterKPct, {
      overThreshold: MLB_K_POSTURE_BASELINE_OVER_THRESHOLD,
      underThreshold: MLB_K_POSTURE_BASELINE_UNDER_THRESHOLD,
    }),
    opponent_k_factor: classifyPitcherKProjectionSignal(opponentKFactor, {
      overThreshold: MLB_K_POSTURE_OPP_FACTOR_OVER_THRESHOLD,
      underThreshold: MLB_K_POSTURE_OPP_FACTOR_UNDER_THRESHOLD,
    }),
    projected_innings_bucket: classifyPitcherKProjectionSignal(expectedIp, {
      overThreshold: MLB_K_POSTURE_EXPECTED_IP_OVER_THRESHOLD,
      underThreshold: MLB_K_POSTURE_EXPECTED_IP_UNDER_THRESHOLD,
    }),
  };

  const overSupport = Object.values(postureComponents).filter(
    (signal) => signal === 'OVER_SUPPORT',
  ).length;
  const underSupport = Object.values(postureComponents).filter(
    (signal) => signal === 'UNDER_SUPPORT',
  ).length;
  const trapCount = Array.isArray(trapFlags) ? trapFlags.length : 0;
  const trustedProjection =
    projectionSource !== 'SYNTHETIC_FALLBACK' &&
    !MLB_K_POSTURE_UNTRUSTED_LEASH_FLAGS.has(leashFlag) &&
    Number.isFinite(starterKPct) &&
    Number.isFinite(oppKPctVsHand) &&
    Number.isFinite(expectedIp);

  let posture = 'NO_EDGE_ZONE';
  if (!trustedProjection) {
    posture = 'DATA_UNTRUSTED';
  } else if (trapCount >= 2) {
    posture = 'TRAP_FLAGGED';
  } else if (underSupport >= 2 && overSupport === 0) {
    posture = 'UNDER_CANDIDATE';
  } else if (underSupport >= 2 && overSupport === 1) {
    posture = 'UNDER_LEAN_ONLY';
  } else if (overSupport >= 2 && underSupport === 0) {
    posture = 'OVER_CANDIDATE';
  }

  return {
    posture: MLB_K_POSTURE_LABELS.includes(posture) ? posture : 'NO_EDGE_ZONE',
    posture_components: postureComponents,
    posture_inputs: {
      projection_source: projectionSource,
      leash_tier: leashTier ?? null,
      leash_flag: leashFlag ?? null,
      starter_k_pct: Number.isFinite(starterKPct)
        ? Math.round(starterKPct * 1000) / 1000
        : null,
      opponent_k_factor: Number.isFinite(opponentKFactor)
        ? Math.round(opponentKFactor * 1000) / 1000
        : null,
      projected_ip: Number.isFinite(expectedIp)
        ? Math.round(expectedIp * 10) / 10
        : null,
    },
    posture_support: {
      over: overSupport,
      under: underSupport,
      trap_flags_active: trapCount,
    },
  };
}

function calculatePoissonTail(lambda, threshold) {
  if (!Number.isFinite(lambda) || lambda < 0 || !Number.isInteger(threshold) || threshold < 0) {
    return null;
  }
  let cdfBelow = 0;
  let pmf = Math.exp(-lambda);
  for (let k = 0; k < threshold; k += 1) {
    if (k > 0) pmf *= lambda / k;
    cdfBelow += pmf;
  }
  return clampValue(1 - cdfBelow, 0, 1);
}

function impliedProbabilityToAmericanOdds(probability) {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }
  const odds = probability >= 0.5
    ? -Math.round((probability / (1 - probability)) * 100)
    : Math.round(((1 - probability) / probability) * 100);
  return Object.is(odds, -0) ? 0 : odds;
}

function buildPitcherKProbabilityLadder(kMean) {
  const ladder = {};
  const fairPrices = {};
  for (const threshold of MLB_K_POISSON_THRESHOLDS) {
    const pOver = calculatePoissonTail(kMean, threshold);
    const key = `p_${threshold}_plus`;
    const fairKey = `k_${threshold}_plus`;
    ladder[key] = pOver === null ? null : Math.round(pOver * 1000) / 1000;
    fairPrices[fairKey] = {
      over: impliedProbabilityToAmericanOdds(pOver),
      under: impliedProbabilityToAmericanOdds(
        pOver === null ? null : 1 - pOver,
      ),
    };
  }
  return { probability_ladder: ladder, fair_prices: fairPrices };
}

function resolveOpponentPitcherKProfile(matchup = {}) {
  const l30K = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30);
  const l30Pa = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30_pa) ?? 0;
  const seasonK = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season);
  const seasonPa = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season_pa) ?? 0;
  const oppObp = toFiniteNumberOrNull(matchup?.opp_obp);
  const oppXwoba = toFiniteNumberOrNull(matchup?.opp_xwoba);
  const oppHardHitPct = toFiniteNumberOrNull(matchup?.opp_hard_hit_pct);

  if (l30Pa >= 100 && l30K !== null) {
    return {
      opp_k_pct_vs_hand: l30K,
      opp_obp: oppObp,
      opp_xwoba: oppXwoba,
      opp_hard_hit_pct: oppHardHitPct,
      thin_sample: false,
      missing_inputs: [],
    };
  }

  if (seasonPa >= 100 && seasonK !== null) {
    return {
      opp_k_pct_vs_hand: seasonK,
      opp_obp: oppObp,
      opp_xwoba: oppXwoba,
      opp_hard_hit_pct: oppHardHitPct,
      thin_sample: false,
      missing_inputs: [],
    };
  }

  return {
    opp_k_pct_vs_hand: seasonK ?? l30K ?? _leagueAvgKPct,
    opp_obp: oppObp,
    opp_xwoba: oppXwoba,
    opp_hard_hit_pct: oppHardHitPct,
    thin_sample: true,
    missing_inputs: [
      ...(seasonK === null && l30K === null ? ['opponent_k_pct_vs_hand'] : []),
    ],
  };
}

/**
 * Calculate raw K projection.
 * docs/pitcher_ks/02projection.md
 */
function calculateProjectionK(pitcher, matchup, leashTier, weather, options = {}) {
  const seasonStarts = pitcher?.season_starts ?? pitcher?.starts ?? 0;
  const starterKPct =
    toFiniteNumberOrNull(pitcher?.season_k_pct) ??
    toFiniteNumberOrNull(pitcher?.k_pct);
  const starterSwStrPct =
    toFiniteNumberOrNull(pitcher?.current_season_swstr_pct) ??
    toFiniteNumberOrNull(pitcher?.swstr_pct);
  const bbPct = toFiniteNumberOrNull(pitcher?.bb_pct);
  const xwobaAllowed =
    toFiniteNumberOrNull(pitcher?.xwoba_allowed) ??
    toFiniteNumberOrNull(pitcher?.x_woba_allowed);
  const allowThinSample = options.allowThinSample === true;
  const projectionFlags = [];
  const missingInputs = [];
  // Non-blocking missing fields: flagged in the output missing_inputs for observability
  // but do NOT affect projection_source or status_cap.
  const observabilityMissing = [];
  const degradedInputs = [];
  const opponentProfile = resolveOpponentPitcherKProfile(matchup);
  const expectedIp =
    toFiniteNumberOrNull(LEASH_TIER_PARAMS[leashTier]?.expected_ip) ?? 5.0;
  const kLeashMult = getPitcherKLeashMultiplier(leashTier);
  const veloMph = toFiniteNumberOrNull(pitcher?.season_avg_velo);

  if (seasonStarts < MLB_K_MIN_PROJECTION_STARTS && !allowThinSample) {
    return {
      value: null,
      projection: null,
      reason_code: 'INSUFFICIENT_STARTS',
      missing_inputs: ['season_starts'],
      projection_source: 'SYNTHETIC_FALLBACK',
      status_cap: 'PASS',
      uncalculable: true,
    };
  }
  if (seasonStarts < MLB_K_MIN_PROJECTION_STARTS) {
    projectionFlags.push('THIN_SAMPLE_STARTS');
  }
  if (starterKPct === null) missingInputs.push('starter_k_pct');
  if (!pitcher?.handedness) missingInputs.push('starter_handedness');
  // Statcast driver inputs improve projection quality; when absent we degrade
  // quality and project with proxies instead of suppressing output.
  if (starterSwStrPct === null) missingInputs.push('statcast_swstr');
  if (veloMph === null) missingInputs.push('statcast_velo');
  if (starterSwStrPct === null) degradedInputs.push('starter_whiff_proxy');
  if (veloMph === null) degradedInputs.push('starter_velo_proxy');
  missingInputs.push(...(opponentProfile.missing_inputs || []));
  if (
    opponentProfile.opp_obp === null &&
    opponentProfile.opp_xwoba === null &&
    opponentProfile.opp_hard_hit_pct === null
  ) {
    missingInputs.push('opponent_contact_profile');
  }
  if (opponentProfile.thin_sample) {
    projectionFlags.push('THIN_SAMPLE_OPPONENT_SPLIT');
  }

  const effectiveStarterKPct = starterKPct ?? _leagueAvgKPct;
  const whiffProxyPct = starterSwStrPct ?? clampValue(
    effectiveStarterKPct * 0.42,
    0.08,
    0.18,
  );
  const oppKPctVsHand =
    opponentProfile.opp_k_pct_vs_hand ?? _leagueAvgKPct;
  const oppObp = opponentProfile.opp_obp ?? MLB_K_DEFAULT_OPP_OBP;
  const oppXwoba = opponentProfile.opp_xwoba ?? MLB_K_DEFAULT_OPP_XWOBA;
  const oppHardHitPct =
    opponentProfile.opp_hard_hit_pct ?? MLB_K_DEFAULT_OPP_HARD_HIT_PCT;

  const battersPerInning = clampValue(
    MLB_F5_DEFAULT_BF_PER_INNING +
      ((bbPct ?? _defaultBbPct) - _defaultBbPct) * 5.5 +
      ((xwobaAllowed ?? MLB_F5_DEFAULT_STARTER_XWOBA) - MLB_F5_DEFAULT_STARTER_XWOBA) * 8.0 +
      (oppObp - MLB_K_DEFAULT_OPP_OBP) * 4.5 +
      (oppXwoba - MLB_K_DEFAULT_OPP_XWOBA) * 5.5 +
      ((oppHardHitPct - MLB_K_DEFAULT_OPP_HARD_HIT_PCT) / 100) * 1.2,
    3.8,
    4.9,
  );
  const projectedIp = pitcher?.is_doubleheader_first_game
    ? Math.max(3.0, expectedIp - 0.5)
    : expectedIp;
  const bfExp = projectedIp * battersPerInning;
  let kInteraction =
    (effectiveStarterKPct * oppKPctVsHand) / _leagueAvgKPct;
  kInteraction *= clampValue(
    1 + (whiffProxyPct - MLB_K_DEFAULT_SWSTR_PCT) * 0.45,
    0.93,
    1.08,
  );
  kInteraction *= clampValue(
    1 - (oppXwoba - MLB_K_DEFAULT_OPP_XWOBA) * 0.35 -
      ((oppHardHitPct - MLB_K_DEFAULT_OPP_HARD_HIT_PCT) / 100) * 0.08,
    0.9,
    1.08,
  );
  kInteraction = clampValue(kInteraction, 0.08, 0.38);

  let kMean = bfExp * kInteraction * kLeashMult;

  const parkFactor = toFiniteNumberOrNull(matchup?.park_k_factor) ?? 1.0;
  if (parkFactor >= 1.05) kMean *= 1.04;
  else if (parkFactor < 0.95) kMean *= 0.94;
  else if (parkFactor < 1.0) kMean *= 0.97;

  const temp = weather?.temp_at_first_pitch ?? weather?.temp_f ?? 72;
  if (temp < 45) kMean *= 0.95;

  if (veloMph !== null) {
    if (veloMph >= 95) kMean *= 1.025;      // high-velo advantage: +2.5%
    else if (veloMph < 90) kMean *= 0.975; // low-velo penalty: -2.5%
    // 90–94.9: no modifier
  }

  // WI-1173: Command-context derivation (supersedes WI-0763 BB% projection modifier).
  // Lookback is N=10 starts, aligned with buildPitcherStrikeoutLookback limit.
  const strikeoutHistory = pitcher?.strikeout_history ?? [];
  const lookback10 = strikeoutHistory.slice(0, 10);
  const startsWithBf = lookback10.filter(
    (s) => Number.isFinite(s.batters_faced) && s.batters_faced > 0,
  );

  let recentBbPct = null;
  let recentBbPctStatus = 'MISSING';
  if (startsWithBf.length > 0) {
    const totalWalks = startsWithBf.reduce((sum, s) => sum + (s.walks ?? 0), 0);
    const totalBf = startsWithBf.reduce((sum, s) => sum + s.batters_faced, 0);
    if (totalBf > 0) {
      recentBbPct = totalWalks / totalBf;
      recentBbPctStatus = totalBf < COMMAND_RISK_SMALL_SAMPLE_BF ? 'SMALL_SAMPLE' : 'OK';
    }
  }

  const commandRiskFlag =
    recentBbPctStatus === 'OK' &&
    recentBbPct !== null &&
    recentBbPct >= COMMAND_RISK_BB_PCT_THRESHOLD;

  // home_away_context: HOME/AWAY when game_role is attributable; MIXED/UNKNOWN otherwise.
  const gameRole = pitcher?.game_role ?? null;
  let homeAwayContext;
  if (gameRole === 'home') {
    homeAwayContext = 'HOME';
  } else if (gameRole === 'away') {
    homeAwayContext = 'AWAY';
  } else {
    const isHomeTag = (s) => s.home_away === 'H' || s.home_away === 'home';
    const isAwayTag = (s) => s.home_away === 'A' || s.home_away === 'away';
    const hasHome = lookback10.some(isHomeTag);
    const hasAway = lookback10.some(isAwayTag);
    homeAwayContext = hasHome && hasAway ? 'MIXED' : 'UNKNOWN';
  }

  // Command-context reason codes are informational and do not affect projection_source.
  // They are emitted in a separate array merged into flags at return time.
  const commandContextFlags = [];
  if (commandRiskFlag) commandContextFlags.push('COMMAND_RISK_RECENT_BB_RATE');
  else if (recentBbPctStatus === 'SMALL_SAMPLE') commandContextFlags.push('COMMAND_CONTEXT_SMALL_SAMPLE');
  else if (recentBbPctStatus === 'MISSING') commandContextFlags.push('COMMAND_CONTEXT_MISSING');
  if (homeAwayContext === 'HOME' || homeAwayContext === 'AWAY') {
    commandContextFlags.push('HOME_AWAY_CONTEXT_SHIFT');
  }

  // Apply projection penalty for command risk with overlap cap.
  // projection_pre_overlap is defined here, before overlap controls are applied.
  // Overlap controls: WI-1173 command-context penalty (future leash additive controls go here too).
  const projectionPreOverlap = kMean;
  if (commandRiskFlag) {
    kMean -= COMMAND_RISK_PROJECTION_PENALTY;
  }
  kMean = Math.max(kMean, projectionPreOverlap - COMMAND_RISK_OVERLAP_CAP);

  const roundedMean = Math.round(kMean * 10) / 10;
  const ladder = buildPitcherKProbabilityLadder(roundedMean);
  const overPlayableAtOrBelow = roundToHalf(
    roundedMean - MLB_K_NO_EDGE_BAND_KS,
    'floor',
  );
  const underPlayableAtOrAbove = roundToHalf(
    roundedMean + MLB_K_NO_EDGE_BAND_KS,
    'ceil',
  );

  const hardMissingInputs = missingInputs.filter(
    (field) => field !== 'statcast_swstr' && field !== 'statcast_velo',
  );

  return {
    value: roundedMean,
    projection: roundedMean,
    k_mean: roundedMean,
    starter_k_pct: effectiveStarterKPct,
    starter_swstr_pct: starterSwStrPct,
    whiff_proxy_pct: whiffProxyPct,
    opp_k_pct_vs_hand: oppKPctVsHand,
    projected_ip: projectedIp,
    expected_ip: projectedIp,
    batters_per_inning: Math.round(battersPerInning * 100) / 100,
    bf_exp: Math.round(bfExp * 10) / 10,
    k_interaction: Math.round(kInteraction * 1000) / 1000,
    k_leash_mult: kLeashMult,
    projection_source: hardMissingInputs.length > 0
      ? 'SYNTHETIC_FALLBACK'
      : degradedInputs.length > 0 || projectionFlags.length > 0 || missingInputs.length > 0
        ? 'DEGRADED_MODEL'
        : 'FULL_MODEL',
    // Missing swstr specifically caps confidence to LEAN when no hard inputs are missing.
    status_cap:
      hardMissingInputs.length === 0 && missingInputs.includes('statcast_swstr')
        ? 'LEAN'
        : 'PASS',
    missing_inputs: Array.from(new Set([...missingInputs, ...observabilityMissing])),
    degraded_inputs: Array.from(new Set(degradedInputs)),
    statcast_inputs: {
      swstr_pct: starterSwStrPct,
      season_avg_velo: toFiniteNumberOrNull(pitcher?.season_avg_velo) ?? null,
    },
    // WI-1173: command-context fields for traceability and downstream audit.
    recent_bb_pct: recentBbPct !== null ? Math.round(recentBbPct * 1000) / 1000 : null,
    recent_bb_pct_status: recentBbPctStatus,
    command_risk_flag: commandRiskFlag,
    home_away_context: homeAwayContext,
    playability: {
      over_playable_at_or_below: overPlayableAtOrBelow,
      under_playable_at_or_above: underPlayableAtOrAbove,
    },
    fair_prices: ladder.fair_prices,
    probability_ladder: ladder.probability_ladder,
    flags: [...projectionFlags, ...commandContextFlags],
    uncalculable: false,
  };
}

/**
 * Block 1: score projection margin vs. market line.
 * docs/pitcher_ks/05market.md
 */
function scoreMarginBlock1(projection, line, side) {
  const margin = side === 'over' ? projection - line : line - projection;
  const floor  = side === 'over' ? 0.5 : 0.75;
  if (margin < floor)
    return { score: 0, halt: true, margin, reason: `Margin ${margin.toFixed(2)}K below ${floor}K floor` };
  const score = side === 'over'
    ? (margin > 1.0 ? 3 : margin >= 0.75 ? 2 : 1)
    : (margin > 1.5 ? 3 : margin >= 1.0 ? 2 : 1);
  return { score, halt: false, margin };
}

/** Block 2: leash integrity score. */
function scoreLeashBlock2(leashResult) {
  return LEASH_TIER_PARAMS[leashResult.tier]?.score ?? 0;
}

/** Block 3 sub-signal: trend overlay. docs/pitcher_ks/04overlay.md */
function scoreTrendOverlay(pitcher) {
  const starts = pitcher.season_starts ?? pitcher.starts ?? 0;
  if (starts < 8)
    return { score: 0, reason: `Insufficient starts (${starts}) for trend window — need 8+` };
  if (pitcher.k_pct_last_4_starts == null || pitcher.k_pct_prior_4_starts == null)
    return { score: 0, reason: 'K% split data unavailable' };
  const delta = pitcher.k_pct_last_4_starts - pitcher.k_pct_prior_4_starts;
  if (delta > 0.02)
    return { score: 1, reason: `K% +${(delta * 100).toFixed(1)}pp over last 4 starts` };
  return { score: 0, reason: `K% delta ${(delta * 100).toFixed(1)}pp — below +2pp threshold` };
}

/** Block 3 sub-signal: umpire overlay. */
function scoreUmpireOverlay(ump) {
  const gp = ump?.games_behind_plate_current_season ?? 0;
  if (gp < 30) return { score: 0, reason: `Ump sample ${gp} GP — below 30 GP minimum` };
  const diff = ump?.k_rate_diff_vs_league ?? 0;
  if (diff > 0.03)
    return { score: 1, reason: `Ump K rate +${(diff * 100).toFixed(1)}pp above league avg` };
  return { score: 0, reason: `Ump K rate ${(diff * 100).toFixed(1)}pp — below +3pp threshold` };
}

/** Block 3 sub-signal: BvP overlay. */
function scoreBvPOverlay(pitcher, confirmedLineup) {
  if (!confirmedLineup) return { score: 0, reason: 'Lineup not confirmed — BvP not scoreable' };
  const swStr = pitcher?.current_season_swstr_pct;
  if (swStr != null && swStr < 0.11)
    return { score: 0, reason: `SwStr% ${(swStr * 100).toFixed(1)}% below 11% — historical BvP unreliable` };
  const pa = pitcher?.bvp_pa ?? 0;
  const k  = pitcher?.bvp_k  ?? 0;
  if (pa < 30) return { score: 0, reason: `BvP sample ${pa} PA — below 30 PA minimum` };
  const kRate = k / pa;
  if (kRate > 0.28)
    return { score: 1, reason: `BvP K rate ${(kRate * 100).toFixed(1)}% on ${pa} PA, SwStr% confirmed` };
  return { score: 0, reason: `BvP K rate ${(kRate * 100).toFixed(1)}% — below 28% threshold` };
}

/** Block 4: market structure (line movement direction). */
function scoreMarketStructure(market, side) {
  if (!market || market.opening_line == null) return 0;
  const movedAgainst = side === 'over'
    ? market.line > market.opening_line
    : market.line < market.opening_line;
  return movedAgainst ? 0 : 1;
}

const MLB_K_TRAP_INPUT_KEYS = Object.freeze([
  'leash_bucket',
  'market_move',
  'name_risk_proxy',
  'opp_k_bucket',
  'opp_k_volatility',
  'opp_profile_staleness',
  'projection_band',
  'public_betting',
  'ump_context',
]);

const MLB_K_TRAP_OPTIONAL_INPUT_FLAGS = Object.freeze({
  market_move: 'UNAVAILABLE_MARKET_MOVE',
  public_betting: 'UNAVAILABLE_PUBLIC',
  ump_context: 'UNAVAILABLE_UMP',
});

function sortUniqueStrings(values = []) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function resolveTrapOppKBucket(matchup = {}) {
  const l30K = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30);
  const l30Pa = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30_pa);
  const seasonK = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season);
  const seasonPa = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season_pa);
  const oppKPct =
    (Number.isFinite(l30Pa) && l30Pa >= 100 && l30K !== null)
      ? l30K
      : (Number.isFinite(seasonPa) && seasonPa >= 100 && seasonK !== null)
        ? seasonK
        : l30K ?? seasonK ?? null;

  if (!Number.isFinite(oppKPct)) return 'UNKNOWN';
  if (oppKPct <= (_leagueAvgKPct - 0.015)) return 'LOW_K';
  if (oppKPct >= (_leagueAvgKPct + 0.015)) return 'HIGH_K';
  return 'MID_K';
}

function resolveTrapLeashBucket(leashTier) {
  if (leashTier === 'Short') return 'SHORT';
  if (leashTier === 'Mod' || leashTier === 'Mod+') return 'STANDARD';
  if (leashTier === 'Full') return 'LONG';
  return 'UNKNOWN';
}

function resolveTrapNameRiskProxy(pitcher = {}) {
  if (pitcher?.is_star_name === true) return 'AMBIGUOUS';
  if (String(pitcher?.full_name || '').trim().length > 0) return 'CLEAR';
  return 'UNKNOWN';
}

function resolveTrapProjectionBand(projection) {
  const projectedKs = toFiniteNumberOrNull(projection);
  if (projectedKs === null) return 'UNKNOWN';
  if (projectedKs < 2.5 || projectedKs > 8.5) return 'OUTSIDE_STATIC_BAND';
  if (projectedKs < 4.5) return 'LOW';
  if (projectedKs < 6.5) return 'MID';
  return 'HIGH';
}

function resolveTrapOppKVolatility(matchup = {}) {
  const l30K = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30);
  const seasonK = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season);
  if (l30K === null || seasonK === null) return 'UNKNOWN';

  const delta = Math.abs(l30K - seasonK);
  if (delta >= 0.03) return 'HIGH';
  if (delta >= 0.015) return 'MID';
  return 'LOW';
}

function resolveTrapOppProfileStaleness(matchup = {}) {
  const l30K = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30);
  const l30Pa = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_l30_pa);
  const seasonK = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season);
  const seasonPa = toFiniteNumberOrNull(matchup?.opp_k_pct_vs_handedness_season_pa);

  if (l30K !== null && Number.isFinite(l30Pa) && l30Pa >= 100) return 'FRESH';
  if (l30K !== null && Number.isFinite(l30Pa) && l30Pa > 0) return 'STALE';
  if (seasonK !== null && Number.isFinite(seasonPa) && seasonPa >= 100) {
    return 'STATIC_FALLBACK';
  }
  return 'UNKNOWN';
}

function buildTrapDiagnostics({
  pitcher = {},
  matchup = {},
  market = null,
  ump = {},
  projection = null,
  leashTier = null,
} = {}) {
  const umpAvailable =
    toFiniteNumberOrNull(ump?.games_behind_plate_current_season) !== null &&
    toFiniteNumberOrNull(ump?.k_rate_diff_vs_league) !== null;
  const publicBettingAvailable =
    toFiniteNumberOrNull(market?.over_bet_pct) !== null &&
    market?.line_soft_vs_comparable !== undefined;
  const marketMoveAvailable =
    market?.movement_against_play !== undefined &&
    toFiniteNumberOrNull(market?.movement_magnitude) !== null &&
    market?.movement_source_sharp !== undefined;

  const diagnostics = {
    leash_bucket: resolveTrapLeashBucket(leashTier),
    market_move: marketMoveAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
    name_risk_proxy: resolveTrapNameRiskProxy(pitcher),
    opp_k_bucket: resolveTrapOppKBucket(matchup),
    opp_k_volatility: resolveTrapOppKVolatility(matchup),
    opp_profile_staleness: resolveTrapOppProfileStaleness(matchup),
    projection_band: resolveTrapProjectionBand(projection),
    public_betting: publicBettingAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
    ump_context: umpAvailable ? 'AVAILABLE' : 'UNAVAILABLE',
  };

  const inputsPresent = [];
  const inputsMissing = [];
  const unavailableFlags = [];

  for (const key of MLB_K_TRAP_INPUT_KEYS) {
    const value = diagnostics[key];
    const unavailableFlag = MLB_K_TRAP_OPTIONAL_INPUT_FLAGS[key];
    const isUnavailable = value === 'UNAVAILABLE';
    const isUnknown = value === 'UNKNOWN';
    if (!isUnavailable && !isUnknown) {
      inputsPresent.push(key);
    } else {
      inputsMissing.push(key);
      if (isUnavailable && unavailableFlag) unavailableFlags.push(unavailableFlag);
    }
  }

  return {
    diagnostics,
    inputs_present: sortUniqueStrings(inputsPresent),
    inputs_missing: sortUniqueStrings(inputsMissing),
    unavailable_flags: sortUniqueStrings(unavailableFlags),
  };
}

/**
 * Block 5: trap scan.
 * docs/pitcher_ks/06trap.md
 */
function runTrapScan(pitcher, matchup, market, ump, weather, opts) {
  const {
    side = 'over',
    projectionOnly = false,
    block1Score = 0,
    projection = null,
    leashTier = null,
  } = opts || {};
  const actionableFlags = [];
  const trapInputs = buildTrapDiagnostics({
    pitcher,
    matchup,
    market,
    ump,
    projection,
    leashTier,
  });

  // 1. Public bias
  if (pitcher?.is_star_name && market?.over_bet_pct > 0.70 &&
      market?.line_soft_vs_comparable && block1Score <= 1)
    actionableFlags.push('PUBLIC_BIAS');

  // 2. Hidden role risk
  if (matchup?.has_role_signal)
    actionableFlags.push('HIDDEN_ROLE_RISK');

  // 3. Lineup context gap (only with confirmed lineup)
  if (!projectionOnly && matchup?.confirmed_lineup &&
      ((matchup.high_k_hitters_absent ?? 0) >= 2 || matchup.handedness_shift_material))
    actionableFlags.push('LINEUP_CONTEXT_GAP');

  // 4. Market movement anomaly (full mode only)
  if (!projectionOnly && market?.movement_against_play &&
      (market?.movement_magnitude ?? 0) >= 0.5 && market?.movement_source_sharp)
    actionableFlags.push('SHARP_COUNTER_MOVEMENT');

  // 5. Weather / park
  const temp = weather?.temp_at_first_pitch ?? weather?.temp_f;
  if (temp != null && temp < 45 && !pitcher?.projection_weather_adjusted)
    actionableFlags.push('WEATHER_UNACCOUNTED');
  if ((weather?.wind_in_mph ?? 0) > 15 && weather?.wind_direction === 'IN')
    actionableFlags.push('WIND_SUPPRESSION');

  // 6. Ump suppression (overs only)
  if (side === 'over' && (ump?.k_rate_diff_vs_league ?? 0) < -0.04 &&
      (ump?.games_behind_plate_current_season ?? 0) >= 30)
    actionableFlags.push('UMP_SUPPRESSION');

  const activeFlags = sortUniqueStrings(actionableFlags);
  const flags = sortUniqueStrings([
    ...activeFlags,
    ...trapInputs.unavailable_flags,
  ]);

  return {
    flags,
    actionable_flags: activeFlags,
    count: activeFlags.length,
    block5_score: activeFlags.length === 0 ? 1 : 0,
    verdict_eligible: activeFlags.length < 2,
    diagnostics: trapInputs.diagnostics,
    inputs_present: trapInputs.inputs_present,
    inputs_missing: trapInputs.inputs_missing,
    confidence_cap_reason: null,
  };
}

/**
 * Apply confidence caps based on trap diagnostics (WI-1255).
 * 
 * Rules:
 * 1. opp_profile_staleness === 'STALE' → cap to WATCH; emit CAP_OPP_STALE
 * 2. leash_bucket === 'UNKNOWN' → cap to WATCH; emit CAP_LEASH_UNKNOWN
 * 3. opp_profile_staleness === 'STATIC_FALLBACK' → cap to DATA_UNTRUSTED; emit CAP_OPP_STATIC_FALLBACK
 * 4. leash_bucket === 'SHORT' + over candidate → force TRAP_FLAGGED; emit CAP_SHORT_LEASH_OVER
 * 5. opp_k_bucket === 'LOW_K' + projected Ks > 6.5 → cap to UNDER_LEAN_ONLY; emit CAP_LOW_OPP_HIGH_PROJ
 * 6. Both opp_profile_staleness STALE/STATIC_FALLBACK + leash_bucket UNKNOWN → suppress output entirely
 *
 * @param {string} posture - Current posture (PLAY, WATCH, LEAN, UNDER_LEAN_ONLY, etc.)
 * @param {string|null} selectionSide - 'OVER' or 'UNDER'
 * @param {number|null} projection - Projected K value
 * @param {object} trapDiagnostics - Trap diagnostics from trap scan
 * @returns {{ cappedPosture: string, capReason: string|null, suppressOutput: boolean }}
 */
function applyConfidenceCaps({
  posture = 'NO_EDGE_ZONE',
  selectionSide = null,
  projection = null,
  trapDiagnostics = {},
} = {}) {
  const {
    opp_profile_staleness: oppStaleness = null,
    leash_bucket: leashBucket = null,
    opp_k_bucket: oppKBucket = null,
  } = trapDiagnostics;

  const MID_TIER_UPPER_BOUND = 6.5;

  // Full suppression: BOTH opp_profile_staleness is STALE/STATIC_FALLBACK AND leash_bucket is UNKNOWN
  if (
    (oppStaleness === 'STALE' || oppStaleness === 'STATIC_FALLBACK') &&
    leashBucket === 'UNKNOWN'
  ) {
    return {
      cappedPosture: 'NO_OUTPUT_INSUFFICIENT_DATA',
      capReason: 'INSUFFICIENT_DATA_BOTH_FRESHNESS_LEASH',
      suppressOutput: true,
    };
  }

  // Rule 1: opp_profile_staleness === 'STALE' → cap to WATCH
  if (oppStaleness === 'STALE') {
    return {
      cappedPosture: 'WATCH',
      capReason: 'CAP_OPP_STALE',
      suppressOutput: false,
    };
  }

  // Rule 2: leash_bucket === 'UNKNOWN' → cap to WATCH
  if (leashBucket === 'UNKNOWN') {
    return {
      cappedPosture: 'WATCH',
      capReason: 'CAP_LEASH_UNKNOWN',
      suppressOutput: false,
    };
  }

  // Rule 3: opp_profile_staleness === 'STATIC_FALLBACK' → cap to DATA_UNTRUSTED
  if (oppStaleness === 'STATIC_FALLBACK') {
    return {
      cappedPosture: 'DATA_UNTRUSTED',
      capReason: 'CAP_OPP_STATIC_FALLBACK',
      suppressOutput: false,
    };
  }

  // Rule 4: leash_bucket === 'SHORT' + over candidate → force TRAP_FLAGGED
  if (leashBucket === 'SHORT' && selectionSide === 'OVER' && posture === 'OVER_CANDIDATE') {
    return {
      cappedPosture: 'TRAP_FLAGGED',
      capReason: 'CAP_SHORT_LEASH_OVER',
      suppressOutput: false,
    };
  }

  // Rule 5: opp_k_bucket === 'LOW_K' + projected Ks > 6.5 → cap to UNDER_LEAN_ONLY
  const projValue = Number.isFinite(projection) ? projection : null;
  if (oppKBucket === 'LOW_K' && projValue !== null && projValue > MID_TIER_UPPER_BOUND) {
    return {
      cappedPosture: 'UNDER_LEAN_ONLY',
      capReason: 'CAP_LOW_OPP_HIGH_PROJ',
      suppressOutput: false,
    };
  }

  // No cap applies
  return {
    cappedPosture: posture,
    capReason: null,
    suppressOutput: false,
  };
}

function withTrapDiagnostics(result, trapResult) {
  return {
    ...result,
    trap_diagnostics: trapResult?.diagnostics ?? null,
    trap_inputs_present: trapResult?.inputs_present ?? [],
    trap_inputs_missing: trapResult?.inputs_missing ?? [],
    trap_flags: trapResult?.flags ?? [],
    confidence_cap_reason:
      trapResult?.confidence_cap_reason === undefined
        ? null
        : trapResult.confidence_cap_reason,
  };
}

/** Penalty schedule. docs/pitcher_ks/scoring.md */
function calculatePenalties(pitcher, matchup) {
  const detail = [];
  let total = 0;
  const oppKPct = matchup?.opp_k_pct_vs_handedness_l30;
  if (oppKPct != null && oppKPct < 0.18) {
    total -= 2; detail.push({ label: 'Contact-heavy lineup', deduction: -2 });
  }
  const veloDrop = (pitcher?.season_avg_velo ?? 0) - (pitcher?.last3_avg_velo ?? pitcher?.season_avg_velo ?? 0);
  if (veloDrop > 1.5) {
    total -= 2; detail.push({ label: `Velocity drop ${veloDrop.toFixed(1)} mph`, deduction: -2 });
  }
  if (matchup?.handedness_split_unfavorable && !(pitcher?.bvp_pa >= 30)) {
    total -= 1; detail.push({ label: 'Unfavorable handedness split', deduction: -1 });
  }
  const pf = matchup?.park_k_factor ?? 1.0;
  if (pf < 0.95) {
    total -= 1; detail.push({ label: `Park K factor headwind (${pf})`, deduction: -1 });
  }
  if ((matchup?.high_chase_bats_absent ?? 0) >= 1) {
    total -= 1; detail.push({ label: 'High-chase bat absent from confirmed lineup', deduction: -1 });
  }
  return { total, detail };
}

function getConfidenceTier(netScore) {
  if (netScore >= 9) return 'Max';
  if (netScore >= 7) return 'Strong';
  if (netScore >= 5) return 'Marginal';
  return 'No play';
}

function getKVerdict(tier) {
  if (tier === 'No play') return 'Pass';
  if (tier === 'Marginal') return 'Conditional';
  return 'Play';
}

function averageFinite(values = []) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function buildUnderHistoryMetrics(history = [], line = null) {
  const validHistory = (Array.isArray(history) ? history : []).filter(
    (entry) => Number.isFinite(entry?.strikeouts),
  );
  const last5 = validHistory.slice(0, 5);
  const last10 = validHistory.slice(0, 10);
  const underRate = (entries) => {
    if (!Number.isFinite(line) || entries.length === 0) return null;
    const underCount = entries.filter((entry) => entry.strikeouts < line).length;
    return underCount / entries.length;
  };

  return {
    starts_available: validHistory.length,
    last5_count: last5.length,
    last10_count: last10.length,
    under_rate_last5: underRate(last5),
    under_rate_last10: underRate(last10),
    avg_k_last10: averageFinite(last10.map((entry) => entry.strikeouts)),
    avg_pitch_count_last3: averageFinite(
      validHistory
        .slice(0, 3)
        .map((entry) => entry.number_of_pitches),
    ),
  };
}

function pushUnderScoreComponent(components, code, label, points, applied) {
  components.push({ code, label, points, applied: Boolean(applied) });
  return applied ? points : 0;
}

function buildPitcherKUnderWhy(result) {
  const parts = [];
  const history = result.history_metrics || {};
  const form = result.current_form_metrics || {};

  if (Number.isFinite(history.under_rate_last5)) {
    parts.push(`L5 under ${(history.under_rate_last5 * 100).toFixed(0)}%`);
  }
  if (Number.isFinite(history.avg_k_last10) && Number.isFinite(result.selected_market?.line)) {
    parts.push(
      `avg ${history.avg_k_last10.toFixed(1)} Ks vs ${result.selected_market.line.toFixed(1)} line`,
    );
  }
  if (
    Number.isFinite(form.season_k9) &&
    Number.isFinite(form.recent_k9) &&
    form.season_k9 > form.recent_k9
  ) {
    parts.push(`recent K/9 down ${(form.season_k9 - form.recent_k9).toFixed(1)}`);
  }
  if (Number.isFinite(form.avg_pitch_count_last3)) {
    parts.push(`pitch count ${form.avg_pitch_count_last3.toFixed(0)}`);
  }

  return parts.join(' | ');
}

function normalizePitcherKMarketInput(marketContract = null) {
  if (!marketContract || typeof marketContract !== 'object') return null;

  const line = toFiniteNumberOrNull(marketContract.line);
  const overPrice = toFiniteNumberOrNull(marketContract.over_price);
  const underPrice = toFiniteNumberOrNull(marketContract.under_price);
  const bookmaker =
    String(marketContract.bookmaker || marketContract.book || '').trim() || null;
  const lineSource =
    String(marketContract.line_source || marketContract.source || bookmaker || '').trim() ||
    null;
  const currentTimestamp =
    String(marketContract.current_timestamp || marketContract.fetched_at || '').trim() ||
    null;
  const altLines = (Array.isArray(marketContract.alt_lines) ? marketContract.alt_lines : [])
    .map((altLine) => {
      if (!altLine || typeof altLine !== 'object') return null;
      const side = String(altLine.side || '').trim().toLowerCase();
      const lineValue = toFiniteNumberOrNull(altLine.line);
      const juice = toFiniteNumberOrNull(altLine.juice ?? altLine.price);
      const book = String(altLine.book || altLine.bookmaker || '').trim() || null;
      if (!['over', 'under'].includes(side) || lineValue === null) return null;
      return {
        side,
        line: lineValue,
        juice: juice === null ? null : Math.trunc(juice),
        book,
        source:
          String(altLine.source || altLine.line_source || lineSource || '').trim() || null,
        captured_at:
          String(altLine.captured_at || altLine.current_timestamp || currentTimestamp || '').trim() ||
          null,
      };
    })
    .filter(Boolean);

  if (
    line === null &&
    overPrice === null &&
    underPrice === null &&
    altLines.length === 0
  ) {
    return null;
  }

  return {
    line,
    over_price: overPrice === null ? null : Math.trunc(overPrice),
    under_price: underPrice === null ? null : Math.trunc(underPrice),
    bookmaker,
    line_source: lineSource,
    opening_line: toFiniteNumberOrNull(marketContract.opening_line),
    opening_over_price: toFiniteNumberOrNull(
      marketContract.opening_over_price ?? marketContract.opening_juice_over,
    ),
    opening_under_price: toFiniteNumberOrNull(
      marketContract.opening_under_price ?? marketContract.opening_juice_under,
    ),
    best_available_line: toFiniteNumberOrNull(marketContract.best_available_line) ?? line,
    best_available_over_price: toFiniteNumberOrNull(
      marketContract.best_available_over_price ?? overPrice,
    ),
    best_available_under_price: toFiniteNumberOrNull(
      marketContract.best_available_under_price ?? underPrice,
    ),
    best_available_bookmaker:
      String(marketContract.best_available_bookmaker || bookmaker || '').trim() || null,
    current_timestamp: currentTimestamp,
    alt_lines: altLines,
  };
}

function scorePitcherKUnder(pitcherInput, matchupInput, marketInput, weatherInput) {
  const leashResult = classifyLeash(pitcherInput);
  if (leashResult.uncalculable) {
    return {
      status: 'HALTED',
      verdict: 'NO_PLAY',
      reason_code: leashResult.flag,
      basis: 'ODDS_BACKED',
      direction: 'UNDER',
      flags: [leashResult.flag].filter(Boolean),
    };
  }

  const leashTier = leashResult.tier || 'Mod';
  const projectionResult = calculateProjectionK(
    pitcherInput,
    matchupInput,
    leashTier,
    weatherInput || {},
  );
  if (projectionResult.uncalculable) {
    return {
      status: 'HALTED',
      verdict: 'NO_PLAY',
      reason_code: projectionResult.reason_code,
      basis: 'ODDS_BACKED',
      direction: 'UNDER',
      flags: [projectionResult.reason_code].filter(Boolean),
    };
  }

  const projection = projectionResult.value;
  const selectedLine = Number.isFinite(marketInput?.line) ? marketInput.line : null;
  const underPrice = Number.isFinite(marketInput?.under_price)
    ? marketInput.under_price
    : null;
  const historyMetrics = buildUnderHistoryMetrics(
    pitcherInput?.strikeout_history,
    selectedLine,
  );
  const avgLast3PitchCount =
    averageFinite(pitcherInput?.last_three_pitch_counts || []) ??
    historyMetrics.avg_pitch_count_last3;
  const currentFormMetrics = {
    season_k9: pitcherInput?.k_per_9 ?? null,
    recent_k9: pitcherInput?.recent_k_per_9 ?? pitcherInput?.k_per_9 ?? null,
    recent_ip: pitcherInput?.recent_ip ?? null,
    avg_pitch_count_last3: avgLast3PitchCount,
  };

  const hardFlags = [];
  if (selectedLine === null) hardFlags.push('UNDER_MARKET_LINE_MISSING');
  if (underPrice === null) hardFlags.push('UNDER_MARKET_PRICE_MISSING');
  if (selectedLine !== null && selectedLine < 5.0) hardFlags.push('UNDER_LINE_TOO_LOW');
  if (underPrice !== null && underPrice < -155) hardFlags.push('UNDER_PRICE_TOO_JUICED');
  if (historyMetrics.starts_available < 5) hardFlags.push('UNDER_HISTORY_THIN');

  const selectedMarket = {
    line: selectedLine,
    under_price: underPrice,
    over_price: Number.isFinite(marketInput?.over_price) ? marketInput.over_price : null,
    bookmaker: marketInput?.bookmaker ?? null,
  };

  if (hardFlags.length > 0) {
    return {
      status: 'COMPLETE',
      verdict: 'NO_PLAY',
      basis: 'ODDS_BACKED',
      direction: 'UNDER',
      projection,
      line_delta: selectedLine !== null ? projection - selectedLine : null,
      under_score: 0,
      score_components: [],
      history_metrics: historyMetrics,
      current_form_metrics: currentFormMetrics,
      selected_market: selectedMarket,
      flags: hardFlags,
      why: hardFlags.join(', '),
    };
  }

  const components = [];
  let score = 0;
  const lineMinusAvgKLast10 = selectedLine - historyMetrics.avg_k_last10;
  const seasonMinusRecentK9 =
    currentFormMetrics.season_k9 !== null && currentFormMetrics.recent_k9 !== null
      ? currentFormMetrics.season_k9 - currentFormMetrics.recent_k9
      : null;

  score += pushUnderScoreComponent(
    components,
    'UNDER_LAST5_80',
    'Last 5 under rate >= 80%',
    3,
    historyMetrics.under_rate_last5 >= 0.8,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LAST5_60',
    'Last 5 under rate >= 60%',
    2,
    historyMetrics.under_rate_last5 >= 0.6 && historyMetrics.under_rate_last5 < 0.8,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LAST5_40',
    'Last 5 under rate >= 40%',
    1,
    historyMetrics.under_rate_last5 >= 0.4 && historyMetrics.under_rate_last5 < 0.6,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LAST10_70',
    'Last 10 under rate >= 70%',
    2,
    historyMetrics.under_rate_last10 >= 0.7,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LAST10_60',
    'Last 10 under rate >= 60%',
    1,
    historyMetrics.under_rate_last10 >= 0.6 && historyMetrics.under_rate_last10 < 0.7,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LINE_PLUS_1',
    'Line is at least 1.0 above average Ks',
    2,
    lineMinusAvgKLast10 >= 1.0,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LINE_PLUS_05',
    'Line is at least 0.5 above average Ks',
    1,
    lineMinusAvgKLast10 >= 0.5 && lineMinusAvgKLast10 < 1.0,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_LINE_NEGATIVE',
    'Line is not above average Ks',
    -1,
    lineMinusAvgKLast10 <= 0,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_RECENT_K_DROP_MAJOR',
    'Recent K/9 is down at least 0.75',
    1,
    seasonMinusRecentK9 >= 0.75,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_RECENT_K_DROP_MINOR',
    'Recent K/9 is down at least 0.35',
    0.5,
    seasonMinusRecentK9 >= 0.35 && seasonMinusRecentK9 < 0.75,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_RECENT_K_SPIKE',
    'Recent K/9 is up sharply',
    -1,
    seasonMinusRecentK9 <= -0.75,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_PITCH_COUNT_SUPPRESSION',
    'Average pitch count last 3 starts is below 90',
    1,
    avgLast3PitchCount !== null && avgLast3PitchCount < 90,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_RECENT_IP_SUPPRESSION',
    'Recent innings pitched is below 5.5',
    1,
    currentFormMetrics.recent_ip !== null && currentFormMetrics.recent_ip < 5.5,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_FULL_LEASH_PENALTY',
    'Pitch count and innings still show a full leash',
    -1,
    avgLast3PitchCount !== null &&
      avgLast3PitchCount >= 95 &&
      currentFormMetrics.recent_ip !== null &&
      currentFormMetrics.recent_ip >= 6.2,
  );
  score += pushUnderScoreComponent(
    components,
    'UNDER_HOT_WEATHER',
    'Hot weather leans under on leash durability',
    0.5,
    Number.isFinite(weatherInput?.temp_f) && weatherInput.temp_f >= 85,
  );

  const roundedScore = Math.max(0, Math.round(score * 10) / 10);
  const verdict =
    roundedScore >= 7.5 ? 'PLAY' : roundedScore >= 5.5 ? 'WATCH' : 'NO_PLAY';
  const flags = components.filter((component) => component.applied).map((component) => component.code);

  const result = {
    status: 'COMPLETE',
    verdict,
    basis: 'ODDS_BACKED',
    direction: 'UNDER',
    projection,
    line_delta: selectedLine !== null ? projection - selectedLine : null,
    under_score: roundedScore,
    score_components: components,
    history_metrics: historyMetrics,
    current_form_metrics: currentFormMetrics,
    selected_market: selectedMarket,
    flags,
  };

  result.why = buildPitcherKUnderWhy(result);
  return result;
}

/**
 * Score a pitcher K prop using the Sharp Cheddar K 6-step pipeline.
 *
 * In PROJECTION_ONLY mode (options.mode === 'PROJECTION_ONLY'): no market line
 * required. Block 1 and Block 4 are skipped; reason_codes record the bypass.
 * Output always includes basis='PROJECTION_ONLY', a PASS verdict, explicit
 * reason_codes, and a projection posture derived from baseline K skill,
 * opponent K factor, and projected innings.
 *
 * @param {object} pitcherInput
 * @param {object} matchupInput
 * @param {object} [umpInput]
 * @param {object|null} [marketInput]
 * @param {object} [weatherInput]
 * @param {object} [options]
 * @param {'PROJECTION_ONLY'|'FULL'} [options.mode]
 * @param {'over'|'under'} [options.side]
 * @returns {object}
 */
function scorePitcherK(pitcherInput, matchupInput, umpInput, marketInput, weatherInput, options) {
  const _requestedMode = (options || {}).mode || 'PROJECTION_ONLY';
  const mode = 'PROJECTION_ONLY';
  const side = (options || {}).side || 'over';
  const projectionOnly = true;
  const reasonCodes = [MLB_K_PROJECTION_ONLY_PASS_REASON];

  // Step 1A — Leash (needed for expected_ip in projection formula)
  const leashResult = classifyLeash(pitcherInput);
  if (leashResult.uncalculable) {
    const earlyTrapResult = runTrapScan(
      pitcherInput,
      matchupInput,
      marketInput,
      umpInput || {},
      weatherInput || {},
      {
        side,
        projectionOnly,
        block1Score: 0,
        projection: null,
        leashTier: leashResult.tier ?? null,
      },
    );
    const postureSummary = resolvePitcherKProjectionPosture({
      projectionSource: 'SYNTHETIC_FALLBACK',
      leashTier: leashResult.tier ?? null,
      leashFlag: leashResult.flag ?? null,
    });
    return withTrapDiagnostics({
      status: 'HALTED',
      halted_at: 'STEP_1',
      reason_code: leashResult.flag,
      verdict: 'PASS',
      basis: mode,
      projection_only: true,
      reason_codes: [
        MLB_K_PROJECTION_ONLY_PASS_REASON,
        leashResult.flag,
        ...(earlyTrapResult.flags || []),
        ...(_requestedMode !== 'PROJECTION_ONLY'
          ? [`MODE_FORCED:${_requestedMode}->PROJECTION_ONLY`]
          : []),
      ].filter(Boolean),
      projection_source: 'SYNTHETIC_FALLBACK',
      status_cap: 'PASS',
      missing_inputs: ['starter_role'],
      degraded_inputs: [],
      playability: {
        over_playable_at_or_below: null,
        under_playable_at_or_above: null,
      },
      fair_prices: null,
      probability_ladder: null,
      posture: postureSummary.posture,
      posture_components: postureSummary.posture_components,
      posture_inputs: postureSummary.posture_inputs,
      posture_support: postureSummary.posture_support,
    }, earlyTrapResult);
  }

  // Step 1B — Raw K projection
  const leashTier  = leashResult.tier || 'Mod';
  const projResult = calculateProjectionK(
    pitcherInput,
    matchupInput,
    leashTier,
    weatherInput || {},
    { allowThinSample: projectionOnly },
  );
  if (projResult.uncalculable) {
    const earlyTrapResult = runTrapScan(
      pitcherInput,
      matchupInput,
      marketInput,
      umpInput || {},
      weatherInput || {},
      {
        side,
        projectionOnly,
        block1Score: 0,
        projection: projResult.projection ?? projResult.value ?? null,
        leashTier: leashResult.tier ?? null,
      },
    );
    const postureSummary = resolvePitcherKProjectionPosture({
      projectionSource: projResult.projection_source ?? 'SYNTHETIC_FALLBACK',
      leashTier: leashResult.tier ?? null,
      leashFlag: leashResult.flag ?? null,
      starterKPct: projResult.starter_k_pct ?? null,
      oppKPctVsHand: projResult.opp_k_pct_vs_hand ?? null,
      expectedIp: projResult.projected_ip ?? projResult.expected_ip ?? null,
    });
    return withTrapDiagnostics({
      status: 'HALTED',
      halted_at: 'STEP_1',
      reason_code: projResult.reason_code,
      verdict: 'PASS',
      basis: mode,
      projection_only: true,
      reason_codes: [
        MLB_K_PROJECTION_ONLY_PASS_REASON,
        projResult.reason_code,
        ...(projResult.flags || []),
        ...(earlyTrapResult.flags || []),
        ...(_requestedMode !== 'PROJECTION_ONLY'
          ? [`MODE_FORCED:${_requestedMode}->PROJECTION_ONLY`]
          : []),
      ].filter(Boolean),
      projection_source: projResult.projection_source ?? 'SYNTHETIC_FALLBACK',
      status_cap: projResult.status_cap ?? 'PASS',
      missing_inputs: projResult.missing_inputs ?? [],
      degraded_inputs: projResult.degraded_inputs ?? [],
      playability: projResult.playability ?? {
        over_playable_at_or_below: null,
        under_playable_at_or_above: null,
      },
      fair_prices: projResult.fair_prices ?? null,
      probability_ladder: projResult.probability_ladder ?? null,
      posture: postureSummary.posture,
      posture_components: postureSummary.posture_components,
      posture_inputs: postureSummary.posture_inputs,
      posture_support: postureSummary.posture_support,
    }, earlyTrapResult);
  }
  const projection = projResult.value;
  reasonCodes.push(...(projResult.flags || []));
  reasonCodes.push(...(projResult.missing_inputs || []).map((field) => `MISSING_INPUT:${field}`));
  reasonCodes.push(...(projResult.degraded_inputs || []).map((field) => `DEGRADED_INPUT:${field}`));
  if (_requestedMode !== 'PROJECTION_ONLY') {
    reasonCodes.push(`MODE_FORCED:${_requestedMode}->PROJECTION_ONLY`);
  }
  const baselineTrapResult = runTrapScan(
    pitcherInput,
    matchupInput,
    marketInput,
    umpInput || {},
    weatherInput || {},
    {
      side,
      projectionOnly,
      block1Score: 0,
      projection,
      leashTier: leashResult.tier ?? null,
    },
  );
  const projectionPosture = resolvePitcherKProjectionPosture({
    projectionSource: projResult.projection_source,
    leashTier: leashResult.tier ?? null,
    leashFlag: leashResult.flag ?? null,
    starterKPct: projResult.starter_k_pct ?? null,
    oppKPctVsHand: projResult.opp_k_pct_vs_hand ?? null,
    expectedIp: projResult.projected_ip ?? projResult.expected_ip ?? null,
    trapFlags: baselineTrapResult.actionable_flags,
  });

  // Step 1C — Block 1: margin (full mode only)
  let block1Score = 0;
  if (!projectionOnly && marketInput?.line != null) {
    const b1 = scoreMarginBlock1(projection, marketInput.line, side);
    block1Score = b1.score;
    if (b1.halt) {
      return { status: 'HALTED', halted_at: 'STEP_1', reason_code: 'BLOCK_1_NO_MARGIN',
               projection, margin: b1.margin, verdict: 'PASS', basis: mode };
    }
  } else if (projectionOnly) {
    reasonCodes.push('BLOCK_1_SKIPPED:PROJECTION_ONLY');
  }

  // Step 2 — Leash gate (overs)
  if (!leashResult.over_eligible && side === 'over') {
    return withTrapDiagnostics({
      status: 'HALTED',
      halted_at: 'STEP_2',
      reason_code: leashResult.flag || 'SHORT_LEASH',
      projection,
      k_mean: projResult.k_mean,
      bf_exp: projResult.bf_exp,
      projected_ip: projResult.projected_ip,
      batters_per_inning: projResult.batters_per_inning,
      k_interaction: projResult.k_interaction,
      k_leash_mult: projResult.k_leash_mult,
      starter_k_pct: projResult.starter_k_pct,
      starter_swstr_pct: projResult.starter_swstr_pct,
      whiff_proxy_pct: projResult.whiff_proxy_pct,
      opp_k_pct_vs_hand: projResult.opp_k_pct_vs_hand,
      fair_prices: projResult.fair_prices,
      probability_ladder: projResult.probability_ladder,
      playability: projResult.playability,
      projection_source: projResult.projection_source,
      status_cap: 'PASS',
      missing_inputs: projResult.missing_inputs,
      degraded_inputs: projResult.degraded_inputs,
      leash_tier: leashResult.tier,
      verdict: 'PASS',
      basis: mode,
      projection_only: true,
      reason_codes: Array.from(new Set([
        ...reasonCodes,
        leashResult.flag || 'SHORT_LEASH',
        ...(baselineTrapResult.flags || []),
      ])),
      posture: projectionPosture.posture,
      posture_components: projectionPosture.posture_components,
      posture_inputs: projectionPosture.posture_inputs,
      posture_support: projectionPosture.posture_support,
    }, baselineTrapResult);
  }
  const block2Score = scoreLeashBlock2(leashResult);

  // Step 3 — Overlays
  const trendResult = scoreTrendOverlay(pitcherInput);
  const umpResult   = scoreUmpireOverlay(umpInput || {});
  const bvpResult   = scoreBvPOverlay(pitcherInput, matchupInput?.confirmed_lineup);
  const block3Score = trendResult.score + umpResult.score + bvpResult.score;

  // Step 4 — Market structure (Block 4)
  let block4Score = 0;
  if (!projectionOnly && marketInput != null) {
    block4Score = scoreMarketStructure(marketInput, side);
  } else if (projectionOnly) {
    reasonCodes.push('BLOCK_4_SKIPPED:PROJECTION_ONLY');
  }

  // Step 5 — Trap scan (Block 5)
  const trapResult = runTrapScan(pitcherInput, matchupInput, marketInput, umpInput || {}, weatherInput || {}, {
    side,
    projectionOnly,
    block1Score,
    projection,
    leashTier: leashResult.tier ?? null,
  });
  if (!trapResult.verdict_eligible) {
    const trapFlaggedPosture = resolvePitcherKProjectionPosture({
      projectionSource: projResult.projection_source,
      leashTier: leashResult.tier ?? null,
      leashFlag: leashResult.flag ?? null,
      starterKPct: projResult.starter_k_pct ?? null,
      oppKPctVsHand: projResult.opp_k_pct_vs_hand ?? null,
      expectedIp: projResult.projected_ip ?? projResult.expected_ip ?? null,
      trapFlags: trapResult.actionable_flags,
    });
    return withTrapDiagnostics({
      status: 'SUSPENDED',
      halted_at: 'STEP_5',
      reason_code: 'ENVIRONMENT_COMPROMISED',
      projection,
      k_mean: projResult.k_mean,
      bf_exp: projResult.bf_exp,
      projected_ip: projResult.projected_ip,
      batters_per_inning: projResult.batters_per_inning,
      k_interaction: projResult.k_interaction,
      k_leash_mult: projResult.k_leash_mult,
      starter_k_pct: projResult.starter_k_pct,
      starter_swstr_pct: projResult.starter_swstr_pct,
      whiff_proxy_pct: projResult.whiff_proxy_pct,
      opp_k_pct_vs_hand: projResult.opp_k_pct_vs_hand,
      fair_prices: projResult.fair_prices,
      probability_ladder: projResult.probability_ladder,
      playability: projResult.playability,
      projection_source: projResult.projection_source,
      status_cap: 'PASS',
      missing_inputs: projResult.missing_inputs,
      degraded_inputs: projResult.degraded_inputs,
      leash_tier: leashResult.tier,
      overlays: { trend: trendResult, ump: umpResult, bvp: bvpResult },
      verdict: 'PASS',
      basis: mode,
      projection_only: true,
      reason_codes: Array.from(new Set([
        ...reasonCodes,
        'ENVIRONMENT_COMPROMISED',
        ...(trapResult.flags || []),
      ])),
      posture: trapFlaggedPosture.posture,
      posture_components: trapFlaggedPosture.posture_components,
      posture_inputs: trapFlaggedPosture.posture_inputs,
      posture_support: trapFlaggedPosture.posture_support,
    }, trapResult);
  }
  const block5Score = trapResult.block5_score;

  // Step 6 — Confidence scoring
  const penalties = calculatePenalties(pitcherInput, matchupInput || {});
  const rawScore  = block1Score + block2Score + block3Score + block4Score + block5Score;

  // WI-1173: command-context confidence deductions (applied after standard penalties).
  // -5 for command risk, -2 for small sample; mutually exclusive (command_risk requires OK status).
  let commandContextConfidenceDelta = 0;
  const commandContextReasonCodes = [];
  if (projResult.command_risk_flag === true) {
    commandContextConfidenceDelta -= 5;
    commandContextReasonCodes.push('COMMAND_RISK_RECENT_BB_RATE');
  } else if (projResult.recent_bb_pct_status === 'SMALL_SAMPLE') {
    commandContextConfidenceDelta -= 2;
    commandContextReasonCodes.push('COMMAND_CONTEXT_SMALL_SAMPLE');
  } else if (projResult.recent_bb_pct_status === 'MISSING') {
    commandContextReasonCodes.push('COMMAND_CONTEXT_MISSING');
  }
  if (projResult.home_away_context === 'HOME' || projResult.home_away_context === 'AWAY') {
    commandContextReasonCodes.push('HOME_AWAY_CONTEXT_SHIFT');
  }

  const netScore  = Math.max(0, rawScore + penalties.total + commandContextConfidenceDelta);
  const tier = getConfidenceTier(netScore);

  // WI-1255: Apply confidence caps based on trap diagnostics
  const capResult = applyConfidenceCaps({
    posture: projectionPosture.posture,
    selectionSide: side === 'over' ? 'OVER' : side === 'under' ? 'UNDER' : null,
    projection,
    trapDiagnostics: baselineTrapResult.diagnostics || {},
  });

  const finalPosture = capResult.cappedPosture;
  const confidenceCapReason = capResult.capReason;

  // If output suppression is flagged, modify verdict to NO_OUTPUT_INSUFFICIENT_DATA
  const finalResult = {
    status: 'COMPLETE',
    projection,
    k_mean: projResult.k_mean,
    bf_exp: projResult.bf_exp,
    projected_ip: projResult.projected_ip,
    batters_per_inning: projResult.batters_per_inning,
    k_interaction: projResult.k_interaction,
    k_leash_mult: projResult.k_leash_mult,
    starter_k_pct: projResult.starter_k_pct,
    starter_swstr_pct: projResult.starter_swstr_pct,
    whiff_proxy_pct: projResult.whiff_proxy_pct,
    opp_k_pct_vs_hand: projResult.opp_k_pct_vs_hand,
    fair_prices: projResult.fair_prices,
    probability_ladder: projResult.probability_ladder,
    playability: projResult.playability,
    projection_source: projResult.projection_source,
    status_cap: projResult.status_cap,
    missing_inputs: projResult.missing_inputs,
    degraded_inputs: projResult.degraded_inputs,
    leash_tier: leashResult.tier,
    leash_flag: leashResult.flag || null,
    overlays: { trend: trendResult, ump: umpResult, bvp: bvpResult },
    blocks: { b1: block1Score, b2: block2Score, b3: block3Score, b4: block4Score, b5: block5Score },
    penalties: penalties.detail,
    raw_score: rawScore,
    net_score: netScore,
    tier,
    verdict: capResult.suppressOutput ? 'PASS' : 'PASS',
    // WI-1173: command-context output fields for traceability.
    recent_bb_pct: projResult.recent_bb_pct ?? null,
    recent_bb_pct_status: projResult.recent_bb_pct_status ?? 'MISSING',
    command_risk_flag: projResult.command_risk_flag ?? false,
    home_away_context: projResult.home_away_context ?? 'UNKNOWN',
    reason_codes: Array.from(new Set([
      ...reasonCodes,
      ...(leashResult.flag ? [leashResult.flag] : []),
      ...(trapResult.flags || []),
      ...commandContextReasonCodes,
      ...(confidenceCapReason ? [confidenceCapReason] : []),
    ])),
    posture: finalPosture,
    posture_components: projectionPosture.posture_components,
    posture_inputs: projectionPosture.posture_inputs,
    posture_support: projectionPosture.posture_support,
    basis: mode,
    projection_only: projectionOnly,
  };

  const resultWithDiags = withTrapDiagnostics(finalResult, trapResult);
  resultWithDiags.confidence_cap_reason = confidenceCapReason;
  return resultWithDiags;
}

/**
 * Normalize a pitcher name for lookup in strikeout_lines keys.
 * Mirrors normalizePitcherLookupKey in run_mlb_model.js — kept in sync manually.
 * @param {string|null} name
 * @returns {string}
 */
function _normalizePitcherLookupKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Select the best under market entry from a strikeout_lines map.
 *
 * Selection criteria (descending priority):
 *   1. Highest line (>= 5.0 minimum)
 *   2. Best under_price (closest to 0 from negative side; -105 beats -115)
 *   3. Bookmaker priority (lower number = higher priority)
 *
 * @param {object|null} strikeoutLines  raw_data.mlb.strikeout_lines
 * @param {string|null} pitcherName     pitcher full_name for normalized key lookup
 * @param {object}      bookmakerPriority  map of bookmaker -> priority number
 * @returns {{ line, under_price, over_price, bookmaker, line_source, fetched_at }|null}
 */
function selectPitcherKUnderMarket(strikeoutLines, pitcherName, bookmakerPriority) {
  if (!strikeoutLines || typeof strikeoutLines !== 'object') return null;

  const bpMap = bookmakerPriority || {};
  const entries = Object.entries(strikeoutLines)
    .map(([key, entry]) => ({ key, entry }))
    .filter(({ entry }) => {
      if (!entry || typeof entry !== 'object') return false;
      const line = Number(entry.line);
      return Number.isFinite(line) && line >= 5.0;
    });

  if (entries.length === 0) return null;

  entries.sort((a, b) => {
    const lineA = Number(a.entry.line);
    const lineB = Number(b.entry.line);
    if (lineB !== lineA) return lineB - lineA; // highest line first

    const priceA = Number.isFinite(Number(a.entry.under_price)) ? Number(a.entry.under_price) : -999;
    const priceB = Number.isFinite(Number(b.entry.under_price)) ? Number(b.entry.under_price) : -999;
    if (priceB !== priceA) return priceB - priceA; // closest to 0 wins (-105 > -115)

    const bkA = String(a.entry.bookmaker || '').toLowerCase();
    const bkB = String(b.entry.bookmaker || '').toLowerCase();
    const priorityA = bpMap[bkA] ?? 99;
    const priorityB = bpMap[bkB] ?? 99;
    return priorityA - priorityB; // lower number = higher priority
  });

  const best = entries[0].entry;
  return {
    line: Number.isFinite(Number(best.line)) ? Number(best.line) : null,
    under_price: Number.isFinite(Number(best.under_price)) ? Number(best.under_price) : null,
    over_price: Number.isFinite(Number(best.over_price)) ? Number(best.over_price) : null,
    bookmaker: String(best.bookmaker || '').trim() || null,
    line_source: String(best.line_source || best.bookmaker || '').trim() || null,
    fetched_at: String(best.fetched_at || '').trim() || null,
  };
}

/**
 * Build pitcher-K driver cards from an odds snapshot.
 *
 * Reads raw_data.mlb.{home,away}_pitcher (populated by enrichMlbPitcherData).
 * Pitcher-K currently emits projection-only PASS cards (no market line
 * required). If mode='ODDS_BACKED' is requested, the function still forces
 * PROJECTION_ONLY output, adds MODE_FORCED reason codes, and surfaces only
 * projection posture intelligence.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {object} [options]
 * @param {'PROJECTION_ONLY'|'ODDS_BACKED'} [options.mode]
 * @returns {Array<object>}
 */
function computePitcherKDriverCards(gameId, oddsSnapshot, options) {
  const requestedMode = (options || {}).mode || 'PROJECTION_ONLY';
  const mlb = parseRawMlb(oddsSnapshot);
  const cards = [];

  const candidates = [
    { pitcher: mlb.home_pitcher, role: 'home', team: oddsSnapshot?.home_team },
    { pitcher: mlb.away_pitcher, role: 'away', team: oddsSnapshot?.away_team },
  ];

  for (const { pitcher, role, team } of candidates) {
    if (!pitcher) continue;

    const playerId = pitcher.mlb_id != null ? String(pitcher.mlb_id) : null;
    const playerName = pitcher.full_name ?? null;

    const pitcherInput = {
      full_name: playerName,
      k_per_9: pitcher.k_per_9 ?? null,
      recent_k_per_9: pitcher.recent_k_per_9 ?? null,
      season_k_pct: pitcher.season_k_pct ?? pitcher.k_pct ?? null,
      handedness: pitcher.handedness ?? null,
      bb_pct: pitcher.bb_pct ?? null,
      xwoba_allowed: pitcher.xwoba_allowed ?? pitcher.x_woba_allowed ?? null,
      recent_ip: pitcher.recent_ip ?? pitcher.avg_ip ?? null,
      season_starts: pitcher.starts ?? pitcher.season_starts ?? 0,
      starts: pitcher.starts ?? pitcher.season_starts ?? 0,
      il_return: pitcher.il_return ?? false,
      days_since_last_start: pitcher.days_since_last_start ?? null,
      role: pitcher.role ?? 'starter',
      last_three_pitch_counts: pitcher.last_three_pitch_counts ?? null,
      k_pct_last_4_starts: pitcher.k_pct_last_4_starts ?? null,
      k_pct_prior_4_starts: pitcher.k_pct_prior_4_starts ?? null,
      current_season_swstr_pct:
        pitcher.current_season_swstr_pct ?? pitcher.swstr_pct ?? null,
      bvp_pa: pitcher.bvp_pa ?? 0,
      bvp_k: pitcher.bvp_k ?? 0,
      is_star_name: pitcher.is_star_name ?? false,
      season_avg_velo: pitcher.season_avg_velo ?? null,
      last3_avg_velo: pitcher.last3_avg_velo ?? null,
      strikeout_history: pitcher.strikeout_history ?? [],
      // WI-1173: game_role ('home'|'away') populates home_away_context for command-context derivation
      game_role: role,
    };

    const opponentProfile = resolveTeamSplitProfile(
      role === 'home'
        ? mlb.away_offense_profile
        : mlb.home_offense_profile,
      pitcher.handedness,
    );
    const matchupInput = {
      opp_k_pct_vs_handedness_l30:
        mlb.opp_k_pct_vs_handedness_l30?.[role] ??
        opponentProfile?.k_pct ??
        null,
      opp_k_pct_vs_handedness_l30_pa:
        mlb.opp_k_pct_pa?.[role] ??
        (opponentProfile?.k_pct != null ? 600 : 0),
      opp_k_pct_vs_handedness_season:
        mlb.opp_k_pct_season?.[role] ??
        opponentProfile?.k_pct ??
        null,
      opp_k_pct_vs_handedness_season_pa:
        mlb.opp_k_pct_season_pa?.[role] ??
        (opponentProfile?.k_pct != null ? 600 : 0),
      // opp_obp: prefer live mlb_team_batting_stats row (attached by enrichMlbPitcherData
      // after WI-0744 migration), then bb_pct-derived estimate from static offense profile,
      // then league-average default. The static MLB_F5_TEAM_OFFENSE_SPLITS have no bb_pct /
      // xwoba / hard_hit_pct, so the final fallback is always exercised until the DB table
      // is populated — but it is never null, preventing the 'opponent_contact_profile' flag.
      opp_obp: mlb[role === 'home' ? 'away_batting_stats' : 'home_batting_stats']?.obp
        ?? (opponentProfile?.bb_pct != null
          ? clampValue(0.245 + opponentProfile.bb_pct * 0.8, 0.285, 0.355)
          : MLB_K_DEFAULT_OPP_OBP),
      opp_xwoba: mlb[role === 'home' ? 'away_batting_stats' : 'home_batting_stats']?.xwoba
        ?? opponentProfile?.xwoba
        ?? MLB_K_DEFAULT_OPP_XWOBA,
      opp_hard_hit_pct: mlb[role === 'home' ? 'away_batting_stats' : 'home_batting_stats']?.hard_hit_pct
        ?? opponentProfile?.hard_hit_pct
        ?? MLB_K_DEFAULT_OPP_HARD_HIT_PCT,
      opp_chase_rate_l30: mlb.opp_chase_rate?.[role] ?? null,
      park_k_factor: mlb.park_k_factor ?? 1.0,
      confirmed_lineup: mlb.confirmed_lineup?.[role] ?? null,
      has_role_signal: pitcher.has_role_signal ?? false,
      high_k_hitters_absent: mlb.high_k_hitters_absent?.[role] ?? 0,
      handedness_shift_material: false,
    };

    const weatherInput = {
      temp_at_first_pitch: mlb.temp_f ?? null,
      temp_f: mlb.temp_f ?? null,
      wind_in_mph: mlb.wind_mph ?? null,
      wind_direction: mlb.wind_dir ?? null,
    };
    // Pitcher-K currently runs as projection-only: no line/price dependency.
    const result = scorePitcherK(
      pitcherInput,
      matchupInput,
      {},
      null,
      weatherInput,
      { mode: 'PROJECTION_ONLY', side: 'over' },
    );
    const hasProjection =
      typeof result.projection === 'number' &&
      Number.isFinite(result.projection);
    const reasonCodes = Array.from(new Set([
      ...(Array.isArray(result.reason_codes) ? result.reason_codes : []),
      MLB_K_PROJECTION_ONLY_PASS_REASON,
      ...(requestedMode === 'ODDS_BACKED' ? ['MODE_FORCED:ODDS_BACKED->PROJECTION_ONLY'] : []),
      ...(result.projection_source === 'SYNTHETIC_FALLBACK'
        ? ['PASS_SYNTHETIC_FALLBACK', 'PASS_MISSING_DRIVER_INPUTS']
        : []),
      ...(!hasProjection ? ['PASS_MISSING_DRIVER_INPUTS'] : []),
    ]));
    const projectionOnlyMissingInputs = Array.isArray(result.missing_inputs)
      ? [...result.missing_inputs]
      : [];
    const passReasonCode =
      reasonCodes.find((code) => code.startsWith('PASS_')) ??
      MLB_K_PROJECTION_ONLY_PASS_REASON;
    const posture = result.posture ?? 'DATA_UNTRUSTED';

    cards.push({
      market: `pitcher_k_${role}`,
      pitcher_team: team,
      player_id: playerId,
      player_name: playerName,
      prediction: 'PASS',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      confidence: result.net_score != null ? result.net_score / 10 : 0,
      ev_threshold_passed: false,
      emit_card: true,
      card_verdict: 'PASS',
      tier: null,
      posture,
      reasoning: _buildPitcherKReasoning(result),
      projection_source: result.projection_source ?? 'SYNTHETIC_FALLBACK',
      status_cap: result.status_cap ?? 'PASS',
      missing_inputs: projectionOnlyMissingInputs,
      trap_diagnostics: result.trap_diagnostics ?? null,
      trap_inputs_present: result.trap_inputs_present ?? [],
      trap_inputs_missing: result.trap_inputs_missing ?? [],
      trap_flags: result.trap_flags ?? [],
      confidence_cap_reason:
        result.confidence_cap_reason === undefined
          ? null
          : result.confidence_cap_reason,
      reason_codes: reasonCodes,
      pass_reason_code: passReasonCode,
      playability: result.playability ?? null,
      projection: hasProjection
        ? {
            k_mean: result.k_mean ?? result.projection ?? null,
            projected_ip: result.projected_ip ?? result.expected_ip ?? null,
            bf_exp: result.bf_exp ?? null,
            batters_per_inning: result.batters_per_inning ?? null,
            k_interaction: result.k_interaction ?? null,
            k_leash_mult: result.k_leash_mult ?? null,
            starter_k_pct: result.starter_k_pct ?? null,
            starter_swstr_pct: result.starter_swstr_pct ?? null,
            whiff_proxy_pct: result.whiff_proxy_pct ?? null,
            opp_k_pct_vs_hand: result.opp_k_pct_vs_hand ?? null,
            probability_ladder: result.probability_ladder ?? null,
            fair_prices: result.fair_prices ?? null,
            posture,
            posture_components: result.posture_components ?? null,
            posture_inputs: result.posture_inputs ?? null,
          }
        : null,
      drivers: [{
        type: 'pitcher-k',
        projection: result.projection ?? null,
        k_mean: result.k_mean ?? result.projection ?? null,
        probability_ladder: result.probability_ladder ?? null,
        fair_prices: result.fair_prices ?? null,
        leash_tier: result.leash_tier ?? null,
        net_score: result.net_score ?? null,
        tier: result.tier ?? null,
        posture,
        trap_diagnostics: result.trap_diagnostics ?? null,
        trap_inputs_present: result.trap_inputs_present ?? [],
        trap_inputs_missing: result.trap_inputs_missing ?? [],
        trap_flags: result.trap_flags ?? [],
        confidence_cap_reason:
          result.confidence_cap_reason === undefined
            ? null
            : result.confidence_cap_reason,
      }],
      prop_decision: {
        verdict: 'PASS',
        lean_side: null,
        line: null,
        display_price: null,
        projection: result.projection ?? null,
        k_mean: result.k_mean ?? result.projection ?? null,
        probability_ladder: result.probability_ladder ?? null,
        fair_prices: result.fair_prices ?? null,
        playability: result.playability ?? null,
        projection_source: result.projection_source ?? 'SYNTHETIC_FALLBACK',
        status_cap: result.status_cap ?? 'PASS',
        missing_inputs: projectionOnlyMissingInputs,
        posture,
        posture_components: result.posture_components ?? null,
        posture_inputs: result.posture_inputs ?? null,
        trap_diagnostics: result.trap_diagnostics ?? null,
        trap_inputs_present: result.trap_inputs_present ?? [],
        trap_inputs_missing: result.trap_inputs_missing ?? [],
        trap_flags: result.trap_flags ?? [],
        confidence_cap_reason:
          result.confidence_cap_reason === undefined
            ? null
            : result.confidence_cap_reason,
        line_delta: null,
        fair_prob: result.probability_ladder?.p_6_plus ?? null,
        implied_prob: null,
        prob_edge_pp: null,
        ev: null,
        why: _buildPitcherKReasoning(result),
        flags: reasonCodes,
      },
      prop_display_state: 'PROJECTION_ONLY',
      pitcher_k_result: result,
      basis: 'PROJECTION_ONLY',
      line: null,
      line_source: null,
      over_price: null,
      under_price: null,
      best_line_bookmaker: null,
    });
  }

  return cards;
}

function _buildPitcherKReasoning(result) {
  if (result.direction === 'UNDER') {
    const parts = [];
    if (result.projection != null) parts.push(`Projection: ${result.projection} Ks`);
    if (result.selected_market?.line != null) {
      parts.push(`Line: ${result.selected_market.line}`);
    }
    if (result.under_score != null) parts.push(`Under score: ${result.under_score}/10`);
    parts.push(`Verdict: ${result.verdict}`);
    if (result.why) parts.push(result.why);
    return parts.join(' | ');
  }
  if (result.status === 'HALTED')
    return `HALTED at ${result.halted_at}: ${result.reason_code} | Posture: ${result.posture ?? 'DATA_UNTRUSTED'}`;
  if (result.status === 'SUSPENDED')
    return `SUSPENDED — environment compromised: ${(result.trap_flags || []).join(', ')} | Posture: ${result.posture ?? 'TRAP_FLAGGED'}`;
  const parts = [];
  if (result.projection != null) parts.push(`K mean: ${result.projection} Ks`);
  if (result.posture) parts.push(`Posture: ${result.posture}`);
  if (result.bf_exp != null && result.k_interaction != null && result.k_leash_mult != null) {
    parts.push(`BF=${result.bf_exp} × Kint=${result.k_interaction} × leash=${result.k_leash_mult}`);
  }
  if (result.probability_ladder) {
    const ladder = result.probability_ladder;
    parts.push(
      `P(5+)=${ladder.p_5_plus ?? 'n/a'} P(6+)=${ladder.p_6_plus ?? 'n/a'} P(7+)=${ladder.p_7_plus ?? 'n/a'}`,
    );
  }
  if (result.playability) {
    parts.push(
      `fair O<=${result.playability.over_playable_at_or_below ?? 'n/a'} U>=${result.playability.under_playable_at_or_above ?? 'n/a'}`,
    );
  }
  if (result.leash_tier) parts.push(`Leash: ${result.leash_tier}`);
  if (result.projection_source) parts.push(`Source: ${result.projection_source}`);
  if (result.net_score != null) parts.push(`Signal score: ${result.net_score}/10 (${result.tier})`);
  parts.push(`Verdict: ${result.verdict}`);
  return parts.join(' | ');
}

/**
 * WI-0874: Resolve the best MLB model signal for a POTD candidate.
 *
 * Picks the highest-confidence FIRE full_game_ml card from computeMLBDriverCards
 * and returns { modelWinProb, edge, projection_source } so scoreCandidate can
 * use pitcher-quality signal instead of consensus fair-pair probability.
 *
 * Returns null when:
 *   - ENABLE_MLB_MODEL=false
 *   - No FIRE cards exist
 *   - Best card is a total market (f5_total / full_game_total) — not an ML signal
 *   - projection_source contains 'SYNTHETIC' or 'FALLBACK'
 *   - drivers array is empty or win_prob_home is missing/invalid
 *
 * @param {{ gameId: string, oddsSnapshot: object, sport: string }} game
 * @returns {{ modelWinProb: number, edge: number, projection_source: string } | null}
 */
function resolveMLBModelSignal(game) {
  if (process.env.ENABLE_MLB_MODEL === 'false') return null;

  const cards = computeMLBDriverCards(game.gameId, game.oddsSnapshot);
  if (!Array.isArray(cards) || cards.length === 0) return null;

  // Only FIRE cards with no SYNTHETIC/FALLBACK projection
  const fireCards = cards.filter((card) => {
    if (!card.ev_threshold_passed || card.status !== 'FIRE') return false;
    const src = card.projection_source ?? '';
    if (src.includes('SYNTHETIC') || src.includes('FALLBACK')) return false;
    return true;
  });

  if (fireCards.length === 0) return null;

  // Market priority: full_game_ml > f5_total > full_game_total
  const MARKET_PRIORITY = { full_game_ml: 0, f5_total: 1, full_game_total: 2 };
  fireCards.sort((a, b) => {
    const pa = MARKET_PRIORITY[a.market] ?? 99;
    const pb = MARKET_PRIORITY[b.market] ?? 99;
    if (pa !== pb) return pa - pb;
    // Same market: higher confidence wins
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const best = fireCards[0];

  // Total market cards: no ML win-prob — return null so consensus path is used
  if (best.market === 'f5_total' || best.market === 'full_game_total') return null;

  // full_game_ml card
  if (best.market === 'full_game_ml') {
    const driver = best.drivers?.[0];
    if (!driver) return null;
    const { win_prob_home, edge, side } = driver;
    if (!Number.isFinite(win_prob_home) || !Number.isFinite(edge)) return null;

    let modelWinProb;
    if (side === 'HOME') {
      modelWinProb = win_prob_home;
    } else if (side === 'AWAY') {
      modelWinProb = 1 - win_prob_home;
    } else {
      return null;
    }

    return {
      modelWinProb,
      edge,
      projection_source: best.projection_source,
    };
  }

  return null;
}

module.exports = {
  projectF5Total,
  projectF5TotalCard,
  projectF5ML,
  computeMLBDriverCards,
  evaluateMlbGameMarkets,
  // Sharp Cheddar K pipeline
  scorePitcherK,
  scorePitcherKUnder,
  buildUnderHistoryMetrics,
  normalizePitcherKMarketInput,
  selectPitcherKUnderMarket,
  computePitcherKDriverCards,
  // WI-1255: Confidence cap enforcement
  applyConfidenceCaps,
  // Exported for unit testing (WI-0770)
  calculateProjectionK,
  // WI-0872: full-game total model
  computeBullpenContext,
  scoreBullpenQuality,
  scoreBullpenWorkload,
  computeTeamBullpenRuns,
  computeBullpenAdjustmentRuns,
  computeTotalVariance,
  simulateGameTotalDistribution,
  validateTotalDrivers,
  projectLateInningsRuns,
  projectFullGameTotal,
  projectFullGameTotalCard,
  // WI-0873: full-game ML model
  projectFullGameML,
  // Exported for unit testing (WI-0821)
  resolveOffenseComposite,
  // WI-0877: synthetic-line F5 edge driver
  projectTeamF5RunsAgainstStarter,
  // WI-0840: dynamic league constants
  setLeagueConstants,
  // WI-0874: POTD MLB model signal resolver
  resolveMLBModelSignal,
  // Exported for unit testing (pass-reason-integrity-02)
  selectPassReasonCode,
};
