/**
 * Inference Models Plugin System
 * 
 * This module provides a pluggable architecture for running inference models.
 * Each sport has a model factory that can be swapped for real inference.
 * 
 * Usage:
 *   const { getModel } = require('./models');
 *   const model = getModel('NHL');
 *   const result = model.infer(gameId, oddsSnapshot);
 * 
 * To swap for real inference:
 *   1. Point MODEL_ENDPOINT env var to your inference server
 *   2. Model will attempt HTTP call before falling back to mock
 * 
 * Real inference expected response format:
 *   {
 *     prediction: 'HOME' | 'AWAY',
 *     confidence: number (0-1),
 *     reasoning: string,
 *     ev_threshold_passed: boolean
 *   }
 */

const http = require('http');
const https = require('https');

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawData(rawData) {
  if (!rawData) return {};
  if (typeof rawData === 'object') return rawData;
  if (typeof rawData !== 'string') return {};
  try {
    return JSON.parse(rawData);
  } catch {
    return {};
  }
}

function statusFromNumbers(values) {
  const present = values.filter((v) => v !== null && v !== undefined).length;
  if (present === values.length && values.length > 0) return 'ok';
  if (present > 0) return 'partial';
  return 'missing';
}

/**
 * Determine pick tier from calibrated confidence (0-1 scale).
 * Ported from personal-dashboard pick-schema.js.
 * SUPER ≥ 0.75, BEST ≥ 0.70, WATCH ≥ 0.60, null otherwise.
 * @param {number} confidence - 0 to 1
 * @returns {'SUPER'|'BEST'|'WATCH'|null}
 */
function determineTier(confidence) {
  if (confidence >= 0.75) return 'SUPER';
  if (confidence >= 0.70) return 'BEST';
  if (confidence >= 0.60) return 'WATCH';
  return null;
}

function computeNHLDrivers(gameId, oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const homeOdds = toNumber(oddsSnapshot?.h2h_home ?? oddsSnapshot?.moneyline_home);
  const awayOdds = toNumber(oddsSnapshot?.h2h_away ?? oddsSnapshot?.moneyline_away);
  const total = toNumber(oddsSnapshot?.total);

  const goalieHomeGsax = toNumber(
    raw?.goalie_home_gsax ?? raw?.goalie?.home?.gsax ?? raw?.goalies?.home?.gsax
  );
  const goalieAwayGsax = toNumber(
    raw?.goalie_away_gsax ?? raw?.goalie?.away?.gsax ?? raw?.goalies?.away?.gsax
  );
  const goalieDelta = goalieHomeGsax !== null && goalieAwayGsax !== null
    ? goalieHomeGsax - goalieAwayGsax
    : null;
  const goalieScore = goalieDelta === null ? 0.5 : clamp((goalieDelta + 3) / 6, 0, 1);

  const ppHome = toNumber(raw?.pp_home_pct ?? raw?.special_teams?.home?.pp_pct);
  const pkHome = toNumber(raw?.pk_home_pct ?? raw?.special_teams?.home?.pk_pct);
  const ppAway = toNumber(raw?.pp_away_pct ?? raw?.special_teams?.away?.pp_pct);
  const pkAway = toNumber(raw?.pk_away_pct ?? raw?.special_teams?.away?.pk_pct);
  const specialTeamsDelta = [ppHome, pkHome, ppAway, pkAway].every((v) => v !== null)
    ? (ppHome + pkHome) - (ppAway + pkAway)
    : null;
  const specialTeamsScore = specialTeamsDelta === null ? 0.5 : clamp((specialTeamsDelta + 25) / 50, 0, 1);

  const xgfHome = toNumber(raw?.xgf_home_pct ?? raw?.teams?.home?.xgf_pct ?? raw?.xgf?.home_pct);
  const xgfAway = toNumber(raw?.xgf_away_pct ?? raw?.teams?.away?.xgf_pct ?? raw?.xgf?.away_pct);
  const shotQualityDelta = xgfHome !== null && xgfAway !== null
    ? (xgfHome - xgfAway)
    : null;
  const shotEnvironmentScore = shotQualityDelta === null ? 0.5 : clamp((shotQualityDelta + 10) / 20, 0, 1);

  const pulledHomeSec = toNumber(raw?.empty_net_pull_home_sec ?? raw?.empty_net?.home_pull_seconds_remaining);
  const pulledAwaySec = toNumber(raw?.empty_net_pull_away_sec ?? raw?.empty_net?.away_pull_seconds_remaining);
  const pullDelta = pulledHomeSec !== null && pulledAwaySec !== null
    ? (pulledHomeSec - pulledAwaySec)
    : null;
  const emptyNetScore = pullDelta === null ? 0.5 : clamp((pullDelta + 60) / 120, 0, 1);

  const fragilityDistance = total === null ? null : Math.min(Math.abs(total - 5.5), Math.abs(total - 6.5));
  const totalFragilityScore = fragilityDistance === null ? 0.5 : clamp(1 - (fragilityDistance / 0.6), 0, 1);

  const pdoHome = toNumber(raw?.pdo_home ?? raw?.teams?.home?.pdo);
  const pdoAway = toNumber(raw?.pdo_away ?? raw?.teams?.away?.pdo);
  const pdoDelta = pdoHome !== null && pdoAway !== null
    ? (pdoAway - pdoHome)
    : null;
  const pdoRegressionScore = pdoDelta === null ? 0.5 : clamp((pdoDelta + 0.04) / 0.08, 0, 1);

  const drivers = {
    goalie: {
      score: goalieScore,
      weight: 0.24,
      status: statusFromNumbers([goalieHomeGsax, goalieAwayGsax]),
      inputs: { home_gsax: goalieHomeGsax, away_gsax: goalieAwayGsax, delta: goalieDelta },
      note: 'Uses GSaX when available; neutral fallback when unavailable.'
    },
    specialTeams: {
      score: specialTeamsScore,
      weight: 0.16,
      status: statusFromNumbers([ppHome, pkHome, ppAway, pkAway]),
      inputs: { pp_home_pct: ppHome, pk_home_pct: pkHome, pp_away_pct: ppAway, pk_away_pct: pkAway, delta: specialTeamsDelta },
      note: 'Power-play + penalty-kill mismatch.'
    },
    shotEnvironment: {
      score: shotEnvironmentScore,
      weight: 0.14,
      status: statusFromNumbers([xgfHome, xgfAway]),
      inputs: { xgf_home_pct: xgfHome, xgf_away_pct: xgfAway, delta: shotQualityDelta },
      note: 'Uses xGF% shot-quality profile (5v5) when available.'
    },
    emptyNet: {
      score: emptyNetScore,
      weight: 0.08,
      status: statusFromNumbers([pulledHomeSec, pulledAwaySec]),
      inputs: { home_pull_sec_remaining: pulledHomeSec, away_pull_sec_remaining: pulledAwaySec, delta: pullDelta },
      note: 'Late-game goalie pull aggressiveness proxy.'
    },
    totalFragility: {
      score: totalFragilityScore,
      weight: 0.06,
      status: statusFromNumbers([total]),
      inputs: { total, nearest_key_number_distance: fragilityDistance },
      note: 'Sensitivity near 5.5 / 6.5 totals.'
    },
    pdoRegression: {
      score: pdoRegressionScore,
      weight: 0.18,
      status: statusFromNumbers([pdoHome, pdoAway]),
      inputs: { pdo_home: pdoHome, pdo_away: pdoAway, delta: pdoDelta },
      note: 'Regression pressure from PDO imbalance.'
    }
  };

  const weightedScores = Object.values(drivers).map((driver) => driver.score * driver.weight);
  const weightedSum = weightedScores.reduce((sum, value) => sum + value, 0);
  const baselineConfidence = mockModels.NHL.confidence;
  const confidenceAdjustment = (weightedSum - 0.5) * 0.22;
  const confidence = clamp(baselineConfidence + confidenceAdjustment, 0.56, 0.78);

  const prediction = homeOdds !== null && awayOdds !== null
    ? (homeOdds < awayOdds ? 'HOME' : 'AWAY')
    : (confidence >= 0.64 ? 'HOME' : 'AWAY');

  const topDrivers = Object.entries(drivers)
    .sort((a, b) => Math.abs(b[1].score - 0.5) - Math.abs(a[1].score - 0.5))
    .slice(0, 3)
    .map(([name, driver]) => `${name}:${driver.score.toFixed(2)}`);

  return {
    prediction,
    confidence,
    ev_threshold_passed: confidence > 0.55,
    reasoning: `NHL composite driver signal (${topDrivers.join(', ')})`,
    drivers,
    driver_summary: {
      game_id: gameId,
      weighted_confidence: confidence,
      top_drivers: topDrivers
    }
  };
}

/**
 * Compute per-driver NHL card descriptors from a single odds snapshot.
 *
 * Returns an array of descriptor objects — one per active driver.
 * Drivers with status === 'missing' are filtered out (emptyNet, welcomeHome when no h2h).
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card descriptor objects
 */
function computeNHLDriverCards(gameId, oddsSnapshot) {
  const drivers = computeNHLDrivers(gameId, oddsSnapshot).drivers;

  function direction(score) {
    if (score > 0.52) return 'HOME';
    if (score < 0.48) return 'AWAY';
    return 'NEUTRAL';
  }

  const descriptors = [];

  // --- goalie ---
  {
    const d = drivers.goalie;
    const dir = direction(d.score);
    const conf = clamp(0.65 + Math.abs(d.score - 0.5) * 0.4, 0.65, 0.85);
    descriptors.push({
      cardType: 'nhl-goalie',
      cardTitle: `NHL Goalie Edge: ${dir}`,
      confidence: conf,
      tier: determineTier(conf),
      prediction: dir,
      reasoning: `GSaX goalie tier delta favors ${dir} (delta: ${d.inputs.delta != null ? d.inputs.delta.toFixed(2) : 'n/a'})`,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'goalie',
      driverInputs: d.inputs,
      driverScore: d.score,
      driverStatus: d.status,
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- specialTeams ---
  {
    const d = drivers.specialTeams;
    const dir = direction(d.score);
    const conf = clamp(0.60 + Math.abs(d.score - 0.5) * 0.2, 0.60, 0.70);
    descriptors.push({
      cardType: 'nhl-special-teams',
      cardTitle: `NHL Special Teams Mismatch: ${dir}`,
      confidence: conf,
      tier: determineTier(conf),
      prediction: dir,
      reasoning: `PP/PK composite mismatch favors ${dir} (${d.inputs.delta != null ? d.inputs.delta.toFixed(1) : 'n/a'} pct-pt edge)`,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'specialTeams',
      driverInputs: d.inputs,
      driverScore: d.score,
      driverStatus: d.status,
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- shotEnvironment ---
  {
    const d = drivers.shotEnvironment;
    const dir = direction(d.score);
    const conf = clamp(0.60 + Math.abs(d.score - 0.5) * 0.3, 0.60, 0.75);
    descriptors.push({
      cardType: 'nhl-shot-environment',
      cardTitle: `NHL Shot Environment: ${dir}`,
      confidence: conf,
      tier: determineTier(conf),
      prediction: dir,
      reasoning: `xGF% 5v5 shot quality profile favors ${dir} (delta: ${d.inputs.delta != null ? d.inputs.delta.toFixed(1) : 'n/a'} pct)`,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'shotEnvironment',
      driverInputs: d.inputs,
      driverScore: d.score,
      driverStatus: d.status,
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- emptyNet (skip when missing) ---
  {
    const d = drivers.emptyNet;
    if (d.status !== 'missing') {
      const dir = direction(d.score);
      const conf = clamp(0.58 + Math.abs(d.score - 0.5) * 0.3, 0.58, 0.72);
      descriptors.push({
        cardType: 'nhl-empty-net',
        cardTitle: `NHL Empty Net Tendencies: ${dir}`,
        confidence: conf,
        tier: determineTier(conf),
        prediction: dir,
        reasoning: `Coach goalie-pull timing edge favors ${dir}`,
        ev_threshold_passed: conf > 0.60,
        driverKey: 'emptyNet',
        driverInputs: d.inputs,
        driverScore: d.score,
        driverStatus: d.status,
        inference_source: 'driver',
        is_mock: true
      });
    }
  }

  // --- totalFragility (always NEUTRAL) ---
  {
    const d = drivers.totalFragility;
    const conf = clamp(0.58 + d.score * 0.2, 0.58, 0.78);
    descriptors.push({
      cardType: 'nhl-total-fragility',
      cardTitle: 'NHL Total Fragility',
      confidence: conf,
      tier: determineTier(conf),
      prediction: 'NEUTRAL',
      reasoning: `Total near key number ${d.inputs.total} (distance: ${d.inputs.nearest_key_number_distance != null ? d.inputs.nearest_key_number_distance.toFixed(2) : 'n/a'} from 5.5/6.5/7.5)`,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'totalFragility',
      driverInputs: d.inputs,
      driverScore: d.score,
      driverStatus: d.status,
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- pdoRegression ---
  {
    const d = drivers.pdoRegression;
    const dir = direction(d.score);
    const conf = clamp(0.70 + Math.abs(d.score - 0.5) * 0.3, 0.70, 0.85);
    descriptors.push({
      cardType: 'nhl-pdo-regression',
      cardTitle: `NHL PDO Regression Signal: ${dir}`,
      confidence: conf,
      tier: determineTier(conf),
      prediction: dir,
      reasoning: `PDO imbalance (delta: ${d.inputs.delta != null ? d.inputs.delta.toFixed(3) : 'n/a'}) suggests regression toward ${dir}`,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'pdoRegression',
      driverInputs: d.inputs,
      driverScore: d.score,
      driverStatus: d.status,
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- welcomeHome (global meta-driver: fade of the home team) ---
  // Fires AWAY when market over-prices home advantage; skipped when no edge.
  // h2h odds are decimal (e.g. 1.85 = home fav, 2.10 = away fav).
  // implied_prob = 1 / decimal_odds; edge = implied_prob - 0.5 (positive = home favored).
  // score = (market_corroboration * 0.4 + venue_intensity * 0.3 + rest * 0.3)
  // Skip if no h2h_home odds, or if home is not actually favored (score < 0.55).
  {
    const h2hHome = toNumber(oddsSnapshot?.h2h_home);
    const h2hAway = toNumber(oddsSnapshot?.h2h_away);

    // Decimal odds must be > 1; negative value would mean American format (handled separately if needed)
    if (h2hHome !== null && h2hHome > 1) {
      const impliedProbHome = 1 / h2hHome;
      const edge = impliedProbHome - 0.5; // positive = market prices home advantage

      // market_corroboration: 1 when market meaningfully prices home (>53% implied), else 0.5
      const marketCorroboration = impliedProbHome > 0.53 ? 1 : 0.5;
      const venueIntensity = 0.6; // NHL neutral baseline (enhance with arena data later)
      const rest = 0.5;           // placeholder — enhance with schedule data later

      const score = (marketCorroboration * 0.4) + (venueIntensity * 0.3) + (rest * 0.3);

      // Only emit when market is actually pricing home advantage (score > 0.6 → AWAY fade)
      // score ≤ 0.6 or < 0.55: not enough value — skip
      if (score >= 0.55) {
        const dir = score > 0.6 ? 'AWAY' : 'NEUTRAL';
        const conf = clamp(0.60 + score * 0.15, 0.60, 0.75);
        descriptors.push({
          cardType: 'nhl-welcome-home',
          cardTitle: `NHL Welcome Home Fade: ${dir}`,
          confidence: conf,
          tier: determineTier(conf),
          prediction: dir,
          reasoning: `Market prices home at ${(impliedProbHome * 100).toFixed(0)}% implied — fade HOME, back VISITORS`,
          ev_threshold_passed: conf > 0.60,
          driverKey: 'welcomeHome',
          driverInputs: {
            h2h_home: h2hHome,
            h2h_away: h2hAway,
            implied_prob_home: impliedProbHome,
            market_corroboration: marketCorroboration,
            venue_intensity: venueIntensity,
            rest,
            edge
          },
          driverScore: score,
          driverStatus: 'ok',
          inference_source: 'driver',
          is_mock: true
        });
      }
    }
  }

  return descriptors;
}

/**
 * Compute per-driver NBA card descriptors from a single odds snapshot.
 *
 * Ported driver logic from personal-dashboard/server/drivers/nba-drivers.js.
 * Drivers only emit when their signal is actionable — neutral/missing data skips.
 *
 * Drivers:
 *   rest-advantage  — B2B fatigue (one team on 0 rest days)
 *   travel          — Road B2B penalty (away on 0 rest days, home rested)
 *   lineup          — Key player out / probable missing (injury_status in raw_data)
 *   matchup-style   — Pace mismatch or elite O vs weak D
 *   blowout-risk    — Large spread (≥8 pts) → garbage time suppresses pace
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card descriptor objects
 */
function computeNBADriverCards(_gameId, oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const descriptors = [];

  // --- rest-advantage & travel (both use same rest data) ---
  const restDaysHome = toNumber(raw?.rest_days_home ?? raw?.home?.rest_days);
  const restDaysAway = toNumber(raw?.rest_days_away ?? raw?.away?.rest_days);

  if (restDaysHome !== null && restDaysAway !== null) {
    const homeB2B = restDaysHome === 0;
    const awayB2B = restDaysAway === 0;

    if (homeB2B || awayB2B) {
      const score = homeB2B && !awayB2B ? 0.1   // home exhausted → AWAY edge
        : awayB2B && !homeB2B   ? 0.9   // away exhausted → HOME edge
        : 0.5;                           // both B2B → neutral
      const dir = score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL';
      const conf = clamp(0.65 + Math.abs(score - 0.5) * 0.4, 0.65, 0.85);
      const b2bSide = homeB2B && !awayB2B ? 'HOME' : awayB2B && !homeB2B ? 'AWAY' : 'BOTH';

      descriptors.push({
        cardType: 'nba-rest-advantage',
        cardTitle: `NBA Rest Edge: ${dir}`,
        confidence: conf,
        tier: determineTier(conf),
        prediction: dir,
        reasoning: `${b2bSide} team on B2B — fatigue factor favors ${dir}`,
        ev_threshold_passed: conf > 0.60,
        driverKey: 'restAdvantage',
        driverInputs: { rest_days_home: restDaysHome, rest_days_away: restDaysAway },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: true
      });
    }

    // travel: road B2B is a second compounding signal (away on B2B, home rested)
    if (restDaysAway === 0 && restDaysHome > 0) {
      const conf = 0.68;
      descriptors.push({
        cardType: 'nba-travel',
        cardTitle: 'NBA Road B2B Penalty',
        confidence: conf,
        tier: determineTier(conf),
        prediction: 'HOME',
        reasoning: `Away team on road B2B — travel + fatigue composite favors HOME`,
        ev_threshold_passed: conf > 0.60,
        driverKey: 'travel',
        driverInputs: { rest_days_away: restDaysAway, rest_days_home: restDaysHome },
        driverScore: 0.85,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: true
      });
    }
  }

  // --- lineup (only fires when injuries are flagged) ---
  const injuryHome = raw?.injury_status_home ?? raw?.home?.injury_status ?? null;
  const injuryAway = raw?.injury_status_away ?? raw?.away?.injury_status ?? null;
  const depleted = injuryHome === 'depleted' || injuryAway === 'depleted';
  const questionable = injuryHome === 'probable_missing' || injuryAway === 'probable_missing';

  if (depleted || questionable) {
    const conf = depleted ? 0.62 : 0.58;
    const depletedDir = injuryHome === 'depleted' ? 'AWAY'
      : injuryAway === 'depleted' ? 'HOME'
      : 'NEUTRAL';
    const dir = depleted ? depletedDir : 'NEUTRAL';
    const score = depleted ? (dir === 'HOME' ? 0.8 : dir === 'AWAY' ? 0.2 : 0.5) : 0.5;

    descriptors.push({
      cardType: 'nba-lineup',
      cardTitle: `NBA Lineup Alert: ${dir}`,
      confidence: conf,
      tier: determineTier(conf),
      prediction: dir,
      reasoning: `${depleted ? 'Key player(s) out' : 'Probable starter questionable'} — lineup uncertainty is a live signal`,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'lineup',
      driverInputs: { injury_status_home: injuryHome, injury_status_away: injuryAway },
      driverScore: score,
      driverStatus: 'ok',
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- matchup-style (pace mismatch or elite O vs weak D) ---
  const paceHome = toNumber(raw?.pace_home ?? raw?.home?.pace);
  const paceAway = toNumber(raw?.pace_away ?? raw?.away?.pace);
  const avgPtsHome = toNumber(raw?.avg_points_home ?? raw?.home?.avg_points);
  const avgPtsAway = toNumber(raw?.avg_points_away ?? raw?.away?.avg_points);
  const avgPtsAllowedHome = toNumber(raw?.avg_points_allowed_home ?? raw?.home?.avg_points_allowed);
  const avgPtsAllowedAway = toNumber(raw?.avg_points_allowed_away ?? raw?.away?.avg_points_allowed);

  const hasPace = paceHome !== null && paceAway !== null;
  const hasEfficiency = (avgPtsHome !== null && avgPtsAllowedAway !== null)
    || (avgPtsAway !== null && avgPtsAllowedHome !== null);

  if (hasPace || hasEfficiency) {
    let score = 0.5;
    let dir = 'NEUTRAL';
    let reasoning = 'Pace/efficiency matchup signal';

    if (hasPace) {
      const paceDelta = paceHome - paceAway;
      if (Math.abs(paceDelta) >= 4) {
        reasoning = `Extreme pace mismatch (delta: ${paceDelta.toFixed(1)} poss) — total variance signal`;
      }
    }

    // Elite O vs Weak D overrides direction
    if (avgPtsHome > 115 && avgPtsAllowedAway > 115) {
      score = 0.75;
      dir = 'HOME';
      reasoning = `Elite HOME offense vs weak AWAY defense (${avgPtsHome.toFixed(0)} pts/g vs ${avgPtsAllowedAway.toFixed(0)} allowed)`;
    } else if (avgPtsAway !== null && avgPtsAllowedHome !== null
        && avgPtsAway > 115 && avgPtsAllowedHome > 115) {
      score = 0.25;
      dir = 'AWAY';
      reasoning = `Road elite AWAY offense vs weak HOME defense (${avgPtsAway.toFixed(0)} pts/g vs ${avgPtsAllowedHome.toFixed(0)} allowed)`;
    }

    const conf = clamp(0.60 + Math.abs(score - 0.5) * 0.4, 0.60, 0.80);
    descriptors.push({
      cardType: 'nba-matchup-style',
      cardTitle: `NBA Matchup Style: ${dir}`,
      confidence: conf,
      tier: determineTier(conf),
      prediction: dir,
      reasoning,
      ev_threshold_passed: conf > 0.60,
      driverKey: 'matchupStyle',
      driverInputs: {
        pace_home: paceHome,
        pace_away: paceAway,
        avg_pts_home: avgPtsHome,
        avg_pts_away: avgPtsAway,
        avg_pts_allowed_home: avgPtsAllowedHome,
        avg_pts_allowed_away: avgPtsAllowedAway
      },
      driverScore: score,
      driverStatus: statusFromNumbers([paceHome, paceAway]),
      inference_source: 'driver',
      is_mock: true
    });
  }

  // --- blowout-risk (derived from spread — always available when odds exist) ---
  if (spreadHome !== null) {
    const absSpread = Math.abs(spreadHome);
    if (absSpread >= 8) {
      const conf = absSpread >= 12 ? 0.75 : 0.65;
      descriptors.push({
        cardType: 'nba-blowout-risk',
        cardTitle: 'NBA Blowout Risk',
        confidence: conf,
        tier: determineTier(conf),
        prediction: 'NEUTRAL',
        reasoning: `Large spread (${spreadHome > 0 ? '+' : ''}${spreadHome}) — garbage time risk suppresses 4Q pace`,
        ev_threshold_passed: conf > 0.60,
        driverKey: 'blowoutRisk',
        driverInputs: { spread_home: spreadHome, abs_spread: absSpread },
        driverScore: 0.5,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: true
      });
    }
  }

  return descriptors;
}

/**
 * Mock models (fallback)
 */
const mockModels = {
  NHL: {
    confidence: 0.65,
  },
  NBA: {
    confidence: 0.62,
  },
  FPL: {
    confidence: 0.58,
  },
  NFL: {
    confidence: 0.67,
  },
  MLB: {
    confidence: 0.64,
  }
};

/**
 * Perform HTTP inference call
 */
async function callRemoteModel(sport, gameId, oddsSnapshot) {
  const endpoint = process.env.MODEL_ENDPOINT || '';
  if (!endpoint) {
    return null; // No remote inference configured
  }

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sport,
      gameId,
      odds: {
        h2h_home: oddsSnapshot.h2h_home,
        h2h_away: oddsSnapshot.h2h_away,
        spread_home: oddsSnapshot.spread_home,
        spread_away: oddsSnapshot.spread_away,
        total: oddsSnapshot.total
      }
    });

    const url = new URL(endpoint);
    const protocol = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Model-Sport': sport,
        'X-Model-Auth': process.env.MODEL_AUTH_TOKEN || ''
      },
      timeout: 10000 // 10 second timeout
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const result = JSON.parse(data);
            if (result.prediction && result.confidence !== undefined) {
              resolve({
                ...result,
                inference_source: 'remote',
                model_endpoint: endpoint,
                is_mock: false
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    });

    req.on('error', (error) => {
      console.warn(`[Models] Remote inference failed for ${sport}:`, error.message);
      resolve(null); // Fall back to mock
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn(`[Models] Remote inference timeout for ${sport}`);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Get inference for a sport
 * Tries remote first, falls back to mock
 */
async function getInference(sport, gameId, oddsSnapshot) {
  // Try remote inference first
  const remoteResult = await callRemoteModel(sport, gameId, oddsSnapshot);
  if (remoteResult) {
    console.log(`[Models] Using remote inference for ${sport}`);
    return remoteResult;
  }

  // Fall back to mock
  const mockConfig = mockModels[sport];
  if (!mockConfig) {
    throw new Error(`Unknown sport: ${sport}`);
  }

  const homeOdds = oddsSnapshot.h2h_home || oddsSnapshot.moneyline_home;
  const awayOdds = oddsSnapshot.h2h_away || oddsSnapshot.moneyline_away;

  if (sport === 'NHL') {
    const nhl = computeNHLDrivers(gameId, oddsSnapshot);
    return {
      ...nhl,
      inference_source: 'mock',
      model_endpoint: null,
      is_mock: true
    };
  }

  const confidence = mockConfig.confidence;
  const predictHome = homeOdds < awayOdds;

  return {
    prediction: predictHome ? 'HOME' : 'AWAY',
    confidence,
    ev_threshold_passed: confidence > 0.55, // Conservative threshold
    reasoning: `Model prefers ${predictHome ? 'HOME' : 'AWAY'} team at ${confidence.toFixed(2)} confidence`,
    inference_source: 'mock',
    model_endpoint: null,
    is_mock: true
  };
}

/**
 * Get a model instance for a sport
 */
function getModel(sport) {
  return {
    sport,
    infer: async (gameId, oddsSnapshot) => {
      return getInference(sport, gameId, oddsSnapshot);
    }
  };
}

module.exports = {
  getInference,
  getModel,
  callRemoteModel,
  mockModels,
  computeNHLDriverCards,
  computeNBADriverCards,
  determineTier
};
