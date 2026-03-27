'use strict';

/**
 * MLB Model — Pure arithmetic pitcher-based projections.
 *
 * No DB calls, no network. All inputs come from oddsSnapshot.raw_data.mlb.
 *
 * Exports:
 *   projectStrikeouts(pitcherStats, line, overlays)  → strikeout prop card
 *   projectF5Total(homePitcher, awayPitcher)          → raw F5 projection
 *   projectF5TotalCard(home, away, f5Line)            → F5 card with thresholds
 *   computeMLBDriverCards(gameId, oddsSnapshot)       → array of card descriptors
 */

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
 * Formula: ERA-based expected runs per team × 5/9 innings fraction.
 * Overlays: WHIP (run-prevention proxy), K/9 (strikeout suppression).
 *
 * @param {object} homePitcher
 * @param {object} awayPitcher
 * @returns {object|null}
 */
function projectF5Total(homePitcher, awayPitcher) {
  // Both pitchers required
  if (!homePitcher || !awayPitcher) return null;
  if (homePitcher.era == null || awayPitcher.era == null) return null;

  const LEAGUE_AVG_RPG = 4.5;
  const homeExpected = (awayPitcher.era + LEAGUE_AVG_RPG) / 2;
  const awayExpected = (homePitcher.era + LEAGUE_AVG_RPG) / 2;
  let base = (homeExpected + awayExpected) * (5 / 9);

  // WHIP overlay
  const avgWhip = ((homePitcher.whip ?? 1.25) + (awayPitcher.whip ?? 1.25)) / 2;
  if (avgWhip > 1.40) base *= 1.15;
  else if (avgWhip < 1.10) base *= 0.90;

  // K/9 overlay
  const avgK9 = ((homePitcher.k_per_9 ?? 8.5) + (awayPitcher.k_per_9 ?? 8.5)) / 2;
  if (avgK9 > 10.0) base *= 0.92;
  else if (avgK9 < 7.0) base *= 1.08;

  // Confidence 1-10
  let confidence = 5;
  if (homePitcher.era < 3.50 && awayPitcher.era < 3.50) confidence += 2;
  if ((homePitcher.whip ?? 1.25) < 1.20 && (awayPitcher.whip ?? 1.25) < 1.20) confidence += 1;
  if (homePitcher.era > 5.00 || awayPitcher.era > 5.00) confidence -= 2;
  if (Math.abs(homePitcher.era - awayPitcher.era) > 2.0) confidence -= 1;
  confidence = Math.max(1, Math.min(10, confidence));

  return { base, confidence, avgWhip, avgK9 };
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
 * @returns {object|null}
 */
function projectF5TotalCard(homePitcher, awayPitcher, f5Line) {
  const proj = projectF5Total(homePitcher, awayPitcher);
  if (!proj || f5Line == null) return null;

  const edge = proj.base - f5Line;
  const isOver = edge >= 0.5 && proj.confidence >= 8;
  const isUnder = edge <= -0.7 && proj.confidence >= 8;
  const prediction = isOver ? 'OVER' : isUnder ? 'UNDER' : 'PASS';

  return {
    prediction,
    edge,
    projected: proj.base,
    confidence: proj.confidence,
    ev_threshold_passed: isOver || isUnder,
    reasoning: `F5 projected ${proj.base.toFixed(2)} vs line ${f5Line} (edge ${edge >= 0 ? '+' : ''}${edge.toFixed(2)}, avgWHIP=${proj.avgWhip.toFixed(2)}, avgK9=${proj.avgK9.toFixed(1)}, conf ${proj.confidence}/10)`,
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
 *   home_pitcher, away_pitcher, strikeout_lines.{home,away}, f5_line
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

  // Extract weather overlays from raw_data.mlb (populated by enrichMlbPitcherData)
  const weatherOverlays = {
    wind_mph: mlb.wind_mph ?? null,
    temp_f: mlb.temp_f ?? null,
  };

  // Strikeout card — home pitcher
  if (homePitcher && mlb.strikeout_lines?.home != null) {
    const result = projectStrikeouts(homePitcher, mlb.strikeout_lines.home, weatherOverlays);
    if (result) {
      cards.push({
        market: 'strikeouts_home',
        pitcher: oddsSnapshot?.home_team,
        prediction: result.prediction,
        confidence: result.confidence / 10, // normalize to 0-1
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        drivers: [{ type: 'mlb-strikeout', edge: result.edge, projected: result.projected }],
      });
    }
  }

  // Strikeout card — away pitcher
  if (awayPitcher && mlb.strikeout_lines?.away != null) {
    const result = projectStrikeouts(awayPitcher, mlb.strikeout_lines.away, weatherOverlays);
    if (result) {
      cards.push({
        market: 'strikeouts_away',
        pitcher: oddsSnapshot?.away_team,
        prediction: result.prediction,
        confidence: result.confidence / 10,
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        drivers: [{ type: 'mlb-strikeout', edge: result.edge, projected: result.projected }],
      });
    }
  }

  // F5 total card
  if (homePitcher && awayPitcher && mlb.f5_line != null) {
    const result = projectF5TotalCard(homePitcher, awayPitcher, mlb.f5_line);
    if (result) {
      cards.push({
        market: 'f5_total',
        prediction: result.prediction,
        confidence: result.confidence / 10,
        ev_threshold_passed: result.ev_threshold_passed,
        reasoning: result.reasoning,
        drivers: [{ type: 'mlb-f5', edge: result.edge, projected: result.projected }],
      });
    }
  }

  return cards;
}

// ============================================================
// SHARP CHEDDAR K — Pitcher Strikeout Decision Engine v1.0
// Implements docs/pitcher_ks/01process.md through 07output.md
// ============================================================

const LEAGUE_AVG_K_PCT = 0.225; // ~22.5% — update seasonally

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

/**
 * Calculate raw K projection.
 * docs/pitcher_ks/02projection.md
 */
function calculateProjectionK(pitcher, matchup, leashTier, weather) {
  const seasonStarts = pitcher.season_starts ?? pitcher.starts ?? 0;
  if (seasonStarts < 3)
    return { value: null, reason_code: 'INSUFFICIENT_STARTS', uncalculable: true };

  const seasonK9 = pitcher.k_per_9 ?? null;
  if (!seasonK9)
    return { value: null, reason_code: 'MISSING_K9', uncalculable: true };

  // Blended K/9: 40% season + 60% rolling if >= 4 starts
  const blendedK9 = (seasonStarts >= 4 && pitcher.recent_k_per_9 != null)
    ? 0.40 * seasonK9 + 0.60 * pitcher.recent_k_per_9
    : seasonK9;

  const expectedIp = LEASH_TIER_PARAMS[leashTier]?.expected_ip ?? 5.0;

  // Opponent environment — use L30 split if 100+ PA, else season, else neutral
  const oppL30     = matchup?.opp_k_pct_vs_handedness_l30;
  const oppL30Pa   = matchup?.opp_k_pct_vs_handedness_l30_pa ?? 0;
  const oppSeason  = matchup?.opp_k_pct_vs_handedness_season;
  const oppSeasonPa = matchup?.opp_k_pct_vs_handedness_season_pa ?? 0;
  const chaseRate  = matchup?.opp_chase_rate_l30;

  let usedKPct = LEAGUE_AVG_K_PCT;
  let thinSample = true;
  if (oppL30Pa >= 100 && oppL30 != null)         { usedKPct = oppL30;    thinSample = false; }
  else if (oppSeasonPa >= 100 && oppSeason != null) { usedKPct = oppSeason; thinSample = false; }

  // Contact cap check
  let base;
  if (!thinSample && usedKPct < 0.18 && chaseRate != null && chaseRate < 0.26) {
    base = Math.min((blendedK9 / 9) * expectedIp, (blendedK9 / 9) * 4.5);
  } else if (!thinSample && (usedKPct < 0.18 || (chaseRate != null && chaseRate < 0.26))) {
    base = Math.min((blendedK9 / 9) * expectedIp, (blendedK9 / 9) * 5.0);
  } else {
    base = (blendedK9 / 9) * expectedIp * (usedKPct / LEAGUE_AVG_K_PCT);
  }

  // Park factor
  const pf = matchup?.park_k_factor ?? 1.0;
  if (pf >= 1.05) base *= 1.04;
  else if (pf < 0.95) base *= 0.94;
  else if (pf < 1.00) base *= 0.97;

  // Weather
  const temp = weather?.temp_at_first_pitch ?? weather?.temp_f ?? 72;
  if (temp < 45) base *= 0.95;

  // Double-header first game
  if (pitcher.is_doubleheader_first_game)
    base *= (expectedIp - 0.5) / expectedIp;

  return { value: Math.round(base * 10) / 10, blended_k9: blendedK9, expected_ip: expectedIp, uncalculable: false };
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
  const mode = (options || {}).mode || 'FULL';
  const side = (options || {}).side || 'over';
  const projectionOnly = mode === 'PROJECTION_ONLY';
  const reasonCodes = [];

  // Step 1A — Leash (needed for expected_ip in projection formula)
  const leashResult = classifyLeash(pitcherInput);
  if (leashResult.uncalculable) {
    return { status: 'HALTED', halted_at: 'STEP_1', reason_code: leashResult.flag,
             verdict: 'PASS', basis: mode };
  }

  // Step 1B — Raw K projection
  const leashTier  = leashResult.tier || 'Mod';
  const projResult = calculateProjectionK(pitcherInput, matchupInput, leashTier, weatherInput || {});
  if (projResult.uncalculable) {
    return { status: 'HALTED', halted_at: 'STEP_1', reason_code: projResult.reason_code,
             verdict: 'PASS', basis: mode };
  }
  const projection = projResult.value;

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
    return { status: 'HALTED', halted_at: 'STEP_2',
             reason_code: leashResult.flag || 'SHORT_LEASH',
             projection, leash_tier: leashResult.tier, verdict: 'PASS', basis: mode };
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
    return { status: 'SUSPENDED', halted_at: 'STEP_5', reason_code: 'ENVIRONMENT_COMPROMISED',
             trap_flags: trapResult.flags, projection, leash_tier: leashResult.tier,
             overlays: { trend: trendResult, ump: umpResult, bvp: bvpResult },
             verdict: 'PASS', basis: mode };
  }
  const block5Score = trapResult.block5_score;

  // Step 6 — Confidence scoring
  const penalties = calculatePenalties(pitcherInput, matchupInput || {});
  const rawScore  = block1Score + block2Score + block3Score + block4Score + block5Score;
  const netScore  = Math.max(0, rawScore + penalties.total);
  const tier      = getConfidenceTier(netScore);
  const verdict   = getKVerdict(tier);

  return {
    status: 'COMPLETE',
    projection,
    leash_tier: leashResult.tier,
    leash_flag: leashResult.flag || null,
    overlays: { trend: trendResult, ump: umpResult, bvp: bvpResult },
    blocks: { b1: block1Score, b2: block2Score, b3: block3Score, b4: block4Score, b5: block5Score },
    penalties: penalties.detail,
    raw_score: rawScore,
    net_score: netScore,
    tier,
    verdict,
    trap_flags: trapResult.flags,
    reason_codes: reasonCodes,
    basis: mode,
    projection_only: projectionOnly,
  };
}

/**
 * Build pitcher-K driver cards from an odds snapshot.
 *
 * Reads raw_data.mlb.{home,away}_pitcher (populated by enrichMlbPitcherData).
 * Default mode is PROJECTION_ONLY — no market line required.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @param {object} [options]
 * @param {'PROJECTION_ONLY'|'FULL'} [options.mode]
 * @returns {Array<object>}
 */
function computePitcherKDriverCards(gameId, oddsSnapshot, options) {
  const mode = (options || {}).mode || 'PROJECTION_ONLY';
  const isOddsBacked = mode === 'ODDS_BACKED';
  const mlb = parseRawMlb(oddsSnapshot);
  const cards = [];

  const candidates = [
    { pitcher: mlb.home_pitcher, role: 'home', team: oddsSnapshot?.home_team },
    { pitcher: mlb.away_pitcher, role: 'away', team: oddsSnapshot?.away_team },
  ];

  for (const { pitcher, role, team } of candidates) {
    if (!pitcher) continue;

    const pitcherInput = {
      k_per_9: pitcher.k_per_9 ?? null,
      recent_k_per_9: pitcher.recent_k_per_9 ?? null,
      recent_ip: pitcher.recent_ip ?? pitcher.avg_ip ?? null,
      season_starts: pitcher.starts ?? pitcher.season_starts ?? 0,
      starts: pitcher.starts ?? pitcher.season_starts ?? 0,
      il_return: pitcher.il_return ?? false,
      days_since_last_start: pitcher.days_since_last_start ?? null,
      role: pitcher.role ?? 'starter',
      last_three_pitch_counts: pitcher.last_three_pitch_counts ?? null,
      k_pct_last_4_starts: pitcher.k_pct_last_4_starts ?? null,
      k_pct_prior_4_starts: pitcher.k_pct_prior_4_starts ?? null,
      current_season_swstr_pct: pitcher.swstr_pct ?? null,
      bvp_pa: pitcher.bvp_pa ?? 0,
      bvp_k: pitcher.bvp_k ?? 0,
      is_star_name: pitcher.is_star_name ?? false,
      season_avg_velo: pitcher.season_avg_velo ?? null,
      last3_avg_velo: pitcher.last3_avg_velo ?? null,
    };

    const matchupInput = {
      opp_k_pct_vs_handedness_l30: mlb.opp_k_pct_vs_handedness_l30?.[role] ?? null,
      opp_k_pct_vs_handedness_l30_pa: mlb.opp_k_pct_pa?.[role] ?? 0,
      opp_k_pct_vs_handedness_season: mlb.opp_k_pct_season?.[role] ?? null,
      opp_k_pct_vs_handedness_season_pa: mlb.opp_k_pct_season_pa?.[role] ?? 0,
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

    // Resolve market input from strikeout_lines for ODDS_BACKED mode.
    // strikeout_lines is a map of pitcher_name (lower) → { line, over_price, under_price, bookmaker }
    // populated by enrichMlbPitcherData when mode = 'ODDS_BACKED'.
    let marketInput = null;
    let lineMeta = { line_source: null, over_price: null, under_price: null, best_line_bookmaker: null };

    if (isOddsBacked) {
      const pitcherNameKey = (pitcher.full_name || team || '').toLowerCase();
      const strikeoutLines = mlb.strikeout_lines ?? {};
      // Exact key match first, then partial match (pitcher full name may differ from team name)
      const lineRow =
        strikeoutLines[pitcherNameKey] ||
        Object.entries(strikeoutLines).find(([k]) =>
          k.includes(pitcherNameKey.slice(0, 4)) || pitcherNameKey.includes(k.slice(0, 4)),
        )?.[1] ||
        null;

      if (lineRow) {
        marketInput = { line: lineRow.line, opening_line: lineRow.line };
        lineMeta = {
          line_source: lineRow.bookmaker ?? 'unknown',
          over_price: lineRow.over_price ?? null,
          under_price: lineRow.under_price ?? null,
          best_line_bookmaker: lineRow.bookmaker ?? null,
        };
      } else {
        // No line found for this pitcher in ODDS_BACKED mode — downgrade to PROJECTION_ONLY
        console.warn(
          `[mlb-model] [pitcher-k] No market line found for ${team || role} pitcher ` +
            `in ODDS_BACKED mode — scoring as PROJECTION_ONLY (line_basis_missing).`,
        );
      }
    }

    // Pass 'FULL' mode when odds are available (enables Block 1 + Block 4),
    // otherwise 'PROJECTION_ONLY'.
    const scoreMode = isOddsBacked && marketInput ? 'FULL' : 'PROJECTION_ONLY';
    const result = scorePitcherK(pitcherInput, matchupInput, {}, marketInput, weatherInput, { mode: scoreMode, side: 'over' });

    // scorePitcherK returns `verdict: 'Play' | 'Pass'` — not `ev_threshold_passed`.
    // Map verdict to the standard ev_threshold_passed contract so the caller's filter works.
    // side is always 'over', so a 'Play' verdict is an OVER signal.
    const isPlay = result.status === 'COMPLETE' && result.verdict === 'Play';

    cards.push({
      market: `pitcher_k_${role}`,
      pitcher_team: team,
      prediction: isPlay ? 'OVER' : 'PASS',
      confidence: result.net_score != null ? result.net_score / 10 : 0,
      ev_threshold_passed: isPlay,
      reasoning: _buildPitcherKReasoning(result),
      drivers: [{
        type: 'pitcher-k',
        projection: result.projection ?? null,
        leash_tier: result.leash_tier ?? null,
        net_score: result.net_score ?? null,
        tier: result.tier ?? null,
      }],
      pitcher_k_result: result,
      // basis reflects actual scoring mode: 'FULL' → 'ODDS_BACKED', 'PROJECTION_ONLY' → 'PROJECTION_ONLY'
      basis: result.basis === 'FULL' ? 'ODDS_BACKED' : 'PROJECTION_ONLY',
      // Odds-backed enrichment fields (all null in PROJECTION_ONLY)
      ...lineMeta,
    });
  }

  return cards;
}

function _buildPitcherKReasoning(result) {
  if (result.status === 'HALTED')
    return `HALTED at ${result.halted_at}: ${result.reason_code}`;
  if (result.status === 'SUSPENDED')
    return `SUSPENDED — environment compromised: ${(result.trap_flags || []).join(', ')}`;
  const parts = [];
  if (result.projection != null) parts.push(`Projection: ${result.projection} Ks`);
  if (result.leash_tier)         parts.push(`Leash: ${result.leash_tier}`);
  if (result.net_score != null)  parts.push(`Score: ${result.net_score}/10 (${result.tier})`);
  parts.push(`Verdict: ${result.verdict}`);
  return parts.join(' | ');
}

module.exports = {
  projectStrikeouts,
  projectF5Total,
  projectF5TotalCard,
  computeMLBDriverCards,
  computePitcherStatsAsOf,
  // Sharp Cheddar K pipeline
  scorePitcherK,
  computePitcherKDriverCards,
};
