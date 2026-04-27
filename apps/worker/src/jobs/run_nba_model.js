/**
 * NBA Model Runner Job
 *
 * Reads latest NBA odds from DB, runs per-driver inference, and stores
 * card_payloads (one per active driver: rest-advantage, travel, lineup,
 * matchup-style, blowout-risk). Drivers only emit when their signal is
 * actionable — neutral/missing data produces no card.
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/run_nba_model.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:run-nba-model)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  wasJobRecentlySuccessful,
  setCurrentRunId,
  getOddsWithUpcomingGames,
  getUpcomingGamesAsSyntheticSnapshots,
  insertCardPayload,
  prepareModelAndCardWrite,
  runPerGameWriteTransaction,
  validateCardPayload,
  shouldRunJobKey,
  withDb,
  enrichOddsSnapshotWithEspnMetrics,
  updateOddsSnapshotRawData,
  getDatabase,
  computeLineDelta,
  getTeamMetricsWithGames,
} = require('@cheddar-logic/data');

const { kellyStake } = require('@cheddar-logic/models/src/edge-calculator');

const {
  computeNBADriverCards,
  generateCard,
  computeNBAMarketDecisions,
  selectExpressionChoice,
  computeTotalBias,
  buildMarketPayload,
  determineTier,
  buildMarketCallCard,
} = require('../models');
const {
  analyzePaceSynergy,
  computeNbaLeagueBaselines,
  setNbaLeagueBaselinesForRun,
} = require('../models/nba-pace-synergy');
const { assessProjectionInputs } = require('../models/projections');
const {
  buildRecommendationFromPrediction,
  buildMatchup,
  formatStartTimeLocal,
  formatCountdown,
  buildMarketFromOdds,
  buildPipelineState,
  collectDecisionReasonCodes,
  edgeCalculator,
  marginToWinProbability,
  WATCHDOG_REASONS,
  buildDecisionBasisMeta,
} = require('@cheddar-logic/models');
const {
  publishDecisionForCard,
  capturePublishedDecisionState,
  assertNoDecisionMutation,
  syncCanonicalDecisionEnvelope,
} = require('../utils/decision-publisher');
const { evaluateExecution } = require('./execution-gate');
const {
  normalizeRawDataPayload,
} = require('../utils/normalize-raw-data-payload');
const {
  resolveThresholdProfile,
} = require('@cheddar-logic/models');
const {
  isPlayoffGame,
  PLAYOFF_SIGMA_MULTIPLIER,
  PLAYOFF_EDGE_MIN_INCREMENT,
} = require('../utils/playoff-detection');
const { computeRestDays } = require('../utils/rest-days');
const { sendDiscordMessages } = require('./post_discord_cards');
const { applyCalibration } = require('../utils/calibration');
const {
  assertFeatureTimeliness,
  applyFeatureTimelinessEnforcement,
} = require('../models/feature-time-guard');
const {
  computeNbaResidualCorrection,
  applyNbaResidualCombinedCeiling,
} = require('../models/residual-projection');
const { detectNbaRegime } = require('../utils/nba-regime-detection');

const ENABLE_WELCOME_HOME = process.env.ENABLE_WELCOME_HOME === 'true';

// WI-0768: weight applied when blending pace-anchor total with market total
const TEAM_CONTEXT_WEIGHT = 0.25;
const ESPN_NULL_ALERT_WINDOW_MINUTES = 60;
const ESPN_NULL_ALERT_THRESHOLD_DEFAULT = 2;
const ESPN_NULL_NO_GAMES_PERSIST_WINDOW_MINUTES_DEFAULT = 20;
const NBA_ROLLING_BIAS_MIN_GAMES = 50;
const NBA_ROLLING_BIAS_CLAMP = 4.0;
const VOL_ENV_SIGMA_MIN_SAMPLES = 15;
const VOL_ENV_SIGMA_MIN_MULTIPLIER = 0.75;
const VOL_ENV_SIGMA_MAX_MULTIPLIER = 1.5;
const VOL_ENV_SIGMA_DEFAULTS = Object.freeze({
  HIGH: 1.25,
  MED: 1.0,
  LOW: 0.85,
});

const NBA_PROJECTION_ACCURACY_CARD_TYPES = new Set([
  'nba-total-projection',
  'nba-totals-call',
]);

const NBA_ROLE_MULTIPLIERS = Object.freeze({
  OFFENSIVE_HUB: 1.2,
  RIM_PROTECTOR: 0.6,
  REBOUNDER: 0.7,
  SPACER: 0.85,
  BENCH: 0.2,
});

const NBA_INJURY_TEAM_CAP = 12;
const NBA_OFFENSIVE_HUB_PACE_SURGE_OFFSET = 0.5;

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatSignedOneDecimal(value) {
  const numeric = Number.isFinite(value) ? value : 0;
  return `${numeric >= 0 ? '+' : ''}${numeric.toFixed(1)}`;
}

function normalizeNbaCalibrationState(rollingBias) {
  const source = rollingBias?.source === 'computed' ? 'computed' : 'fallback';
  const bias = source === 'computed'
    ? (toFiniteNumberOrNull(rollingBias?.bias) ?? 0)
    : 0;
  return {
    bias,
    games_sampled: Number.isFinite(rollingBias?.games_sampled)
      ? rollingBias.games_sampled
      : 0,
    source,
    correction_applied: source === 'computed',
  };
}

function computeNbaRollingBias({
  db,
  windowGames = NBA_ROLLING_BIAS_MIN_GAMES,
  logger = console,
} = {}) {
  const limit = Number.isInteger(windowGames) && windowGames > 0
    ? windowGames
    : NBA_ROLLING_BIAS_MIN_GAMES;

  if (!db || typeof db.prepare !== 'function') {
    logger.warn?.(
      `[NBAModel] [CALIBRATION_INACTIVE] 0 settled games - minimum ${NBA_ROLLING_BIAS_MIN_GAMES} required before correction activates`,
    );
    return { bias: 0, games_sampled: 0, source: 'fallback' };
  }

  let row = null;
  try {
    const stmt = db.prepare(`
      SELECT AVG(sample.raw_total - sample.actual_total) AS mean_error, COUNT(*) AS n
      FROM (
        SELECT raw_total, actual_total
        FROM projection_accuracy_line_evals
        WHERE sport = 'nba'
          AND market_family = 'NBA_TOTAL'
          AND actual_total IS NOT NULL
          AND raw_total IS NOT NULL
          AND settled_at < datetime('now')
        ORDER BY settled_at DESC
        LIMIT ${limit}
      ) AS sample
    `);
    row = typeof stmt.get === 'function'
      ? stmt.get()
      : (typeof stmt.all === 'function' ? stmt.all()[0] : null);
  } catch (_) {
    logger.warn?.(
      `[NBAModel] [CALIBRATION_INACTIVE] 0 settled games - minimum ${NBA_ROLLING_BIAS_MIN_GAMES} required before correction activates`,
    );
    return { bias: 0, games_sampled: 0, source: 'fallback' };
  }
  const gamesSampled = Number.isFinite(Number(row?.n)) ? Number(row.n) : 0;

  if (gamesSampled < NBA_ROLLING_BIAS_MIN_GAMES) {
    logger.warn?.(
      `[NBAModel] [CALIBRATION_INACTIVE] ${gamesSampled} settled games - minimum ${NBA_ROLLING_BIAS_MIN_GAMES} required before correction activates`,
    );
    return { bias: 0, games_sampled: gamesSampled, source: 'fallback' };
  }

  const rawBias = toFiniteNumberOrNull(row?.mean_error) ?? 0;
  const clampedBias = Math.max(
    -NBA_ROLLING_BIAS_CLAMP,
    Math.min(NBA_ROLLING_BIAS_CLAMP, rawBias),
  );
  if (Math.abs(rawBias) > NBA_ROLLING_BIAS_CLAMP) {
    logger.warn?.(
      `[NBAModel] [BIAS_CORRECTION] bias_raw=${rawBias.toFixed(1)} clamped to +/-4.0 - investigate outlier`,
    );
  }
  logger.log?.(
    `[NBAModel] [BIAS_CORRECTION] rolling_bias=${formatSignedOneDecimal(clampedBias)} games_sampled=${gamesSampled}`,
  );

  return { bias: clampedBias, games_sampled: gamesSampled, source: 'computed' };
}

function deriveTotalBand(marketTotal) {
  if (!Number.isFinite(marketTotal)) return null;
  if (marketTotal < 220) return '<220';
  if (marketTotal < 230) return '220-230';
  if (marketTotal < 240) return '230-240';
  return '240+';
}

function deriveVolEnv(totalSigma) {
  const sigma = toFiniteNumberOrNull(totalSigma);
  if (sigma === null) return null;
  if (sigma < 11) return 'LOW';
  if (sigma < 14) return 'MED';
  return 'HIGH';
}

function computeVolEnvSigmaMultipliers({ db, logger = console } = {}) {
  const defaults = {
    multipliers: { ...VOL_ENV_SIGMA_DEFAULTS },
    sourceByBucket: {
      HIGH: 'fallback',
      MED: 'fallback',
      LOW: 'fallback',
    },
    sampleByBucket: {
      HIGH: null,
      MED: null,
      LOW: null,
    },
    mode: 'fallback',
    medSamples: 0,
  };

  if (!db || typeof db.prepare !== 'function') {
    return defaults;
  }

  try {
    const rowsStmt = db.prepare(`
      SELECT vol_env,
             SQRT(AVG((raw_total - actual_total) * (raw_total - actual_total))) AS rmse,
             COUNT(*) AS n
      FROM projection_accuracy_line_evals
      WHERE sport = 'nba'
        AND market_family = 'NBA_TOTAL'
        AND vol_env IS NOT NULL
        AND raw_total IS NOT NULL
        AND actual_total IS NOT NULL
        AND settled_at < datetime('now')
      GROUP BY vol_env
      HAVING COUNT(*) >= ${VOL_ENV_SIGMA_MIN_SAMPLES}
    `);
    const rows = typeof rowsStmt.all === 'function' ? rowsStmt.all() : [];

    let medSamples = 0;
    try {
      const medStmt = db.prepare(`
        SELECT COUNT(*) AS n
        FROM projection_accuracy_line_evals
        WHERE sport = 'nba'
          AND market_family = 'NBA_TOTAL'
          AND vol_env = 'MED'
          AND raw_total IS NOT NULL
          AND actual_total IS NOT NULL
          AND settled_at < datetime('now')
      `);
      const medRow = typeof medStmt.get === 'function' ? medStmt.get() : null;
      medSamples = Number.isFinite(Number(medRow?.n)) ? Number(medRow.n) : 0;
    } catch (_) {
      medSamples = 0;
    }

    const bucketMap = new Map();
    for (const row of rows) {
      const bucket = String(row?.vol_env || '').toUpperCase();
      if (!['HIGH', 'MED', 'LOW'].includes(bucket)) continue;
      const rmse = toFiniteNumberOrNull(row?.rmse);
      const n = Number.isFinite(Number(row?.n)) ? Number(row.n) : 0;
      if (rmse === null || n < VOL_ENV_SIGMA_MIN_SAMPLES) continue;
      bucketMap.set(bucket, { rmse, n });
    }

    const med = bucketMap.get('MED');
    if (!med) {
      return {
        ...defaults,
        medSamples,
      };
    }

    const high = bucketMap.get('HIGH');
    const low = bucketMap.get('LOW');
    const next = {
      multipliers: {
        HIGH: high
          ? clamp(
            high.rmse / med.rmse,
            VOL_ENV_SIGMA_MIN_MULTIPLIER,
            VOL_ENV_SIGMA_MAX_MULTIPLIER,
          )
          : VOL_ENV_SIGMA_DEFAULTS.HIGH,
        MED: 1,
        LOW: low
          ? clamp(
            low.rmse / med.rmse,
            VOL_ENV_SIGMA_MIN_MULTIPLIER,
            VOL_ENV_SIGMA_MAX_MULTIPLIER,
          )
          : VOL_ENV_SIGMA_DEFAULTS.LOW,
      },
      sourceByBucket: {
        HIGH: high ? 'empirical' : 'fallback',
        MED: 'empirical',
        LOW: low ? 'empirical' : 'fallback',
      },
      sampleByBucket: {
        HIGH: high?.n ?? null,
        MED: med.n,
        LOW: low?.n ?? null,
      },
      mode: high && low ? 'empirical' : 'mixed',
      medSamples,
    };

    next.multipliers.HIGH = clamp(
      next.multipliers.HIGH,
      VOL_ENV_SIGMA_MIN_MULTIPLIER,
      VOL_ENV_SIGMA_MAX_MULTIPLIER,
    );
    next.multipliers.MED = clamp(
      next.multipliers.MED,
      VOL_ENV_SIGMA_MIN_MULTIPLIER,
      VOL_ENV_SIGMA_MAX_MULTIPLIER,
    );
    next.multipliers.LOW = clamp(
      next.multipliers.LOW,
      VOL_ENV_SIGMA_MIN_MULTIPLIER,
      VOL_ENV_SIGMA_MAX_MULTIPLIER,
    );

    return next;
  } catch (error) {
    logger.warn?.(`[NBAModel] [VOL_ENV_SIGMA] fallback to defaults: ${error.message}`);
    return defaults;
  }
}

function formatVolEnvSigmaLog(volEnvSigmaConfig) {
  if (volEnvSigmaConfig.mode === 'fallback') {
    return `[NBAModel] [VOL_ENV_SIGMA] using hardcoded defaults - insufficient MED samples (n=${volEnvSigmaConfig.medSamples ?? 0})`;
  }

  const renderBucket = (bucket) => {
    const multiplier = Number(volEnvSigmaConfig.multipliers?.[bucket]);
    const source = volEnvSigmaConfig.sourceByBucket?.[bucket] === 'empirical'
      ? 'empirical'
      : 'fallback';
    const samples = volEnvSigmaConfig.sampleByBucket?.[bucket];
    if (source === 'empirical') {
      return `${bucket}=${multiplier.toFixed(2)}x(n=${samples},empirical)`;
    }
    return `${bucket}=${multiplier.toFixed(2)}x(fallback)`;
  };

  return `[NBAModel] [VOL_ENV_SIGMA] ${renderBucket('HIGH')} ${renderBucket('MED')} ${renderBucket('LOW')}`;
}

function applyVolEnvSigmaMultiplier(sigma, volEnv, volEnvSigmaConfig) {
  if (!sigma || typeof sigma !== 'object') return sigma;
  const normalizedVolEnv = ['HIGH', 'MED', 'LOW'].includes(volEnv)
    ? volEnv
    : 'MED';
  const multiplier = clamp(
    toFiniteNumberOrNull(volEnvSigmaConfig?.multipliers?.[normalizedVolEnv])
      ?? VOL_ENV_SIGMA_DEFAULTS[normalizedVolEnv]
      ?? 1,
    VOL_ENV_SIGMA_MIN_MULTIPLIER,
    VOL_ENV_SIGMA_MAX_MULTIPLIER,
  );
  const source = volEnvSigmaConfig?.sourceByBucket?.[normalizedVolEnv] === 'empirical'
    ? 'empirical'
    : 'fallback';

  const scale = (value) => {
    const numeric = toFiniteNumberOrNull(value);
    return numeric === null ? value ?? null : numeric * multiplier;
  };

  return {
    ...sigma,
    margin: scale(sigma.margin),
    total: scale(sigma.total),
    spread: scale(sigma.spread),
    vol_env_sigma_multiplier: multiplier,
    vol_env_sigma_source: source,
    vol_env_bucket: normalizedVolEnv,
  };
}

function derivePaceTier(rawData, leagueBaselines = null) {
  const metrics = rawData?.espn_metrics;
  const paceHome = toFiniteNumberOrNull(
    metrics?.home?.metrics?.paceHome ?? metrics?.home?.metrics?.pace,
  );
  const paceAway = toFiniteNumberOrNull(
    metrics?.away?.metrics?.paceAway ?? metrics?.away?.metrics?.pace,
  );
  const avgPtsHome = toFiniteNumberOrNull(
    metrics?.home?.metrics?.avgPtsHome ?? metrics?.home?.metrics?.avgPoints,
  );
  const avgPtsAway = toFiniteNumberOrNull(
    metrics?.away?.metrics?.avgPtsAway ?? metrics?.away?.metrics?.avgPoints,
  );

  if (!Number.isFinite(paceHome) || !Number.isFinite(paceAway)) return null;
  return analyzePaceSynergy(
    paceHome,
    paceAway,
    avgPtsHome,
    avgPtsAway,
    leagueBaselines,
  )?.synergyType ?? null;
}

function getNbaPlayerNumber(player, snakeKey, camelKey, fallback = 0) {
  const value = player?.[snakeKey] ?? player?.[camelKey];
  const numeric = toFiniteNumberOrNull(value);
  return numeric === null ? fallback : numeric;
}

function getOptionalNbaPlayerNumber(player, snakeKey, camelKey) {
  const hasSnake = player && Object.prototype.hasOwnProperty.call(player, snakeKey);
  const hasCamel = player && Object.prototype.hasOwnProperty.call(player, camelKey);
  if (!hasSnake && !hasCamel) return null;
  return toFiniteNumberOrNull(player?.[snakeKey] ?? player?.[camelKey]);
}

function computeNbaStartRatio(player) {
  const startsLast5 = getNbaPlayerNumber(player, 'starts_last5', 'startsLast5', 0);
  return Math.min(1, Math.max(0, startsLast5 / 5));
}

function classifyNbaInjuryRole(player) {
  const startsLast5 = getNbaPlayerNumber(player, 'starts_last5', 'startsLast5', 0);
  const avgPointsLast5 = getNbaPlayerNumber(player, 'avg_points_last5', 'avgPointsLast5', 0);
  const assistsLast5 = getOptionalNbaPlayerNumber(player, 'assists_last5', 'assistsLast5');
  const usagePct = getOptionalNbaPlayerNumber(player, 'usage_pct', 'usagePct');
  const blocksLast5 = getOptionalNbaPlayerNumber(player, 'blocks_last5', 'blocksLast5');
  const reboundsLast5 = getOptionalNbaPlayerNumber(player, 'rebounds_last5', 'reboundsLast5');

  if (startsLast5 === 0) return 'BENCH';

  const hasExtendedSignals =
    assistsLast5 !== null ||
    usagePct !== null ||
    blocksLast5 !== null ||
    reboundsLast5 !== null;

  if (hasExtendedSignals) {
    if (
      (assistsLast5 !== null && assistsLast5 > 4) ||
      (usagePct !== null && usagePct > 28) ||
      avgPointsLast5 > 22
    ) {
      return 'OFFENSIVE_HUB';
    }

    if (reboundsLast5 !== null && reboundsLast5 > 8) {
      return 'REBOUNDER';
    }

    if (
      (blocksLast5 !== null && blocksLast5 > 1.5) ||
      (avgPointsLast5 < 12 && startsLast5 >= 3)
    ) {
      return 'RIM_PROTECTOR';
    }

    return 'SPACER';
  }

  if (avgPointsLast5 > 22) return 'OFFENSIVE_HUB';
  if (avgPointsLast5 >= 10) return 'SPACER';
  if (avgPointsLast5 < 10 && startsLast5 >= 3) return 'RIM_PROTECTOR';
  return 'BENCH';
}

function computeNbaRoleAwarePointImpact(player) {
  const avgPointsLast5 = getNbaPlayerNumber(player, 'avg_points_last5', 'avgPointsLast5', 0);
  const roleClass = classifyNbaInjuryRole(player);
  const roleMultiplier = NBA_ROLE_MULTIPLIERS[roleClass] ?? 0;
  const startRatio = computeNbaStartRatio(player);
  const pointImpact = avgPointsLast5 * roleMultiplier * startRatio;

  return {
    role_class: roleClass,
    role_multiplier: roleMultiplier,
    start_ratio: Number(startRatio.toFixed(3)),
    point_impact: Number(pointImpact.toFixed(2)),
  };
}

function buildNbaRoleAuditEntry(flag) {
  return {
    player_name: flag?.player ?? flag?.player_name ?? null,
    player_id: flag?.player_id ?? null,
    role_class: flag?.role_class ?? null,
    role_multiplier: flag?.role_multiplier ?? null,
    start_ratio: flag?.start_ratio ?? null,
    point_impact: flag?.point_impact ?? null,
  };
}

function inferNbaActiveStarterCount(players, missingImpactFlags) {
  const explicitActiveStarters = players.filter((player) => {
    const rawStatus = String(player?.rawStatus ?? player?.status ?? '').trim().toUpperCase();
    return (
      rawStatus &&
      !['OUT', 'INACTIVE', 'DOUBTFUL'].includes(rawStatus) &&
      getNbaPlayerNumber(player, 'starts_last5', 'startsLast5', 0) > 0
    );
  }).length;

  if (explicitActiveStarters > 0) return explicitActiveStarters;

  const missingStarterCount = missingImpactFlags.filter(
    (flag) => getNbaPlayerNumber(flag, 'starts_last5', 'startsLast5', 0) > 0,
  ).length;
  return Math.max(0, 5 - missingStarterCount);
}

function computeNbaTeamInjuryImpact({ flags = [], players = [] } = {}) {
  const impactFlags = flags.filter((flag) => flag?.is_impact_player);
  const rawTeamImpact = impactFlags.reduce(
    (sum, flag) => sum + (toFiniteNumberOrNull(flag?.point_impact) ?? 0),
    0,
  );
  const missingHub = impactFlags.some((flag) => flag.role_class === 'OFFENSIVE_HUB');
  const activeStarterCount = inferNbaActiveStarterCount(players, impactFlags);
  const paceSurgeOffset =
    missingHub && activeStarterCount >= 2
      ? NBA_OFFENSIVE_HUB_PACE_SURGE_OFFSET
      : 0;
  const teamImpactAfterRedistribution = Math.max(
    0,
    rawTeamImpact - paceSurgeOffset,
  );
  const cappedTeamImpact = Math.min(
    teamImpactAfterRedistribution,
    NBA_INJURY_TEAM_CAP,
  );

  return {
    raw_team_impact: Number(rawTeamImpact.toFixed(2)),
    pace_surge_offset: Number(paceSurgeOffset.toFixed(2)),
    team_impact_after_redistribution: Number(teamImpactAfterRedistribution.toFixed(2)),
    capped_team_impact: Number(cappedTeamImpact.toFixed(2)),
    role_classes: impactFlags.map(buildNbaRoleAuditEntry),
  };
}

function computeNbaInjuryProjectionReduction(homeImpactContext, awayImpactContext) {
  const homeFlags = Array.isArray(homeImpactContext?.availabilityFlags)
    ? homeImpactContext.availabilityFlags
    : [];
  const awayFlags = Array.isArray(awayImpactContext?.availabilityFlags)
    ? awayImpactContext.availabilityFlags
    : [];
  const homePlayers = Array.isArray(homeImpactContext?.players)
    ? homeImpactContext.players
    : [];
  const awayPlayers = Array.isArray(awayImpactContext?.players)
    ? awayImpactContext.players
    : [];
  const homeImpact = computeNbaTeamInjuryImpact({
    flags: homeFlags,
    players: homePlayers,
  });
  const awayImpact = computeNbaTeamInjuryImpact({
    flags: awayFlags,
    players: awayPlayers,
  });
  const reduction = (homeImpact.capped_team_impact + awayImpact.capped_team_impact) * 0.5;

  return {
    home_impact: {
      raw_team_impact: homeImpact.raw_team_impact,
      pace_surge_offset: homeImpact.pace_surge_offset,
      team_impact_after_redistribution: homeImpact.team_impact_after_redistribution,
      capped_team_impact: homeImpact.capped_team_impact,
    },
    away_impact: {
      raw_team_impact: awayImpact.raw_team_impact,
      pace_surge_offset: awayImpact.pace_surge_offset,
      team_impact_after_redistribution: awayImpact.team_impact_after_redistribution,
      capped_team_impact: awayImpact.capped_team_impact,
    },
    reduction_applied: Number(reduction.toFixed(2)),
    role_classes: {
      home: homeImpact.role_classes,
      away: awayImpact.role_classes,
    },
  };
}

function computeInjuryPointImpact(availabilityFlags) {
  if (!Array.isArray(availabilityFlags) || availabilityFlags.length === 0) return 0;
  let total = 0;
  for (const flag of availabilityFlags) {
    if (!flag?.is_impact_player) continue;
    const status = String(flag.status || '').trim().toUpperCase();
    const roleAwareImpact = toFiniteNumberOrNull(flag.point_impact);
    if (roleAwareImpact !== null) {
      total += roleAwareImpact;
      continue;
    }
    const avgPoints = toFiniteNumberOrNull(flag.avg_points_last5);
    if (avgPoints === null) continue;
    if (status === 'OUT' || status === 'INACTIVE' || status === 'DOUBTFUL') {
      total += avgPoints;
    } else if (status === 'QUESTIONABLE') {
      total += avgPoints * 0.5;
    }
  }
  return Number(total.toFixed(2));
}

function deriveInjuryCloud(pointImpact) {
  const impact = toFiniteNumberOrNull(pointImpact) ?? 0;
  if (impact <= 0) return 'NONE';
  if (impact < 15) return 'MODERATE';
  return 'SEVERE';
}

function normalizeDriverContributions(payloadData) {
  const summaryWeights = Array.isArray(payloadData?.driver_summary?.weights)
    ? payloadData.driver_summary.weights
    : [];

  const normalized = summaryWeights
    .map((entry) => ({
      driver: entry?.driver ? String(entry.driver).trim() : null,
      weight: toFiniteNumberOrNull(entry?.weight),
      signal: toFiniteNumberOrNull(entry?.signal ?? entry?.score),
    }))
    .filter((entry) => entry.driver && entry.weight !== null && entry.signal !== null);

  if (normalized.length > 0) return normalized;

  const fallbackDriver = payloadData?.driver?.key ? String(payloadData.driver.key) : null;
  const fallbackSignal = toFiniteNumberOrNull(payloadData?.driver?.score);
  const fallbackWeight = fallbackDriver ? toFiniteNumberOrNull(NBA_DRIVER_WEIGHTS[fallbackDriver]) : null;
  if (fallbackDriver && fallbackSignal !== null && fallbackWeight !== null) {
    return [{ driver: fallbackDriver, weight: fallbackWeight, signal: fallbackSignal }];
  }

  return null;
}

function resolveProjectionRawForAccuracy(payloadData) {
  const projectionTotal = toFiniteNumberOrNull(payloadData?.projection?.total);
  if (projectionTotal !== null) return projectionTotal;

  const projectionComparison = payloadData?.odds_context?.projection_comparison;
  const comparisonScalar = toFiniteNumberOrNull(projectionComparison);
  if (comparisonScalar !== null) return comparisonScalar;

  return toFiniteNumberOrNull(projectionComparison?.fair_line_from_projection);
}

function stampNbaProjectionAccuracyFields(card, {
  oddsSnapshot,
  effectiveSigma,
  volEnv,
  availabilityGate,
  leagueBaselines = null,
} = {}) {
  if (!card?.cardType || !NBA_PROJECTION_ACCURACY_CARD_TYPES.has(card.cardType)) return;
  if (!card.payloadData || typeof card.payloadData !== 'object') return;

  const payloadData = card.payloadData;
  if (!payloadData.raw_data || typeof payloadData.raw_data !== 'object') payloadData.raw_data = {};

  const projectionRaw = resolveProjectionRawForAccuracy(payloadData);
  if (projectionRaw !== null) {
    if (!payloadData.projection_accuracy || typeof payloadData.projection_accuracy !== 'object') {
      payloadData.projection_accuracy = {};
    }
    payloadData.projection_accuracy.projection_raw = projectionRaw;
  }

  const marketTotal =
    toFiniteNumberOrNull(oddsSnapshot?.total) ??
    toFiniteNumberOrNull(payloadData?.line) ??
    toFiniteNumberOrNull(payloadData?.odds_context?.total);
  const injuryPointImpact = computeInjuryPointImpact(
    availabilityGate?.availabilityFlags ?? payloadData.raw_data?.availability_flags,
  );

  payloadData.raw_data.market_total = marketTotal;
  payloadData.raw_data.pace_tier = derivePaceTier(
    oddsSnapshot?.raw_data ?? payloadData.raw_data,
    leagueBaselines,
  );
  payloadData.raw_data.vol_env = volEnv ?? deriveVolEnv(effectiveSigma?.total);
  payloadData.raw_data.vol_env_sigma_multiplier =
    toFiniteNumberOrNull(effectiveSigma?.vol_env_sigma_multiplier) ?? null;
  payloadData.raw_data.vol_env_sigma_source =
    effectiveSigma?.vol_env_sigma_source === 'empirical' ? 'empirical' : 'fallback';
  payloadData.raw_data.total_band = deriveTotalBand(marketTotal);
  payloadData.raw_data.injury_cloud = deriveInjuryCloud(injuryPointImpact);
  payloadData.raw_data.driver_contributions = normalizeDriverContributions(payloadData);
}

function stampNbaFeatureTimestamps(rawData, capturedAt) {
  if (!capturedAt || !rawData || typeof rawData !== 'object') return;
  if (!rawData.feature_timestamps || typeof rawData.feature_timestamps !== 'object') {
    rawData.feature_timestamps = {};
  }

  for (const field of ['pace_anchor_total', 'blended_total', 'rest_days_home', 'rest_days_away', 'availability_flags']) {
    if (rawData.feature_timestamps[field] != null) continue;
    if (rawData[field] !== null && rawData[field] !== undefined && rawData[field] !== '') {
      rawData.feature_timestamps[field] = capturedAt;
    }
  }
}

function applyNbaFeatureTimelinessGuardToCards(cards, { rawData, betPlacedAt, gameId } = {}) {
  const cardList = Array.isArray(cards) ? cards : cards ? [cards] : [];
  if (cardList.length === 0 || !betPlacedAt) {
    return { evaluated: false, blockedCount: 0, timeliness: null };
  }

  const sourceRawData = rawData && typeof rawData === 'object' ? rawData : {};
  stampNbaFeatureTimestamps(sourceRawData, betPlacedAt);
  const timeliness = assertFeatureTimeliness(sourceRawData, betPlacedAt);
  if (!timeliness.ok) {
    console.warn(
      `[FeatureGuard] ${gameId || 'unknown-game'}: ${timeliness.violations.length} violation(s): ` +
        timeliness.violations.map((v) => v.field).join(', '),
    );
  }

  let blockedCount = 0;
  for (const card of cardList) {
    if (!card?.payloadData || typeof card.payloadData !== 'object') continue;
    card.payloadData.feature_timeliness = timeliness;
    if (applyFeatureTimelinessEnforcement(card.payloadData, timeliness)) {
      blockedCount++;
    }
  }

  return { evaluated: true, blockedCount, timeliness };
}

function normalizeEspnNullReason(reason) {
  return (
    String(reason || 'UNKNOWN')
      .trim()
      .replace(/\s+/g, '_')
      .toUpperCase() || 'UNKNOWN'
  );
}

function getEspnNullAlertThreshold() {
  const parsed = Number.parseInt(
    process.env.ESPN_NULL_ALERT_THRESHOLD ?? `${ESPN_NULL_ALERT_THRESHOLD_DEFAULT}`,
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ESPN_NULL_ALERT_THRESHOLD_DEFAULT;
}

function getEspnNullNoGamesPersistWindowMinutes() {
  const parsed = Number.parseInt(
    process.env.ESPN_NULL_NO_GAMES_PERSIST_WINDOW_MINUTES ?? `${ESPN_NULL_NO_GAMES_PERSIST_WINDOW_MINUTES_DEFAULT}`,
    10,
  );
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : ESPN_NULL_NO_GAMES_PERSIST_WINDOW_MINUTES_DEFAULT;
}

function slugifyEspnNullToken(value, maxLength = 40) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const fallback = normalized || 'unknown';
  return fallback.length > maxLength ? fallback.slice(0, maxLength) : fallback;
}

function buildEspnNullTeamKey(team, reason) {
  return `${String(team || '').trim().toUpperCase()}::${normalizeEspnNullReason(reason)}`;
}

function isNoGamesEspnNullReason(reason) {
  return normalizeEspnNullReason(reason) === 'NO_GAMES';
}

function buildEspnNullSeenJobName(sport, entry) {
  const sportToken = slugifyEspnNullToken(sport, 12);
  const teamToken = slugifyEspnNullToken(entry?.team, 28);
  const reasonToken = slugifyEspnNullToken(entry?.reason, 24);
  return `espn_null_seen_${sportToken}_${teamToken}_${reasonToken}`;
}

function markEspnNullSeenSignal({
  sport,
  entry,
  logger = console,
  wasJobRecentlySuccessfulFn = wasJobRecentlySuccessful,
  insertJobRunFn = insertJobRun,
  markJobRunSuccessFn = markJobRunSuccess,
  markJobRunFailureFn = markJobRunFailure,
}) {
  const seenJobName = buildEspnNullSeenJobName(sport, entry);
  const seenRecently = wasJobRecentlySuccessfulFn(
    seenJobName,
    getEspnNullNoGamesPersistWindowMinutes(),
  );
  const seenRunId = uuidV4();
  try {
    insertJobRunFn(seenJobName, seenRunId);
    markJobRunSuccessFn(seenRunId);
  } catch (error) {
    markJobRunFailureFn(seenRunId, error.message);
    logger.warn(
      `[${sport}Model] Failed to record ESPN null observation for ${entry?.team || 'UNKNOWN_TEAM'}: ${error.message}`,
    );
  }
  return seenRecently;
}

function buildEspnNullAlertMessage(sport, nullMetricTeams) {
  const lines = [
    `⚠️ **${sport} ESPN Null Metrics Alert**`,
    '',
    `${nullMetricTeams.length} team(s) returned neutral ESPN metrics in the latest run:`,
  ];
  for (const entry of nullMetricTeams) {
    lines.push(`• \`${entry.team}\` — ${entry.reason}`);
  }
  return lines.join('\n');
}

function extractNbaEspnNullMetricTeams({ homeTeam, awayTeam, homeResult, awayResult }) {
  const entries = [];
  const candidates = [
    { team: homeTeam, result: homeResult },
    { team: awayTeam, result: awayResult },
  ];

  for (const candidate of candidates) {
    if (candidate.result?.metrics?.avgPoints !== null) continue;
    entries.push({
      team: candidate.team || 'UNKNOWN_TEAM',
      reason: normalizeEspnNullReason(candidate.result?.metrics?.espn_null_reason),
    });
  }

  return entries;
}

function recordEspnNullTeams({
  sport,
  registry,
  nullMetricTeams,
  logger = console,
}) {
  const recorded = [];
  for (const entry of nullMetricTeams) {
    const normalizedEntry = {
      team: entry?.team || 'UNKNOWN_TEAM',
      reason: normalizeEspnNullReason(entry?.reason),
    };
    const key = buildEspnNullTeamKey(normalizedEntry.team, normalizedEntry.reason);
    if (registry.has(key)) continue;
    registry.set(key, normalizedEntry);
    logger.warn(
      `[ESPN_NULL] sport=${sport} team=${normalizedEntry.team} reason=${normalizedEntry.reason}`,
    );
    recorded.push(normalizedEntry);
  }
  return recorded;
}

async function sendEspnNullDiscordAlert({
  sport,
  nullMetricTeams,
  logger = console,
  sendDiscordMessagesFn = sendDiscordMessages,
  wasJobRecentlySuccessfulFn = wasJobRecentlySuccessful,
  insertJobRunFn = insertJobRun,
  markJobRunSuccessFn = markJobRunSuccess,
  markJobRunFailureFn = markJobRunFailure,
}) {
  const dedupedTeams = [];
  const seen = new Set();
  for (const entry of nullMetricTeams) {
    const normalizedEntry = {
      team: entry?.team || 'UNKNOWN_TEAM',
      reason: normalizeEspnNullReason(entry?.reason),
    };
    const key = buildEspnNullTeamKey(normalizedEntry.team, normalizedEntry.reason);
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedTeams.push(normalizedEntry);
  }

  const persistentTeams = [];
  let suppressedNoGamesCount = 0;
  for (const entry of dedupedTeams) {
    if (!isNoGamesEspnNullReason(entry.reason)) {
      persistentTeams.push(entry);
      continue;
    }

    const seenRecently = markEspnNullSeenSignal({
      sport,
      entry,
      logger,
      wasJobRecentlySuccessfulFn,
      insertJobRunFn,
      markJobRunSuccessFn,
      markJobRunFailureFn,
    });
    if (seenRecently) {
      persistentTeams.push(entry);
    } else {
      suppressedNoGamesCount += 1;
    }
  }

  if (persistentTeams.length < getEspnNullAlertThreshold()) {
    if (suppressedNoGamesCount > 0) {
      logger.log(
        `[${sport}Model] Suppressed ${suppressedNoGamesCount} transient ESPN null NO_GAMES alert candidate(s) pending persistence`,
      );
    }
    return { sent: false, reason: 'below_threshold', count: persistentTeams.length };
  }

  if (process.env.ENABLE_DISCORD_CARD_WEBHOOKS !== 'true') {
    return { sent: false, reason: 'discord_disabled', count: persistentTeams.length };
  }

  const webhookUrl = String(process.env.DISCORD_ALERT_WEBHOOK_URL || '').trim();
  if (!webhookUrl) {
    logger.warn(`[${sport}Model] DISCORD_ALERT_WEBHOOK_URL not set — skipping ESPN null alert`);
    return { sent: false, reason: 'missing_webhook_url', count: persistentTeams.length };
  }

  const alertJobName = `espn_null_alert_${sport.toLowerCase()}`;
  if (wasJobRecentlySuccessfulFn(alertJobName, ESPN_NULL_ALERT_WINDOW_MINUTES)) {
    return { sent: false, reason: 'cooldown_active', count: persistentTeams.length };
  }

  const alertRunId = uuidV4();
  insertJobRunFn(alertJobName, alertRunId);
  try {
    await sendDiscordMessagesFn({
      webhookUrl,
      messages: [buildEspnNullAlertMessage(sport, persistentTeams)],
    });
    markJobRunSuccessFn(alertRunId);
    logger.log(
      `[${sport}Model] Sent ESPN null alert for ${persistentTeams.length} team(s)`,
    );
    return { sent: true, reason: 'sent', count: persistentTeams.length };
  } catch (error) {
    markJobRunFailureFn(alertRunId, error.message);
    logger.warn(
      `[${sport}Model] Failed to send ESPN null alert: ${error.message}`,
    );
    return { sent: false, reason: 'send_failed', count: persistentTeams.length };
  }
}

/**
 * WI-0841: Build key-player availability gate for a game from live impact context.
 *
 * Fail-open design:
 * - No impact context or unavailable ESPN data → empty flags, no degradation
 * - Only emits flags when ESPN-derived impact context marks a player as impact-level
 *
 * @param {object|null} homeImpactContext
 * @param {object|null} awayImpactContext
 * @returns {{ missingFlags: string[], uncertainFlags: string[], availabilityFlags: Array<object> }}
 */
function buildNbaAvailabilityGate(homeImpactContext, awayImpactContext) {
  const EMPTY = {
    missingFlags: [],
    uncertainFlags: [],
    availabilityFlags: [],
    injuryProjectionReduction: null,
    gateFailedError: null,
  };
  try {
    const missingFlags = [];
    const uncertainFlags = [];
    const availabilityFlags = [];
    const homeGateContext = {
      players: Array.isArray(homeImpactContext?.players) ? homeImpactContext.players : [],
      availabilityFlags: [],
    };
    const awayGateContext = {
      players: Array.isArray(awayImpactContext?.players) ? awayImpactContext.players : [],
      availabilityFlags: [],
    };

    for (const [index, context] of [homeImpactContext, awayImpactContext].entries()) {
      if (!context || context.available === false) continue;
      const sideGateContext = index === 0 ? homeGateContext : awayGateContext;
      const players = Array.isArray(context.players) ? context.players : [];
      for (const player of players) {
        const rawStatus = String(player.rawStatus || '').trim().toUpperCase();
        const reasons = Array.isArray(player.impactReasons)
          ? player.impactReasons.filter(Boolean)
          : [];
        const flag = {
          player: player.playerName || null,
          player_id: player.playerId || null,
          team: player.teamAbbr || null,
          status: rawStatus || null,
          impact_reasons: reasons,
          is_impact_player: Boolean(player.isImpactPlayer),
          avg_points_last5: player.avgPointsLast5 ?? null,
          starts_last5: player.startsLast5 ?? null,
          assists_last5: player.assistsLast5 ?? null,
          usage_pct: player.usagePct ?? null,
          blocks_last5: player.blocksLast5 ?? null,
          rebounds_last5: player.reboundsLast5 ?? null,
        };
        if (player.isImpactPlayer) {
          Object.assign(flag, computeNbaRoleAwarePointImpact(flag));
        }
        availabilityFlags.push(flag);
        sideGateContext.availabilityFlags.push(flag);
        if (player.isImpactPlayer) {
          if (!missingFlags.includes('key_player_out')) missingFlags.push('key_player_out');
        } else if (rawStatus === 'DOUBTFUL') {
          if (!uncertainFlags.includes('key_player_uncertain')) uncertainFlags.push('key_player_uncertain');
        }
      }
    }

    const injuryProjectionReduction = computeNbaInjuryProjectionReduction(
      homeGateContext,
      awayGateContext,
    );

    return {
      missingFlags,
      uncertainFlags,
      availabilityFlags,
      injuryProjectionReduction,
    };
  } catch (err) {
    // Fail-open: DB query errors must not block card generation
    // WI-0907 Phase 4 Task 2: Track gate failure so cards emit AVAILABILITY_GATE_DEGRADED
    console.log(`  [availability] buildNbaAvailabilityGate error (${err.message}) — skipping gate`);
    return { ...EMPTY, gateFailedError: err.message };
  }
}

function applyNbaImpactGateToCard(card, availabilityGate) {
  const hasMissingFlags = Array.isArray(availabilityGate?.missingFlags) && availabilityGate.missingFlags.length > 0;
  const hasUncertainFlags = Array.isArray(availabilityGate?.uncertainFlags) && availabilityGate.uncertainFlags.length > 0;
  const availabilityFlags = Array.isArray(availabilityGate?.availabilityFlags)
    ? availabilityGate.availabilityFlags
    : [];

  if (!hasMissingFlags && !hasUncertainFlags && availabilityFlags.length === 0) return;

  card.payloadData.missing_inputs = [
    ...(card.payloadData.missing_inputs || []),
    ...(availabilityGate?.missingFlags || []),
  ];

  if (availabilityFlags.length > 0) {
    if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
    card.payloadData.raw_data.availability_flags = availabilityFlags;
  }

  if (availabilityGate?.injuryProjectionReduction) {
    if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
    card.payloadData.raw_data.injury_projection_reduction =
      availabilityGate.injuryProjectionReduction;
  }

  if (
    hasMissingFlags &&
    Array.isArray(availabilityGate?.missingFlags) &&
    availabilityGate.missingFlags.includes('key_player_out') &&
    card.payloadData.tier &&
    (card.payloadData.tier === 'FIRE' || card.payloadData.tier === 'WATCH')
  ) {
    card.payloadData.tier = 'LEAN';
  }
}

const NBA_DRIVER_WEIGHTS = {
  // WI-1018: rebalanced — base↑ to dampen additive driver compounding.
  baseProjection: 0.55,
  restAdvantage: 0.1,
  welcomeHomeV2: 0.07,
  matchupStyle: 0.14,
  blowoutRisk: 0.05,
  totalProjection: 0.09,
};

const NBA_DRIVER_CARD_TYPES = [
  'nba-base-projection',
  'nba-rest-advantage',
  'welcome-home',
  'welcome-home-v2', // alias: backward compat with existing DB rows
  'nba-matchup-style',
  'nba-blowout-risk',
  'nba-total-projection',
];

/**
 * WI-0646: Apply PLAYOFF_SIGMA_MULTIPLIER to empirical sigma overrides.
 * Only multiplies finite numeric fields so null/undefined gracefully pass through.
 */
function applyPlayoffSigmaMultiplier(sigma, multiplier) {
  if (!sigma || !multiplier) return sigma;
  const scale = (value) =>
    typeof value === 'number' && !Number.isNaN(value)
      ? value * multiplier
      : value ?? null;

  return {
    sigma_source: sigma.sigma_source,
    games_sampled: sigma.games_sampled ?? null,
    margin: scale(sigma.margin),
    total: scale(sigma.total),
    spread: scale(sigma.spread),
    adjusted_for_playoffs: true,
    playoff_sigma_multiplier: multiplier,
  };
}

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

function applyProjectionInputMetadata(card, projectionGate) {
  if (!card?.payloadData || !projectionGate) return;
  card.payloadData.projection_inputs_complete =
    projectionGate.projection_inputs_complete;
  card.payloadData.missing_inputs = Array.isArray(projectionGate.missing_inputs)
    ? projectionGate.missing_inputs
    : [];
}

function applyDecisionNamespaceMetadata(card) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;
  const payload = card.payloadData;
  const legacyMissingInputs = Array.isArray(payload.missing_inputs)
    ? payload.missing_inputs.map((value) => String(value))
    : [];
  const featureTokenSet = new Set([
    'block_rates_stale',
    'feature_freshness:block_rates_stale',
  ]);
  const marketTokenSet = new Set([
    'market_line',
    'missing_market_odds',
    'no_odds',
    'odds_snapshot_missing',
  ]);

  const derivedFeatureFlagsFromLegacy = legacyMissingInputs
    .filter((token) => featureTokenSet.has(String(token).toLowerCase()))
    .map((token) => `FEATURE_${String(token).trim().toUpperCase()}`);
  const featureFlags = Array.from(
    new Set([
      ...(Array.isArray(payload.feature_flags) ? payload.feature_flags : []),
      ...derivedFeatureFlagsFromLegacy,
    ]),
  );

  const coreMissingInputs = Array.isArray(payload.core_missing_inputs)
    ? payload.core_missing_inputs.map((value) => String(value))
    : legacyMissingInputs.filter((token) => {
      const normalized = String(token).toLowerCase();
      return !featureTokenSet.has(normalized) && !marketTokenSet.has(normalized);
    });

  const coreInputsComplete =
    typeof payload.core_inputs_complete === 'boolean'
      ? payload.core_inputs_complete && coreMissingInputs.length === 0
      : payload.projection_inputs_complete !== false && coreMissingInputs.length === 0;

  payload.feature_flags = featureFlags;
  payload.core_missing_inputs = Array.from(new Set(coreMissingInputs));
  payload.core_inputs_complete = coreInputsComplete;

  // Compatibility mirror: legacy fields are derived from namespaced authority.
  payload.projection_inputs_complete = coreInputsComplete;
  payload.missing_inputs = Array.from(new Set(payload.core_missing_inputs));

  const executionStatus = String(payload.execution_status || '').toUpperCase();
  const basis = String(payload.basis || '').toUpperCase();
  const freshnessTier = payload.freshness_tier
    ? String(payload.freshness_tier).toLowerCase()
    : 'unknown';
  const executionBlocked =
    executionStatus === 'BLOCKED' ||
    (typeof payload.pass_reason_code === 'string' &&
      payload.pass_reason_code.startsWith('PASS_EXECUTION_GATE_')) ||
    payload.execution_gate?.should_bet === false;

  const hasOdds =
    basis === 'ODDS_BACKED' ||
    Number.isFinite(payload.price) ||
    Number.isFinite(payload.market_price_over) ||
    Number.isFinite(payload.market_price_under);

  payload.market_status = {
    has_odds: Boolean(hasOdds),
    freshness_tier: freshnessTier,
    execution_blocked: executionBlocked,
  };
}

function hasFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function extractSameBookOddsContext(oddsSnapshot) {
  const rawData =
    oddsSnapshot?.raw_data && typeof oddsSnapshot.raw_data === 'object'
      ? oddsSnapshot.raw_data
      : null;
  const executionPairs =
    rawData?._execution_pairs && typeof rawData._execution_pairs === 'object'
      ? rawData._execution_pairs
      : {};

  return {
    h2h_same_book_away_for_home:
      oddsSnapshot?.h2h_same_book_away_for_home ??
      oddsSnapshot?.h2hSameBookAwayForHome ??
      executionPairs.h2h_same_book_away_for_home ??
      null,
    h2h_same_book_home_for_away:
      oddsSnapshot?.h2h_same_book_home_for_away ??
      oddsSnapshot?.h2hSameBookHomeForAway ??
      executionPairs.h2h_same_book_home_for_away ??
      null,
    spread_same_book_away_for_home:
      oddsSnapshot?.spread_same_book_away_for_home ??
      oddsSnapshot?.spreadSameBookAwayForHome ??
      executionPairs.spread_same_book_away_for_home ??
      null,
    spread_same_book_home_for_away:
      oddsSnapshot?.spread_same_book_home_for_away ??
      oddsSnapshot?.spreadSameBookHomeForAway ??
      executionPairs.spread_same_book_home_for_away ??
      null,
    total_same_book_under_for_over:
      oddsSnapshot?.total_same_book_under_for_over ??
      oddsSnapshot?.totalSameBookUnderForOver ??
      executionPairs.total_same_book_under_for_over ??
      null,
    total_same_book_over_for_under:
      oddsSnapshot?.total_same_book_over_for_under ??
      oddsSnapshot?.totalSameBookOverForUnder ??
      executionPairs.total_same_book_over_for_under ??
      null,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function applyRegimePaceToBlendedTotal({
  marketTotal,
  paceAnchorTotal,
  regimePaceMultiplier,
  teamContextWeight = TEAM_CONTEXT_WEIGHT,
  injuryProjectionReduction = 0,
} = {}) {
  const anchor = toFiniteNumberOrNull(paceAnchorTotal);
  if (anchor === null) return null;

  const multiplier = toFiniteNumberOrNull(regimePaceMultiplier) ?? 1;
  const adjustedAnchor = anchor * multiplier;
  const market = toFiniteNumberOrNull(marketTotal);
  const blended = market === null
    ? adjustedAnchor
    : market * (1 - teamContextWeight) + adjustedAnchor * teamContextWeight;
  const reduction = toFiniteNumberOrNull(injuryProjectionReduction) ?? 0;
  return Math.max(0, blended - reduction);
}

function computePricedCallCardConfidence({ edgePct, conflictScore }) {
  const normalizedEdgePct = hasFiniteNumber(edgePct) ? edgePct : 0;
  const normalizedConflictScore = hasFiniteNumber(conflictScore)
    ? conflictScore
    : 0;
  const baseConfidence = clamp(0.5 + normalizedEdgePct * 3, 0.5, 0.9);

  return edgeCalculator.computeConfidence({
    baseConfidence,
    watchdogStatus: 'OK',
    missingFieldCount: 0,
    proxyUsed: false,
    conflictScore: normalizedConflictScore,
  });
}

function applyMarketIntelligenceModifier({
  baseConfidence,
  sharpDivergence,
  splitsDivergence,
  edge,
}) {
  const candidates = [];

  if (sharpDivergence === 'SHARP_VS_PUBLIC') {
    candidates.push({
      multiplier: 0.85,
      reasonCode: 'SHARP_VS_MODEL_CONFLICT',
    });
  }

  if (
    (splitsDivergence === 'PUBLIC_HEAVY_HOME' ||
      splitsDivergence === 'PUBLIC_HEAVY_AWAY') &&
    hasFiniteNumber(edge) &&
    edge < 0.04
  ) {
    candidates.push({
      multiplier: 0.88,
      reasonCode: 'PUBLIC_TRAP_RISK',
    });
  }

  if (sharpDivergence === 'SHARP_ALIGNED') {
    candidates.push({
      multiplier: 1.05,
      reasonCode: 'SHARP_CONFIRMATION',
    });
  }

  const selected =
    candidates.length > 0
      ? candidates.reduce((mostConservative, candidate) =>
          candidate.multiplier < mostConservative.multiplier
            ? candidate
            : mostConservative,
        )
      : { multiplier: 1.0, reasonCode: null };
  const normalizedBaseConfidence = hasFiniteNumber(baseConfidence)
    ? baseConfidence
    : 0.5;

  return {
    adjustedConfidence: clamp(
      normalizedBaseConfidence * selected.multiplier,
      0.45,
      0.90,
    ),
    multiplier: selected.multiplier,
    reasonCodes: selected.reasonCode ? [selected.reasonCode] : [],
  };
}

function buildMarketIntelModifierPayload(marketIntel) {
  return {
    multiplier: marketIntel.multiplier,
    reason_codes: [...marketIntel.reasonCodes],
  };
}

function buildMarketLineContext({
  sport,
  gameId,
  marketType,
  selectionSide = null,
}) {
  try {
    return computeLineDelta({
      sport,
      gameId,
      marketType,
      selectionSide,
    });
  } catch (error) {
    console.warn(
      `[NBAModel] Failed to compute ${marketType} line delta for ${gameId}: ${error.message}`,
    );
    // WI-0907 Phase 4 Task 3: Return error info so cards emit LINE_DELTA_COMPUTATION_FAILED
    return { value: null, computationError: error.message };
  }
}

function buildLineContextPayload(lineContext, selectionSide) {
  if (!lineContext || typeof lineContext !== 'object') return null;
  return {
    ...lineContext,
    selection_side: selectionSide || null,
  };
}

function hasMoneylineOdds(oddsSnapshot) {
  const homePrice = oddsSnapshot?.h2h_home ?? oddsSnapshot?.moneyline_home;
  const awayPrice = oddsSnapshot?.h2h_away ?? oddsSnapshot?.moneyline_away;
  return hasFiniteNumber(homePrice) && hasFiniteNumber(awayPrice);
}

function hasSpreadOdds(oddsSnapshot) {
  return (
    hasFiniteNumber(oddsSnapshot?.spread_home) &&
    hasFiniteNumber(oddsSnapshot?.spread_away) &&
    hasFiniteNumber(oddsSnapshot?.spread_price_home) &&
    hasFiniteNumber(oddsSnapshot?.spread_price_away)
  );
}

function hasTotalOdds(oddsSnapshot) {
  return (
    hasFiniteNumber(oddsSnapshot?.total) &&
    hasFiniteNumber(oddsSnapshot?.total_price_over) &&
    hasFiniteNumber(oddsSnapshot?.total_price_under)
  );
}

function buildGamePipelineState({
  oddsSnapshot,
  projectionReady,
  driversReady,
  pricingReady,
  cardReady,
  blockingReasonCodes = [],
}) {
  const teamMappingOk = Boolean(
    oddsSnapshot?.home_team && oddsSnapshot?.away_team,
  );
  const marketLinesOk =
    hasMoneylineOdds(oddsSnapshot) ||
    hasSpreadOdds(oddsSnapshot) ||
    hasTotalOdds(oddsSnapshot);

  return buildPipelineState({
    ingested: Boolean(oddsSnapshot),
    team_mapping_ok: teamMappingOk,
    odds_ok: Boolean(oddsSnapshot?.captured_at) && marketLinesOk,
    market_lines_ok: marketLinesOk,
    projection_ready: projectionReady === true,
    drivers_ready: driversReady === true,
    pricing_ready: pricingReady === true,
    card_ready: cardReady === true,
    blocking_reason_codes: blockingReasonCodes,
  });
}

function deriveGameBlockingReasonCodes({
  oddsSnapshot,
  projectionReady,
  pricingReady,
  cards = [],
}) {
  const reasonCodes = [];
  const hasTeamMapping = Boolean(
    oddsSnapshot?.home_team && oddsSnapshot?.away_team,
  );
  const hasMarketLines =
    hasMoneylineOdds(oddsSnapshot) ||
    hasSpreadOdds(oddsSnapshot) ||
    hasTotalOdds(oddsSnapshot);

  if (!hasTeamMapping) {
    reasonCodes.push(WATCHDOG_REASONS.CONSISTENCY_MISSING);
  }

  if (!hasMarketLines) {
    reasonCodes.push(WATCHDOG_REASONS.MARKET_UNAVAILABLE);
  }

  if (projectionReady === false) {
    reasonCodes.push(WATCHDOG_REASONS.CONSISTENCY_MISSING);
  }

  if (pricingReady === false) {
    cards.forEach((card) => {
      reasonCodes.push(...collectDecisionReasonCodes(card?.payloadData));
    });
  }

  return reasonCodes;
}

function canPriceCard(card) {
  const sharpPriceStatus = card?.payloadData?.decision_v2?.sharp_price_status;
  return Boolean(sharpPriceStatus && sharpPriceStatus !== 'UNPRICED');
}

function resolveSnapshotAgeMeta(oddsSnapshot, nowMs = Date.now()) {
  const capturedAt = oddsSnapshot?.captured_at ?? oddsSnapshot?.fetched_at ?? null;
  if (!capturedAt) {
    return {
      snapshotAgeMs: null,
      reasonCode: WATCHDOG_REASONS.CAPTURED_AT_MISSING,
    };
  }

  const capturedAtMs = new Date(capturedAt).getTime();
  if (!Number.isFinite(capturedAtMs)) {
    return {
      snapshotAgeMs: null,
      reasonCode: WATCHDOG_REASONS.CAPTURED_AT_MS_INVALID,
    };
  }

  return {
    snapshotAgeMs: Math.max(0, nowMs - capturedAtMs),
    reasonCode: null,
  };
}

function toExecutionGatePassReasonCode(reason) {
  const normalized = String(reason || '')
    .toUpperCase()
    .split(':')[0]
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized
    ? `PASS_EXECUTION_GATE_${normalized}`
    : 'PASS_EXECUTION_GATE_BLOCKED';
}

function applyExecutionGateToNbaCard(card, { oddsSnapshot, nowMs = Date.now() } = {}) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') {
    return { evaluated: false, blocked: false, strictDecisionSnapshot: null };
  }

  const payload = card.payloadData;
  const executionStatus = String(payload.execution_status || '').toUpperCase();
  const alreadyPass =
    String(payload.status || '').toUpperCase() === 'PASS' ||
    String(payload.action || '').toUpperCase() === 'PASS' ||
    String(payload.classification || '').toUpperCase() === 'PASS' ||
    String(payload.decision_v2?.official_status || '').toUpperCase() === 'PASS';
  const resolvedModelStatus = String(payload.model_status || 'MODEL_OK').toUpperCase();
  const {
    snapshotAgeMs,
    reasonCode: snapshotAgeReasonCode,
  } = resolveSnapshotAgeMeta(oddsSnapshot, nowMs);

  if (snapshotAgeReasonCode) {
    payload.reason_codes = Array.from(
      new Set([
        ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
        snapshotAgeReasonCode,
      ]),
    ).sort();
    if (payload.decision_v2 && typeof payload.decision_v2 === 'object') {
      payload.decision_v2.watchdog_reason_codes = Array.from(
        new Set([
          ...(Array.isArray(payload.decision_v2.watchdog_reason_codes)
            ? payload.decision_v2.watchdog_reason_codes
            : []),
          snapshotAgeReasonCode,
        ]),
      ).sort();
    }
  }

  if (executionStatus !== 'EXECUTABLE' || alreadyPass) {
    const earlyExitDropReasonCode = alreadyPass
      ? 'NOT_BET_ELIGIBLE'
      : executionStatus === 'PROJECTION_ONLY'
        ? 'PROJECTION_ONLY_EXCLUSION'
        : 'NOT_EXECUTABLE_PATH';
    payload.execution_gate = {
      evaluated: false,
      should_bet: null,
      net_edge: null,
      blocked_by: [earlyExitDropReasonCode],
      model_status: resolvedModelStatus,
      snapshot_age_ms: snapshotAgeMs,
      evaluated_at: new Date(nowMs).toISOString(),
      drop_reason: {
        drop_reason_code: earlyExitDropReasonCode,
        drop_reason_layer: 'worker_gate',
      },
    };

    return {
      evaluated: false,
      blocked: false,
      strictDecisionSnapshot: capturePublishedDecisionState(payload),
    };
  }

  const gateResult = evaluateExecution({
    modelStatus: resolvedModelStatus,
    rawEdge: Number.isFinite(payload.edge) ? payload.edge : null,
    confidence: Number.isFinite(payload.confidence) ? payload.confidence : null,
    snapshotAgeMs,
    marketKey: payload.market_key ?? null,
    sport: payload.sport ?? card.sport ?? 'NBA',
    recommendedBetType: payload.recommended_bet_type ?? null,
    marketType: payload.market_type ?? null,
    period: payload.period ?? payload.market?.period ?? null,
    cardType: card.cardType ?? null,
  });

  payload.execution_gate = {
    evaluated: true,
    should_bet: gateResult.shouldBet,
    net_edge: gateResult.netEdge,
    blocked_by: gateResult.blocked_by,
    hard_blocked_by: Array.isArray(gateResult.hard_blocked_by)
      ? gateResult.hard_blocked_by
      : gateResult.blocked_by,
    advisory_by: Array.isArray(gateResult.advisory_by) ? gateResult.advisory_by : [],
    model_status: resolvedModelStatus,
    snapshot_age_ms: snapshotAgeMs,
    evaluated_at: new Date(nowMs).toISOString(),
    drop_reason: gateResult.drop_reason,
  };
  payload.freshness_tier = gateResult.freshness_decision?.tier ?? 'UNKNOWN';

  if (!gateResult.shouldBet) {
    const passReasonCode = toExecutionGatePassReasonCode(gateResult.reason);
    payload.classification = 'PASS';
    payload.action = 'PASS';
    payload.status = 'PASS';
    payload.ui_display_status = 'PASS';
    payload.execution_status = 'BLOCKED';
    payload.ev_passed = false;
    payload.actionable = false;
    payload.publish_ready = false;
    payload.pass_reason_code = passReasonCode;
    payload.reason_codes = Array.from(
      new Set([passReasonCode, ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : [])]),
    ).sort();
    // WI-0941 TD-01: Stamp decision_v2 at execution gate demotion so official_status remains consistent
    if (payload.decision_v2 && typeof payload.decision_v2 === 'object') {
      payload.decision_v2.official_status = 'PASS';
      payload.decision_v2.primary_reason_code = passReasonCode;
    }
    syncCanonicalDecisionEnvelope(payload, {
      official_status: 'PASS',
      primary_reason_code: passReasonCode,
      execution_status: 'BLOCKED',
      publish_ready: false,
    });
    payload._publish_state = {
      ...(payload._publish_state && typeof payload._publish_state === 'object'
        ? payload._publish_state
        : {}),
      publish_ready: false,
      emit_allowed: true,
      execution_status: 'BLOCKED',
      block_reason: gateResult.reason,
    };
  } else {
    payload.publish_ready = true;
    payload.actionable = true;
    payload._publish_state = {
      ...(payload._publish_state && typeof payload._publish_state === 'object'
        ? payload._publish_state
        : {}),
      publish_ready: true,
      emit_allowed: true,
      execution_status: 'EXECUTABLE',
      block_reason: null,
    };
  }

  return {
    evaluated: true,
    blocked: !gateResult.shouldBet,
    strictDecisionSnapshot: capturePublishedDecisionState(payload),
  };
}

function deriveExecutionStatusForCard(
  card,
  { withoutOddsMode = false } = {},
) {
  const payload = card?.payloadData;
  const existingStatus = String(payload?.execution_status || '').toUpperCase();
  if (
    existingStatus === 'EXECUTABLE' ||
    existingStatus === 'PROJECTION_ONLY' ||
    existingStatus === 'BLOCKED'
  ) {
    return existingStatus;
  }

  if (
    withoutOddsMode ||
    Array.isArray(payload?.tags) && payload.tags.includes('no_odds_mode') ||
    payload?.line_source === 'projection_floor'
  ) {
    return 'PROJECTION_ONLY';
  }

  return Number.isFinite(payload?.price) ? 'EXECUTABLE' : 'BLOCKED';
}

function assignExecutionStatus(card, options = {}) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return null;
  const executionStatus = deriveExecutionStatusForCard(card, options);
  card.payloadData.execution_status = executionStatus;
  return executionStatus;
}

function assertExecutableCardsArePriced(card) {
  const executionStatus = String(
    card?.payloadData?.execution_status || '',
  ).toUpperCase();
  if (executionStatus !== 'EXECUTABLE') return;
  if (canPriceCard(card)) return;

  const error = new Error(
    `[INVARIANT_BREACH] pricing_ready=false cannot coexist with execution_status=EXECUTABLE for ${card?.cardType || 'unknown-card'}`,
  );
  error.code = 'INVARIANT_BREACH';

  if (process.env.NODE_ENV === 'test') {
    throw error;
  }

  console.warn(error.message);
}

function applyNbaSettlementMarketContext(card) {
  if (!card?.payloadData || typeof card.payloadData !== 'object') return;
  const payload = card.payloadData;
  if (String(payload.market_type || '').toUpperCase() !== 'TOTAL') return;

  payload.period = payload.period || 'FULL_GAME';
  payload.market = {
    ...(payload.market && typeof payload.market === 'object'
      ? payload.market
      : {}),
    period: payload.period,
  };
  if (payload.market_context && typeof payload.market_context === 'object') {
    payload.market_context = {
      ...payload.market_context,
      period: payload.period,
      wager: {
        ...(payload.market_context.wager &&
        typeof payload.market_context.wager === 'object'
          ? payload.market_context.wager
          : {}),
        period: payload.period,
      },
    };
  }
}

/**
 * Get home team's recent road trip (consecutive away games)
 * Returns if the team JUST COMPLETED a road trip and is now playing at home
 * Welcome Home Fade: Home team's first game after returning from road trip
 *
 * @param {string} teamName - Team display name
 * @param {string} sport - Sport code (lowercase)
 * @param {string} currentGameTime - Current game time in UTC
 * @param {number} limit - Max games to retrieve
 * @returns {Array<{isHome: boolean, date: string}>} Recent road games if just returning home, else []
 */
function getHomeTeamRecentRoadTrip(
  teamName,
  sport,
  currentGameTime,
  limit = 10,
) {
  if (!teamName || !currentGameTime) return [];

  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT game_id, game_time_utc, home_team, away_team, status
    FROM games
    WHERE LOWER(sport) = ?
      AND (UPPER(away_team) = UPPER(?) OR UPPER(home_team) = UPPER(?))
      AND game_time_utc < ?
    ORDER BY game_time_utc DESC
    LIMIT ?
  `);

  try {
    const results = stmt.all(
      sport.toLowerCase(),
      teamName,
      teamName,
      currentGameTime,
      limit,
    );
    const completedGames = results
      .filter((g) => g.status === 'final' || g.status === 'STATUS_FINAL')
      .reverse(); // Chronological order (oldest to newest)

    if (!completedGames.length) return [];

    // Find the most recent game to see if it started a change pattern
    // Pattern: if recent games are [away, away, away, ...]
    // and we're now at a home game, that's Welcome Home Fade

    const roadTrip = [];

    // Start from most recent game and work backwards
    // Collect consecutive AWAY games
    for (let i = completedGames.length - 1; i >= 0; i--) {
      const game = completedGames[i];
      const isAway =
        game.away_team &&
        game.away_team.toUpperCase() === teamName.toUpperCase();
      const isHome =
        game.home_team &&
        game.home_team.toUpperCase() === teamName.toUpperCase();

      if (isAway) {
        // Team was away in this game - part of road trip
        roadTrip.unshift({
          isHome: false,
          date: game.game_time_utc,
          opponent: game.home_team,
          location: 'away',
        });
      } else if (isHome) {
        // Team was home - this breaks the road trip
        // If we have a road trip, return it (the next game is home after road trip)
        break;
      }
    }

    // Need at least 2 away games to be a meaningful road trip
    return roadTrip.length >= 2 ? roadTrip : [];
  } catch (error) {
    console.error(
      `[WhF] Failed to query road trip for ${teamName}:`,
      error.message,
    );
    return [];
  }
}

/**
 * WI-0768: Fetch team_metrics_cache entries for both teams and compute a pace-anchor
 * total. Blends the anchor with the market total using TEAM_CONTEXT_WEIGHT.
 * Mutates oddsSnapshot.raw_data to add pace_anchor_total and blended_total.
 *
 * @param {string} gameId
 * @param {object} oddsSnapshot
 * @returns {Promise<{available: boolean, paceAnchorTotal: number|null, blendedTotal: number|null, teamContextMissingInputs: string[]}>}
 */
async function applyNbaTeamContext(
  gameId,
  oddsSnapshot,
  {
    rollingBias = null,
    getTeamMetricsWithGamesFn = getTeamMetricsWithGames,
  } = {},
) {
  const homeTeam = oddsSnapshot?.home_team;
  const awayTeam = oddsSnapshot?.away_team;
  const calibrationState = normalizeNbaCalibrationState(rollingBias);

  if (!homeTeam || !awayTeam) {
    return {
      available: false,
      paceAnchorTotal: null,
      blendedTotal: null,
      teamContextMissingInputs: ['nba_team_context'],
      availabilityGate: { missingFlags: [], uncertainFlags: [], availabilityFlags: [] },
      nullMetricTeams: [],
      calibrationState,
      teamMetricsHome: null,
      teamMetricsAway: null,
    };
  }

  try {
    const [homeResult, awayResult] = await Promise.all([
      getTeamMetricsWithGamesFn(homeTeam, 'NBA', { includeImpactContext: true }),
      getTeamMetricsWithGamesFn(awayTeam, 'NBA', { includeImpactContext: true }),
    ]);
    const availabilityGate = buildNbaAvailabilityGate(
      homeResult?.impactContext || null,
      awayResult?.impactContext || null,
    );
    const nullMetricTeams = extractNbaEspnNullMetricTeams({
      homeTeam,
      awayTeam,
      homeResult,
      awayResult,
    });

    const hAvgPts = homeResult?.metrics?.avgPoints;
    const hAvgPtsAllowed = homeResult?.metrics?.avgPointsAllowed;
    const aAvgPts = awayResult?.metrics?.avgPoints;
    const aAvgPtsAllowed = awayResult?.metrics?.avgPointsAllowed;

    const hasContext = [
      hAvgPts,
      hAvgPtsAllowed,
      aAvgPts,
      aAvgPtsAllowed,
    ].every((v) => Number.isFinite(v));

    if (!hasContext) {
      console.log(
        `  [NBA_TEAM_CTX] ${gameId}: team_metrics_cache absent — missing_inputs: nba_team_context`,
      );
      return {
        available: false,
        paceAnchorTotal: null,
        blendedTotal: null,
        teamContextMissingInputs: ['nba_team_context'],
        availabilityGate,
        nullMetricTeams,
        calibrationState,
        teamMetricsHome: homeResult?.metrics ?? null,
        teamMetricsAway: awayResult?.metrics ?? null,
      };
    }

    // pace-anchor: average of both teams' expected scoring contributions
    const paceAnchorTotal =
      (hAvgPts + hAvgPtsAllowed + aAvgPts + aAvgPtsAllowed) / 2;
    // Apply rolling global bias exactly once before market blending. Later
    // residual layers must add their own corrections on top, not compound this.
    const correctedAnchor =
      paceAnchorTotal -
      (calibrationState.correction_applied ? calibrationState.bias : 0);
    const marketTotal = oddsSnapshot?.total ?? null;
    const blendedTotal = Number.isFinite(marketTotal)
      ? marketTotal * (1 - TEAM_CONTEXT_WEIGHT) +
        correctedAnchor * TEAM_CONTEXT_WEIGHT
      : correctedAnchor;
    const injuryProjectionReduction = availabilityGate.injuryProjectionReduction || null;
    const reductionApplied =
      toFiniteNumberOrNull(injuryProjectionReduction?.reduction_applied) ?? 0;
    const adjustedBlendedTotal = Math.max(0, blendedTotal - reductionApplied);

    // Mutate raw_data so downstream models can read the anchor
    if (oddsSnapshot.raw_data && typeof oddsSnapshot.raw_data === 'object') {
      oddsSnapshot.raw_data.pace_anchor_total_raw = Number(
        paceAnchorTotal.toFixed(2),
      );
      oddsSnapshot.raw_data.pace_anchor_total = Number(
        correctedAnchor.toFixed(2),
      );
      oddsSnapshot.raw_data.blended_total = Number(adjustedBlendedTotal.toFixed(2));
      oddsSnapshot.raw_data.calibration_state = calibrationState;
      if (
        injuryProjectionReduction &&
        (
          reductionApplied > 0 ||
          injuryProjectionReduction.role_classes?.home?.length > 0 ||
          injuryProjectionReduction.role_classes?.away?.length > 0
        )
      ) {
        oddsSnapshot.raw_data.injury_projection_reduction =
          injuryProjectionReduction;
      }
    }

    console.log(
      `  [NBA_TEAM_CTX] ${gameId}: pace_anchor=${correctedAnchor.toFixed(2)}, blended=${adjustedBlendedTotal.toFixed(2)} (market=${marketTotal ?? 'n/a'})`,
    );

    return {
      available: true,
      paceAnchorTotal: Number(correctedAnchor.toFixed(2)),
      rawPaceAnchorTotal: Number(paceAnchorTotal.toFixed(2)),
      blendedTotal: Number(adjustedBlendedTotal.toFixed(2)),
      originalBlendedTotal: Number(blendedTotal.toFixed(2)),
      teamContextMissingInputs: [],
      availabilityGate,
      nullMetricTeams,
      calibrationState,
      teamMetricsHome: homeResult?.metrics ?? null,
      teamMetricsAway: awayResult?.metrics ?? null,
    };
  } catch (err) {
    console.warn(
      `  [NBA_TEAM_CTX] ${gameId}: failed to fetch team metrics — ${err.message}`,
    );
    return {
      available: false,
      paceAnchorTotal: null,
      blendedTotal: null,
      teamContextMissingInputs: ['nba_team_context'],
      availabilityGate: { missingFlags: [], uncertainFlags: [], availabilityFlags: [] },
      nullMetricTeams: [],
      calibrationState,
      teamMetricsHome: null,
      teamMetricsAway: null,
    };
  }
}

/**
 * Generate standalone market call cards (nba-totals-call, nba-spread-call)
 * from cross-market decisions. Only emits for FIRE or WATCH status.
 */
function generateNBAMarketCallCards(
  gameId,
  marketDecisions,
  oddsSnapshot,
  { withoutOddsMode = false, lineContexts = {}, spreadLeanMin = null } = {},
) {
  const now = new Date().toISOString();
  const expiresAt = null;

  const matchup = buildMatchup(
    oddsSnapshot?.home_team,
    oddsSnapshot?.away_team,
  );
  const { start_time_local: startTimeLocal, timezone } = formatStartTimeLocal(
    oddsSnapshot?.game_time_utc,
  );
  const countdown = formatCountdown(oddsSnapshot?.game_time_utc);
  const market = buildMarketFromOdds(oddsSnapshot);
  const totalLineContext = lineContexts?.TOTAL || null;
  const spreadLineContext = lineContexts?.SPREAD || null;
  const rawMarketIntel =
    oddsSnapshot?.raw_data && typeof oddsSnapshot.raw_data === 'object'
      ? oddsSnapshot.raw_data
      : {};

  const cards = [];

  // TOTAL decision → nba-totals-call
  const totalDecision = marketDecisions?.TOTAL;
  const totalBias = computeTotalBias(totalDecision);
  const _totalProjection = totalDecision?.projection?.projected_total ?? null;
  if (
    totalDecision &&
    (
      (totalDecision.status === 'FIRE' || totalDecision.status === 'WATCH') ||
      // Without Odds Mode: emit lean whenever projection is available regardless of edge-based status
      (withoutOddsMode && _totalProjection != null)
    )
  ) {
    const rawStatus = totalDecision.status || 'PASS';
    const status = withoutOddsMode && rawStatus === 'PASS' ? 'LEAN' : rawStatus;
    const baseConfidence = withoutOddsMode
      ? 0.52
      : computePricedCallCardConfidence({
          edgePct: totalDecision.edge,
          conflictScore: totalDecision.conflict,
        });
    const marketIntel = applyMarketIntelligenceModifier({
      baseConfidence,
      sharpDivergence: rawMarketIntel.sharp_divergence ?? null,
      splitsDivergence: rawMarketIntel.splits_divergence ?? null,
      edge: totalDecision.edge,
    });
    const confidence = marketIntel.adjustedConfidence;
    const tier = determineTier(confidence);
    const { side, line: marketLine } = totalDecision.best_candidate;
    // In Without Odds Mode there is no market line — fall back to projection.
    const projectedTotal = totalDecision.projection?.projected_total ?? null;
    const line = withoutOddsMode ? (projectedTotal ?? marketLine) : marketLine;
    const totalPrice = withoutOddsMode
      ? null
      : side === 'OVER'
        ? (oddsSnapshot?.total_price_over ?? null)
        : (oddsSnapshot?.total_price_under ?? null);
    const hasLine = line != null;
    const hasPrice = totalPrice != null;
    if (hasLine && (hasPrice || withoutOddsMode)) {
      const lineText = line != null ? ` ${line}` : '';
      const pickText = `${side === 'OVER' ? 'OVER' : 'UNDER'}${lineText}`;
      const reasonCodes = [];
      if (totalBias !== 'OK') reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
      const activeDrivers = (totalDecision.drivers || [])
        .filter((d) => d.eligible)
        .map((d) => d.driverKey);
      const topDrivers = (totalDecision.drivers || [])
        .filter((d) => d.eligible)
        .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
        .slice(0, 3)
        .map((d) => ({
          driver: d.driverKey,
          weight: d.weight,
          score: Number(((d.signal + 1) / 2).toFixed(3)),
        }));

      const payloadData = {
        game_id: gameId,
        sport: 'NBA',
        model_version: 'nba-cross-market-v1',
        home_team: oddsSnapshot?.home_team ?? null,
        away_team: oddsSnapshot?.away_team ?? null,
        matchup,
        start_time_utc: oddsSnapshot?.game_time_utc ?? null,
        start_time_local: startTimeLocal,
        timezone,
        countdown,
        prediction: side,
        confidence,
        tier,
        model_status: totalDecision.model_status ?? 'MODEL_OK',
        status,
        recommended_bet_type: 'total',
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: {
          side,
        },
        line,
        price: totalPrice,
        reason_codes: reasonCodes,
        tags: withoutOddsMode ? ['no_odds_mode'] : [],
        consistency: {
          total_bias: totalBias,
        },
        raw_data: {
          market_intel_modifier: buildMarketIntelModifierPayload(marketIntel),
        },
        reasoning: `${pickText}: ${totalDecision.reasoning}`,
        execution_status: withoutOddsMode ? 'PROJECTION_ONLY' : 'EXECUTABLE',
        edge: totalDecision.edge ?? null,
        edge_pct: totalDecision.edge ?? null,
        edge_points: totalDecision.edge_points ?? null,
        p_fair: totalDecision.p_fair ?? null,
        p_implied: totalDecision.p_implied ?? null,
        model_prob: totalDecision.p_fair ?? null,
        projection: {
          total: totalDecision?.projection?.projected_total ?? line ?? null,
          margin_home: null,
          win_prob_home: null,
        },
        market_context: {
          version: 'v1',
          market_type: 'TOTAL',
          selection_side: side,
          selection_team: null,
          projection: {
            margin_home: null,
            total: totalDecision?.projection?.projected_total ?? line ?? null,
            team_total: null,
            win_prob_home: null,
            score_home: null,
            score_away: null,
          },
          wager: {
            called_line: line ?? null,
            called_price: totalPrice ?? null,
            line_source: withoutOddsMode ? 'projection_floor' : (totalDecision.line_source ?? 'odds_snapshot'),
            price_source: withoutOddsMode ? null : (totalDecision.price_source ?? 'odds_snapshot'),
          },
        },
        market,
        line_source: withoutOddsMode ? 'projection_floor' : (totalDecision.line_source ?? 'odds_snapshot'),
        price_source: withoutOddsMode ? null : (totalDecision.price_source ?? 'odds_snapshot'),
        decision_basis_meta: buildDecisionBasisMeta({
          usingRealLine: !withoutOddsMode,
          edgePct: withoutOddsMode ? null : (totalDecision.edge ?? null),
          marketLineSource: withoutOddsMode ? 'projection_floor' : 'odds_api',
          marketOrPropType: 'total_pace',
        }),
        pricing_trace: {
          called_market_type: 'TOTAL',
          called_side: side,
          called_line: line ?? null,
          called_price: totalPrice ?? null,
          line_source: withoutOddsMode ? 'projection_floor' : (totalDecision.line_source ?? 'odds_snapshot'),
          price_source: withoutOddsMode ? null : (totalDecision.price_source ?? 'odds_snapshot'),
          proxy_used: withoutOddsMode || totalDecision?.projection?.projected_total == null,
        },
        drivers_active: activeDrivers,
        driver_summary: {
          weights: topDrivers,
          impact_note: 'Cross-market totals decision.',
        },
        ev_passed: !withoutOddsMode && totalDecision.status === 'FIRE',
        odds_context: {
          h2h_home: oddsSnapshot?.h2h_home,
          h2h_away: oddsSnapshot?.h2h_away,
          ...extractSameBookOddsContext(oddsSnapshot),
          spread_home: oddsSnapshot?.spread_home,
          spread_away: oddsSnapshot?.spread_away,
          total: oddsSnapshot?.total,
          spread_price_home: oddsSnapshot?.spread_price_home,
          spread_price_away: oddsSnapshot?.spread_price_away,
          total_price_over: oddsSnapshot?.total_price_over,
          total_price_under: oddsSnapshot?.total_price_under,
          captured_at: oddsSnapshot?.captured_at,
          projection_comparison: totalDecision.projection_comparison ?? null,
        },
        line_context: buildLineContextPayload(totalLineContext, side),
        line_delta: totalLineContext?.delta ?? null,
        line_delta_pct: totalLineContext?.delta_pct ?? null,
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_total',
          score: totalDecision.score,
          status: totalDecision.status,
          inputs: {
            net: totalDecision.net,
            conflict: totalDecision.conflict,
            coverage: totalDecision.coverage,
          },
        },
        splits_divergence: (() => {
          const h = oddsSnapshot?.public_bets_pct_home;
          const a = oddsSnapshot?.public_bets_pct_away;
          if (h == null || a == null) return null;
          if (h - a > 15) return 'PUBLIC_HEAVY_HOME';
          if (a - h > 15) return 'PUBLIC_HEAVY_AWAY';
          return 'BALANCED';
        })(),
        sharp_divergence: (() => {
          const circaH = oddsSnapshot?.circa_handle_pct_home;
          const dkH    = oddsSnapshot?.dk_bets_pct_home;
          // Either source absent → null
          if (circaH == null || dkH == null) return null;
          const diff = Math.abs(circaH - dkH);
          if (diff >= 20) return 'SHARP_VS_PUBLIC';
          if (diff < 10)  return 'SHARP_ALIGNED';
          return null; // 10–19 range: inconclusive, emit null
        })(),
        disclaimer:
          'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now,
      };

      cards.push(
        buildMarketCallCard({
          sport: 'NBA',
          gameId,
          cardType: 'nba-totals-call',
          cardTitle: `NBA Totals: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  // SPREAD decision → nba-spread-call
  const spreadDecision = marketDecisions?.SPREAD;
  const nbaSpreadProfile = resolveThresholdProfile({ sport: 'NBA', marketType: 'SPREAD' });
  // WI-0646: use playoff-adjusted spreadLeanMin when provided (isPlayoff=true), else default profile value
  const SPREAD_LEAN_MIN = spreadLeanMin != null ? spreadLeanMin : nbaSpreadProfile.edge.lean_edge_min; // 0.035 via v2 profile
  if (
    spreadDecision &&
    (spreadDecision.status === 'FIRE' || spreadDecision.status === 'WATCH') &&
    (spreadDecision.edge == null || spreadDecision.edge > SPREAD_LEAN_MIN)
  ) {
    const baseConfidence = computePricedCallCardConfidence({
      edgePct: spreadDecision.edge,
      conflictScore: spreadDecision.conflict,
    });
    const marketIntel = applyMarketIntelligenceModifier({
      baseConfidence,
      sharpDivergence: rawMarketIntel.sharp_divergence ?? null,
      splitsDivergence: rawMarketIntel.splits_divergence ?? null,
      edge: spreadDecision.edge,
    });
    const confidence = marketIntel.adjustedConfidence;
    const tier = determineTier(confidence);
    const { side, line } = spreadDecision.best_candidate;
    const spreadPrice =
      side === 'HOME'
        ? (oddsSnapshot?.spread_price_home ?? null)
        : (oddsSnapshot?.spread_price_away ?? null);
    if (spreadPrice != null) {
      const lineText = line != null ? ` ${line > 0 ? '+' + line : line}` : '';
      const pickText = `${side === 'HOME' ? 'Home' : 'Away'}${lineText}`;
      const activeDrivers = (spreadDecision.drivers || [])
        .filter((d) => d.eligible)
        .map((d) => d.driverKey);
      const topDrivers = (spreadDecision.drivers || [])
        .filter((d) => d.eligible)
        .sort((a, b) => Math.abs(b.signal) - Math.abs(a.signal))
        .slice(0, 3)
        .map((d) => ({
          driver: d.driverKey,
          weight: d.weight,
          score: Number(((d.signal + 1) / 2).toFixed(3)),
        }));

      const payloadData = {
        game_id: gameId,
        sport: 'NBA',
        model_version: 'nba-cross-market-v1',
        home_team: oddsSnapshot?.home_team ?? null,
        away_team: oddsSnapshot?.away_team ?? null,
        matchup,
        start_time_utc: oddsSnapshot?.game_time_utc ?? null,
        start_time_local: startTimeLocal,
        timezone,
        countdown,
        prediction: side,
        confidence,
        tier,
        model_status: spreadDecision.model_status ?? 'MODEL_OK',
        recommended_bet_type: 'spread',
        kind: 'PLAY',
        market_type: 'SPREAD',
        selection: {
          side,
          team:
            side === 'HOME'
              ? (oddsSnapshot?.home_team ?? undefined)
              : (oddsSnapshot?.away_team ?? undefined),
        },
        line: line ?? null,
        price: spreadPrice,
        reason_codes: [],
        tags: [],
        consistency: {
          total_bias: totalBias,
        },
        raw_data: {
          market_intel_modifier: buildMarketIntelModifierPayload(marketIntel),
        },
        reasoning: `${pickText}: ${spreadDecision.reasoning}`,
        execution_status: 'EXECUTABLE',
        edge: spreadDecision.edge ?? null,
        edge_pct: spreadDecision.edge ?? null,
        edge_points: spreadDecision.edge_points ?? null,
        p_fair: spreadDecision.p_fair ?? null,
        p_implied: spreadDecision.p_implied ?? null,
        model_prob: spreadDecision.p_fair ?? null,
        projection: {
          total: null,
          margin_home: spreadDecision?.projection?.projected_margin ?? null,
          win_prob_home: null,
        },
        market_context: {
          version: 'v1',
          market_type: 'SPREAD',
          selection_side: side,
          selection_team:
            side === 'HOME'
              ? (oddsSnapshot?.home_team ?? null)
              : (oddsSnapshot?.away_team ?? null),
          projection: {
            margin_home: spreadDecision?.projection?.projected_margin ?? null,
            total: null,
            team_total: null,
            win_prob_home: null,
            score_home: null,
            score_away: null,
          },
          wager: {
            called_line: line ?? null,
            called_price: spreadPrice ?? null,
            line_source: spreadDecision.line_source ?? 'odds_snapshot',
            price_source: spreadDecision.price_source ?? 'odds_snapshot',
          },
        },
        market,
        line_source: spreadDecision.line_source ?? 'odds_snapshot',
        price_source: spreadDecision.price_source ?? 'odds_snapshot',
        pricing_trace: {
          called_market_type: 'SPREAD',
          called_side: side,
          called_line: line ?? null,
          called_price: spreadPrice ?? null,
          line_source: spreadDecision.line_source ?? 'odds_snapshot',
          price_source: spreadDecision.price_source ?? 'odds_snapshot',
          proxy_used: false,
        },
        drivers_active: activeDrivers,
        driver_summary: {
          weights: topDrivers,
          impact_note: 'Cross-market spread decision.',
        },
        ev_passed: spreadDecision.status === 'FIRE',
        odds_context: {
          h2h_home: oddsSnapshot?.h2h_home,
          h2h_away: oddsSnapshot?.h2h_away,
          ...extractSameBookOddsContext(oddsSnapshot),
          spread_home: oddsSnapshot?.spread_home,
          spread_away: oddsSnapshot?.spread_away,
          total: oddsSnapshot?.total,
          spread_price_home: oddsSnapshot?.spread_price_home,
          spread_price_away: oddsSnapshot?.spread_price_away,
          total_price_over: oddsSnapshot?.total_price_over,
          total_price_under: oddsSnapshot?.total_price_under,
          captured_at: oddsSnapshot?.captured_at,
          projection_comparison: spreadDecision.projection_comparison ?? null,
        },
        line_context: buildLineContextPayload(spreadLineContext, side),
        line_delta: spreadLineContext?.delta ?? null,
        line_delta_pct: spreadLineContext?.delta_pct ?? null,
        confidence_pct: Math.round(confidence * 100),
        driver: {
          key: 'cross_market_spread',
          score: spreadDecision.score,
          status: spreadDecision.status,
          inputs: {
            net: spreadDecision.net,
            conflict: spreadDecision.conflict,
            coverage: spreadDecision.coverage,
          },
        },
        splits_divergence: (() => {
          const h = oddsSnapshot?.public_bets_pct_home;
          const a = oddsSnapshot?.public_bets_pct_away;
          if (h == null || a == null) return null;
          if (h - a > 15) return 'PUBLIC_HEAVY_HOME';
          if (a - h > 15) return 'PUBLIC_HEAVY_AWAY';
          return 'BALANCED';
        })(),
        sharp_divergence: (() => {
          const circaH = oddsSnapshot?.circa_handle_pct_home;
          const dkH    = oddsSnapshot?.dk_bets_pct_home;
          // Either source absent → null
          if (circaH == null || dkH == null) return null;
          const diff = Math.abs(circaH - dkH);
          if (diff >= 20) return 'SHARP_VS_PUBLIC';
          if (diff < 10)  return 'SHARP_ALIGNED';
          return null; // 10–19 range: inconclusive, emit null
        })(),
        disclaimer:
          'Analysis provided for educational purposes. Not a recommendation.',
        generated_at: now,
      };

      cards.push(
        buildMarketCallCard({
          sport: 'NBA',
          gameId,
          cardType: 'nba-spread-call',
          cardTitle: `NBA Spread: ${pickText}`,
          payloadData,
          now,
          expiresAt,
        }),
      );
    }
  }

  return cards;
}

/**
 * Main job entrypoint
 * @param {object} options
 * @param {string|null} options.jobKey - Deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 */
async function runNBAModel({ jobKey = null, dryRun = false, withoutOddsMode = process.env.ENABLE_WITHOUT_ODDS_MODE === 'true' } = {}) {
  const jobRunId = `job-nba-model-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NBAModel] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[NBAModel] Job key: ${jobKey}`);
  if (withoutOddsMode) {
    console.log('[NBAModel] WITHOUT_ODDS_MODE=true — projection-floor lines, PROJECTION_ONLY cards, no settlement');
  }
  console.log(`[NBAModel] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[NBAModel] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(
        `[NBAModel] 🔍 DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun('run_nba_model', jobRunId, jobKey);

      const db = getDatabase();
      // WI-0552: Compute empirical sigma from settled game history at job start.
      // Falls back to hardcoded defaults when fewer than 20 settled games exist.
      const computedSigma = edgeCalculator.computeSigmaFromHistory({
        sport: 'NBA',
        db,
      });
      console.log('[run_nba_model] sigma:', JSON.stringify(computedSigma));
      console.log(`[SIGMA_SOURCE] sport=NBA source=${computedSigma.sigma_source} games_sampled=${computedSigma.games_sampled ?? null}`);
      // WI-0814: warn when using uncalibrated sigma — all PLAY cards will be downgraded to LEAN
      if (computedSigma.sigma_source === 'fallback') {
        console.warn(
          '[run_nba_model] [SIGMA_FALLBACK] Fewer than 20 settled games — using uncalibrated sigma defaults. ' +
          'All PLAY cards will be downgraded to LEAN until empirical sigma is available.',
        );
      }
      // WI-1023: Compute vol_env sigma multipliers from empirical RMSE buckets
      const volEnvSigmaConfig = computeVolEnvSigmaMultipliers({ db });
      console.log(formatVolEnvSigmaLog(volEnvSigmaConfig));
      const leagueBaselines = computeNbaLeagueBaselines({ db });
      setNbaLeagueBaselinesForRun({
        paceMin: leagueBaselines.paceMin,
        paceMax: leagueBaselines.paceMax,
        leagueMedianOffEff: leagueBaselines.medianOffEff,
      });
      const rollingBias = computeNbaRollingBias({ db, windowGames: 50 });

      const { DateTime } = require('luxon');
      const nowUtc = DateTime.utc();
      const horizonUtc = nowUtc.plus({ hours: 36 }).toISO();
      console.log('[NBAModel] Fetching odds for upcoming NBA games...');
      const oddsSnapshots = getOddsWithUpcomingGames(
        'NBA',
        nowUtc.toISO(),
        horizonUtc,
      );

      if (oddsSnapshots.length === 0) {
        if (!withoutOddsMode) {
          console.log('[NBAModel] No upcoming NBA games found, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
        // Without-Odds-Mode: no odds_snapshots but games exist — synthesize from games table
        console.log('[NBAModel] WITHOUT_ODDS_MODE: no odds snapshots, building synthetic snapshots from games table');
        oddsSnapshots.push(...getUpcomingGamesAsSyntheticSnapshots('NBA', nowUtc.toISO(), horizonUtc));
        if (oddsSnapshots.length === 0) {
          console.log('[NBAModel] No upcoming NBA games found in games table, exiting.');
          markJobRunSuccess(jobRunId);
          return { success: true, jobRunId, cardsGenerated: 0 };
        }
      }

      console.log(`[NBAModel] Found ${oddsSnapshots.length} odds snapshots`);
      if (!ENABLE_WELCOME_HOME) {
        console.log(
          '[NBAModel] Welcome Home driver disabled (ENABLE_WELCOME_HOME=false)',
        );
      }

      // Dedupe: latest snapshot per game
      const gameOdds = {};
      oddsSnapshots.forEach((snap) => {
        if (
          !gameOdds[snap.game_id] ||
          snap.captured_at > gameOdds[snap.game_id].captured_at
        ) {
          gameOdds[snap.game_id] = snap;
        }
      });

      const gameIds = Object.keys(gameOdds);
      console.log(
        `[NBAModel] Running NBA driver inference on ${gameIds.length} games...`,
      );

      let cardsGenerated = 0;
      let cardsFailed = 0;
      let gatedCount = 0;
      let blockedCount = 0;
      let projectionBlockedCount = 0;
      const gamePipelineStates = {};
      const errors = [];
      const espnNullRegistry = new Map();

      for (const gameId of gameIds) {
        try {
          let oddsSnapshot = gameOdds[gameId];

          // Enrich with ESPN team metrics
          oddsSnapshot = await enrichOddsSnapshotWithEspnMetrics(oddsSnapshot);

          const normalizedRawData = normalizeRawDataPayload(
            oddsSnapshot.raw_data,
          );
          oddsSnapshot.raw_data = normalizedRawData;

          // Persist enrichment to database so models have access to ESPN metrics
          try {
            updateOddsSnapshotRawData(oddsSnapshot.id, normalizedRawData);
          } catch (persistError) {
            console.log(
              `  [warn] ${gameId}: Failed to persist enrichment payload (${persistError.message})`,
            );
          }

          // WI-0768: Fetch team_metrics_cache; compute and blend pace-anchor total
          const teamCtx = await applyNbaTeamContext(gameId, oddsSnapshot, {
            rollingBias,
          });
          recordEspnNullTeams({
            sport: 'NBA',
            registry: espnNullRegistry,
            nullMetricTeams: teamCtx.nullMetricTeams || [],
          });
          // Re-persist raw_data if context enriched it with pace_anchor_total
          if (teamCtx.available) {
            try {
              updateOddsSnapshotRawData(oddsSnapshot.id, oddsSnapshot.raw_data);
            } catch (persistError) {
              console.log(
                `  [warn] ${gameId}: Failed to persist team context enrichment (${persistError.message})`,
              );
            }
          }

          // WI-1024: Compute per-game residual correction after rolling bias.
          // Guard: rollingBias must be a number (WI-1020 active) before calling residual.
          let nbaResidualResult = { correction: 0, source: 'none', samples: 0, segment: 'none', shrinkage_factor: 0 };
          const rollingBiasValue = rollingBias?.bias;
          if (!Number.isFinite(rollingBiasValue)) {
            console.log('[NBAModel] [RESIDUAL] skipped: WI-1020 rolling bias unavailable');
          } else {
            const residualPaceTier = derivePaceTier(oddsSnapshot.raw_data, leagueBaselines);
            const residualTotalBand = deriveTotalBand(toFiniteNumberOrNull(oddsSnapshot?.total));
            const residualMonth = oddsSnapshot.game_time_utc
              ? String(new Date(oddsSnapshot.game_time_utc).getUTCMonth() + 1).padStart(2, '0')
              : null;
            nbaResidualResult = await computeNbaResidualCorrection({
              db,
              homeTeam: oddsSnapshot.home_team,
              awayTeam: oddsSnapshot.away_team,
              paceTier: residualPaceTier,
              totalBand: residualTotalBand,
              month: residualMonth,
              globalBias: rollingBiasValue,
            });
            // Enforce combined ceiling: scale only residual, preserve rollingBias
            const combinedBeforeCeiling = rollingBiasValue + nbaResidualResult.correction;
            if (Math.abs(combinedBeforeCeiling) > 6.0) {
              const bounded = applyNbaResidualCombinedCeiling(rollingBiasValue, nbaResidualResult.correction);
              nbaResidualResult = { ...nbaResidualResult, correction: bounded };
            }
          }

          // WI-1025: Compute rest days here so regime detection can use them in sigma chain
          // (moved earlier than WI-0836 original placement to enable pre-sigma regime detection)
          const _homeRestResult = computeRestDays(oddsSnapshot.home_team, 'nba', oddsSnapshot.game_time_utc);
          const _awayRestResult = computeRestDays(oddsSnapshot.away_team, 'nba', oddsSnapshot.game_time_utc);

          // WI-0646: Detect playoff game and apply threshold overrides
          const isPlayoff = isPlayoffGame(oddsSnapshot);
          if (isPlayoff) console.log(`[PLAYOFF_MODE] gameId: ${gameId}`);
          let effectiveSigma = isPlayoff
            ? applyPlayoffSigmaMultiplier(computedSigma, PLAYOFF_SIGMA_MULTIPLIER)
            : computedSigma;
          // WI-1023: Apply vol_env sigma multiplier after playoff adjustment
          const volEnvFromSigma = deriveVolEnv(effectiveSigma?.total);
          if (volEnvFromSigma) {
            effectiveSigma = applyVolEnvSigmaMultiplier(
              effectiveSigma,
              volEnvFromSigma,
              volEnvSigmaConfig,
            );
          }
          // WI-1025: Regime detection — apply after vol_env sigma, before effectiveSigma is used downstream
          const nbaRegime = detectNbaRegime({
            homeTeam: oddsSnapshot.home_team,
            awayTeam: oddsSnapshot.away_team,
            restDaysHome: _homeRestResult.restDays,
            restDaysAway: _awayRestResult.restDays,
            availabilityGate: teamCtx.availabilityGate ?? null,
            teamMetricsHome: teamCtx.teamMetricsHome ?? null,
            teamMetricsAway: teamCtx.teamMetricsAway ?? null,
            gameDate: oddsSnapshot.game_time_utc,
          });
          // Clamp combined sigma chain (playoff x vol_env x regime) to [0.60, 2.00] of computedSigma
          const SIGMA_CHAIN_MIN = 0.60;
          const SIGMA_CHAIN_MAX = 2.00;
          const rawRegimeSigmaMultiplier = nbaRegime.modifiers.sigmaMultiplier;
          const chainMultiplierTotal = computedSigma.total > 0
            ? (effectiveSigma.total / computedSigma.total) * rawRegimeSigmaMultiplier
            : rawRegimeSigmaMultiplier;
          const chainMultiplierMargin = computedSigma.margin > 0
            ? (effectiveSigma.margin / computedSigma.margin) * rawRegimeSigmaMultiplier
            : rawRegimeSigmaMultiplier;
          const clampedMultiplierTotal = Math.min(SIGMA_CHAIN_MAX, Math.max(SIGMA_CHAIN_MIN, chainMultiplierTotal));
          const clampedMultiplierMargin = Math.min(SIGMA_CHAIN_MAX, Math.max(SIGMA_CHAIN_MIN, chainMultiplierMargin));
          effectiveSigma = {
            ...effectiveSigma,
            total: computedSigma.total * clampedMultiplierTotal,
            margin: computedSigma.margin * clampedMultiplierMargin,
          };
          console.log(`  [NBA_REGIME] ${gameId}: regime=${nbaRegime.regime} tags=[${nbaRegime.tags.join(',')}] sigmaMultiplier=${rawRegimeSigmaMultiplier} clampedTotal=${clampedMultiplierTotal.toFixed(3)}`);
          // WI-1025: Apply paceMultiplier to paceAnchorTotal before market blending.
          const regimePaceMultiplier = nbaRegime.modifiers.paceMultiplier;
          const injuryReductionApplied =
            toFiniteNumberOrNull(teamCtx?.availabilityGate?.injuryProjectionReduction?.reduction_applied) ?? 0;
          const preBlendRegimeTotal = applyRegimePaceToBlendedTotal({
            marketTotal: oddsSnapshot?.total,
            paceAnchorTotal: teamCtx?.paceAnchorTotal,
            regimePaceMultiplier,
            injuryProjectionReduction: injuryReductionApplied,
          });
          const effectiveBlendedTotal = teamCtx.available && Number.isFinite(preBlendRegimeTotal)
            ? Number(preBlendRegimeTotal.toFixed(2))
            : teamCtx.blendedTotal;
          const effectiveSpreadLeanMin = isPlayoff
            ? (resolveThresholdProfile({ sport: 'NBA', marketType: 'SPREAD' }).edge.lean_edge_min + PLAYOFF_EDGE_MIN_INCREMENT)
            : null; // null = use default from generateNBAMarketCallCards

          const projectionGate = assessProjectionInputs('NBA', oddsSnapshot);
          if (!projectionGate.projection_inputs_complete) {
            projectionBlockedCount++;
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot,
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
              blockingReasonCodes: deriveGameBlockingReasonCodes({
                oddsSnapshot,
                projectionReady: false,
                pricingReady: false,
              }),
            });
            console.log(
              `  [gate] ${gameId}: PROJECTION_INPUTS_INCOMPLETE (${projectionGate.missing_inputs.join(', ')})`,
            );
            continue;
          }

          // Query schedule for Welcome Home Fade
          // Welcome Home Fade: Home team coming back from a road trip (first game back)
          const homeTeamRoadTrip = ENABLE_WELCOME_HOME
            ? getHomeTeamRecentRoadTrip(
                oddsSnapshot.home_team,
                'nba',
                oddsSnapshot.game_time_utc,
                10,
              )
            : [];

          const availabilityGate = teamCtx.availabilityGate || {
            missingFlags: [],
            uncertainFlags: [],
            availabilityFlags: [],
          };
          if (availabilityGate.missingFlags.length > 0) {
            const flaggedPlayers = availabilityGate.availabilityFlags.map((f) => f.player).join(', ');
            console.log(
              `  [availability] ${gameId}: ${availabilityGate.missingFlags.join(', ')}` +
              (flaggedPlayers ? ` (${flaggedPlayers})` : ''),
            );
          }

          const driverCards = computeNBADriverCards(gameId, oddsSnapshot, {
            recentRoadGames: homeTeamRoadTrip,
          });

          if (driverCards.length === 0) {
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot,
              projectionReady: true,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
              blockingReasonCodes: deriveGameBlockingReasonCodes({
                oddsSnapshot,
                projectionReady: true,
                pricingReady: false,
              }),
            });
            console.log(`  [skip] ${gameId}: No actionable NBA driver signals`);
            continue;
          }

          // Only clear/write when we have actionable output; avoids wiping prior cards on transient data gaps.
          // WI-0817: collect types now; deletes are deferred into the per-game write transaction below.
          const driverCardTypesToClear = [
            ...new Set([
              ...NBA_DRIVER_CARD_TYPES,
              ...driverCards.map((card) => card.cardType),
            ]),
          ];

          // WI-0836: Enrich oddsSnapshot with computed rest days before market decisions
          // Note: _homeRestResult and _awayRestResult computed earlier (WI-1025 moved them pre-sigma)
          const enrichedSnapshot = {
            ...oddsSnapshot,
            rest_days_home: _homeRestResult.restDays,
            rest_days_away: _awayRestResult.restDays,
          };
          const nbaMarketDecisions = computeNBAMarketDecisions(enrichedSnapshot);

          // WI-0571: log projection comparison per game
          const totalPC = nbaMarketDecisions?.TOTAL?.projection_comparison;
          const spreadPC = nbaMarketDecisions?.SPREAD?.projection_comparison;
          if (totalPC) {
            console.log(
              `  [proj] ${gameId} TOTAL: consensus edge=${totalPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${totalPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${totalPC.execution_alpha_pts ?? 'n/a'} pts, playable=${totalPC.playable_edge}`,
            );
          }
          if (spreadPC) {
            console.log(
              `  [proj] ${gameId} SPREAD: consensus edge=${spreadPC.edge_vs_consensus_pts ?? 'n/a'} pts, best edge=${spreadPC.edge_vs_best_available_pts ?? 'n/a'} pts, alpha=${spreadPC.execution_alpha_pts ?? 'n/a'} pts, playable=${spreadPC.playable_edge}`,
            );
          }

          const nbaLineContexts = {
            TOTAL: buildMarketLineContext({
              sport: 'NBA',
              gameId,
              marketType: 'TOTAL',
              selectionSide:
                nbaMarketDecisions?.TOTAL?.best_candidate?.side ?? null,
            }),
            SPREAD: buildMarketLineContext({
              sport: 'NBA',
              gameId,
              marketType: 'SPREAD',
              selectionSide:
                nbaMarketDecisions?.SPREAD?.best_candidate?.side ?? null,
            }),
          };
          const nbaExpressionChoice =
            selectExpressionChoice(nbaMarketDecisions);
          const nbaMarketPayload = buildMarketPayload({
            decisions: nbaMarketDecisions,
            expressionChoice: nbaExpressionChoice,
          });

          const cards = driverCards.map((descriptor) =>
            generateCard({
              sport: 'NBA',
              gameId,
              descriptor,
              oddsSnapshot,
              marketPayload: nbaMarketPayload,
              now: new Date().toISOString(),
              expiresAt: null,
              driverWeights: NBA_DRIVER_WEIGHTS,
            }),
          );

          const pendingCards = [];

          for (const card of cards) {
            applyProjectionInputMetadata(card, projectionGate);
            // WI-0768: merge nba_team_context into missing_inputs when cache absent
            if (teamCtx.teamContextMissingInputs.length > 0) {
              card.payloadData.missing_inputs = [
                ...(card.payloadData.missing_inputs || []),
                ...teamCtx.teamContextMissingInputs,
              ];
            }
            applyNbaSettlementMarketContext(card);
            assignExecutionStatus(card, { withoutOddsMode });
            applyDecisionNamespaceMetadata(card);
            // WI-0768: cap execution_status at PROJECTION_ONLY when nba_team_context absent
            if (
              teamCtx.teamContextMissingInputs.length > 0 &&
              card.payloadData.execution_status === 'EXECUTABLE'
            ) {
              card.payloadData.execution_status = 'PROJECTION_ONLY';
            }
            // WI-0841: merge ESPN-derived impact flags and cap tier at LEAN
            applyNbaImpactGateToCard(card, availabilityGate);
            const validation = validateCardPayload(
              card.cardType,
              card.payloadData,
            );
            if (!validation.success) {
              throw new Error(
                `Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`,
              );
            }
            const decisionOutcome = publishDecisionForCard({
              card,
              oddsSnapshot,
              // WI-0591: thread empirical sigma so decisioning uses computed
              // values instead of silently falling back to static defaults.
              // WI-0646: effectiveSigma applies PLAYOFF_SIGMA_MULTIPLIER when isPlayoff.
              options: { sigmaOverride: effectiveSigma },
            });
            
            // WI-0907 Phase 4: Emit reason codes for silent degradation paths (Tasks 1-2)
            if (!Array.isArray(card.payloadData.reason_codes)) {
              card.payloadData.reason_codes = [];
            }
            const reasonSet = new Set(card.payloadData.reason_codes);
            
            // Task 1: ESPN null observation
            if (teamCtx.nullMetricTeams && teamCtx.nullMetricTeams.length > 0) {
              reasonSet.add(WATCHDOG_REASONS.ESPN_NULL_OBSERVATION);
            }
            
            // Task 2: Availability gate degraded
            if (availabilityGate.gateFailedError) {
              reasonSet.add(WATCHDOG_REASONS.AVAILABILITY_GATE_DEGRADED);
            }
            
            card.payloadData.reason_codes = Array.from(reasonSet).sort();
            
            if (decisionOutcome.gated) gatedCount++;
            if (decisionOutcome.gated && !decisionOutcome.allow) {
              blockedCount++;
              console.log(
                `  [gate] ${gameId} [${card.cardType}]: ${decisionOutcome.reasonCode}`,
              );
            }
            assertExecutableCardsArePriced(card);
            attachRunId(card, jobRunId);
            // WI-0836: rest signal observability
            if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
            card.payloadData.raw_data.rest_days_home = _homeRestResult.restDays;
            card.payloadData.raw_data.rest_days_away = _awayRestResult.restDays;
            card.payloadData.raw_data.rest_source_home = _homeRestResult.restSource;
            card.payloadData.raw_data.rest_source_away = _awayRestResult.restSource;
            // WI-1025: Stamp regime context for observability and downstream traceability
            card.payloadData.raw_data.nba_regime = {
              regime: nbaRegime.regime,
              tags: nbaRegime.tags,
              modifiers: nbaRegime.modifiers,
            };
            card.payloadData.raw_data.residual_correction = {
              correction: nbaResidualResult.correction,
              source: nbaResidualResult.source,
              samples: nbaResidualResult.samples,
              segment: nbaResidualResult.segment,
              shrinkage_factor: nbaResidualResult.shrinkage_factor,
            };
            const tierLabel = card.payloadData.tier
              ? ` [${card.payloadData.tier}]`
              : '';
            pendingCards.push({
              card,
              strictDecisionSnapshot: decisionOutcome.strictDecisionSnapshot,
              logLine: `  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            });
          }

          // Generate and insert NBA market call cards (nba-totals-call, nba-spread-call)
          const nbaMarketCallCards = generateNBAMarketCallCards(
            gameId,
            nbaMarketDecisions,
            oddsSnapshot,
            { withoutOddsMode, lineContexts: nbaLineContexts, spreadLeanMin: effectiveSpreadLeanMin },
          );
          // WI-0817: call card deletes are deferred into the per-game write transaction below.
          for (const card of nbaMarketCallCards) {
            applyProjectionInputMetadata(card, projectionGate);
            // WI-0768: merge nba_team_context into missing_inputs when cache absent
            if (teamCtx.teamContextMissingInputs.length > 0) {
              card.payloadData.missing_inputs = [
                ...(card.payloadData.missing_inputs || []),
                ...teamCtx.teamContextMissingInputs,
              ];
            }
            // WI-0768: apply blended total to nba-totals-call projection fields
            if (
              card.cardType === 'nba-totals-call' &&
              teamCtx.available &&
              Number.isFinite(effectiveBlendedTotal)
            ) {
              // WI-1024: Apply residual correction exactly once, after rolling bias.
              // WI-1025: Use effectiveBlendedTotal (pace-adjusted pre-blend total) as the base.
              const residualCorrection = nbaResidualResult.correction;
              const adjustedTotal = effectiveBlendedTotal + residualCorrection;
              if (card.payloadData?.projection) {
                card.payloadData.projection.total = adjustedTotal;
              }
              if (card.payloadData?.market_context?.projection) {
                card.payloadData.market_context.projection.total = adjustedTotal;
              }
            }
            if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
            card.payloadData.raw_data.residual_correction = {
              correction: nbaResidualResult.correction,
              source: nbaResidualResult.source,
              samples: nbaResidualResult.samples,
              segment: nbaResidualResult.segment,
              shrinkage_factor: nbaResidualResult.shrinkage_factor,
            };
            applyNbaSettlementMarketContext(card);
            assignExecutionStatus(card, { withoutOddsMode });
            applyDecisionNamespaceMetadata(card);
            // WI-0768: cap execution_status at PROJECTION_ONLY when nba_team_context absent
            if (
              teamCtx.teamContextMissingInputs.length > 0 &&
              card.payloadData.execution_status === 'EXECUTABLE'
            ) {
              card.payloadData.execution_status = 'PROJECTION_ONLY';
            }
            // WI-0841: merge ESPN-derived impact flags and cap tier at LEAN
            applyNbaImpactGateToCard(card, availabilityGate);
            const validation = validateCardPayload(
              card.cardType,
              card.payloadData,
            );
            if (!validation.success) {
              throw new Error(
                `Invalid card payload for ${card.cardType}: ${validation.errors.join('; ')}`,
              );
            }
            const decisionOutcome = publishDecisionForCard({
              card,
              oddsSnapshot,
              // WI-0591: thread empirical sigma so decisioning uses computed
              // values instead of silently falling back to static defaults.
              // WI-0646: effectiveSigma applies PLAYOFF_SIGMA_MULTIPLIER when isPlayoff.
              options: { sigmaOverride: effectiveSigma },
            });
            
            // WI-0907 Phase 4: Emit reason codes for silent degradation paths (Tasks 1-2)
            if (!Array.isArray(card.payloadData.reason_codes)) {
              card.payloadData.reason_codes = [];
            }
            const callCardReasonSet = new Set(card.payloadData.reason_codes);
            
            // Task 1: ESPN null observation
            if (teamCtx.nullMetricTeams && teamCtx.nullMetricTeams.length > 0) {
              callCardReasonSet.add(WATCHDOG_REASONS.ESPN_NULL_OBSERVATION);
            }
            
            // Task 2: Availability gate degraded
            if (availabilityGate.gateFailedError) {
              callCardReasonSet.add(WATCHDOG_REASONS.AVAILABILITY_GATE_DEGRADED);
            }

            // Task 3: Line delta computation failure on call-card line context
            if (card.payloadData?.line_context?.computationError) {
              callCardReasonSet.add(WATCHDOG_REASONS.LINE_DELTA_COMPUTATION_FAILED);
            }
            if (!card.payloadData?.line_context) {
              callCardReasonSet.add(WATCHDOG_REASONS.LINE_CONTEXT_MISSING);
            }
            
            card.payloadData.reason_codes = Array.from(callCardReasonSet).sort();
            
            if (decisionOutcome.gated) gatedCount++;
            // Match NHL WI-0940 pattern: after publishDecisionForCard normalizes reason_codes,
            // detect TOTAL card with withoutOddsMode and status=LEAN, then stamp NBA_NO_ODDS_MODE_LEAN
            if (
              card.cardType === 'nba-totals-call' &&
              withoutOddsMode &&
              card.payloadData?.status === 'LEAN'
            ) {
              if (!Array.isArray(card.payloadData.reason_codes)) {
                card.payloadData.reason_codes = [];
              }
              if (!card.payloadData.reason_codes.includes('NBA_NO_ODDS_MODE_LEAN')) {
                card.payloadData.reason_codes.push('NBA_NO_ODDS_MODE_LEAN');
              }
              if (card.payloadData.decision_v2) {
                card.payloadData.decision_v2.official_status = 'LEAN';
                if (!card.payloadData.decision_v2.primary_reason_code) {
                  card.payloadData.decision_v2.primary_reason_code = 'NBA_NO_ODDS_MODE_LEAN';
                }
              }
              syncCanonicalDecisionEnvelope(card.payloadData, {
                official_status: 'LEAN',
                primary_reason_code:
                  card.payloadData.decision_v2?.primary_reason_code || 'NBA_NO_ODDS_MODE_LEAN',
                execution_status: 'PROJECTION_ONLY',
                publish_ready: false,
              });
            }
            const executionGateOutcome = applyExecutionGateToNbaCard(card, {
              oddsSnapshot,
            });
            if (executionGateOutcome.blocked) {
              console.log(
                `  [execution-gate] ${gameId} [${card.cardType}]: ${card.payloadData.pass_reason_code}`,
              );
              if (
                Array.isArray(card.payloadData?.execution_gate?.blocked_by) &&
                card.payloadData.execution_gate.blocked_by.includes('CALIBRATION_KILL_SWITCH')
              ) {
                console.log('[NBA_MODEL] %s blocked: CALIBRATION_KILL_SWITCH', jobKey || gameId);
              }
            }
            assertExecutableCardsArePriced(card);
            attachRunId(card, jobRunId);
            // WI-0836: rest signal observability
            if (!card.payloadData.raw_data) card.payloadData.raw_data = {};
            card.payloadData.raw_data.rest_days_home = _homeRestResult.restDays;
            card.payloadData.raw_data.rest_days_away = _awayRestResult.restDays;
            card.payloadData.raw_data.rest_source_home = _homeRestResult.restSource;
            card.payloadData.raw_data.rest_source_away = _awayRestResult.restSource;
            // WI-1025: Stamp regime context for observability and downstream traceability
            card.payloadData.raw_data.nba_regime = {
              regime: nbaRegime.regime,
              tags: nbaRegime.tags,
              modifiers: nbaRegime.modifiers,
            };
            const tierLabel = card.payloadData.tier
              ? ` [${card.payloadData.tier}]`
              : '';
            pendingCards.push({
              card,
              strictDecisionSnapshot: executionGateOutcome.strictDecisionSnapshot,
              logLine: `  [ok] ${gameId} [${card.cardType}]${tierLabel}: ${card.payloadData.prediction} (${(card.payloadData.confidence * 100).toFixed(0)}%)`,
            });
          }

          const featureTimelinessOutcome = applyNbaFeatureTimelinessGuardToCards(
            pendingCards.map((entry) => entry.card),
            {
              rawData: oddsSnapshot.raw_data ?? {},
              betPlacedAt: oddsSnapshot.captured_at ?? null,
              gameId,
            },
          );
          if (featureTimelinessOutcome.evaluated) {
            for (const entry of pendingCards) {
              entry.strictDecisionSnapshot = capturePublishedDecisionState(entry.card.payloadData);
            }
          }
          const pricingReady = pendingCards.some((entry) =>
            canPriceCard(entry.card),
          );
          const pipelineState = buildGamePipelineState({
            oddsSnapshot,
            projectionReady: true,
            driversReady: true,
            pricingReady,
            cardReady: pendingCards.length > 0,
            blockingReasonCodes: deriveGameBlockingReasonCodes({
              oddsSnapshot,
              projectionReady: true,
              pricingReady,
              cards: pendingCards.map((entry) => entry.card),
            }),
          });
          gamePipelineStates[gameId] = pipelineState;

          // WI-0835: annotate sigma provenance on all pending card payloads before write.
          for (const entry of pendingCards) {
            if (!entry.card.payloadData.raw_data) entry.card.payloadData.raw_data = {};
            entry.card.payloadData.raw_data.sigma_source = computedSigma.sigma_source;
            entry.card.payloadData.raw_data.sigma_games_sampled = computedSigma.games_sampled ?? null;
            stampNbaProjectionAccuracyFields(entry.card, {
              oddsSnapshot,
              effectiveSigma,
              volEnv: volEnvFromSigma,
              availabilityGate,
              leagueBaselines,
            });
            entry.card.payloadData.raw_data.calibration_state =
              teamCtx.calibrationState || normalizeNbaCalibrationState(rollingBias);
          }

          // WI-0831: apply isotonic calibration to fair_prob before Kelly and card write.
          const NBA_MARKET_CAL_KEY = Object.freeze({
            TOTAL: 'NBA_TOTAL',
            SPREAD: 'SPREAD',
          });
          let _calStmtNba = null;
          try {
            _calStmtNba = getDatabase().prepare(
              'SELECT breakpoints_json FROM calibration_models WHERE sport = ? AND market_type = ?',
            );
          } catch (_e) {
            console.log('[CAL_APPLY] NBA calibration_models table not ready — using raw');
          }
          for (const entry of pendingCards) {
            const pd = entry.card.payloadData;
            if (Number.isFinite(pd.p_fair)) {
              const mType = String(pd.market_type || '').toUpperCase();
              const calKey = NBA_MARKET_CAL_KEY[mType] ?? null;
              let breakpoints = null;
              if (_calStmtNba && calKey) {
                try {
                  const calRow = _calStmtNba.get('NBA', calKey);
                  breakpoints = calRow ? JSON.parse(calRow.breakpoints_json) : null;
                } catch (_e) { /* table missing or parse error — use raw */ }
              }
              const { calibratedProb, calibrationSource } = applyCalibration(pd.p_fair, breakpoints);
              pd.p_fair = calibratedProb;
              if (!pd.raw_data) pd.raw_data = {};
              pd.raw_data.calibration_source = calibrationSource;
            }
          }

          // WI-0819: attach advisory Kelly stake fraction to PLAY/LEAN cards.
          for (const entry of pendingCards) {
            const pd = entry.card.payloadData;
            const officialStatus = pd.decision_v2?.official_status;
            if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
              const { kelly_fraction, kelly_units } = kellyStake(pd.p_fair, pd.price);
              pd.kelly_fraction = kelly_fraction;
              pd.kelly_units = kelly_units;
            } else {
              pd.kelly_fraction = null;
              pd.kelly_units = null;
            }
          }

          // WI-0817: atomic write phase — all deletes + all inserts in one transaction.
          // A crash or throw inside this block rolls back automatically; old cards survive intact.
          runPerGameWriteTransaction(() => {
            for (const ct of driverCardTypesToClear) {
              prepareModelAndCardWrite(gameId, 'nba-drivers-v1', ct, { runId: jobRunId });
            }
            if (nbaMarketCallCards.length > 0) {
              for (const ct of ['nba-totals-call', 'nba-spread-call']) {
                prepareModelAndCardWrite(gameId, 'nba-cross-market-v1', ct, { runId: jobRunId });
              }
            }
            for (const entry of pendingCards) {
              entry.card.payloadData.pipeline_state = pipelineState;
              assertNoDecisionMutation(
                entry.card.payloadData,
                entry.strictDecisionSnapshot,
                { label: `${entry.card.cardType}:before_insert` },
              );
              insertCardPayload(entry.card);
            }
          });
          for (const entry of pendingCards) {
            cardsGenerated++;
            console.log(entry.logLine);
          }
        } catch (gameError) {
          if (gameError.message.startsWith('Invalid card payload'))
            throw gameError;
          cardsFailed++;
          if (!gamePipelineStates[gameId]) {
            gamePipelineStates[gameId] = buildGamePipelineState({
              oddsSnapshot: gameOdds[gameId],
              projectionReady: false,
              driversReady: false,
              pricingReady: false,
              cardReady: false,
            });
          }
          errors.push(`${gameId}: ${gameError.message}`);
          console.error(`  [err] ${gameId}: ${gameError.message}`);
        }
      }

      const summary = {
        cardsGenerated,
        cardsFailed,
        errors,
        pipeline_states: gamePipelineStates,
      };

      markJobRunSuccess(jobRunId, summary);
      try {
        setCurrentRunId(jobRunId, 'nba');
      } catch (runStateError) {
        console.error(
          `[NBAModel] Failed to update run state: ${runStateError.message}`,
        );
      }
      await sendEspnNullDiscordAlert({
        sport: 'NBA',
        nullMetricTeams: [...espnNullRegistry.values()],
      });
      console.log(
        `[NBAModel] ✅ Job complete: ${cardsGenerated} cards generated, ${cardsFailed} failed`,
      );
      console.log(
        `[NBAModel] Decision gate: ${gatedCount} gated, ${blockedCount} blocked`,
      );
      if (projectionBlockedCount > 0) {
        console.log(
          `[NBAModel] Projection input gate: ${projectionBlockedCount}/${gameIds.length} games blocked`,
        );
      }
      console.log(
        `[NBAModel] Pipeline states: ${JSON.stringify(gamePipelineStates)}`,
      );
      if (errors.length > 0)
        errors.forEach((err) => console.error(`  - ${err}`));

      return { success: true, jobRunId, ...summary };
    } catch (error) {
      console.error(`[NBAModel] ❌ Job failed:`, error.message);
      console.error(error.stack);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (_) {}
      return { success: false, jobRunId, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  runNBAModel()
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = {
  runNBAModel,
  buildNbaAvailabilityGate,
  applyNbaImpactGateToCard,
  extractNbaEspnNullMetricTeams,
  recordEspnNullTeams,
  sendEspnNullDiscordAlert,
  generateNBAMarketCallCards,
  applyMarketIntelligenceModifier,
  deriveExecutionStatusForCard,
  applyExecutionGateToNbaCard,
  applyPlayoffSigmaMultiplier,
  applyNbaFeatureTimelinessGuardToCards,
  stampNbaProjectionAccuracyFields,
  applyNbaTeamContext,
  computeNbaRollingBias,
  applyRegimePaceToBlendedTotal,
  deriveTotalBand,
  computeVolEnvSigmaMultipliers,
  applyVolEnvSigmaMultiplier,
  formatVolEnvSigmaLog,
  deriveVolEnv,
};
