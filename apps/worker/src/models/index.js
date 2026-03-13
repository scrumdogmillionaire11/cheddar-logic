/**
 * Inference Models Plugin System
 *
 * This module provides a pluggable architecture for running inference models.
 * Each sport has a model factory that can be swapped for real inference.
 *
 * Usage:
 *   const { getModel } = require('./index');
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
const {
  projectNBA,
  projectNCAAM,
  projectNHL,
} = require('./projections');
const { generateWelcomeHomeCard } = require('./welcome-home-v2');
const {
  computeNHLMarketDecisions,
  computeNBAMarketDecisions,
  selectExpressionChoice,
  computeTotalBias,
  buildMarketPayload,
} = require('./cross-market');
const { predictNHLGame } = require('./nhl-pace-model');
const { resolveGoalieState } = require('./nhl-goalie-state');
const { generateCard, buildMarketCallCard } = require('@cheddar-logic/models');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';
const NHL_1P_REFERENCE_TOTAL_LINE = 1.5;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

function pickNumberWithSource(candidates = []) {
  for (const candidate of candidates) {
    const value = toNumber(candidate?.value);
    if (value !== null) {
      return { value, source: candidate?.source || null };
    }
  }
  return { value: null, source: null };
}

function computeGoalsSharePct(goalsFor, goalsAgainst) {
  if (goalsFor === null || goalsAgainst === null) return null;
  const total = goalsFor + goalsAgainst;
  if (!Number.isFinite(total) || total <= 0) return null;
  return Number((goalsFor / total * 100).toFixed(3));
}

function extractNhlDriverDataQualityContext(rawDataInput) {
  const raw = parseRawData(rawDataInput);

  const ppHome = pickNumberWithSource([
    { value: raw?.pp_home_pct, source: 'raw.pp_home_pct' },
    { value: raw?.special_teams?.home?.pp_pct, source: 'raw.special_teams.home.pp_pct' },
  ]);
  const pkHome = pickNumberWithSource([
    { value: raw?.pk_home_pct, source: 'raw.pk_home_pct' },
    { value: raw?.special_teams?.home?.pk_pct, source: 'raw.special_teams.home.pk_pct' },
  ]);
  const ppAway = pickNumberWithSource([
    { value: raw?.pp_away_pct, source: 'raw.pp_away_pct' },
    { value: raw?.special_teams?.away?.pp_pct, source: 'raw.special_teams.away.pp_pct' },
  ]);
  const pkAway = pickNumberWithSource([
    { value: raw?.pk_away_pct, source: 'raw.pk_away_pct' },
    { value: raw?.special_teams?.away?.pk_pct, source: 'raw.special_teams.away.pk_pct' },
  ]);
  const ppDelta =
    ppHome.value !== null && ppAway.value !== null
      ? Number((ppHome.value - ppAway.value).toFixed(3))
      : null;
  const pkDelta =
    pkHome.value !== null && pkAway.value !== null
      ? Number((pkHome.value - pkAway.value).toFixed(3))
      : null;
  const specialTeamsDelta =
    ppDelta !== null && pkDelta !== null
      ? Number((ppDelta + pkDelta).toFixed(3))
      : null;

  const xgfHome = pickNumberWithSource([
    { value: raw?.xgf_home_pct, source: 'raw.xgf_home_pct' },
    { value: raw?.teams?.home?.xgf_pct, source: 'raw.teams.home.xgf_pct' },
    { value: raw?.xgf?.home_pct, source: 'raw.xgf.home_pct' },
  ]);
  const xgfAway = pickNumberWithSource([
    { value: raw?.xgf_away_pct, source: 'raw.xgf_away_pct' },
    { value: raw?.teams?.away?.xgf_pct, source: 'raw.teams.away.xgf_pct' },
    { value: raw?.xgf?.away_pct, source: 'raw.xgf.away_pct' },
  ]);
  const xgfDelta =
    xgfHome.value !== null && xgfAway.value !== null
      ? Number((xgfHome.value - xgfAway.value).toFixed(3))
      : null;

  const goalsForHome = pickNumberWithSource([
    {
      value: raw?.espn_metrics?.home?.metrics?.avgGoalsFor,
      source: 'raw.espn_metrics.home.metrics.avgGoalsFor',
    },
    { value: raw?.goals_for_home, source: 'raw.goals_for_home' },
  ]);
  const goalsAgainstHome = pickNumberWithSource([
    {
      value: raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst,
      source: 'raw.espn_metrics.home.metrics.avgGoalsAgainst',
    },
    { value: raw?.goals_against_home, source: 'raw.goals_against_home' },
  ]);
  const goalsForAway = pickNumberWithSource([
    {
      value: raw?.espn_metrics?.away?.metrics?.avgGoalsFor,
      source: 'raw.espn_metrics.away.metrics.avgGoalsFor',
    },
    { value: raw?.goals_for_away, source: 'raw.goals_for_away' },
  ]);
  const goalsAgainstAway = pickNumberWithSource([
    {
      value: raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst,
      source: 'raw.espn_metrics.away.metrics.avgGoalsAgainst',
    },
    { value: raw?.goals_against_away, source: 'raw.goals_against_away' },
  ]);
  const goalsShareHome = computeGoalsSharePct(
    goalsForHome.value,
    goalsAgainstHome.value,
  );
  const goalsShareAway = computeGoalsSharePct(
    goalsForAway.value,
    goalsAgainstAway.value,
  );
  const goalsShareProxyDelta =
    goalsShareHome !== null && goalsShareAway !== null
      ? Number((goalsShareHome - goalsShareAway).toFixed(3))
      : null;

  return {
    enrichment_version: 'nhl-driver-context-v1',
    special_teams: {
      pp_home_pct: ppHome.value,
      pk_home_pct: pkHome.value,
      pp_away_pct: ppAway.value,
      pk_away_pct: pkAway.value,
      pp_delta: ppDelta,
      pk_delta: pkDelta,
      pp_pk_delta: specialTeamsDelta,
      available: specialTeamsDelta !== null,
      status: statusFromNumbers([
        ppHome.value,
        pkHome.value,
        ppAway.value,
        pkAway.value,
      ]),
      missing_inputs: [
        ppHome.value === null ? 'pp_home_pct' : null,
        pkHome.value === null ? 'pk_home_pct' : null,
        ppAway.value === null ? 'pp_away_pct' : null,
        pkAway.value === null ? 'pk_away_pct' : null,
      ].filter(Boolean),
      sources: {
        pp_home_pct: ppHome.source,
        pk_home_pct: pkHome.source,
        pp_away_pct: ppAway.source,
        pk_away_pct: pkAway.source,
      },
    },
    shot_environment: {
      xgf_home_pct: xgfHome.value,
      xgf_away_pct: xgfAway.value,
      delta: xgfDelta,
      available: xgfDelta !== null,
      status: statusFromNumbers([xgfHome.value, xgfAway.value]),
      missing_inputs: [
        xgfHome.value === null ? 'xgf_home_pct' : null,
        xgfAway.value === null ? 'xgf_away_pct' : null,
      ].filter(Boolean),
      sources: {
        xgf_home_pct: xgfHome.source,
        xgf_away_pct: xgfAway.source,
      },
      proxy: {
        metric: 'goals_share_pct',
        delta: goalsShareProxyDelta,
        available: goalsShareProxyDelta !== null,
        home_share_pct: goalsShareHome,
        away_share_pct: goalsShareAway,
        sources: {
          goals_for_home: goalsForHome.source,
          goals_against_home: goalsAgainstHome.source,
          goals_for_away: goalsForAway.source,
          goals_against_away: goalsAgainstAway.source,
        },
      },
    },
  };
}

function normalizeGoalieCertaintyToken(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase();
  
  // Status semantics (CRITICAL: preserve throughout pipeline to API):
  // CONFIRMED = official game-day roster decision (locked, don't downgrade)
  // EXPECTED = projected/likely but not yet officially confirmed
  // UNKNOWN = uncertain or unconfirmed
  // 
  // !!! DO NOT DOWNGRADE CONFIRMED → EXPECTED !!!
  // Montreal @ Ottawa with Jacob Fowler CONFIRMED means roster is locked.
  // EDM @ DAL with Tristan Jarry EXPECTED means still subject to change.
  // This distinction must reach the API so UI can display appropriate certainty.
  
  if (token === 'CONFIRMED' || token === 'STARTING' || token === 'OFFICIAL') {
    return 'CONFIRMED';
  }
  if (token === 'EXPECTED' || token === 'PROJECTED' || token === 'LIKELY') {
    return 'EXPECTED';
  }
  if (token === 'UNKNOWN' || token === 'UNCONFIRMED' || token === 'TBD') {
    return 'UNKNOWN';
  }
  return null;
}

function resolveGoalieCertainty(raw, side) {
  const sideKey = side === 'home' ? 'home' : 'away';
  const nested =
    normalizeGoalieCertaintyToken(raw?.goalie?.[sideKey]?.status) ??
    normalizeGoalieCertaintyToken(raw?.goalies?.[sideKey]?.status);
  if (nested) return nested;
  const flat =
    sideKey === 'home'
      ? normalizeGoalieCertaintyToken(raw?.goalie_home_status)
      : normalizeGoalieCertaintyToken(raw?.goalie_away_status);
  if (flat) return flat;
  return 'UNKNOWN';
}

function starterStateToGoalieCertainty(starterState) {
  if (starterState === 'CONFIRMED') return 'CONFIRMED';
  if (starterState === 'EXPECTED') return 'EXPECTED';
  return 'UNKNOWN';
}

function buildScraperGoalieInputFromRaw(raw, side) {
  const sideKey = side === 'home' ? 'home' : 'away';
  const goalieName = isNonEmptyString(raw?.goalie?.[sideKey]?.name)
    ? raw.goalie[sideKey].name.trim()
    : null;
  const status =
    raw?.goalie?.[sideKey]?.status ??
    (sideKey === 'home' ? raw?.goalie_home_status : raw?.goalie_away_status) ??
    null;
  const gsax = toNumber(
    sideKey === 'home'
      ? raw?.goalie_home_gsax ?? raw?.goalie?.home?.gsax ?? raw?.goalies?.home?.gsax
      : raw?.goalie_away_gsax ?? raw?.goalie?.away?.gsax ?? raw?.goalies?.away?.gsax,
  );
  const savePct = toNumber(
    sideKey === 'home'
      ? raw?.goalie_home_save_pct ?? raw?.goalie?.home?.save_pct ?? raw?.goalies?.home?.save_pct
      : raw?.goalie_away_save_pct ?? raw?.goalie?.away?.save_pct ?? raw?.goalies?.away?.save_pct,
  );

  return {
    goalie_name: goalieName,
    status,
    gsax,
    save_pct: savePct,
    source_type: goalieName ? 'SCRAPER_NAME_MATCH' : 'SEASON_TABLE_INFERENCE',
  };
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
  if (confidence >= 0.7) return 'BEST';
  if (confidence >= 0.6) return 'WATCH';
  return null;
}

function computeNHLDrivers(gameId, oddsSnapshot) {
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const total = toNumber(oddsSnapshot?.total);
  const nhlDataQuality = extractNhlDriverDataQualityContext(raw);

  const goalieHomeGsax = toNumber(
    raw?.goalie_home_gsax ??
      raw?.goalie?.home?.gsax ??
      raw?.goalies?.home?.gsax,
  );
  const goalieAwayGsax = toNumber(
    raw?.goalie_away_gsax ??
      raw?.goalie?.away?.gsax ??
      raw?.goalies?.away?.gsax,
  );
  const goalieDelta =
    goalieHomeGsax !== null && goalieAwayGsax !== null
      ? goalieHomeGsax - goalieAwayGsax
      : null;
  const goalieScore =
    goalieDelta === null ? 0.5 : clamp((goalieDelta + 3) / 6, 0, 1);

  const ppHome = nhlDataQuality.special_teams.pp_home_pct;
  const pkHome = nhlDataQuality.special_teams.pk_home_pct;
  const ppAway = nhlDataQuality.special_teams.pp_away_pct;
  const pkAway = nhlDataQuality.special_teams.pk_away_pct;
  const specialTeamsDelta = nhlDataQuality.special_teams.pp_pk_delta;
  const specialTeamsScore =
    specialTeamsDelta === null
      ? 0.5
      : clamp((specialTeamsDelta + 25) / 50, 0, 1);

  const xgfHome = nhlDataQuality.shot_environment.xgf_home_pct;
  const xgfAway = nhlDataQuality.shot_environment.xgf_away_pct;
  const shotQualityDelta = nhlDataQuality.shot_environment.delta;
  const shotEnvironmentScore =
    shotQualityDelta === null ? 0.5 : clamp((shotQualityDelta + 10) / 20, 0, 1);

  const pulledHomeSec = toNumber(
    raw?.empty_net_pull_home_sec ?? raw?.empty_net?.home_pull_seconds_remaining,
  );
  const pulledAwaySec = toNumber(
    raw?.empty_net_pull_away_sec ?? raw?.empty_net?.away_pull_seconds_remaining,
  );
  const pullDelta =
    pulledHomeSec !== null && pulledAwaySec !== null
      ? pulledHomeSec - pulledAwaySec
      : null;
  const emptyNetScore =
    pullDelta === null ? 0.5 : clamp((pullDelta + 60) / 120, 0, 1);

  const fragilityDistance =
    total === null
      ? null
      : Math.min(Math.abs(total - 5.5), Math.abs(total - 6.5));
  const totalFragilityScore =
    fragilityDistance === null ? 0.5 : clamp(1 - fragilityDistance / 0.6, 0, 1);

  const pdoHome = toNumber(raw?.pdo_home ?? raw?.teams?.home?.pdo);
  const pdoAway = toNumber(raw?.pdo_away ?? raw?.teams?.away?.pdo);
  const pdoDelta =
    pdoHome !== null && pdoAway !== null ? pdoAway - pdoHome : null;
  const pdoRegressionScore =
    pdoDelta === null ? 0.5 : clamp((pdoDelta + 0.04) / 0.08, 0, 1);

  const drivers = {
    goalie: {
      score: goalieScore,
      weight: 0.24,
      status: statusFromNumbers([goalieHomeGsax, goalieAwayGsax]),
      inputs: {
        home_gsax: goalieHomeGsax,
        away_gsax: goalieAwayGsax,
        delta: goalieDelta,
      },
      note: 'Uses GSaX when available; neutral fallback when unavailable.',
    },
    specialTeams: {
      score: specialTeamsScore,
      weight: 0.16,
      status: statusFromNumbers([ppHome, pkHome, ppAway, pkAway]),
      inputs: {
        pp_home_pct: ppHome,
        pk_home_pct: pkHome,
        pp_away_pct: ppAway,
        pk_away_pct: pkAway,
        pp_delta: nhlDataQuality.special_teams.pp_delta,
        pk_delta: nhlDataQuality.special_teams.pk_delta,
        pp_pk_delta: specialTeamsDelta,
        delta: specialTeamsDelta,
        missing_inputs: nhlDataQuality.special_teams.missing_inputs,
        sources: nhlDataQuality.special_teams.sources,
      },
      note: 'Power-play + penalty-kill mismatch.',
    },
    shotEnvironment: {
      score: shotEnvironmentScore,
      weight: 0.14,
      status: statusFromNumbers([xgfHome, xgfAway]),
      inputs: {
        xgf_home_pct: xgfHome,
        xgf_away_pct: xgfAway,
        delta: shotQualityDelta,
        missing_inputs: nhlDataQuality.shot_environment.missing_inputs,
        sources: nhlDataQuality.shot_environment.sources,
        proxy: nhlDataQuality.shot_environment.proxy,
      },
      note: 'Uses xGF% shot-quality profile (5v5) when available.',
    },
    emptyNet: {
      score: emptyNetScore,
      weight: 0.08,
      status: statusFromNumbers([pulledHomeSec, pulledAwaySec]),
      inputs: {
        home_pull_sec_remaining: pulledHomeSec,
        away_pull_sec_remaining: pulledAwaySec,
        delta: pullDelta,
      },
      note: 'Late-game goalie pull aggressiveness proxy.',
    },
    totalFragility: {
      score: totalFragilityScore,
      weight: 0.06,
      status: statusFromNumbers([total]),
      inputs: { total, nearest_key_number_distance: fragilityDistance },
      note: 'Sensitivity near 5.5 / 6.5 totals.',
    },
    pdoRegression: {
      score: pdoRegressionScore,
      weight: 0.18,
      status: statusFromNumbers([pdoHome, pdoAway]),
      inputs: { pdo_home: pdoHome, pdo_away: pdoAway, delta: pdoDelta },
      note: 'Regression pressure from PDO imbalance.',
    },
  };

  const weightedScores = Object.values(drivers).map(
    (driver) => driver.score * driver.weight,
  );
  const weightedSum = weightedScores.reduce((sum, value) => sum + value, 0);
  const confidence = clamp(weightedSum, 0.5, 0.85);

  const prediction =
    weightedSum > 0.5 ? 'HOME' : weightedSum < 0.5 ? 'AWAY' : 'NEUTRAL';

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
      top_drivers: topDrivers,
    },
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
 * @param {{ recentRoadGames?: Array<object>|null, canonicalGoalieState?: {home?: object, away?: object}|null }} context
 * @returns {Array<object>} Array of card descriptor objects
 */
function computeNHLDriverCards(gameId, oddsSnapshot, context = {}) {
  const { recentRoadGames = null, canonicalGoalieState = null } = context;
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const total = toNumber(oddsSnapshot?.total);
  const nhlDataQuality = extractNhlDriverDataQualityContext(raw);

  const descriptors = [];

  // Extract ESPN-enriched metrics (for future integration with advanced stats)
  const goalsForHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgGoalsFor ??
      raw?.goals_for_home ??
      null,
  );
  const goalsForAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgGoalsFor ??
      raw?.goals_for_away ??
      null,
  );
  const goalsAgainstHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst ??
      raw?.goals_against_home ??
      null,
  );
  const goalsAgainstAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst ??
      raw?.goals_against_away ??
      null,
  );
  const restDaysHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null,
  );
  const restDaysAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? null,
  );

  const goalieHomeGsax = toNumber(
    raw?.goalie_home_gsax ??
      raw?.goalie?.home?.gsax ??
      raw?.goalies?.home?.gsax,
  );
  const goalieAwayGsax = toNumber(
    raw?.goalie_away_gsax ??
      raw?.goalie?.away?.gsax ??
      raw?.goalies?.away?.gsax,
  );
  const homeGoalieState =
    canonicalGoalieState?.home ??
    resolveGoalieState(
      buildScraperGoalieInputFromRaw(raw, 'home'),
      null,
      gameId,
      'home',
      { gameTimeUtc: oddsSnapshot?.game_time_utc },
    );
  const awayGoalieState =
    canonicalGoalieState?.away ??
    resolveGoalieState(
      buildScraperGoalieInputFromRaw(raw, 'away'),
      null,
      gameId,
      'away',
      { gameTimeUtc: oddsSnapshot?.game_time_utc },
    );
  const homeGoalieCertainty = starterStateToGoalieCertainty(
    homeGoalieState.starter_state,
  );
  const awayGoalieCertainty = starterStateToGoalieCertainty(
    awayGoalieState.starter_state,
  );
  const homeGoalieName = homeGoalieState.goalie_name;
  const awayGoalieName = awayGoalieState.goalie_name;
  const homeGoalieConfirmed = homeGoalieCertainty === 'CONFIRMED';
  const awayGoalieConfirmed = awayGoalieCertainty === 'CONFIRMED';
  const goalieCertaintyStatus =
    homeGoalieCertainty === 'CONFIRMED' && awayGoalieCertainty === 'CONFIRMED'
      ? 'ok'
      : homeGoalieCertainty !== 'UNKNOWN' || awayGoalieCertainty !== 'UNKNOWN'
        ? 'partial'
        : 'missing';

  const xgfHome = nhlDataQuality.shot_environment.xgf_home_pct;
  const xgfAway = nhlDataQuality.shot_environment.xgf_away_pct;
  const shotQualityDelta = nhlDataQuality.shot_environment.delta;

  // --- Base Projection Driver (Real Formula with Goalie Adjustment) ---
  if (goalsForHome && goalsForAway && goalsAgainstHome && goalsAgainstAway) {
    const projection = projectNHL(
      goalsForHome,
      goalsAgainstHome,
      goalsForAway,
      goalsAgainstAway,
      homeGoalieConfirmed,
      awayGoalieConfirmed,
    );

    if (projection.homeProjected && projection.awayProjected) {
      const projectedMargin =
        projection.homeProjected - projection.awayProjected;

      descriptors.push({
        cardType: 'nhl-base-projection',
        cardTitle: `NHL Projection: ${projectedMargin > 0 ? 'HOME' : 'AWAY'} ${projectedMargin > 0 ? '+' : ''}${projectedMargin.toFixed(2)}`,
        confidence: projection.confidence,
        tier: determineTier(projection.confidence),
        prediction: projectedMargin > 0 ? 'HOME' : 'AWAY',
        reasoning: `Base projection: ${projection.homeProjected.toFixed(2)} vs ${projection.awayProjected.toFixed(2)} goals (${homeGoalieConfirmed ? 'confirmed' : 'unconfirmed'} goalies)`,
        ev_threshold_passed: projection.confidence > 0.6,
        driverKey: 'baseProjection',
        driverInputs: {
          home_goals_for: goalsForHome,
          away_goals_for: goalsForAway,
          home_goals_against: goalsAgainstHome,
          away_goals_against: goalsAgainstAway,
          home_goalie_name: homeGoalieName,
          away_goalie_name: awayGoalieName,
          home_goalie_confirmed: homeGoalieConfirmed,
          away_goalie_confirmed: awayGoalieConfirmed,
          home_goalie_certainty: homeGoalieCertainty,
          away_goalie_certainty: awayGoalieCertainty,
          projected_margin: projectedMargin,
        },
        driverScore: clamp((projectedMargin + 2) / 4, 0, 1), // Normalize
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        projectionDetails: {
          homeProjected: projection.homeProjected,
          awayProjected: projection.awayProjected,
          totalProjected: projection.totalProjected,
          goalieConfirmedPenalty: projection.goalieConfirmedPenalty,
        },
      });
    }
  }

  // --- Goalie Certainty Driver (Confirmation Context) ---
  {
    const confidence =
      goalieCertaintyStatus === 'ok'
        ? 0.7
        : goalieCertaintyStatus === 'partial'
          ? 0.58
          : 0.45;
    const reasoningParts = [];
    reasoningParts.push(
      `home ${homeGoalieConfirmed ? 'confirmed' : 'unconfirmed'}`,
    );
    reasoningParts.push(
      `away ${awayGoalieConfirmed ? 'confirmed' : 'unconfirmed'}`,
    );

    descriptors.push({
      cardType: 'nhl-goalie-certainty',
      cardTitle: 'NHL Goalie Certainty',
      confidence,
      tier: determineTier(confidence),
      prediction: 'NEUTRAL',
      reasoning: `Goalie confirmation from canonical starter state: ${reasoningParts.join(', ')}`,
      ev_threshold_passed: confidence > 0.6,
      driverKey: 'goalieCertainty',
      driverInputs: {
        home_goalie_name: homeGoalieName,
        away_goalie_name: awayGoalieName,
        home_goalie_confirmed: homeGoalieConfirmed,
        away_goalie_confirmed: awayGoalieConfirmed,
        home_goalie_certainty: homeGoalieCertainty,
        away_goalie_certainty: awayGoalieCertainty,
        confirmation_source: 'status_or_gsax_proxy',
      },
      driverScore: 0.5,
      driverStatus: goalieCertaintyStatus,
      inference_source: 'driver',
      is_mock: false,
    });
  }

  // --- Rest Advantage Driver (NHL-specific: smaller penalties than NBA) ---
  if (restDaysHome !== null && restDaysAway !== null) {
    const homeB2B = restDaysHome === 0;
    const awayB2B = restDaysAway === 0;

    if (homeB2B || awayB2B) {
      let prediction, confidence, reasoning;

      if (homeB2B && !awayB2B) {
        prediction = 'AWAY';
        confidence = clamp(
          0.62 + (restDaysAway - restDaysHome) * 0.04,
          0.58,
          0.72,
        );
        reasoning = `HOME on B2B (minor NHL penalty) vs AWAY well-rested — slight fatigue edge to AWAY`;
      } else if (awayB2B && !homeB2B) {
        prediction = 'HOME';
        confidence = clamp(
          0.62 + (restDaysHome - restDaysAway) * 0.04,
          0.58,
          0.72,
        );
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
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'restAdvantage',
        driverInputs: {
          rest_days_home: restDaysHome,
          rest_days_away: restDaysAway,
        },
        driverScore:
          prediction === 'HOME' ? 0.65 : prediction === 'AWAY' ? 0.35 : 0.5,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- Welcome Home Fade v2 Driver (Cross-sport road fatigue signal) ---
  if (ENABLE_WELCOME_HOME && restDaysHome !== null && restDaysAway !== null) {
    const awayNetRating =
      goalsForAway && goalsAgainstAway
        ? (goalsForAway - goalsAgainstAway) * 10
        : null;
    const homeNetRating =
      goalsForHome && goalsAgainstHome
        ? (goalsForHome - goalsAgainstHome) * 10
        : null;

    const awayTeam = {
      netRating: awayNetRating,
      restDays: restDaysAway,
    };
    const homeTeam = {
      netRating: homeNetRating,
    };

    // Welcome Home Fade v2: Use real schedule data if available
    if (recentRoadGames && recentRoadGames.length >= 2) {
      const welcomeCard = generateWelcomeHomeCard({
        gameId,
        awayTeam,
        homeTeam,
        sport: 'NHL',
        isBackToBack: restDaysHome === 0,
        recentRoadGames,
        homeTeamRoadTrip: true,
        homeRestDays: restDaysHome,
        gameTimeUtc: oddsSnapshot?.game_time_utc,
      });

      if (welcomeCard) {
        descriptors.push(welcomeCard);
      }
    }
  }

  // --- Goalie Tier Driver (Advanced Stats) ---
  {
    const goalieDelta =
      goalieHomeGsax !== null && goalieAwayGsax !== null
        ? goalieHomeGsax - goalieAwayGsax
        : null;

    if (goalieDelta !== null) {
      const score = clamp((goalieDelta + 3) / 6, 0, 1);
      const direction =
        score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL';
      const confidence = clamp(0.65 + Math.abs(score - 0.5) * 0.3, 0.6, 0.8);

      descriptors.push({
        cardType: 'nhl-goalie',
        cardTitle: `NHL Goalie Edge: ${direction}`,
        confidence,
        tier: determineTier(confidence),
        prediction: direction,
        reasoning: `GSaX goalie tier delta (${goalieDelta.toFixed(2)}) favors ${direction}`,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'goalie',
        driverInputs: {
          home_gsax: goalieHomeGsax,
          away_gsax: goalieAwayGsax,
          delta: goalieDelta,
          home_goalie_name: homeGoalieName,
          away_goalie_name: awayGoalieName,
          home_goalie_certainty: homeGoalieCertainty,
          away_goalie_certainty: awayGoalieCertainty,
        },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- Scoring Environment Driver (Total Over/Under Signal) ---
  if (total !== null) {
    const fragilityDistance = Math.min(
      Math.abs(total - 5.5),
      Math.abs(total - 6.5),
    );
    const score = clamp(1 - fragilityDistance / 0.6, 0, 1);

    if (fragilityDistance < 0.6) {
      const confidence = clamp(0.68 - fragilityDistance * 0.1, 0.6, 0.75);
      descriptors.push({
        cardType: 'nhl-model-output',
        cardTitle: `NHL Total Fragility: Over/Under Variance`,
        confidence,
        tier: determineTier(confidence),
        prediction: 'NEUTRAL',
        reasoning: `Total ${total} near key numbers (5.5/6.5) — high O/U variance sensitivity`,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'scoringEnvironment',
        driverInputs: { total, key_number_distance: fragilityDistance },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- Shot Environment Driver (xGF% / 5v5 profile) ---
  if (shotQualityDelta !== null) {
    const score = clamp((shotQualityDelta + 10) / 20, 0, 1);
    const direction = score > 0.52 ? 'HOME' : score < 0.48 ? 'AWAY' : 'NEUTRAL';
    if (direction !== 'NEUTRAL') {
      const confidence = clamp(0.6 + Math.abs(score - 0.5) * 0.4, 0.6, 0.78);
      descriptors.push({
        cardType: 'nhl-shot-environment',
        cardTitle: `NHL Shot Environment: ${direction}`,
        confidence,
        tier: determineTier(confidence),
        prediction: direction,
        reasoning: `xGF% edge (${shotQualityDelta.toFixed(1)} pts) favors ${direction}`,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'shotEnvironment',
        driverInputs: {
          xgf_home_pct: xgfHome,
          xgf_away_pct: xgfAway,
          delta: shotQualityDelta,
          missing_inputs: nhlDataQuality.shot_environment.missing_inputs,
          sources: nhlDataQuality.shot_environment.sources,
          proxy: nhlDataQuality.shot_environment.proxy,
        },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- Pace Model Totals Driver (Full Game O/U) ---
  // JS port of TotalsPredictor.predict_game() from cheddar-nhl.
  // Emits OVER/UNDER signal when expected_total diverges >= 0.4 goals from market line.
  {
    const goalsForHome = toNumber(
      raw?.espn_metrics?.home?.metrics?.avgGoalsFor ??
        raw?.goals_for_home ??
        null,
    );
    const goalsForAway = toNumber(
      raw?.espn_metrics?.away?.metrics?.avgGoalsFor ??
        raw?.goals_for_away ??
        null,
    );
    const goalsAgainstHome = toNumber(
      raw?.espn_metrics?.home?.metrics?.avgGoalsAgainst ??
        raw?.goals_against_home ??
        null,
    );
    const goalsAgainstAway = toNumber(
      raw?.espn_metrics?.away?.metrics?.avgGoalsAgainst ??
        raw?.goals_against_away ??
        null,
    );
    const homeGoalieSavePct = toNumber(
      raw?.goalie_home_save_pct ??
        raw?.goalie?.home?.save_pct ??
        raw?.goalies?.home?.save_pct ??
        null,
    );
    const awayGoalieSavePct = toNumber(
      raw?.goalie_away_save_pct ??
        raw?.goalie?.away?.save_pct ??
        raw?.goalies?.away?.save_pct ??
        null,
    );
    const paceRestDaysHome = toNumber(
      raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home ?? null,
    );
    const paceRestDaysAway = toNumber(
      raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away ?? null,
    );
    const marketTotal = toNumber(oddsSnapshot?.total);

    const paceResult = predictNHLGame({
      homeGoalsFor: goalsForHome,
      homeGoalsAgainst: goalsAgainstHome,
      awayGoalsFor: goalsForAway,
      awayGoalsAgainst: goalsAgainstAway,
      homeGoalieSavePct,
      awayGoalieSavePct,
      homeGoalieConfirmed,
      awayGoalieConfirmed,
      homeGoalieCertainty,
      awayGoalieCertainty,
      homeGoalieState,
      awayGoalieState,
      homeB2B: paceRestDaysHome === 0,
      awayB2B: paceRestDaysAway === 0,
      restDaysHome: paceRestDaysHome,
      restDaysAway: paceRestDaysAway,
    });

    if (paceResult) {
      if (marketTotal !== null) {
        const projectedTotalForCard = Number(
          paceResult.expectedTotal.toFixed(3),
        );
        const edge =
          Math.round((projectedTotalForCard - marketTotal) * 100) / 100;
        const absEdge = Math.abs(edge);
        const direction = edge >= 0 ? 'OVER' : 'UNDER';

        // Confidence scales with edge magnitude + base model confidence
        let cardConfidence;
        if (absEdge >= 1.5)
          cardConfidence = Math.min(paceResult.confidence + 0.1, 0.8);
        else if (absEdge >= 1.0)
          cardConfidence = Math.min(paceResult.confidence + 0.05, 0.78);
        else if (absEdge >= 0.6) cardConfidence = paceResult.confidence;
        else cardConfidence = Math.max(paceResult.confidence - 0.05, 0.58);
        if (paceResult.goalieConfidenceCapped) {
          cardConfidence = Math.min(cardConfidence, 0.35);
        }

        const edgeLabel = `${edge > 0 ? '+' : ''}${edge} goals`;
        const goalieContext = ` [goalie certainty ${homeGoalieCertainty}/${awayGoalieCertainty}]`;
        const rawContext = ` [raw ${paceResult.rawTotalModel.toFixed(2)} -> regressed ${paceResult.regressedTotalModel.toFixed(2)}]`;
        const clampContext =
          paceResult.totalClampedHigh || paceResult.totalClampedLow
            ? ` [pace clamp ${paceResult.totalClampedLow ? 'low' : 'high'}]`
            : '';
        const modifierContext = paceResult.modifierCapApplied
          ? ' [modifier cap applied]'
          : '';
        const reasonCodes = [];
        if (paceResult.totalClampedHigh)
          reasonCodes.push('PACE_TOTAL_CLAMPED_HIGH');
        if (paceResult.totalClampedLow)
          reasonCodes.push('PACE_TOTAL_CLAMPED_LOW');
        if (paceResult.modifierCapApplied)
          reasonCodes.push('PACE_MODIFIER_CAP_APPLIED');

        descriptors.push({
          cardType: 'nhl-pace-totals',
          cardTitle: `NHL Total: ${direction} ${projectedTotalForCard.toFixed(2)} vs Line ${marketTotal}`,
          confidence: cardConfidence,
          tier: determineTier(cardConfidence),
          prediction: direction,
          reasoning: `Pace model projects ${projectedTotalForCard.toFixed(2)} total (${paceResult.homeExpected.toFixed(2)} home + ${paceResult.awayExpected.toFixed(2)} away) vs market ${marketTotal} — edge ${edgeLabel}${rawContext}${goalieContext}${clampContext}${modifierContext}`,
          ev_threshold_passed: cardConfidence > 0.6,
          driverKey: 'paceTotals',
          driverInputs: {
            home_goals_for: goalsForHome,
            away_goals_for: goalsForAway,
            home_goals_against: goalsAgainstHome,
            away_goals_against: goalsAgainstAway,
            home_goalie_name: homeGoalieName,
            away_goalie_name: awayGoalieName,
            home_expected: paceResult.homeExpected,
            away_expected: paceResult.awayExpected,
            expected_total: projectedTotalForCard,
            model_expected_total: paceResult.expectedTotal,
            raw_total_model: paceResult.rawTotalModel,
            regressed_total_model: paceResult.regressedTotalModel,
            market_total: marketTotal,
            edge,
            home_goalie_confirmed: paceResult.homeGoalieConfirmed,
            away_goalie_confirmed: paceResult.awayGoalieConfirmed,
            home_goalie_certainty: homeGoalieCertainty,
            away_goalie_certainty: awayGoalieCertainty,
            goalie_confidence_capped: paceResult.goalieConfidenceCapped,
            total_clamped_high: paceResult.totalClampedHigh,
            total_clamped_low: paceResult.totalClampedLow,
            modifier_cap_applied: paceResult.modifierCapApplied,
            modifier_breakdown: paceResult.modifierBreakdown,
          },
          driverScore: direction === 'OVER' ? 0.75 : 0.25,
          driverStatus: 'ok',
          inference_source: 'driver',
          is_mock: false,
          reason_codes: reasonCodes,
          market_type: 'TOTAL',
          selection: { side: direction },
          line: marketTotal,
          price:
            direction === 'OVER'
              ? toNumber(oddsSnapshot?.total_price_over ?? null)
              : toNumber(oddsSnapshot?.total_price_under ?? null),
        });
      }

      const firstPeriodModel =
        paceResult.first_period_model &&
        typeof paceResult.first_period_model === 'object'
          ? paceResult.first_period_model
          : null;
      if (
        firstPeriodModel &&
        Number.isFinite(firstPeriodModel.projection_final)
      ) {
        const projected1pTotalForCard = Number(
          firstPeriodModel.projection_final.toFixed(3),
        );
        const projectionRaw1p = Number(
          Number(
            firstPeriodModel.projection_raw ?? projected1pTotalForCard,
          ).toFixed(3),
        );
        const projectionDelta1p =
          Math.round(
            (projected1pTotalForCard - NHL_1P_REFERENCE_TOTAL_LINE) * 100,
          ) / 100;
        const classification = String(
          firstPeriodModel.classification || 'PASS',
        ).toUpperCase();
        const reasonCodes = Array.isArray(firstPeriodModel.reason_codes)
          ? firstPeriodModel.reason_codes.filter(
              (code) => typeof code === 'string',
            )
          : [];
        const goalieConfidence = String(
          firstPeriodModel.goalie_confidence || 'MEDIUM',
        ).toUpperCase();
        const confidenceBase =
          classification === 'PASS'
            ? 0.56
            : classification.includes('BEST')
              ? 0.72
              : classification.includes('PLAY')
                ? 0.67
                : 0.62;
        const confidence1p = clamp(confidenceBase, 0.55, 0.75);

        descriptors.push({
          cardType: 'nhl-pace-1p',
          cardTitle: `NHL 1P Total: ${classification} @ ${projected1pTotalForCard.toFixed(2)}`,
          confidence: confidence1p,
          tier: determineTier(confidence1p),
          prediction: classification,
          classification,
          action: classification === 'PASS' ? 'PASS' : 'HOLD',
          status: classification === 'PASS' ? 'PASS' : 'WATCH',
          reasoning: `1P model classification ${classification} from projection ${projected1pTotalForCard.toFixed(2)} (raw ${projectionRaw1p.toFixed(2)}, ref ${NHL_1P_REFERENCE_TOTAL_LINE}, goalie ${goalieConfidence.toLowerCase()}).`,
          ev_threshold_passed: classification !== 'PASS' && confidence1p > 0.6,
          driverKey: 'paceTotals1p',
          driverInputs: {
            expected_1p_total: projected1pTotalForCard,
            projection_raw: projectionRaw1p,
            projection_final: projected1pTotalForCard,
            projection_delta: projectionDelta1p,
            classification,
            home_goalie_name: homeGoalieName,
            away_goalie_name: awayGoalieName,
            environment_tag: firstPeriodModel.environment_tag ?? null,
            goalie_confidence: goalieConfidence,
            pace_1p: firstPeriodModel.pace_1p ?? null,
            suppressor_1p: firstPeriodModel.suppressor_1p ?? null,
            accelerant_1p: firstPeriodModel.accelerant_1p ?? null,
            reason_codes: reasonCodes,
            model_expected_1p_total: paceResult.expected1pTotal,
            market_1p_total: NHL_1P_REFERENCE_TOTAL_LINE,
            edge: projectionDelta1p,
            home_goalie_confirmed: paceResult.homeGoalieConfirmed,
            away_goalie_confirmed: paceResult.awayGoalieConfirmed,
            home_goalie_certainty: homeGoalieCertainty,
            away_goalie_certainty: awayGoalieCertainty,
            goalie_confidence_capped: paceResult.goalieConfidenceCapped,
          },
          driverScore: classification.includes('OVER')
            ? 0.75
            : classification.includes('UNDER')
              ? 0.25
              : 0.5,
          driverStatus: 'ok',
          inference_source: 'driver',
          is_mock: false,
          reason_codes: reasonCodes,
          market_type: 'FIRST_PERIOD',
          selection: {
            side: classification.includes('OVER')
              ? 'OVER'
              : classification.includes('UNDER')
                ? 'UNDER'
                : 'NONE',
          },
          line: NHL_1P_REFERENCE_TOTAL_LINE,
          line_source: 'fixed_reference',
          price: null,
          price_source: null,
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
function computeNBADriverCards(_gameId, oddsSnapshot, context = {}) {
  const { recentRoadGames = null } = context;
  const raw = parseRawData(oddsSnapshot?.raw_data);
  const spreadHome = toNumber(oddsSnapshot?.spread_home);

  const descriptors = [];

  // Extract ESPN-enriched metrics (with legacy fallback)
  const paceHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.pace ?? raw?.pace_home ?? raw?.home?.pace,
  );
  const paceAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.pace ?? raw?.pace_away ?? raw?.away?.pace,
  );
  const avgPtsHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgPoints ??
      raw?.avg_points_home ??
      raw?.home?.avg_points,
  );
  const avgPtsAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgPoints ??
      raw?.avg_points_away ??
      raw?.away?.avg_points,
  );
  const avgPtsAllowedHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ??
      raw?.avg_points_allowed_home ??
      raw?.home?.avg_points_allowed,
  );
  const avgPtsAllowedAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ??
      raw?.avg_points_allowed_away ??
      raw?.away?.avg_points_allowed,
  );
  const restDaysHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.restDays ??
      raw?.rest_days_home ??
      raw?.home?.rest_days,
  );
  const restDaysAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.restDays ??
      raw?.rest_days_away ??
      raw?.away?.rest_days,
  );
  const homeNetRating =
    avgPtsHome && avgPtsAllowedHome ? avgPtsHome - avgPtsAllowedHome : null;
  const awayNetRating =
    avgPtsAway && avgPtsAllowedAway ? avgPtsAway - avgPtsAllowedAway : null;

  // --- Base Projection Driver (Real Formula) ---
  if (avgPtsHome && avgPtsAway && avgPtsAllowedHome && avgPtsAllowedAway) {
    const projection = projectNBA(
      avgPtsHome,
      avgPtsAllowedHome,
      avgPtsAway,
      avgPtsAllowedAway,
      paceHome || 100,
      paceAway || 100,
      restDaysHome || 1,
      restDaysAway || 1,
    );

    if (projection.homeProjected && projection.awayProjected) {
      const projectedMargin =
        projection.homeProjected - projection.awayProjected;
      const highConfidenceProjection = projection.confidence >= 0.7;

      descriptors.push({
        cardType: 'nba-base-projection',
        cardTitle: `NBA Projection: ${projectedMargin > 0 ? 'HOME' : 'AWAY'} ${Math.abs(projectedMargin).toFixed(1)}`,
        confidence: projection.confidence,
        tier: determineTier(projection.confidence),
        prediction: projectedMargin > 0 ? 'HOME' : 'AWAY',
        reasoning: `Base projection: ${projection.homeProjected.toFixed(1)} vs ${projection.awayProjected.toFixed(1)} (pace multiplier: ${projection.paceMultiplier.toFixed(2)}x, rest adj: ${projection.homeRestAdj}/${projection.awayRestAdj})`,
        ev_threshold_passed: projection.confidence > 0.6,
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
          projected_margin: projectedMargin,
        },
        driverScore: clamp((projectedMargin + 20) / 40, 0, 1), // Normalize to 0-1
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        projectionDetails: {
          homeProjected: projection.homeProjected,
          awayProjected: projection.awayProjected,
          paceMultiplier: projection.paceMultiplier,
          netRatingGap: projection.netRatingGap,
        },
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
        confidence = clamp(
          0.65 + (restDaysAway - restDaysHome) * 0.08,
          0.6,
          0.8,
        );
        reasoning = `HOME on B2B (${restDaysHome}d rest) vs AWAY rested (${restDaysAway}d) — fatigue favors AWAY`;
      } else if (awayB2B && !homeB2B) {
        score = 0.8;
        prediction = 'HOME';
        confidence = clamp(
          0.65 + (restDaysHome - restDaysAway) * 0.08,
          0.6,
          0.8,
        );
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
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'restAdvantage',
        driverInputs: {
          rest_days_home: restDaysHome,
          rest_days_away: restDaysAway,
        },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    } else if (Math.abs(restDaysHome - restDaysAway) >= 2) {
      // Partial rest advantage (not B2B but significant gap)
      const restGap = restDaysHome - restDaysAway;
      const score = restGap > 0 ? 0.65 : 0.35;
      const prediction = restGap > 0 ? 'HOME' : 'AWAY';
      const confidence = clamp(0.6 + Math.abs(restGap) * 0.05, 0.58, 0.72);

      descriptors.push({
        cardType: 'nba-rest-advantage',
        cardTitle: `NBA Rest: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning: `Rest gap: ${prediction} team has ${Math.abs(restGap)} more days rest`,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'restAdvantage',
        driverInputs: {
          rest_days_home: restDaysHome,
          rest_days_away: restDaysAway,
          rest_gap: restGap,
        },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- Welcome Home v2 Driver (Cross-sport road fatigue signal) ---
  if (ENABLE_WELCOME_HOME && restDaysHome !== null && restDaysAway !== null) {
    const awayTeam = {
      netRating: awayNetRating,
      restDays: restDaysAway,
    };
    const homeTeam = {
      netRating: homeNetRating,
    };

    // Welcome Home Fade v2: Use real schedule data if available
    if (recentRoadGames && recentRoadGames.length >= 2) {
      const welcomeCard = generateWelcomeHomeCard({
        gameId: _gameId,
        awayTeam,
        homeTeam,
        sport: 'NBA',
        isBackToBack: restDaysHome === 0,
        recentRoadGames,
        homeTeamRoadTrip: true,
        homeRestDays: restDaysHome,
        gameTimeUtc: oddsSnapshot?.game_time_utc,
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
      score = 0.8;
      prediction = 'HOME';
      reasoning = `Elite HOME offense (${avgPtsHome.toFixed(0)} pts/g) faces weak AWAY defense (${avgPtsAllowedAway.toFixed(0)} allowed)`;
    }
    // Elite away offense vs weak home defense
    else if (avgPtsAway >= 115 && avgPtsAllowedHome >= 115) {
      score = 0.2;
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

    const confidence = clamp(0.62 + Math.abs(score - 0.5) * 0.25, 0.58, 0.8);

    if (prediction !== 'NEUTRAL') {
      descriptors.push({
        cardType: 'nba-matchup-style',
        cardTitle: `NBA Matchup: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'matchupStyle',
        driverInputs: {
          home_offensive_rating: avgPtsHome,
          home_defensive_rating: avgPtsAllowedHome,
          away_offensive_rating: avgPtsAway,
          away_defensive_rating: avgPtsAllowedAway,
        },
        driverScore: score,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
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
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'blowoutRisk',
        driverInputs: { spread_home: spreadHome },
        driverScore: 0.5,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- NBA Total Projection Driver ---
  //
  // Keep projected total aligned with cross-market totals decisions:
  // use the same projectNBA() path + rounded projected_total output.
  {
    const homePace = toNumber(raw?.espn_metrics?.home?.metrics?.pace ?? null);
    const awayPace = toNumber(raw?.espn_metrics?.away?.metrics?.pace ?? null);
    const homeAvgPts = toNumber(
      raw?.espn_metrics?.home?.metrics?.avgPoints ?? null,
    );
    const awayAvgPts = toNumber(
      raw?.espn_metrics?.away?.metrics?.avgPoints ?? null,
    );
    const homeAvgAllowed = toNumber(
      raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ?? null,
    );
    const awayAvgAllowed = toNumber(
      raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ?? null,
    );
    const marketTotal = toNumber(oddsSnapshot?.total);

    if (
      homeAvgPts &&
      homeAvgAllowed &&
      awayAvgPts &&
      awayAvgAllowed &&
      marketTotal
    ) {
      const projection = projectNBA(
        homeAvgPts,
        homeAvgAllowed,
        awayAvgPts,
        awayAvgAllowed,
        homePace,
        awayPace,
        restDaysHome,
        restDaysAway,
      );
      if (
        projection &&
        projection.homeProjected != null &&
        projection.awayProjected != null
      ) {
        const homeProjected = projection.homeProjected;
        const awayProjected = projection.awayProjected;
        const projectedTotal =
          Math.round((homeProjected + awayProjected) * 10) / 10;

        const edge = Math.round((projectedTotal - marketTotal) * 10) / 10;
        const absEdge = Math.abs(edge);

        // Only emit when edge is meaningful (< 1.0 pt is noise)
        if (absEdge >= 1.0) {
          const direction = edge > 0 ? 'OVER' : 'UNDER';

          // Confidence scales with edge magnitude
          let confidence;
          if (absEdge >= 5.0) confidence = 0.75;
          else if (absEdge >= 3.0) confidence = 0.7;
          else if (absEdge >= 2.0) confidence = 0.65;
          else confidence = 0.61;

          descriptors.push({
            cardType: 'nba-total-projection',
            cardTitle: `NBA Total: ${direction} ${projectedTotal} vs Line ${marketTotal}`,
            confidence,
            tier: determineTier(confidence),
            prediction: direction,
            reasoning: `Model projects ${projectedTotal} total (${homeProjected.toFixed(1)} + ${awayProjected.toFixed(1)}) vs line ${marketTotal} — edge ${edge > 0 ? '+' : ''}${edge} pts`,
            ev_threshold_passed: confidence > 0.6,
            driverKey: 'totalProjection',
            driverInputs: {
              projected_total: projectedTotal,
              market_total: marketTotal,
              edge,
              home_projected: homeProjected,
              away_projected: awayProjected,
            },
            driverScore: direction === 'OVER' ? 0.75 : 0.25,
            driverStatus: 'ok',
            inference_source: 'driver',
            is_mock: false,
          });
        }
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
  },
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
        total: oddsSnapshot.total,
      },
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
        'X-Model-Auth': process.env.MODEL_AUTH_TOKEN || '',
      },
      timeout: 10000, // 10 second timeout
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
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
                is_mock: false,
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
      console.warn(
        `[Models] Remote inference failed for ${sport}:`,
        error.message,
      );
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
      is_mock: true,
    };
  }

  if (sport === 'NBA') {
    const nbaCards = computeNBADriverCards(gameId, oddsSnapshot);
    if (nbaCards.length > 0) {
      // Aggregate: take the highest-confidence card as the representative signal
      const best = nbaCards.reduce((a, b) =>
        b.confidence > a.confidence ? b : a,
      );
      return {
        prediction: best.prediction,
        confidence: best.confidence,
        ev_threshold_passed: best.ev_threshold_passed,
        reasoning: best.reasoning,
        drivers: nbaCards,
        inference_source: 'mock',
        model_endpoint: null,
        is_mock: true,
      };
    }
  }

  if (sport === 'NCAAM' || sport === 'NCAA') {
    const ncaamCards = computeNCAAMDriverCards(gameId, oddsSnapshot);
    if (ncaamCards.length > 0) {
      // Aggregate: take the highest-confidence card
      const best = ncaamCards.reduce((a, b) =>
        b.confidence > a.confidence ? b : a,
      );
      return {
        prediction: best.prediction,
        confidence: best.confidence,
        ev_threshold_passed: best.ev_threshold_passed,
        reasoning: best.reasoning,
        drivers: ncaamCards,
        inference_source: 'mock',
        model_endpoint: null,
        is_mock: true,
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
    is_mock: true,
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

  const descriptors = [];
  let projectedMarginForDrivers = null;

  // Extract ESPN-enriched metrics
  const avgPtsHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgPoints ?? raw?.avg_points_home,
  );
  const avgPtsAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgPoints ?? raw?.avg_points_away,
  );
  const avgPtsAllowedHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.avgPointsAllowed ??
      raw?.avg_points_allowed_home,
  );
  const avgPtsAllowedAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.avgPointsAllowed ??
      raw?.avg_points_allowed_away,
  );
  const restDaysHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.restDays ?? raw?.rest_days_home,
  );
  const restDaysAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.restDays ?? raw?.rest_days_away,
  );
  const freeThrowPctHome = toNumber(
    raw?.espn_metrics?.home?.metrics?.freeThrowPct ??
      raw?.free_throw_pct_home ??
      raw?.home?.free_throw_pct,
  );
  const freeThrowPctAway = toNumber(
    raw?.espn_metrics?.away?.metrics?.freeThrowPct ??
      raw?.free_throw_pct_away ??
      raw?.away?.free_throw_pct,
  );
  const totalLine = toNumber(oddsSnapshot?.total);

  // --- Base Projection Driver (NCAAM Formula with HCA) ---
  if (avgPtsHome && avgPtsAway && avgPtsAllowedHome && avgPtsAllowedAway) {
    const projection = projectNCAAM(
      avgPtsHome,
      avgPtsAllowedHome,
      avgPtsAway,
      avgPtsAllowedAway,
    );

    if (projection.homeProjected && projection.awayProjected) {
      const projectedMargin = projection.projectedMargin;
      projectedMarginForDrivers = projectedMargin;

      // NCAAM confidence slightly different from NBA (college variance higher)
      let confidence = 0.55;

      if (Math.abs(projectedMargin) >= 10) {
        confidence = 0.72;
      } else if (Math.abs(projectedMargin) >= 5) {
        confidence = 0.65;
      } else if (Math.abs(projectedMargin) < 3) {
        confidence = 0.5 + Math.random() * 0.05; // Slight variance in toss-up games
      }

      descriptors.push({
        cardType: 'ncaam-base-projection',
        cardTitle: `NCAAM Projection: ${projectedMargin > 0 ? 'HOME' : 'AWAY'} ${Math.abs(projectedMargin).toFixed(1)}`,
        confidence,
        tier: determineTier(confidence),
        prediction: projectedMargin > 0 ? 'HOME' : 'AWAY',
        reasoning: `Projection: ${projection.homeProjected.toFixed(1)} vs ${projection.awayProjected.toFixed(1)} (HCA: +2.5pts)`,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'baseProjection',
        driverInputs: {
          home_avg_pts: avgPtsHome,
          away_avg_pts: avgPtsAway,
          home_def: avgPtsAllowedHome,
          away_def: avgPtsAllowedAway,
          projected_margin: projectedMargin,
        },
        driverScore: clamp((projectedMargin + 25) / 50, 0, 1),
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        projectionDetails: {
          homeProjected: projection.homeProjected,
          awayProjected: projection.awayProjected,
          hca: 2.5,
        },
      });
    }
  }

  // --- Rest Advantage Driver (College-specific) ---
  if (restDaysHome !== null && restDaysAway !== null) {
    const homeB2B = restDaysHome === 0;
    const awayB2B = restDaysAway === 0;

    if (homeB2B || awayB2B) {
      let prediction, confidence, reasoning;

      if (homeB2B && !awayB2B) {
        prediction = 'AWAY';
        confidence = clamp(
          0.64 + (restDaysAway - restDaysHome) * 0.08,
          0.58,
          0.75,
        );
        reasoning = `HOME on B2B vs AWAY rested — college fatigue compounds quickly`;
      } else if (awayB2B && !homeB2B) {
        prediction = 'HOME';
        confidence = clamp(
          0.64 + (restDaysHome - restDaysAway) * 0.08,
          0.58,
          0.75,
        );
        reasoning = `AWAY on B2B vs HOME rested — home court + rest edge`;
      } else {
        prediction = 'NEUTRAL';
        confidence = 0.55;
        reasoning = 'Both on B2B — rest neutral';
      }

      if (confidence > 0.6) {
        descriptors.push({
          cardType: 'ncaam-rest-advantage',
          cardTitle: `NCAAM Rest: ${prediction}`,
          confidence,
          tier: determineTier(confidence),
          prediction,
          reasoning,
          ev_threshold_passed: true,
          driverKey: 'restAdvantage',
          driverInputs: {
            rest_days_home: restDaysHome,
            rest_days_away: restDaysAway,
          },
          driverScore:
            prediction === 'HOME' ? 0.7 : prediction === 'AWAY' ? 0.3 : 0.5,
          driverStatus: 'ok',
          inference_source: 'driver',
          is_mock: false,
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
      confidence = clamp(0.65 + Math.abs(efficiencyGap) * 0.04, 0.6, 0.78);
      prediction = efficiencyGap > 0 ? 'HOME' : 'AWAY';
      reasoning = `Efficiency gap: ${prediction} has +${Math.abs(efficiencyGap).toFixed(1)} net rating`;
    }

    if (prediction !== 'NEUTRAL' && confidence > 0.6) {
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
          efficiency_gap: efficiencyGap,
        },
        driverScore: prediction === 'HOME' ? 0.7 : 0.3,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
      });
    }
  }

  // --- Free Throw Spread Driver (rule-based) ---
  if (
    totalLine !== null &&
    totalLine < 160 &&
    freeThrowPctHome !== null &&
    freeThrowPctAway !== null
  ) {
    const ftGap = Number((freeThrowPctHome - freeThrowPctAway).toFixed(2));
    const maxFtPct = Math.max(freeThrowPctHome, freeThrowPctAway);
    const minFtPct = Math.min(freeThrowPctHome, freeThrowPctAway);
    const hasThresholdSplit = maxFtPct > 75 && minFtPct < 75;
    const prediction = hasThresholdSplit
      ? ftGap > 0
        ? 'HOME'
        : ftGap < 0
          ? 'AWAY'
          : null
      : null;

    if (prediction) {
      if (
        projectedMarginForDrivers === null &&
        avgPtsHome &&
        avgPtsAway &&
        avgPtsAllowedHome &&
        avgPtsAllowedAway
      ) {
        const projection = projectNCAAM(
          avgPtsHome,
          avgPtsAllowedHome,
          avgPtsAway,
          avgPtsAllowedAway,
        );
        projectedMarginForDrivers = toNumber(projection?.projectedMargin);
      }

      const confidence = 0.62;
      descriptors.push({
        cardType: 'ncaam-ft-trend',
        cardTitle: `NCAAM FT%-Trend: ${prediction}`,
        confidence,
        tier: determineTier(confidence),
        prediction,
        reasoning: `FT% edge (${freeThrowPctHome.toFixed(1)} vs ${freeThrowPctAway.toFixed(1)}) with total ${totalLine.toFixed(1)} under 160`,
        ev_threshold_passed: true,
        driverKey: 'freeThrowTrend',
        driverInputs: {
          home_ft_pct: freeThrowPctHome,
          away_ft_pct: freeThrowPctAway,
          ft_gap: ftGap,
          total_line: totalLine,
          projected_margin: projectedMarginForDrivers,
        },
        driverScore: prediction === 'HOME' ? 0.66 : 0.34,
        driverStatus: 'ok',
        inference_source: 'driver',
        is_mock: false,
        marketTypes: ['spread'],
      });
    }
  }

  // --- FALLBACK: Use market spread when team metrics unavailable ---
  if (descriptors.length === 0) {
    const spreadHome = toNumber(oddsSnapshot?.spread_home);

    if (spreadHome !== null && Number.isFinite(spreadHome)) {
      // Use market spread as projected margin proxy
      const projectedMargin = spreadHome;

      let confidence = 0.55;
      if (Math.abs(projectedMargin) >= 10) {
        confidence = 0.7;
      } else if (Math.abs(projectedMargin) >= 5) {
        confidence = 0.65;
      }

      descriptors.push({
        cardType: 'ncaam-base-projection',
        cardTitle: `NCAAM Projection: ${projectedMargin < 0 ? 'HOME' : 'AWAY'} ${Math.abs(projectedMargin).toFixed(1)}`,
        confidence,
        tier: determineTier(confidence),
        prediction: projectedMargin < 0 ? 'HOME' : 'AWAY',
        reasoning: `Fallback to market spread proxy (${spreadHome}) because team metrics were unavailable`,
        ev_threshold_passed: confidence > 0.6,
        driverKey: 'baseProjection',
        driverInputs: {
          projected_margin: -1 * projectedMargin,
          spread_home: spreadHome,
          fallback_source: 'market_spread',
        },
        driverScore: clamp(0.5 + (-1 * projectedMargin) / 50, 0, 1),
        driverStatus: 'fallback',
        inference_source: 'market_fallback',
        is_mock: false,
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
    },
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
  computeNBAMarketDecisions,
  selectExpressionChoice,
  computeTotalBias,
  buildMarketPayload,
  generateCard,
  buildMarketCallCard,
  extractNhlDriverDataQualityContext,
};
