'use strict';

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
 *   selectMlbGameMarket(gameId, oddsSnapshot, cards)  → deterministic MLB selector result
 */

const MLB_F5_EDGE_THRESHOLD = 0.5;
const MLB_F5_DEFAULT_XFIP = 4.3;
const MLB_F5_DEFAULT_TEAM_WRC_PLUS = 100;
const MLB_F5_DEFAULT_TEAM_K_PCT = 0.225;
const MLB_F5_DEFAULT_TEAM_ISO = 0.165;
const MLB_F5_DEFAULT_TEAM_BB_PCT = 0.085;
const MLB_F5_DEFAULT_TEAM_XWOBA = 0.320;
const MLB_F5_DEFAULT_TEAM_HARD_HIT = 39.0;
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
  const missingSkillParts = skillParts
    .filter((part) => part.value === null)
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
    skillRa9 *= clampValue(1 - (kPct - MLB_F5_DEFAULT_TEAM_K_PCT) * 0.35, 0.88, 1.12);
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

  if (wrcPlus === null || kPct === null || iso === null) return null;

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
      ((bbPct ?? MLB_F5_DEFAULT_TEAM_BB_PCT) - MLB_F5_DEFAULT_TEAM_BB_PCT) * 22 +
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
    };
  }

  let adjustedRa9 = starterSkillRa9 * (matchupProfile.wrc_plus / 100);
  adjustedRa9 *= clampValue(
    1 + (matchupProfile.iso - MLB_F5_DEFAULT_TEAM_ISO) * 0.35,
    0.9,
    1.12,
  );
  adjustedRa9 *= clampValue(
    1 - (matchupProfile.k_pct - MLB_F5_DEFAULT_TEAM_K_PCT) * 0.45,
    0.9,
    1.12,
  );
  adjustedRa9 *= clampValue(
    1 + ((matchupProfile.bb_pct ?? MLB_F5_DEFAULT_TEAM_BB_PCT) - MLB_F5_DEFAULT_TEAM_BB_PCT) * 0.8,
    0.94,
    1.08,
  );
  const contactMult = clampValue(
    1 +
      ((matchupProfile.xwoba ?? MLB_F5_DEFAULT_TEAM_XWOBA) - MLB_F5_DEFAULT_TEAM_XWOBA) * 0.9 +
      (((matchupProfile.hard_hit_pct ?? MLB_F5_DEFAULT_TEAM_HARD_HIT) - MLB_F5_DEFAULT_TEAM_HARD_HIT) / 100) * 0.25 +
      ((starterSkillProfile.xwoba_allowed ?? MLB_F5_DEFAULT_STARTER_XWOBA) - MLB_F5_DEFAULT_STARTER_XWOBA) * 0.9,
    0.9,
    1.12,
  );
  adjustedRa9 *= contactMult;
  if (matchupProfile.rolling_14d_wrc_plus !== null) {
    adjustedRa9 *= clampValue(
      1 + ((matchupProfile.rolling_14d_wrc_plus - 100) / 100) * 0.15,
      0.95,
      1.05,
    );
  }
  adjustedRa9 *= clampValue(parkFactor, 0.9, 1.12);
  adjustedRa9 *= weatherFactor ?? 1.0;
  adjustedRa9 *= starterLeashProfile.ttop_penalty_mult;

  return {
    f5_runs: Math.max(0.3, adjustedRa9 * (starterLeashProfile.starter_ip_f5_exp / 9)),
    missing_inputs: [],
    degraded_inputs: Array.from(new Set(degradedInputs)),
    matchup_profile: matchupProfile,
    starter_skill_ra9: starterSkillRa9,
    starter_ip_f5_exp: starterLeashProfile.starter_ip_f5_exp,
    ttop_penalty_mult: starterLeashProfile.ttop_penalty_mult,
    bf_exp: starterLeashProfile.bf_exp,
    contact_mult: contactMult,
    park_factor: parkFactor,
    weather_factor: weatherFactor ?? 1.0,
  };
}

function buildF5SyntheticFallbackProjection(homePitcher, awayPitcher) {
  const homeStarterSkill =
    resolveStarterSkillProfile(homePitcher).starter_skill_ra9 ??
    MLB_F5_DEFAULT_XFIP;
  const awayStarterSkill =
    resolveStarterSkillProfile(awayPitcher).starter_skill_ra9 ??
    MLB_F5_DEFAULT_XFIP;
  const homeLeashIp = resolveStarterLeashProfile(awayPitcher).starter_ip_f5_exp;
  const awayLeashIp = resolveStarterLeashProfile(homePitcher).starter_ip_f5_exp;
  const homeMean = Math.max(0.3, awayStarterSkill * (homeLeashIp / 9));
  const awayMean = Math.max(0.3, homeStarterSkill * (awayLeashIp / 9));
  const totalMean = homeMean + awayMean;
  const rangeWidth = Math.max(0.4, Math.sqrt(Math.max(totalMean, 0.1)) * MLB_F5_POISSON_RANGE_SCALE);

  return {
    base: totalMean,
    confidence: 4,
    avgWhip: ((homePitcher?.whip ?? 1.25) + (awayPitcher?.whip ?? 1.25)) / 2,
    avgK9: ((homePitcher?.k_per_9 ?? 8.5) + (awayPitcher?.k_per_9 ?? 8.5)) / 2,
    projection_source: 'SYNTHETIC_FALLBACK',
    status_cap: 'PASS',
    missing_inputs: [],
    reason_codes: ['PASS_SYNTHETIC_FALLBACK'],
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
 * Project strikeout total for a pitcher vs a given line.
 *
 * Formula: weighted K/9 (70/30 season/recent) × expectedIP / 9 × opponentFactor
 * Overlays: umpire factor, trend, wind, temperature.
 *
 * @param {object} pitcherStats
 * @param {number} line
 * @param {object} [overlays={}]
 * @returns {object|null}
 */
function projectStrikeouts(pitcherStats, line, overlays = {}) {
  // Weighted K/9
  const seasonK9 = pitcherStats.k_per_9 ?? null;
  const recentK9 = pitcherStats.recent_k_per_9 ?? seasonK9;
  if (seasonK9 === null) return null; // no stats yet

  const k9 = 0.7 * seasonK9 + 0.3 * recentK9;
  const expectedIp = pitcherStats.recent_ip ?? 5.5;
  const opponentFactor = overlays.opponent_factor ?? 1.0;
  let base = (k9 * expectedIp) / 9 * opponentFactor;

  // Overlays (multiplicative, applied to base)
  const umpireFactor = overlays.umpire_factor ?? 1.0;
  if (umpireFactor > 1.08) base *= 1.05;
  else if (umpireFactor < 0.92) base *= 0.95;

  const trend = recentK9 / seasonK9; // recent vs season ratio
  if (trend > 1.15) base *= 1.03;
  else if (trend < 0.85) base *= 0.97;

  const wind = overlays.wind_mph ?? 0;
  if (wind > 15) base *= 1.02;

  const temp = overlays.temp_f ?? 72;
  if (temp < 50) base *= 1.02;
  else if (temp > 85) base *= 0.98;

  const edge = base - line;

  // Confidence 1-10
  let confidence = 5;
  const absEdge = Math.abs(edge);
  if (absEdge > 2.0) confidence += 3;
  else if (absEdge > 1.0) confidence += 2;
  else if (absEdge > 0.5) confidence += 1;

  const activeOverlays = [umpireFactor !== 1.0, trend > 1.15 || trend < 0.85, wind > 15, temp < 50 || temp > 85].filter(Boolean).length;
  confidence += Math.min(activeOverlays, 2);

  // Low-line caution
  if (line < 5.0) {
    return {
      prediction: 'PASS',
      edge,
      projected: base,
      confidence,
      ev_threshold_passed: false,
      reasoning: `CAUTION: low line (${line}) — accuracy degrades below 5.0K`,
    };
  }

  // Thresholds (backtest validated)
  const isOver = edge >= 1.0 && confidence >= 8;
  const isUnder = edge <= -1.0 && confidence >= 8;
  const prediction = isOver ? 'OVER' : isUnder ? 'UNDER' : 'PASS';

  return {
    prediction,
    edge,
    projected: base,
    confidence,
    ev_threshold_passed: isOver || isUnder,
    reasoning: `K/9=${k9.toFixed(2)} × IP=${expectedIp} → projected ${base.toFixed(1)} vs line ${line} (edge ${edge >= 0 ? '+' : ''}${edge.toFixed(1)}, conf ${confidence}/10)`,
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
  if (!homePitcher || !awayPitcher) {
    const fallback = buildF5SyntheticFallbackProjection(homePitcher, awayPitcher);
    fallback.missing_inputs = [
      ...(!homePitcher ? ['home_starting_pitcher'] : []),
      ...(!awayPitcher ? ['away_starting_pitcher'] : []),
    ];
    fallback.reason_codes = Array.from(new Set([
      ...(fallback.reason_codes || []),
      'PASS_MISSING_DRIVER_INPUTS',
    ]));
    return fallback;
  }

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

  return {
    base,
    confidence,
    avgWhip,
    avgK9,
    projection_source: degradedInputs.length > 0 ? 'DEGRADED_MODEL' : 'FULL_MODEL',
    status_cap: degradedInputs.length > 0 ? 'LEAN' : 'PLAY',
    missing_inputs: degradedInputs,
    degraded_inputs: degradedInputs,
    reason_codes: degradedInputs.length > 0 ? ['MODEL_DEGRADED_INPUTS'] : [],
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

/**
 * Project F5 total card with OVER/UNDER/PASS signal.
 *
 * Thresholds (backtest validated):
 *   OVER: edge >= +0.5 AND confidence >= 8
 *   UNDER: edge <= -0.7 AND confidence >= 8
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

  const edge = proj.base - f5Line;
  const leanSide = edge >= 0 ? 'OVER' : 'UNDER';
  const fallbackProjection = proj.projection_source === 'SYNTHETIC_FALLBACK';
  const degradedProjection = proj.projection_source === 'DEGRADED_MODEL';
  const hasEdge = Math.abs(edge) >= MLB_F5_EDGE_THRESHOLD;
  const isOver = !fallbackProjection && edge >= MLB_F5_EDGE_THRESHOLD && proj.confidence >= 8;
  const isUnder = !fallbackProjection && edge <= -MLB_F5_EDGE_THRESHOLD && proj.confidence >= 8;
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
  const reasonCodes = Array.from(new Set([
    ...(proj.reason_codes || []),
    ...(fallbackProjection ? ['PASS_SYNTHETIC_FALLBACK'] : []),
    ...(!hasEdge ? ['PASS_NO_EDGE'] : []),
    ...(degradedProjection && evThresholdPassed ? ['MODEL_DEGRADED_INPUTS'] : []),
  ]));

  return {
    prediction,
    status,
    action: status === 'FIRE' ? 'FIRE' : status === 'WATCH' ? 'HOLD' : 'PASS',
    classification: status === 'FIRE' ? 'BASE' : status === 'WATCH' ? 'LEAN' : 'PASS',
    edge,
    projected: proj.base,
    confidence: proj.confidence,
    ev_threshold_passed: status === 'FIRE' || status === 'WATCH',
    projection_source: proj.projection_source,
    status_cap: proj.status_cap,
    missing_inputs: proj.missing_inputs,
    reason_codes: reasonCodes,
    pass_reason_code: status !== 'PASS'
      ? null
      : (reasonCodes.find((code) => code.startsWith('PASS_')) ?? 'PASS_NO_EDGE'),
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
  };
}

/**
 * Project F5 Moneyline side pick from pitcher matchup vs. published F5 ML prices.
 *
 * Algorithm:
 *   1. Derive per-team expected F5 runs from ERA (same as projectF5Total base).
 *   2. Convert run differential to home win probability via logistic function.
 *   3. Compare projected win probability to implied probability from ML prices.
 *   4. Emit HOME / AWAY / PASS based on edge vs. lean_edge_min (0.04) and confidence.
 *
 * @param {object} homePitcher - { era, whip, k_per_9 }
 * @param {object} awayPitcher - { era, whip, k_per_9 }
 * @param {number} mlF5Home - American odds for home side (e.g. -120)
 * @param {number} mlF5Away - American odds for away side (e.g. +105)
 * @returns {object|null}
 */
function projectF5ML(homePitcher, awayPitcher, mlF5Home, mlF5Away) {
  if (!homePitcher || !awayPitcher) return null;
  if (mlF5Home == null || mlF5Away == null) return null;
  if (homePitcher.era == null || awayPitcher.era == null) return null;

  const LEAGUE_AVG_RPG = 4.5;
  // Home team expected F5 runs = function of away pitcher ERA
  const homeExpected = (awayPitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
  // Away team expected F5 runs = function of home pitcher ERA
  const awayExpected = (homePitcher.era + LEAGUE_AVG_RPG) / 2 * (5 / 9);
  const runDiff = homeExpected - awayExpected; // positive = home advantage

  // Logistic win probability from run differential (coefficient 0.8 empirical for F5)
  const winProbHome = 1 / (1 + Math.exp(-0.8 * runDiff));

  // American odds → implied probability (includes vig)
  function mlToImplied(ml) {
    if (!Number.isFinite(ml)) return null;
    return ml < 0 ? (-ml) / (-ml + 100) : 100 / (ml + 100);
  }
  const impliedHome = mlToImplied(mlF5Home);
  const impliedAway = mlToImplied(mlF5Away);
  if (impliedHome === null || impliedAway === null) return null;

  const homeEdge = winProbHome - impliedHome;
  const awayEdge = (1 - winProbHome) - impliedAway;

  // Prefer full-model confidence, but preserve the legacy ERA/WHIP fallback for
  // F5 ML because this market still uses the simpler side-projection path.
  const proj = projectF5Total(homePitcher, awayPitcher);
  const fallbackConfidence = (() => {
    const avgEra = (homePitcher.era + awayPitcher.era) / 2;
    const avgWhip = ((homePitcher.whip ?? 1.3) + (awayPitcher.whip ?? 1.3)) / 2;
    const avgK9 = ((homePitcher.k_per_9 ?? 8.0) + (awayPitcher.k_per_9 ?? 8.0)) / 2;
    let score = 6;
    if (avgEra <= 3.5) score += 1;
    if (avgWhip <= 1.2) score += 1;
    if (avgK9 >= 8.5) score += 1;
    return Math.min(score, 10);
  })();
  const confidence = proj && proj.projection_source === 'FULL_MODEL'
    ? proj.confidence
    : fallbackConfidence;

  const LEAN_EDGE_MIN = 0.04; // F5 ML edge threshold (slightly wider than totals)
  const CONFIDENCE_MIN = 6;

  let side = 'PASS';
  let edge = 0;
  if (homeEdge >= LEAN_EDGE_MIN && confidence >= CONFIDENCE_MIN) {
    side = 'HOME';
    edge = homeEdge;
  } else if (awayEdge >= LEAN_EDGE_MIN && confidence >= CONFIDENCE_MIN) {
    side = 'AWAY';
    edge = awayEdge;
  }

  return {
    side,
    prediction: side,
    edge,
    projected_win_prob_home: winProbHome,
    confidence,
    ev_threshold_passed: side !== 'PASS',
    reasoning: `F5 ML: homeExp=${homeExpected.toFixed(2)} awayExp=${awayExpected.toFixed(2)} runDiff=${runDiff >= 0 ? '+' : ''}${runDiff.toFixed(2)} pWin(H)=${(winProbHome * 100).toFixed(1)}% implH=${(impliedHome * 100).toFixed(1)}% implA=${(impliedAway * 100).toFixed(1)}% edgeH=${homeEdge >= 0 ? '+' : ''}${(homeEdge * 100).toFixed(1)}pp edgeA=${awayEdge >= 0 ? '+' : ''}${(awayEdge * 100).toFixed(1)}pp conf=${confidence}/10`,
  };
}

/**
 * Compute pitcher K/9 and recent IP as-of a specific date.
 * Uses only game logs WHERE game_date < asOfDate — true walk-forward simulation.
 * Anti-look-ahead: same guarantee as Python BacktestEngine.get_pitcher_data_as_of_date().
 *
 * @param {number} mlbPitcherId
 * @param {string} asOfDate - 'YYYY-MM-DD'
 * @param {object} db - better-sqlite3 database instance
 * @param {number} recentStarts - number of recent starts for recent_k_per_9 (default 5)
 * @returns {{ k_per_9, recent_k_per_9, recent_ip, era, whip, starts } | null}
 */
function computePitcherStatsAsOf(mlbPitcherId, asOfDate, db, recentStarts = 5) {
  // All starts before asOfDate in current season
  const season = new Date(asOfDate).getFullYear();
  const allStarts = db.prepare(`
    SELECT innings_pitched, strikeouts, walks, hits, earned_runs, game_date
    FROM mlb_pitcher_game_logs
    WHERE mlb_pitcher_id = ?
      AND season = ?
      AND game_date < ?
      AND innings_pitched > 0
    ORDER BY game_date DESC
  `).all(mlbPitcherId, season, asOfDate);

  if (allStarts.length === 0) return null;

  // Season totals
  const totalIp = allStarts.reduce((s, r) => s + (r.innings_pitched ?? 0), 0);
  const totalK  = allStarts.reduce((s, r) => s + (r.strikeouts ?? 0), 0);
  const totalBb = allStarts.reduce((s, r) => s + (r.walks ?? 0), 0);
  const totalH  = allStarts.reduce((s, r) => s + (r.hits ?? 0), 0);
  const totalEr = allStarts.reduce((s, r) => s + (r.earned_runs ?? 0), 0);

  const k_per_9 = totalIp > 0 ? (totalK / totalIp) * 9 : null;
  const era = totalIp > 0 ? (totalEr / totalIp) * 9 : null;
  const whip = totalIp > 0 ? (totalBb + totalH) / totalIp : null;

  // Recent starts
  const recent = allStarts.slice(0, recentStarts);
  const recentIpSum = recent.reduce((s, r) => s + (r.innings_pitched ?? 0), 0);
  const recentKSum  = recent.reduce((s, r) => s + (r.strikeouts ?? 0), 0);

  const recent_k_per_9 = recentIpSum > 0 ? (recentKSum / recentIpSum) * 9 : k_per_9;
  const recent_ip = recent.length > 0 ? recentIpSum / recent.length : null;

  return { k_per_9, recent_k_per_9, recent_ip, era, whip, starts: allStarts.length };
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

  return cards;
}

function roundScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

/**
 * MLB currently has one configured game market: F5 total.
 * This helper keeps selector behavior explicit and stable before additional
 * MLB game markets arrive in later work items.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {Array<object>} driverCards
 * @returns {object}
 */
function selectMlbGameMarket(gameId, oddsSnapshot, driverCards = []) {
  const f5Card = driverCards.find((card) => card.market === 'f5_total') ?? null;
  const chosen_market = 'F5_TOTAL';
  const why_this_market = 'Rule 1: only configured MLB game market';
  const rejected = {};

  if (!f5Card) {
    rejected.F5_TOTAL = 'NO_F5_LINE';
  }

  return {
    game_id: gameId,
    matchup: `${oddsSnapshot?.away_team ?? 'unknown'} @ ${oddsSnapshot?.home_team ?? 'unknown'}`,
    chosen_market,
    why_this_market,
    markets: f5Card
      ? [
          {
            market: 'F5_TOTAL',
            status: f5Card.ev_threshold_passed ? 'FIRE' : 'PASS',
            prediction: f5Card.prediction,
            score: roundScore(f5Card.confidence),
            edge: f5Card.drivers?.[0]?.edge ?? null,
            projected: f5Card.drivers?.[0]?.projected ?? null,
            projection_source: f5Card.projection_source ?? null,
            status_cap: f5Card.status_cap ?? null,
            pass_reason_code: f5Card.pass_reason_code ?? null,
          },
        ]
      : [],
    rejected,
    selected_driver: f5Card,
  };
}

// ============================================================
// SHARP CHEDDAR K — Pitcher Strikeout Decision Engine v1.0
// Implements docs/pitcher_ks/01process.md through 07output.md
// ============================================================

const LEAGUE_AVG_K_PCT = 0.225; // ~22.5% — update seasonally
const MLB_K_DEFAULT_SWSTR_PCT = 0.112;
const MLB_K_DEFAULT_OPP_OBP = 0.315;
const MLB_K_DEFAULT_OPP_XWOBA = 0.320;
const MLB_K_DEFAULT_OPP_HARD_HIT_PCT = 39.0;
const MLB_K_MIN_PROJECTION_STARTS = 3;
const MLB_K_NO_EDGE_BAND_KS = 0.5;
const MLB_K_POISSON_THRESHOLDS = [5, 6, 7];
const MLB_K_PROJECTION_ONLY_PASS_REASON = 'PASS_PROJECTION_ONLY_NO_MARKET';

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
    opp_k_pct_vs_hand: seasonK ?? l30K ?? LEAGUE_AVG_K_PCT,
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
  const degradedInputs = [];
  const opponentProfile = resolveOpponentPitcherKProfile(matchup);
  const expectedIp =
    toFiniteNumberOrNull(LEASH_TIER_PARAMS[leashTier]?.expected_ip) ?? 5.0;
  const kLeashMult = getPitcherKLeashMultiplier(leashTier);

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
  // WI-0770: swstr_pct is a real Statcast signal — its absence is a true missing
  // input (not a degraded proxy). When absent: flag statcast_swstr, cap at LEAN.
  if (starterSwStrPct === null) missingInputs.push('statcast_swstr');
  // season_avg_velo absence noted but does not block (velo modifier simply omitted)
  if ((pitcher?.season_avg_velo ?? null) === null) missingInputs.push('statcast_velo');
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

  const effectiveStarterKPct = starterKPct ?? LEAGUE_AVG_K_PCT;
  const whiffProxyPct = starterSwStrPct ?? clampValue(
    effectiveStarterKPct * 0.42,
    0.08,
    0.18,
  );
  const oppKPctVsHand =
    opponentProfile.opp_k_pct_vs_hand ?? LEAGUE_AVG_K_PCT;
  const oppObp = opponentProfile.opp_obp ?? MLB_K_DEFAULT_OPP_OBP;
  const oppXwoba = opponentProfile.opp_xwoba ?? MLB_K_DEFAULT_OPP_XWOBA;
  const oppHardHitPct =
    opponentProfile.opp_hard_hit_pct ?? MLB_K_DEFAULT_OPP_HARD_HIT_PCT;

  const battersPerInning = clampValue(
    MLB_F5_DEFAULT_BF_PER_INNING +
      ((bbPct ?? MLB_F5_DEFAULT_TEAM_BB_PCT) - MLB_F5_DEFAULT_TEAM_BB_PCT) * 5.5 +
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
    (effectiveStarterKPct * oppKPctVsHand) / LEAGUE_AVG_K_PCT;
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

  // WI-0770: velocity tier modifier — only applied when season_avg_velo is present
  const veloMph = toFiniteNumberOrNull(pitcher?.season_avg_velo);
  if (veloMph !== null) {
    if (veloMph >= 95) kMean *= 1.025;      // high-velo advantage: +2.5%
    else if (veloMph < 90) kMean *= 0.975; // low-velo penalty: -2.5%
    // 90–94.9: no modifier
  }

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
    projection_source: missingInputs.length > 0
      ? 'SYNTHETIC_FALLBACK'
      : degradedInputs.length > 0 || projectionFlags.length > 0
        ? 'DEGRADED_MODEL'
        : 'FULL_MODEL',
    // WI-0770: null swstr_pct caps card at LEAN — real signal absent, not proxy-filled
    status_cap: starterSwStrPct === null ? 'LEAN' : 'PASS',
    missing_inputs: Array.from(new Set(missingInputs)),
    degraded_inputs: Array.from(new Set(degradedInputs)),
    statcast_inputs: {
      swstr_pct: starterSwStrPct,
      season_avg_velo: toFiniteNumberOrNull(pitcher?.season_avg_velo) ?? null,
    },
    playability: {
      over_playable_at_or_below: overPlayableAtOrBelow,
      under_playable_at_or_above: underPlayableAtOrAbove,
    },
    fair_prices: ladder.fair_prices,
    probability_ladder: ladder.probability_ladder,
    flags: projectionFlags,
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

/**
 * Block 5: trap scan.
 * docs/pitcher_ks/06trap.md
 */
function runTrapScan(pitcher, matchup, market, ump, weather, opts) {
  const { side = 'over', projectionOnly = false, block1Score = 0 } = opts || {};
  const flags = [];

  // 1. Public bias
  if (pitcher?.is_star_name && market?.over_bet_pct > 0.70 &&
      market?.line_soft_vs_comparable && block1Score <= 1)
    flags.push('PUBLIC_BIAS');

  // 2. Hidden role risk
  if (matchup?.has_role_signal)
    flags.push('HIDDEN_ROLE_RISK');

  // 3. Lineup context gap (only with confirmed lineup)
  if (!projectionOnly && matchup?.confirmed_lineup &&
      ((matchup.high_k_hitters_absent ?? 0) >= 2 || matchup.handedness_shift_material))
    flags.push('LINEUP_CONTEXT_GAP');

  // 4. Market movement anomaly (full mode only)
  if (!projectionOnly && market?.movement_against_play &&
      (market?.movement_magnitude ?? 0) >= 0.5 && market?.movement_source_sharp)
    flags.push('SHARP_COUNTER_MOVEMENT');

  // 5. Weather / park
  const temp = weather?.temp_at_first_pitch ?? weather?.temp_f;
  if (temp != null && temp < 45 && !pitcher?.projection_weather_adjusted)
    flags.push('WEATHER_UNACCOUNTED');
  if ((weather?.wind_in_mph ?? 0) > 15 && weather?.wind_direction === 'IN')
    flags.push('WIND_SUPPRESSION');

  // 6. Ump suppression (overs only)
  if (side === 'over' && (ump?.k_rate_diff_vs_league ?? 0) < -0.04 &&
      (ump?.games_behind_plate_current_season ?? 0) >= 30)
    flags.push('UMP_SUPPRESSION');

  return {
    flags,
    count: flags.length,
    block5_score: flags.length === 0 ? 1 : 0,
    verdict_eligible: flags.length < 2,
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
 * Output always includes basis='PROJECTION_ONLY' and explicit reason_codes.
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
    return {
      status: 'HALTED',
      halted_at: 'STEP_1',
      reason_code: leashResult.flag,
      verdict: 'PASS',
      basis: mode,
      projection_only: true,
      reason_codes: [
        MLB_K_PROJECTION_ONLY_PASS_REASON,
        leashResult.flag,
        `MODE_FORCED:${_requestedMode}->PROJECTION_ONLY`,
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
    };
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
    return {
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
        `MODE_FORCED:${_requestedMode}->PROJECTION_ONLY`,
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
    };
  }
  const projection = projResult.value;
  reasonCodes.push(...(projResult.flags || []));
  reasonCodes.push(...(projResult.missing_inputs || []).map((field) => `MISSING_INPUT:${field}`));
  reasonCodes.push(...(projResult.degraded_inputs || []).map((field) => `DEGRADED_INPUT:${field}`));
  if (_requestedMode !== 'PROJECTION_ONLY') {
    reasonCodes.push(`MODE_FORCED:${_requestedMode}->PROJECTION_ONLY`);
  }

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
    return {
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
      ])),
    };
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
    side, projectionOnly, block1Score,
  });
  if (!trapResult.verdict_eligible) {
    return {
      status: 'SUSPENDED',
      halted_at: 'STEP_5',
      reason_code: 'ENVIRONMENT_COMPROMISED',
      trap_flags: trapResult.flags,
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
    };
  }
  const block5Score = trapResult.block5_score;

  // Step 6 — Confidence scoring
  const penalties = calculatePenalties(pitcherInput, matchupInput || {});
  const rawScore  = block1Score + block2Score + block3Score + block4Score + block5Score;
  const netScore  = Math.max(0, rawScore + penalties.total);
  const tier = getConfidenceTier(netScore);

  return {
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
    verdict: 'PASS',
    trap_flags: trapResult.flags,
    reason_codes: Array.from(new Set([
      ...reasonCodes,
      ...(leashResult.flag ? [leashResult.flag] : []),
      ...(trapResult.flags || []),
    ])),
    basis: mode,
    projection_only: projectionOnly,
  };
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
 * Default mode is PROJECTION_ONLY — no market line required.
 * When mode='ODDS_BACKED', attempts to select an under market from
 * raw_data.mlb.strikeout_lines and calls scorePitcherKUnder.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {object} [options]
 * @param {'PROJECTION_ONLY'|'ODDS_BACKED'} [options.mode]
 * @param {object} [options.bookmakerPriority]  bookmaker -> priority map (required for ODDS_BACKED)
 * @returns {Array<object>}
 */
function computePitcherKDriverCards(gameId, oddsSnapshot, options) {
  const requestedMode = (options || {}).mode || 'PROJECTION_ONLY';
  const bookmakerPriority = (options || {}).bookmakerPriority || {};
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

    // ── ODDS_BACKED branch ─────────────────────────────────────────────────
    if (requestedMode === 'ODDS_BACKED') {
      const strikeoutLinesMap = mlb.strikeout_lines ?? {};
      const selectedMarket = selectPitcherKUnderMarket(
        strikeoutLinesMap,
        playerName,
        bookmakerPriority,
      );

      if (selectedMarket !== null) {
        const normalizedMarket = normalizePitcherKMarketInput(selectedMarket);
        const underResult = scorePitcherKUnder(pitcherInput, matchupInput, normalizedMarket, weatherInput);
        const verdict = underResult.verdict ?? 'NO_PLAY';
        const emitCard = verdict === 'PLAY' || verdict === 'WATCH';
        // Determine prop_display_state inline
        const propDisplayState = verdict === 'PLAY' ? 'PLAY' : verdict === 'WATCH' ? 'WATCH' : 'PROJECTION_ONLY';
        const underReasonCodes = Array.from(new Set([
          'ODDS_BACKED_UNDER',
          ...(Array.isArray(underResult.flags) ? underResult.flags : []),
        ]));

        cards.push({
          market: `pitcher_k_${role}`,
          pitcher_team: team,
          player_id: playerId,
          player_name: playerName,
          prediction: verdict,
          status: verdict,
          action: verdict,
          classification: verdict,
          confidence: 0,
          ev_threshold_passed: emitCard,
          emit_card: emitCard,
          card_verdict: verdict,
          tier: null,
          reasoning: _buildPitcherKReasoning(underResult),
          projection_source: 'ODDS_BACKED',
          status_cap: verdict,
          missing_inputs: [],
          reason_codes: underReasonCodes,
          pass_reason_code: null,
          playability: null,
          projection: null,
          drivers: [{
            type: 'pitcher-k',
            projection: underResult.projection ?? null,
            k_mean: null,
            probability_ladder: null,
            fair_prices: null,
            leash_tier: null,
            net_score: null,
            tier: null,
          }],
          prop_decision: {
            verdict,
            lean_side: 'UNDER',
            line: normalizedMarket?.line ?? null,
            display_price: normalizedMarket?.under_price ?? null,
            projection: underResult.projection ?? null,
            k_mean: null,
            line_delta: underResult.line_delta ?? null,
            under_score: underResult.under_score ?? null,
            score_components: underResult.score_components ?? null,
            history_metrics: underResult.history_metrics ?? null,
            current_form_metrics: underResult.current_form_metrics ?? null,
            selected_market: underResult.selected_market ?? null,
            flags: underResult.flags ?? null,
            why: underResult.why ?? null,
            probability_ladder: null,
            fair_prices: null,
            playability: null,
            projection_source: 'ODDS_BACKED',
            status_cap: verdict,
            missing_inputs: [],
            fair_prob: null,
            implied_prob: null,
            prob_edge_pp: null,
            ev: null,
          },
          prop_display_state: propDisplayState,
          pitcher_k_result: underResult,
          basis: 'ODDS_BACKED',
          direction: 'UNDER',
          line: normalizedMarket?.line ?? null,
          line_source: normalizedMarket?.line_source ?? null,
          over_price: normalizedMarket?.over_price ?? null,
          under_price: normalizedMarket?.under_price ?? null,
          best_line_bookmaker: normalizedMarket?.bookmaker ?? null,
        });
        continue; // skip PROJECTION_ONLY path for this pitcher
      }

      // ODDS_BACKED requested but no qualifying market found — fall back to PROJECTION_ONLY
      // and annotate with reason code.
    }
    // ── PROJECTION_ONLY path (default + ODDS_BACKED fallback) ──────────────

    const result = scorePitcherK(
      pitcherInput,
      matchupInput,
      {},
      null,
      weatherInput,
      { mode: requestedMode, side: 'over' },
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
    const passReasonCode =
      reasonCodes.find((code) => code.startsWith('PASS_')) ??
      MLB_K_PROJECTION_ONLY_PASS_REASON;

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
      reasoning: _buildPitcherKReasoning(result),
      projection_source: result.projection_source ?? 'SYNTHETIC_FALLBACK',
      status_cap: result.status_cap ?? 'PASS',
      missing_inputs: Array.isArray(result.missing_inputs) ? result.missing_inputs : [],
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
        missing_inputs: Array.isArray(result.missing_inputs) ? result.missing_inputs : [],
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
    return `HALTED at ${result.halted_at}: ${result.reason_code}`;
  if (result.status === 'SUSPENDED')
    return `SUSPENDED — environment compromised: ${(result.trap_flags || []).join(', ')}`;
  const parts = [];
  if (result.projection != null) parts.push(`K mean: ${result.projection} Ks`);
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

module.exports = {
  projectStrikeouts,
  projectF5Total,
  projectF5TotalCard,
  projectF5ML,
  computeMLBDriverCards,
  selectMlbGameMarket,
  computePitcherStatsAsOf,
  // Sharp Cheddar K pipeline
  scorePitcherK,
  scorePitcherKUnder,
  buildUnderHistoryMetrics,
  normalizePitcherKMarketInput,
  selectPitcherKUnderMarket,
  computePitcherKDriverCards,
  // Exported for unit testing (WI-0770)
  calculateProjectionK,
};
