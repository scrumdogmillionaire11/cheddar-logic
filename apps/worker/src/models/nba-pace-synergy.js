'use strict';

/**
 * NBA Pace Synergy Model
 *
 * JS port of cheddar-nba-2.0/src/services/pace_synergy.py (PaceSynergyService).
 * Models possession amplification/suppression when both teams share similar
 * pace profiles.
 *
 * Pace is NOT just averaged — certain matchups create compounding effects:
 *   FAST x FAST:  Both teams accelerate each other (compound possessions)
 *   SLOW x SLOW:  Both teams suppress possessions (grind-it-out games)
 *   Mixed Pace:   No synergy (one team dictates or effects cancel)
 *
 * Percentile computation defaults to the 2025-26 season linear approximation:
 *   pct = (pace - 99.3) / (107.8 - 99.3) * 100, clamped [0, 100]
 *
 * The worker can provide live league baselines computed from team_metrics_cache.
 */

// 2025-26 season fallback range (from cheddar-nba-2.0 pace_synergy.py)
const FALLBACK_PACE_MIN = 99.3;
const FALLBACK_PACE_MAX = 107.8;
const FALLBACK_LEAGUE_MEDIAN_OFF_EFF = 113.0;

let activeLeagueBaselines = null;

// Percentile thresholds for pace classification
const FAST_THRESHOLD_PCT = 70.0; // 70th percentile = FAST (~105.0+ pace)
const VERY_FAST_THRESHOLD = 80.0; // 80th percentile = VERY FAST (~105.4+ pace)
const SLOW_THRESHOLD_PCT = 30.0; // 30th percentile = SLOW (~102.5- pace)
const VERY_SLOW_THRESHOLD = 20.0; // 20th percentile = VERY SLOW (~101.5- pace)
const PACE_CLASH_THRESHOLD = 40.0; // Percentile gap to classify as pace clash

// Possession adjustments (from Python constants)
const FAST_FAST_BOOST_FULL = 0.6;
const FAST_FAST_BOOST_HALF = 0.3;
const VERY_FAST_BOOST_FULL = 1.2;
const VERY_FAST_BOOST_HALF = 0.6;
const SLOW_SLOW_PENALTY = -0.6;
const VERY_SLOW_SLOW_PENALTY = -1.2;
const PACE_ADJUSTMENT_MAX = 1.5;

function clampPaceAdjustment(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 0;
  return Math.max(-PACE_ADJUSTMENT_MAX, Math.min(PACE_ADJUSTMENT_MAX, value));
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMetricsPayload(metrics) {
  if (!metrics) return null;
  if (typeof metrics === 'object') return metrics;
  try {
    return JSON.parse(metrics);
  } catch (_) {
    return null;
  }
}

function pickFirstFinite(...values) {
  for (const value of values) {
    const parsed = toFiniteNumberOrNull(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function extractBaselineSample(row) {
  const metrics = parseMetricsPayload(row?.metrics);
  if (!metrics || typeof metrics !== 'object') return null;

  const pace = pickFirstFinite(
    metrics.pace,
    metrics.paceHome,
    metrics.paceAway,
    metrics.possessions,
    metrics.possessions_per_game,
  );
  const explicitOffEff = pickFirstFinite(
    metrics.offensiveRating,
    metrics.offensive_rating,
    metrics.offRtg,
    metrics.off_rtg,
    metrics.ortg,
    metrics.offensiveEfficiency,
    metrics.offensive_efficiency,
    metrics.offEff,
    metrics.off_eff,
  );
  const avgPoints = pickFirstFinite(
    metrics.avgPoints,
    metrics.avgPts,
    metrics.points_per_game,
  );
  const offEff = explicitOffEff ?? avgPoints;

  if (pace === null || offEff === null) return null;
  return { pace, offEff };
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function hardcodedFallbackBaselines(gamesUsed = 0) {
  return {
    paceMin: FALLBACK_PACE_MIN,
    paceMax: FALLBACK_PACE_MAX,
    medianOffEff: FALLBACK_LEAGUE_MEDIAN_OFF_EFF,
    gamesUsed,
    source: 'fallback',
  };
}

function normalizeBaselines(baselines) {
  const source = baselines || activeLeagueBaselines || hardcodedFallbackBaselines();
  const paceMin = toFiniteNumberOrNull(source.paceMin) ?? FALLBACK_PACE_MIN;
  const paceMax = toFiniteNumberOrNull(source.paceMax) ?? FALLBACK_PACE_MAX;
  const leagueMedianOffEff =
    toFiniteNumberOrNull(source.leagueMedianOffEff) ??
    toFiniteNumberOrNull(source.medianOffEff) ??
    FALLBACK_LEAGUE_MEDIAN_OFF_EFF;

  if (paceMax <= paceMin) {
    return {
      paceMin: FALLBACK_PACE_MIN,
      paceMax: FALLBACK_PACE_MAX,
      leagueMedianOffEff,
    };
  }

  return { paceMin, paceMax, leagueMedianOffEff };
}

function setNbaLeagueBaselinesForRun(baselines) {
  activeLeagueBaselines = baselines && typeof baselines === 'object'
    ? {
        paceMin: toFiniteNumberOrNull(baselines.paceMin) ?? FALLBACK_PACE_MIN,
        paceMax: toFiniteNumberOrNull(baselines.paceMax) ?? FALLBACK_PACE_MAX,
        leagueMedianOffEff:
          toFiniteNumberOrNull(baselines.leagueMedianOffEff) ??
          toFiniteNumberOrNull(baselines.medianOffEff) ??
          FALLBACK_LEAGUE_MEDIAN_OFF_EFF,
      }
    : null;
}

function resetNbaLeagueBaselinesForRun() {
  activeLeagueBaselines = null;
}

function computeNbaLeagueBaselines({ db, logger = console } = {}) {
  if (!db || typeof db.prepare !== 'function') {
    logger.warn?.('[NBA_BASELINES] insufficient data - using hardcoded fallback');
    return hardcodedFallbackBaselines(0);
  }

  let rows = [];
  try {
    const stmt = db.prepare(`
      SELECT metrics, fetched_at, cache_date
      FROM team_metrics_cache
      WHERE UPPER(sport) = 'NBA'
        AND metrics IS NOT NULL
        AND fetched_at >= datetime('now', '-14 days')
      ORDER BY fetched_at DESC
    `);
    rows = typeof stmt.all === 'function' ? stmt.all() : [];
  } catch (_) {
    logger.warn?.('[NBA_BASELINES] insufficient data - using hardcoded fallback');
    return hardcodedFallbackBaselines(0);
  }
  const samples = rows
    .map(extractBaselineSample)
    .filter(Boolean);

  if (samples.length < 10) {
    logger.warn?.('[NBA_BASELINES] insufficient data - using hardcoded fallback');
    return hardcodedFallbackBaselines(samples.length);
  }

  const sortedPace = samples.map((sample) => sample.pace).sort((a, b) => a - b);
  const p5idx = Math.floor(sortedPace.length * 0.05);
  const p95idx = Math.ceil(sortedPace.length * 0.95) - 1;
  const paceMin = sortedPace[Math.max(0, p5idx)];
  const paceMax = sortedPace[Math.min(sortedPace.length - 1, p95idx)];
  const medianOffEff = median(samples.map((sample) => sample.offEff));

  logger.log?.(
    `[NBA_BASELINES] paceMin=${paceMin.toFixed(1)} paceMax=${paceMax.toFixed(1)} medianOffEff=${medianOffEff.toFixed(1)} gamesUsed=${samples.length}`,
  );

  return {
    paceMin,
    paceMax,
    medianOffEff,
    gamesUsed: samples.length,
    source: 'computed',
  };
}

/**
 * Convert raw pace value to a percentile [0, 100] using the 2025-26 linear
 * approximation of the league distribution.
 *
 * @param {number|null} pace
 * @param {object|null} baselines
 * @returns {number|null}
 */
function paceToPct(pace, baselines = null) {
  if (pace === null || pace === undefined) return null;
  const { paceMin, paceMax } = normalizeBaselines(baselines);
  const pct = ((pace - paceMin) / (paceMax - paceMin)) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Handle VERY FAST x VERY FAST matchup (both >= 80th percentile).
 */
function _handleVeryFastFast(
  homePacePct,
  awayPacePct,
  homeOffEff,
  awayOffEff,
  leagueMedianOffEff,
) {
  const passesGate =
    homeOffEff !== null &&
    homeOffEff >= leagueMedianOffEff &&
    awayOffEff !== null &&
    awayOffEff >= leagueMedianOffEff;

  if (passesGate) {
    return {
      synergyType: 'VERY_FAST\xd7VERY_FAST',
      paceAdjustment: clampPaceAdjustment(VERY_FAST_BOOST_FULL),
      passesEfficiencyGate: true,
      homePacePct,
      awayPacePct,
      bettingSignal: 'ELITE_OVER',
      reasoning: `VERY_FAST\xd7VERY_FAST elite synergy (both \u226580th pct). Both highly efficient (ORtg \u2265${leagueMedianOffEff}). Maximum boost: totals explosion territory.`,
    };
  }

  return {
    synergyType: 'VERY_FAST\xd7VERY_FAST',
    paceAdjustment: clampPaceAdjustment(VERY_FAST_BOOST_HALF),
    passesEfficiencyGate: false,
    homePacePct,
    awayPacePct,
    bettingSignal: 'ATTACK_OVER',
    reasoning: `VERY_FAST\xd7VERY_FAST pace (both \u226580th pct) but mediocre efficiency. Home ORtg=${homeOffEff ?? 'N/A'}, Away ORtg=${awayOffEff ?? 'N/A'}. Reduced boost: extreme pace still compounds possessions despite scoring limits.`,
  };
}

/**
 * Handle FAST x FAST matchup (both >= 70th percentile, < 80th).
 */
function _handleFastFast(
  homePacePct,
  awayPacePct,
  homeOffEff,
  awayOffEff,
  leagueMedianOffEff,
) {
  const passesGate =
    homeOffEff !== null &&
    homeOffEff >= leagueMedianOffEff &&
    awayOffEff !== null &&
    awayOffEff >= leagueMedianOffEff;

  if (passesGate) {
    return {
      synergyType: 'FAST\xd7FAST',
      paceAdjustment: clampPaceAdjustment(FAST_FAST_BOOST_FULL),
      passesEfficiencyGate: true,
      homePacePct,
      awayPacePct,
      bettingSignal: 'ATTACK_OVER',
      reasoning: `FAST\xd7FAST synergy (both \u226570th pct). Both efficient (ORtg \u2265${leagueMedianOffEff}). Full boost: possessions compound.`,
    };
  }

  return {
    synergyType: 'FAST\xd7FAST',
    paceAdjustment: clampPaceAdjustment(FAST_FAST_BOOST_HALF),
    passesEfficiencyGate: false,
    homePacePct,
    awayPacePct,
    bettingSignal: 'LEAN_OVER',
    reasoning: `FAST\xd7FAST pace (both \u226570th pct) but mediocre efficiency. Home ORtg=${homeOffEff ?? 'N/A'}, Away ORtg=${awayOffEff ?? 'N/A'}. Reduced boost: pace creates chances but scoring efficiency limits upside.`,
  };
}

/**
 * Analyze pace synergy between two NBA teams.
 *
 * @param {number|null} homePace - raw pace value (possessions/game proxy)
 * @param {number|null} awayPace
 * @param {number|null} homeOffEff - offensive rating proxy (avgPoints / ORtg)
 * @param {number|null} awayOffEff
 * @returns {object|null} synergy result or null if insufficient data
 *   Shape: { synergyType, paceAdjustment, bettingSignal, homePacePct, awayPacePct,
 *            passesEfficiencyGate, reasoning }
 */
function analyzePaceSynergy(
  homePace,
  awayPace,
  homeOffEff,
  awayOffEff,
  baselines = null,
) {
  const resolvedBaselines = normalizeBaselines(baselines);
  const homePacePct = paceToPct(homePace, resolvedBaselines);
  const awayPacePct = paceToPct(awayPace, resolvedBaselines);

  // Null check: cannot compute synergy without valid pace data
  if (homePacePct === null || awayPacePct === null) {
    return null;
  }

  // VERY FAST x VERY FAST (both >= 80th pct)
  if (
    homePacePct >= VERY_FAST_THRESHOLD &&
    awayPacePct >= VERY_FAST_THRESHOLD
  ) {
    return _handleVeryFastFast(
      homePacePct,
      awayPacePct,
      homeOffEff,
      awayOffEff,
      resolvedBaselines.leagueMedianOffEff,
    );
  }

  // FAST x FAST (both >= 70th pct)
  if (homePacePct >= FAST_THRESHOLD_PCT && awayPacePct >= FAST_THRESHOLD_PCT) {
    return _handleFastFast(
      homePacePct,
      awayPacePct,
      homeOffEff,
      awayOffEff,
      resolvedBaselines.leagueMedianOffEff,
    );
  }

  // VERY SLOW x VERY SLOW (both <= 20th pct)
  if (
    homePacePct <= VERY_SLOW_THRESHOLD &&
    awayPacePct <= VERY_SLOW_THRESHOLD
  ) {
    return {
      synergyType: 'VERY_SLOW\xd7VERY_SLOW',
      paceAdjustment: clampPaceAdjustment(VERY_SLOW_SLOW_PENALTY),
      passesEfficiencyGate: true, // No gate required for slow matchups
      homePacePct,
      awayPacePct,
      bettingSignal: 'BEST_UNDER',
      reasoning:
        'VERY_SLOW\xd7VERY_SLOW elite grind (both \u226420th pct). Extreme possession suppression. These are best UNDER environments. Market often inflated due to brand names.',
    };
  }

  // SLOW x SLOW (both <= 30th pct)
  if (homePacePct <= SLOW_THRESHOLD_PCT && awayPacePct <= SLOW_THRESHOLD_PCT) {
    return {
      synergyType: 'SLOW\xd7SLOW',
      paceAdjustment: clampPaceAdjustment(SLOW_SLOW_PENALTY),
      passesEfficiencyGate: true, // No gate required for slow matchups
      homePacePct,
      awayPacePct,
      bettingSignal: 'STRONG_UNDER',
      reasoning:
        'SLOW\xd7SLOW grind game (both \u226430th pct). Both teams shorten the game. Half-court possessions dominate. Fewer transition opportunities.',
    };
  }

  // PACE CLASH (large gap between the two teams' pace percentiles)
  const paceGap = Math.abs(homePacePct - awayPacePct);
  if (paceGap >= PACE_CLASH_THRESHOLD) {
    return {
      synergyType: 'PACE_CLASH',
      paceAdjustment: 0,
      passesEfficiencyGate: false,
      homePacePct,
      awayPacePct,
      bettingSignal: 'NO_EDGE',
      reasoning: `Pace clash detected (${paceGap.toFixed(0)} percentile gap). One team likely dictates tempo.`,
    };
  }

  // No meaningful synergy
  return {
    synergyType: 'NONE',
    paceAdjustment: 0,
    passesEfficiencyGate: false,
    homePacePct,
    awayPacePct,
    bettingSignal: 'NO_EDGE',
    reasoning: 'No pace synergy (teams not both fast or both slow)',
  };
}

module.exports = {
  analyzePaceSynergy,
  computeNbaLeagueBaselines,
  setNbaLeagueBaselinesForRun,
  resetNbaLeagueBaselinesForRun,
  paceToPct,
  FALLBACK_PACE_MIN,
  FALLBACK_PACE_MAX,
  FALLBACK_LEAGUE_MEDIAN_OFF_EFF,
};
