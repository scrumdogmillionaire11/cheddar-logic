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
const { projectNBA, projectNBACanonical, projectNCAAM, projectNHL } = require('./projections');
const { generateWelcomeHomeCard } = require('./welcome-home-v2');
const { computeNHLMarketDecisions, selectExpressionChoice, buildMarketPayload } = require('./cross-market');
const { analyzePaceSynergy } = require('./nba-pace-synergy');

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
  const confidence = clamp(weightedSum, 0.50, 0.85);

  const prediction = weightedSum > 0.5 ? 'HOME' : weightedSum < 0.5 ? 'AWAY' : 'NEUTRAL';

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
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const total = toNumber(oddsSnapshot?.total);

  const descriptors = [];

  // Extract ESPN-enriched metrics (for future integration with advanced stats)
  const goalsForHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgGoalsFor ?? raw?.goals_for_home ?? null);
  const goalsForAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgGoalsFor ?? raw?.goals_for_away ?? null);
  const goalsAgainstHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst ?? raw?.goals_against_home ?? null);
  const goalsAgainstAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst ?? raw?.goals_against_away ?? null);
  const restDaysHome = toNumber(raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null);
  const restDaysAway = toNumber(raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? null);

  const goalieHomeGsax = toNumber(
    raw?.goalie_home_gsax ?? raw?.goalie?.home?.gsax ?? raw?.goalies?.home?.gsax
  );
  const goalieAwayGsax = toNumber(
    raw?.goalie_away_gsax ?? raw?.goalie?.away?.gsax ?? raw?.goalies?.away?.gsax
  );
  const homeGoalieConfirmed = goalieHomeGsax !== null && goalieHomeGsax !== undefined;
  const awayGoalieConfirmed = goalieAwayGsax !== null && goalieAwayGsax !== undefined;

  // --- Base Projection Driver (Real Formula with Goalie Adjustment) ---
  if (goalsForHome && goalsForAway && goalsAgainstHome && goalsAgainstAway) {
    const projection = projectNHL(
      goalsForHome, goalsAgainstHome,
      goalsForAway, goalsAgainstAway,
      homeGoalieConfirmed, awayGoalieConfirmed
    );

    if (projection.homeProjected && projection.awayProjected) {
      const projectedMargin = projection.homeProjected - projection.awayProjected;
      
      descriptors.push({
        cardType: 'nhl-base-projection',
        cardTitle: `NHL Projection: ${projectedMargin > 0 ? 'HOME' : 'AWAY'} ${Math.abs(projectedMargin).toFixed(2)} Goals`,
        confidence: projection.confidence,
        tier: determineTier(projection.confidence),
        prediction: projectedMargin > 0 ? 'HOME' : 'AWAY',
        reasoning: `Base projection: ${projection.homeProjected.toFixed(2)} vs ${projection.awayProjected.toFixed(2)} goals (${homeGoalieConfirmed ? 'confirmed' : 'unconfirmed'} goalies)`,
        ev_threshold_passed: projection.confidence > 0.60,
        driverKey: 'baseProjection',
        driverInputs: {
          home_goals_for: goalsForHome,
          away_goals_for: goalsForAway,
          home_goals_against: goalsAgainstHome,
          away_goals_against: goalsAgainstAway,
          home_goalie_confirmed: homeGoalieConfirmed,
          away_goalie_confirmed: awayGoalieConfirmed,
          projected_margin: projectedMargin
        },
        driverScore: clamp((projectedMargin + 2) / 4, 0, 1),  // Normalize
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        projectionDetails: {
          homeProjected: projection.homeProjected,
          awayProjected: projection.awayProjected,
          totalProjected: projection.totalProjected,
          goalieConfirmedPenalty: projection.goalieConfirmedPenalty
        }
      });
    }
  }

  // --- Rest Advantage Driver (NHL-specific: smaller penalties than NBA) ---
  if (restDaysHome !== null && restDaysAway !== null) {
    const homeB2B = restDaysHome === 0;
    const awayB2B = restDaysAway === 0;

    if (homeB2B || awayB2B) {
      let prediction, confidence, reasoning;

      if (homeB2B && !awayB2B) {
        prediction = 'AWAY';
        confidence = clamp(0.62 + (restDaysAway - restDaysHome) * 0.04, 0.58, 0.72);
        reasoning = `HOME on B2B (minor NHL penalty) vs AWAY well-rested — slight fatigue edge to AWAY`;
      } else if (awayB2B && !homeB2B) {
        prediction = 'HOME';
        confidence = clamp(0.62 + (restDaysHome - restDaysAway) * 0.04, 0.58, 0.72);
        reasoning = `AWAY on B2B vs HOME rested — slight fatigue edge to HOME`;
      } else {
        prediction = 'NEUTRAL';
        confidence = 0.55;
        reasoning = 'Both teams on B2B — rest neutral';
      }

      descriptors.push({
        cardType: 'nhl-rest-advantage',
        cardTitle: `NHL Rest: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'restAdvantage',
        driverInputs: { rest_days_home: restDaysHome, rest_days_away: restDaysAway },
        driverScore: prediction === 'HOME' ? 0.65 : prediction === 'AWAY' ? 0.35 : 0.5,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    }
  }

  // --- Goalie Tier Driver (Advanced Stats) ---
  {
    const goalieDelta = goalieHomeGsax !== null && goalieAwayGsax !== null
      ? goalieHomeGsax - goalieAwayGsax
      : null;

    if (goalieDelta !== null) {
      const score = clamp((goalieDelta + 3) / 6, 0, 1);
      const direction = score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL';
      const confidence = clamp(0.65 + Math.abs(score - 0.5) * 0.3, 0.60, 0.80);

      descriptors.push({
        cardType: 'nhl-goalie',
        cardTitle: `NHL Goalie Edge: ${direction}`,
        confidence,
        tier: determineTier(confidence),
        prediction: direction,
        reasoning: `GSaX goalie tier delta (${goalieDelta.toFixed(2)}) favors ${direction}`,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'goalie',
        driverInputs: { home_gsax: goalieHomeGsax, away_gsax: goalieAwayGsax, delta: goalieDelta },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    }
  }

  // --- Scoring Environment Driver (Total Over/Under Signal) ---
  if (total !== null) {
    const fragilityDistance = Math.min(Math.abs(total - 5.5), Math.abs(total - 6.5));
    const score = clamp(1 - (fragilityDistance / 0.6), 0, 1);

    if (fragilityDistance < 0.6) {
      const confidence = clamp(0.68 - fragilityDistance * 0.1, 0.60, 0.75);
      descriptors.push({
        cardType: 'nhl-model-output',
        cardTitle: `NHL Total Fragility: Over/Under Variance`,
        confidence,
        tier: determineTier(confidence),
        prediction: 'NEUTRAL',
        reasoning: `Total ${total} near key numbers (5.5/6.5) — high O/U variance sensitivity`,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'scoringEnvironment',
        driverInputs: { total, key_number_distance: fragilityDistance },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
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

  // Extract ESPN-enriched metrics (with legacy fallback)
  const paceHome = toNumber(raw?.espn_metrics?.home?.metrics?.pace ?? raw?.pace_home ?? raw?.home?.pace);
  const paceAway = toNumber(raw?.espn_metrics?.away?.metrics?.pace ?? raw?.pace_away ?? raw?.away?.pace);
  const avgPtsHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPoints ?? raw?.avg_points_home ?? raw?.home?.avg_points);
  const avgPtsAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPoints ?? raw?.avg_points_away ?? raw?.away?.avg_points);
  const avgPtsAllowedHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ?? raw?.avg_points_allowed_home ?? raw?.home?.avg_points_allowed);
  const avgPtsAllowedAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ?? raw?.avg_points_allowed_away ?? raw?.away?.avg_points_allowed);
  const restDaysHome = toNumber(raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? raw?.home?.rest_days);
  const restDaysAway = toNumber(raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? raw?.away?.rest_days);
  const homeNetRating = avgPtsHome && avgPtsAllowedHome ? avgPtsHome - avgPtsAllowedHome : null;
  const awayNetRating = avgPtsAway && avgPtsAllowedAway ? avgPtsAway - avgPtsAllowedAway : null;

  // --- Base Projection Driver (Real Formula) ---
  if (avgPtsHome && avgPtsAway && avgPtsAllowedHome && avgPtsAllowedAway) {
    const projection = projectNBA(
      avgPtsHome, avgPtsAllowedHome,
      avgPtsAway, avgPtsAllowedAway,
      paceHome || 100, paceAway || 100,
      restDaysHome || 1, restDaysAway || 1
    );

    if (projection.homeProjected && projection.awayProjected) {
      const projectedMargin = projection.homeProjected - projection.awayProjected;
      const highConfidenceProjection = projection.confidence >= 0.70;

      descriptors.push({
        cardType: 'nba-base-projection',
        cardTitle: `NBA Projection: ${projectedMargin > 0 ? 'HOME' : 'AWAY'} ${Math.abs(projectedMargin).toFixed(1)}`,
        confidence: projection.confidence,
        tier: determineTier(projection.confidence),
        prediction: projectedMargin > 0 ? 'HOME' : 'AWAY',
        reasoning: `Base projection: ${projection.homeProjected.toFixed(1)} vs ${projection.awayProjected.toFixed(1)} (pace multiplier: ${projection.paceMultiplier.toFixed(2)}x, rest adj: ${projection.homeRestAdj}/${projection.awayRestAdj})`,
        ev_threshold_passed: projection.confidence > 0.60,
        driverKey: 'baseProjection',
        driverInputs: {
          home_avg_pts: avgPtsHome,
          away_avg_pts: avgPtsAway,
          home_def: avgPtsAllowedHome,
          away_def: avgPtsAllowedAway,
          home_pace: paceHome,
          away_pace: paceAway,
          home_rest: restDaysHome,
          away_rest: restDaysAway,
          projected_margin: projectedMargin
        },
        driverScore: clamp((projectedMargin + 20) / 40, 0, 1),  // Normalize to 0-1
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        projectionDetails: {
          homeProjected: projection.homeProjected,
          awayProjected: projection.awayProjected,
          paceMultiplier: projection.paceMultiplier,
          netRatingGap: projection.netRatingGap
        }
      });
    }
  }

  // --- Rest Advantage Driver (Enhanced with Real Rest Data) ---
  if (restDaysHome !== null && restDaysAway !== null) {
    const homeB2B = restDaysHome === 0;
    const awayB2B = restDaysAway === 0;

    if (homeB2B || awayB2B) {
      let score, prediction, confidence, reasoning;

      if (homeB2B && !awayB2B) {
        score = 0.2;
        prediction = 'AWAY';
        confidence = clamp(0.65 + (restDaysAway - restDaysHome) * 0.08, 0.60, 0.80);
        reasoning = `HOME on B2B (${restDaysHome}d rest) vs AWAY rested (${restDaysAway}d) — fatigue favors AWAY`;
      } else if (awayB2B && !homeB2B) {
        score = 0.8;
        prediction = 'HOME';
        confidence = clamp(0.65 + (restDaysHome - restDaysAway) * 0.08, 0.60, 0.80);
        reasoning = `AWAY on B2B (${restDaysAway}d rest) vs HOME rested (${restDaysHome}d) — fatigue favors HOME`;
      } else {
        score = 0.5;
        prediction = 'NEUTRAL';
        confidence = 0.58;
        reasoning = 'Both teams on B2B — rest neutral';
      }

      descriptors.push({
        cardType: 'nba-rest-advantage',
        cardTitle: `NBA Rest: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'restAdvantage',
        driverInputs: { rest_days_home: restDaysHome, rest_days_away: restDaysAway },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    } else if (Math.abs(restDaysHome - restDaysAway) >= 2) {
      // Partial rest advantage (not B2B but significant gap)
      const restGap = restDaysHome - restDaysAway;
      const score = restGap > 0 ? 0.65 : 0.35;
      const prediction = restGap > 0 ? 'HOME' : 'AWAY';
      const confidence = clamp(0.60 + Math.abs(restGap) * 0.05, 0.58, 0.72);

      descriptors.push({
        cardType: 'nba-rest-advantage',
        cardTitle: `NBA Rest: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning: `Rest gap: ${prediction} team has ${Math.abs(restGap)} more days rest`,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'restAdvantage',
        driverInputs: { rest_days_home: restDaysHome, rest_days_away: restDaysAway, rest_gap: restGap },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    }
  }

  // --- Welcome Home v2 Driver (Cross-sport road fatigue signal) ---
  if (restDaysAway !== null) {
    const awayTeam = {
      netRating: awayNetRating,
      restDays: restDaysAway
    };
    const homeTeam = {
      netRating: homeNetRating
    };
    
    // Simplified trigger: away on 2+ game road stretch (would need game history in production)
    // For now, detect via back-to-back penalty
    if (restDaysAway === 0) {
      const welcomeCard = generateWelcomeHomeCard({
        gameId: _gameId,
        awayTeam,
        homeTeam,
        sport: 'NBA',
        isBackToBack: true,
        recentRoadGames: [{ isHome: false }, { isHome: false }]  // Simplified 2-game road trip
      });

      if (welcomeCard) {
        descriptors.push(welcomeCard);
      }
    }
  }

  // --- Matchup Style Driver (Elite O vs Weak D) ---
  if (avgPtsHome && avgPtsAllowedAway && avgPtsAway && avgPtsAllowedHome) {
    let score = 0.5;
    let prediction = 'NEUTRAL';
    let reasoning = 'Balanced matchup';

    // Elite home offense vs weak away defense
    if (avgPtsHome >= 115 && avgPtsAllowedAway >= 115) {
      score = 0.80;
      prediction = 'HOME';
      reasoning = `Elite HOME offense (${avgPtsHome.toFixed(0)} pts/g) faces weak AWAY defense (${avgPtsAllowedAway.toFixed(0)} allowed)`;
    } 
    // Elite away offense vs weak home defense
    else if (avgPtsAway >= 115 && avgPtsAllowedHome >= 115) {
      score = 0.20;
      prediction = 'AWAY';
      reasoning = `Elite AWAY offense (${avgPtsAway.toFixed(0)} pts/g) faces weak HOME defense (${avgPtsAllowedHome.toFixed(0)} allowed)`;
    }
    // Balanced efficiency advantage
    else {
      const homeEfficiency = avgPtsHome - avgPtsAllowedHome;
      const awayEfficiency = avgPtsAway - avgPtsAllowedAway;
      if (Math.abs(homeEfficiency - awayEfficiency) >= 3) {
        score = homeEfficiency > awayEfficiency ? 0.65 : 0.35;
        prediction = homeEfficiency > awayEfficiency ? 'HOME' : 'AWAY';
        reasoning = `Efficiency gap: ${prediction} has +${Math.abs(homeEfficiency - awayEfficiency).toFixed(1)} net rating advantage`;
      }
    }

    const confidence = clamp(0.62 + Math.abs(score - 0.5) * 0.25, 0.58, 0.80);

    if (prediction !== 'NEUTRAL') {
      descriptors.push({
        cardType: 'nba-matchup-style',
        cardTitle: `NBA Matchup: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'matchupStyle',
        driverInputs: {
          home_offensive_rating: avgPtsHome,
          home_defensive_rating: avgPtsAllowedHome,
          away_offensive_rating: avgPtsAway,
          away_defensive_rating: avgPtsAllowedAway
        },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    }
  }

  // --- Blowout Risk Driver (From Spread Clarity) ---
  if (spreadHome !== null) {
    const absSpread = Math.abs(spreadHome);
    if (absSpread >= 8) {
      const confidence = absSpread >= 12 ? 0.75 : 0.65;
      descriptors.push({
        cardType: 'nba-blowout-risk',
        cardTitle: 'NBA Blowout Risk',
        confidence,
        tier: determineTier(confidence),
        prediction: 'NEUTRAL',
        reasoning: `Large spread (${spreadHome > 0 ? '+' : ''}${spreadHome}) indicates expected blowout — garbage time risk`,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'blowoutRisk',
        driverInputs: { spread_home: spreadHome },
        driverScore: 0.5,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    }
  }

  // --- NBA Total Projection Driver ---
  //
  // Projects game total and compares to market O/U line → OVER / UNDER edge.
  // Pace synergy (FAST×FAST, SLOW×SLOW, etc.) is applied as a point delta
  // on top of the base projection using league-average PPP (1.15 pts/possession).
  //
  // NOTE: We use simple averaging rather than the canonical PPP×pace formula
  // because our pace stat is derived from scoring (avgPoints * 0.92), not real
  // possessions. Multiplying PPP × derived-pace inflates totals by ~10-15 pts.
  // When real possession data is available, switch to projectNBACanonical().
  //
  //   homeProjected = (homeAvgPts + awayAvgPtsAllowed) / 2
  //   awayProjected = (awayAvgPts + homeAvgPtsAllowed) / 2
  //   synergyPts    = synergy.paceAdjustment × 1.15 (pts/possession)
  //   projectedTotal = homeProjected + awayProjected + synergyPts
  //   edge = projectedTotal - market_line → OVER / UNDER
  {
    const homePace = toNumber(raw?.espn_metrics?.home?.metrics?.pace ?? null);
    const awayPace = toNumber(raw?.espn_metrics?.away?.metrics?.pace ?? null);
    const homeAvgPts = toNumber(raw?.espn_metrics?.home?.metrics?.avgPoints ?? null);
    const awayAvgPts = toNumber(raw?.espn_metrics?.away?.metrics?.avgPoints ?? null);
    const homeAvgAllowed = toNumber(raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ?? null);
    const awayAvgAllowed = toNumber(raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ?? null);
    const marketTotal = toNumber(oddsSnapshot?.total);

    // Pace synergy — run for all games to get possession adjustment
    const synergy = (homePace && awayPace && homeAvgPts && awayAvgPts)
      ? analyzePaceSynergy(homePace, awayPace, homeAvgPts, awayAvgPts)
      : null;

    // Convert possession delta → points (NBA 2025-26 avg PPP ≈ 1.15)
    const LEAGUE_AVG_PPP = 1.15;
    const synergyPts = synergy ? Math.round(synergy.paceAdjustment * LEAGUE_AVG_PPP * 10) / 10 : 0;

    if (homeAvgPts && homeAvgAllowed && awayAvgPts && awayAvgAllowed && marketTotal) {
      const homeProjected = (homeAvgPts + awayAvgAllowed) / 2;
      const awayProjected = (awayAvgPts + homeAvgAllowed) / 2;
      const projectedTotal = Math.round((homeProjected + awayProjected + synergyPts) * 10) / 10;

      const edge = Math.round((projectedTotal - marketTotal) * 10) / 10;
      const absEdge = Math.abs(edge);

      // Only emit when edge is meaningful (< 1.0 pt is noise)
      if (absEdge >= 1.0) {
        const direction = edge > 0 ? 'OVER' : 'UNDER';

        // Confidence scales with edge magnitude
        let confidence;
        if (absEdge >= 5.0)      confidence = 0.75;
        else if (absEdge >= 3.0) confidence = 0.70;
        else if (absEdge >= 2.0) confidence = 0.65;
        else                     confidence = 0.61;

        const synergyLabel = (synergy && synergy.synergyType !== 'NONE' && synergy.synergyType !== 'PACE_CLASH')
          ? ` [${synergy.synergyType}, ${synergyPts > 0 ? '+' : ''}${synergyPts} pts]`
          : '';

        descriptors.push({
          cardType: 'nba-total-projection',
          cardTitle: `NBA Total: ${direction} ${projectedTotal} vs Line ${marketTotal}`,
          confidence,
          tier: determineTier(confidence),
          prediction: direction,
          reasoning: `Model projects ${projectedTotal} total (${Math.round(homeProjected * 10) / 10} + ${Math.round(awayProjected * 10) / 10}) vs line ${marketTotal} — edge ${edge > 0 ? '+' : ''}${edge} pts${synergyLabel}`,
          ev_threshold_passed: confidence > 0.60,
          driverKey: 'totalProjection',
          driverInputs: {
            projected_total: projectedTotal,
            market_total: marketTotal,
            edge,
            synergy_pts: synergyPts,
            synergy_type: synergy?.synergyType ?? 'NONE',
            synergy_signal: synergy?.bettingSignal ?? 'NO_EDGE',
            home_projected: Math.round(homeProjected * 10) / 10,
            away_projected: Math.round(awayProjected * 10) / 10
          },
          driverScore: direction === 'OVER' ? 0.75 : 0.25,
          driverStatus: 'ok',
          inference_source: 'driver',
          is_mock: false
        });
      }
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

  if (sport === 'NBA') {
    const nbaCards = computeNBADriverCards(gameId, oddsSnapshot);
    if (nbaCards.length > 0) {
      // Aggregate: take the highest-confidence card as the representative signal
      const best = nbaCards.reduce((a, b) => b.confidence > a.confidence ? b : a);
      return {
        prediction: best.prediction,
        confidence: best.confidence,
        ev_threshold_passed: best.ev_threshold_passed,
        reasoning: best.reasoning,
        drivers: nbaCards,
        inference_source: 'mock',
        model_endpoint: null,
        is_mock: true
      };
    }
  }

  if (sport === 'NCAAM' || sport === 'NCAA') {
    const ncaamCards = computeNCAAMDriverCards(gameId, oddsSnapshot);
    if (ncaamCards.length > 0) {
      // Aggregate: take the highest-confidence card
      const best = ncaamCards.reduce((a, b) => b.confidence > a.confidence ? b : a);
      return {
        prediction: best.prediction,
        confidence: best.confidence,
        ev_threshold_passed: best.ev_threshold_passed,
        reasoning: best.reasoning,
        drivers: ncaamCards,
        inference_source: 'mock',
        model_endpoint: null,
        is_mock: true
      };
    }
  }

  // Remaining sports (NFL, MLB, FPL) — keep mock constant fallback.
  // Note: For FPL this is a shared-contract compatibility signal only;
  // the domain strategy engine is FPL Sage.
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
 * Compute per-driver NCAAM card descriptors from a single odds snapshot.
 *
 * Uses college basketball specific formulas with 2.5pt HCA and Welcome Home adjustment.
 * Drivers: base-projection, matchup-style
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @returns {Array<object>} Array of card descriptor objects
 */
function computeNCAAMDriverCards(_gameId, oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const descriptors = [];

  // Extract ESPN-enriched metrics
  const avgPtsHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPoints ?? raw?.avg_points_home);
  const avgPtsAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPoints ?? raw?.avg_points_away);
  const avgPtsAllowedHome = toNumber(raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ?? raw?.avg_points_allowed_home);
  const avgPtsAllowedAway = toNumber(raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ?? raw?.avg_points_allowed_away);
  const restDaysHome = toNumber(raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home);
  const restDaysAway = toNumber(raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away);

  // --- Base Projection Driver (NCAAM Formula with HCA) ---
  if (avgPtsHome && avgPtsAway && avgPtsAllowedHome && avgPtsAllowedAway) {
    const projection = projectNCAAM(avgPtsHome, avgPtsAllowedHome, avgPtsAway, avgPtsAllowedAway);

    if (projection.homeProjected && projection.awayProjected) {
      const projectedMargin = projection.projectedMargin;
      
      // NCAAM confidence slightly different from NBA (college variance higher)
      let confidence = 0.55;
      
      if (Math.abs(projectedMargin) >= 10) {
        confidence = 0.72;
      } else if (Math.abs(projectedMargin) >= 5) {
        confidence = 0.65;
      } else if (Math.abs(projectedMargin) < 3) {
        confidence = 0.50 + (Math.random() * 0.05);  // Slight variance in toss-up games
      }

      descriptors.push({
        cardType: 'ncaam-base-projection',
        cardTitle: `NCAAM Projection: ${projectedMargin > 0 ? 'HOME' : 'AWAY'} ${Math.abs(projectedMargin).toFixed(1)}`,
        confidence,
        tier: determineTier(confidence),
        prediction: projectedMargin > 0 ? 'HOME' : 'AWAY',
        reasoning: `Projection: ${projection.homeProjected.toFixed(1)} vs ${projection.awayProjected.toFixed(1)} (HCA: +2.5pts)`,
        ev_threshold_passed: confidence > 0.60,
        driverKey: 'baseProjection',
        driverInputs: {
          home_avg_pts: avgPtsHome,
          away_avg_pts: avgPtsAway,
          home_def: avgPtsAllowedHome,
          away_def: avgPtsAllowedAway,
          projected_margin: projectedMargin
        },
        driverScore: clamp((projectedMargin + 25) / 50, 0, 1),
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        projectionDetails: {
          homeProjected: projection.homeProjected,
          awayProjected: projection.awayProjected,
          hca: 2.5
        }
      });
    }
  }

  // --- Rest Advantage Driver (College-specific) ---
  if (restDaysHome !== null && restDaysAway !== null) {
    const homeB2B = restDaysHome === 0;
    const awayB2B = restDaysAway !== 0;

    if (homeB2B || awayB2B) {
      let prediction, confidence, reasoning;

      if (homeB2B && !awayB2B) {
        prediction = 'AWAY';
        confidence = clamp(0.64 + (restDaysAway - restDaysHome) * 0.08, 0.58, 0.75);
        reasoning = `HOME on B2B vs AWAY rested — college fatigue compounds quickly`;
      } else if (awayB2B && !homeB2B) {
        prediction = 'HOME';
        confidence = clamp(0.64 + (restDaysHome - restDaysAway) * 0.08, 0.58, 0.75);
        reasoning = `AWAY on B2B vs HOME rested — home court + rest edge`;
      } else {
        prediction = 'NEUTRAL';
        confidence = 0.55;
        reasoning = 'Both on B2B — rest neutral';
      }

      if (confidence > 0.60) {
        descriptors.push({
          cardType: 'ncaam-rest-advantage',
          cardTitle: `NCAAM Rest: ${prediction}`,
          confidence,
          tier: determineTier(confidence),
          prediction,
          reasoning,
          ev_threshold_passed: true,
          driverKey: 'restAdvantage',
          driverInputs: { rest_days_home: restDaysHome, rest_days_away: restDaysAway },
          driverScore: prediction === 'HOME' ? 0.70 : prediction === 'AWAY' ? 0.30 : 0.5,
          driverStatus: 'ok',
          inference_source: 'driver',
          is_mock: false
        });
      }
    }
  }

  // --- Matchup Style Driver (Elite O vs Weak D) ---
  if (avgPtsHome && avgPtsAllowedAway && avgPtsAway && avgPtsAllowedHome) {
    let prediction = 'NEUTRAL';
    let confidence = 0.55;
    let reasoning = 'Balanced matchup';

    const homeEfficiency = avgPtsHome - avgPtsAllowedHome;
    const awayEfficiency = avgPtsAway - avgPtsAllowedAway;
    const efficiencyGap = homeEfficiency - awayEfficiency;

    if (Math.abs(efficiencyGap) >= 5) {
      confidence = clamp(0.65 + Math.abs(efficiencyGap) * 0.04, 0.60, 0.78);
      prediction = efficiencyGap > 0 ? 'HOME' : 'AWAY';
      reasoning = `Efficiency gap: ${prediction} has +${Math.abs(efficiencyGap).toFixed(1)} net rating`;
    }

    if (prediction !== 'NEUTRAL' && confidence > 0.60) {
      descriptors.push({
        cardType: 'ncaam-matchup-style',
        cardTitle: `NCAAM Matchup: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning,
        ev_threshold_passed: true,
        driverKey: 'matchupStyle',
        driverInputs: {
          home_offensive_rating: avgPtsHome,
          home_defensive_rating: avgPtsAllowedHome,
          away_offensive_rating: avgPtsAway,
          away_defensive_rating: avgPtsAllowedAway,
          efficiency_gap: efficiencyGap
        },
        driverScore: prediction === 'HOME' ? 0.70 : 0.30,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false
      });
    }
  }

  return descriptors;
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
  computeNCAAMDriverCards,
  determineTier,
  computeNHLMarketDecisions,
  selectExpressionChoice,
  buildMarketPayload
};
