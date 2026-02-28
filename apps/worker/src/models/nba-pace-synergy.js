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
 * Percentile computation uses 2025-26 season linear approximation:
 *   pct = (pace - 99.3) / (107.8 - 99.3) * 100, clamped [0, 100]
 */

// 2025-26 season reference range (from cheddar-nba-2.0 pace_synergy.py)
const PACE_MIN = 99.3;
const PACE_MAX = 107.8;

// Percentile thresholds for pace classification
const FAST_THRESHOLD_PCT   = 70.0;  // 70th percentile = FAST (~105.0+ pace)
const VERY_FAST_THRESHOLD  = 80.0;  // 80th percentile = VERY FAST (~105.4+ pace)
const SLOW_THRESHOLD_PCT   = 30.0;  // 30th percentile = SLOW (~102.5- pace)
const VERY_SLOW_THRESHOLD  = 20.0;  // 20th percentile = VERY SLOW (~101.5- pace)
const PACE_CLASH_THRESHOLD = 40.0;  // Percentile gap to classify as pace clash

// NBA 2025-26 league median ORtg (offensive efficiency proxy)
const LEAGUE_MEDIAN_OFF_EFF = 113.0;

// Possession adjustments (from Python constants)
const FAST_FAST_BOOST_FULL   = 0.6;
const FAST_FAST_BOOST_HALF   = 0.3;
const VERY_FAST_BOOST_FULL   = 1.2;
const VERY_FAST_BOOST_HALF   = 0.6;
const SLOW_SLOW_PENALTY      = -0.6;
const VERY_SLOW_SLOW_PENALTY = -1.2;

/**
 * Convert raw pace value to a percentile [0, 100] using the 2025-26 linear
 * approximation of the league distribution.
 *
 * @param {number|null} pace
 * @returns {number|null}
 */
function paceToPct(pace) {
  if (pace === null || pace === undefined) return null;
  const pct = (pace - PACE_MIN) / (PACE_MAX - PACE_MIN) * 100;
  return Math.max(0, Math.min(100, pct));
}

/**
 * Handle VERY FAST x VERY FAST matchup (both >= 80th percentile).
 */
function _handleVeryFastFast(homePacePct, awayPacePct, homeOffEff, awayOffEff) {
  const passesGate = (homeOffEff !== null && homeOffEff >= LEAGUE_MEDIAN_OFF_EFF)
                  && (awayOffEff !== null && awayOffEff >= LEAGUE_MEDIAN_OFF_EFF);

  if (passesGate) {
    return {
      synergyType: 'VERY_FAST\xd7VERY_FAST',
      paceAdjustment: VERY_FAST_BOOST_FULL,
      passesEfficiencyGate: true,
      homePacePct,
      awayPacePct,
      bettingSignal: 'ELITE_OVER',
      reasoning: `VERY_FAST\xd7VERY_FAST elite synergy (both \u226580th pct). Both highly efficient (ORtg \u2265${LEAGUE_MEDIAN_OFF_EFF}). Maximum boost: totals explosion territory.`
    };
  }

  return {
    synergyType: 'VERY_FAST\xd7VERY_FAST',
    paceAdjustment: VERY_FAST_BOOST_HALF,
    passesEfficiencyGate: false,
    homePacePct,
    awayPacePct,
    bettingSignal: 'ATTACK_OVER',
    reasoning: `VERY_FAST\xd7VERY_FAST pace (both \u226580th pct) but mediocre efficiency. Home ORtg=${(homeOffEff ?? 'N/A')}, Away ORtg=${(awayOffEff ?? 'N/A')}. Reduced boost: extreme pace still compounds possessions despite scoring limits.`
  };
}

/**
 * Handle FAST x FAST matchup (both >= 70th percentile, < 80th).
 */
function _handleFastFast(homePacePct, awayPacePct, homeOffEff, awayOffEff) {
  const passesGate = (homeOffEff !== null && homeOffEff >= LEAGUE_MEDIAN_OFF_EFF)
                  && (awayOffEff !== null && awayOffEff >= LEAGUE_MEDIAN_OFF_EFF);

  if (passesGate) {
    return {
      synergyType: 'FAST\xd7FAST',
      paceAdjustment: FAST_FAST_BOOST_FULL,
      passesEfficiencyGate: true,
      homePacePct,
      awayPacePct,
      bettingSignal: 'ATTACK_OVER',
      reasoning: `FAST\xd7FAST synergy (both \u226570th pct). Both efficient (ORtg \u2265${LEAGUE_MEDIAN_OFF_EFF}). Full boost: possessions compound.`
    };
  }

  return {
    synergyType: 'FAST\xd7FAST',
    paceAdjustment: FAST_FAST_BOOST_HALF,
    passesEfficiencyGate: false,
    homePacePct,
    awayPacePct,
    bettingSignal: 'LEAN_OVER',
    reasoning: `FAST\xd7FAST pace (both \u226570th pct) but mediocre efficiency. Home ORtg=${(homeOffEff ?? 'N/A')}, Away ORtg=${(awayOffEff ?? 'N/A')}. Reduced boost: pace creates chances but scoring efficiency limits upside.`
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
function analyzePaceSynergy(homePace, awayPace, homeOffEff, awayOffEff) {
  const homePacePct = paceToPct(homePace);
  const awayPacePct = paceToPct(awayPace);

  // Null check: cannot compute synergy without valid pace data
  if (homePacePct === null || awayPacePct === null) {
    return null;
  }

  // VERY FAST x VERY FAST (both >= 80th pct)
  if (homePacePct >= VERY_FAST_THRESHOLD && awayPacePct >= VERY_FAST_THRESHOLD) {
    return _handleVeryFastFast(homePacePct, awayPacePct, homeOffEff, awayOffEff);
  }

  // FAST x FAST (both >= 70th pct)
  if (homePacePct >= FAST_THRESHOLD_PCT && awayPacePct >= FAST_THRESHOLD_PCT) {
    return _handleFastFast(homePacePct, awayPacePct, homeOffEff, awayOffEff);
  }

  // VERY SLOW x VERY SLOW (both <= 20th pct)
  if (homePacePct <= VERY_SLOW_THRESHOLD && awayPacePct <= VERY_SLOW_THRESHOLD) {
    return {
      synergyType: 'VERY_SLOW\xd7VERY_SLOW',
      paceAdjustment: VERY_SLOW_SLOW_PENALTY,
      passesEfficiencyGate: true,  // No gate required for slow matchups
      homePacePct,
      awayPacePct,
      bettingSignal: 'BEST_UNDER',
      reasoning: 'VERY_SLOW\xd7VERY_SLOW elite grind (both \u226420th pct). Extreme possession suppression. These are best UNDER environments. Market often inflated due to brand names.'
    };
  }

  // SLOW x SLOW (both <= 30th pct)
  if (homePacePct <= SLOW_THRESHOLD_PCT && awayPacePct <= SLOW_THRESHOLD_PCT) {
    return {
      synergyType: 'SLOW\xd7SLOW',
      paceAdjustment: SLOW_SLOW_PENALTY,
      passesEfficiencyGate: true,  // No gate required for slow matchups
      homePacePct,
      awayPacePct,
      bettingSignal: 'STRONG_UNDER',
      reasoning: 'SLOW\xd7SLOW grind game (both \u226430th pct). Both teams shorten the game. Half-court possessions dominate. Fewer transition opportunities.'
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
      reasoning: `Pace clash detected (${paceGap.toFixed(0)} percentile gap). One team likely dictates tempo.`
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
    reasoning: 'No pace synergy (teams not both fast or both slow)'
  };
}

module.exports = { analyzePaceSynergy };
