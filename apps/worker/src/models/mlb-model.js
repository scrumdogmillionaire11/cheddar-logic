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

module.exports = {
  projectStrikeouts,
  projectF5Total,
  projectF5TotalCard,
  computeMLBDriverCards,
};
