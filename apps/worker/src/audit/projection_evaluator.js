'use strict';

const PROJECTION_CALIBRATION_BUCKETS = Object.freeze([
  { label: '0-2', min: 0, max: 2 },
  { label: '2-4', min: 2, max: 4 },
  { label: '4-6', min: 4, max: 6 },
  { label: '6+', min: 6, max: Number.POSITIVE_INFINITY },
]);

const PROJECTION_ALERT_WINDOWS = new Set(['last_200', 'season_to_date']);

const PROJECTION_FAMILY_THRESHOLDS = Object.freeze({
  MLB_F5_TOTAL: Object.freeze({
    max_mae: 1.75,
    max_abs_bias: 0.75,
    min_directional_accuracy: 0.53,
    min_sample_count: 25,
  }),
  MLB_PITCHER_K: Object.freeze({
    max_mae: 2.25,
    max_abs_bias: 0.9,
    min_directional_accuracy: 0.53,
    min_sample_count: 25,
  }),
  NHL_1P_TOTAL: Object.freeze({
    max_mae: 0.85,
    max_abs_bias: 0.4,
    min_directional_accuracy: 0.53,
    min_sample_count: 25,
  }),
  NHL_PLAYER_SHOTS: Object.freeze({
    max_mae: 1.4,
    max_abs_bias: 0.6,
    min_directional_accuracy: 0.53,
    min_sample_count: 25,
  }),
  NHL_PLAYER_SHOTS_1P: Object.freeze({
    max_mae: 0.8,
    max_abs_bias: 0.35,
    min_directional_accuracy: 0.53,
    min_sample_count: 25,
  }),
});

function toUpperToken(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function normalizePlayerName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePeriodToken(value) {
  const token = toUpperToken(value);
  if (!token) return 'FULL_GAME';
  if (token === 'FIRST_PERIOD' || token === 'FIRST_5_INNINGS' || token === '1ST_PERIOD' || token === '1P') {
    return '1P';
  }
  return 'FULL_GAME';
}

function getPayloadValue(payload, path, fallback = null) {
  let current = payload;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return fallback;
    current = current[segment];
  }
  return current === undefined ? fallback : current;
}

function resolvePredictionValue(row) {
  const payload = row?.payload || {};
  return firstFiniteNumber(
    payload.numeric_projection,
    getPayloadValue(payload, ['projection', 'k_mean']),
    getPayloadValue(payload, ['projection', 'total']),
    getPayloadValue(payload, ['projection', 'projected_total']),
    getPayloadValue(payload, ['decision', 'model_projection']),
    getPayloadValue(payload, ['decision', 'projection']),
  );
}

function resolveDirection(row) {
  const payload = row?.payload || {};
  const token = toUpperToken(
    payload.recommended_direction ||
      getPayloadValue(payload, ['play', 'selection', 'side']) ||
      getPayloadValue(payload, ['selection', 'side']) ||
      getPayloadValue(payload, ['play', 'decision_v2', 'direction']) ||
      getPayloadValue(payload, ['decision_v2', 'direction']) ||
      getPayloadValue(payload, ['decision', 'direction']) ||
      payload.prediction,
  );

  if (token === 'OVER' || token === 'UNDER') return token;
  return null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function resolveFirstPeriodTotal(row) {
  const metadata = row?.game_result_metadata;
  if (!metadata || typeof metadata !== 'object') return null;

  const verification =
    metadata.firstPeriodVerification &&
    typeof metadata.firstPeriodVerification === 'object'
      ? metadata.firstPeriodVerification
      : null;
  if (verification && verification.isComplete === false) return null;

  const scoreObjects = [metadata.firstPeriodScores, metadata.first_period_scores];
  for (const scoreObject of scoreObjects) {
    if (!scoreObject || typeof scoreObject !== 'object') continue;
    const home = toNumber(scoreObject.home);
    const away = toNumber(scoreObject.away);
    if (Number.isFinite(home) && Number.isFinite(away)) {
      return home + away;
    }
  }

  return null;
}

function resolvePlayerShotsActualValue(row) {
  const payload = row?.payload || {};
  const metadata = row?.game_result_metadata;
  const playerShots =
    metadata?.playerShots && typeof metadata.playerShots === 'object'
      ? metadata.playerShots
      : null;
  if (!playerShots) return null;

  const period = normalizePeriodToken(
    getPayloadValue(payload, ['play', 'period']) || payload.period,
  );
  const byPlayerId = period === '1P'
    ? playerShots.firstPeriodByPlayerId
    : playerShots.fullGameByPlayerId;
  if (!byPlayerId || typeof byPlayerId !== 'object') return null;

  const playerId = String(
    getPayloadValue(payload, ['play', 'player_id']) || payload.player_id || '',
  ).trim();
  const directById = playerId ? toNumber(byPlayerId[playerId]) : null;
  if (Number.isFinite(directById)) return directById;

  const playerName = normalizePlayerName(
    getPayloadValue(payload, ['play', 'player_name']) || payload.player_name,
  );
  if (!playerName) return null;

  const playerIdByNormalizedName =
    playerShots.playerIdByNormalizedName &&
    typeof playerShots.playerIdByNormalizedName === 'object'
      ? playerShots.playerIdByNormalizedName
      : {};
  const mappedPlayerId = playerIdByNormalizedName[playerName];
  return mappedPlayerId ? toNumber(byPlayerId[String(mappedPlayerId)]) : null;
}

function resolveMlbF5ActualValue(row) {
  return toNumber(row?.game_result_metadata?.f5_total);
}

function resolveActualValue(row) {
  switch (row?.card_family) {
    case 'NHL_1P_TOTAL':
      return resolveFirstPeriodTotal(row);
    case 'NHL_PLAYER_SHOTS':
    case 'NHL_PLAYER_SHOTS_1P':
      return resolvePlayerShotsActualValue(row);
    case 'MLB_F5_TOTAL':
      return resolveMlbF5ActualValue(row);
    case 'MLB_PITCHER_K':
      return null;
    default:
      return null;
  }
}

function buildEmptyProjectionMetrics(cardFamily) {
  return {
    actuals_available: false,
    bias: null,
    calibration_buckets: PROJECTION_CALIBRATION_BUCKETS.map((bucket) => ({
      avg_actual: null,
      avg_projection: null,
      count: 0,
      label: bucket.label,
    })),
    card_family: cardFamily || 'UNKNOWN',
    directional_accuracy: null,
    directional_sample_count: 0,
    mae: null,
    missing_actual_count: 0,
    missing_projection_count: 0,
    sample_count: 0,
    rows_seen: 0,
  };
}

function buildBucketStates() {
  return PROJECTION_CALIBRATION_BUCKETS.map((bucket) => ({
    ...bucket,
    actualSum: 0,
    count: 0,
    projectionSum: 0,
  }));
}

function bucketForProjection(projection) {
  return PROJECTION_CALIBRATION_BUCKETS.find((bucket) => {
    if (bucket.max === Number.POSITIVE_INFINITY) {
      return projection >= bucket.min;
    }
    return projection >= bucket.min && projection < bucket.max;
  });
}

function finalizeBuckets(bucketStates) {
  return bucketStates.map((bucket) => ({
    avg_actual:
      bucket.count > 0 ? round(bucket.actualSum / bucket.count) : null,
    avg_projection:
      bucket.count > 0 ? round(bucket.projectionSum / bucket.count) : null,
    count: bucket.count,
    label: bucket.label,
  }));
}

function evaluateProjectionRows(rows = [], cardFamily = null) {
  const metrics = buildEmptyProjectionMetrics(cardFamily);
  const bucketStates = buildBucketStates();
  let absErrorSum = 0;
  let signedBiasSum = 0;
  let directionCorrectCount = 0;

  metrics.rows_seen = Array.isArray(rows) ? rows.length : 0;

  for (const row of Array.isArray(rows) ? rows : []) {
    const projection = resolvePredictionValue(row);
    const actual = resolveActualValue(row);

    if (!Number.isFinite(projection)) {
      metrics.missing_projection_count += 1;
      continue;
    }
    if (!Number.isFinite(actual)) {
      metrics.missing_actual_count += 1;
      continue;
    }

    metrics.sample_count += 1;
    absErrorSum += Math.abs(actual - projection);
    signedBiasSum += projection - actual;

    const direction = resolveDirection(row);
    if (direction === 'OVER' || direction === 'UNDER') {
      metrics.directional_sample_count += 1;
      if (
        (direction === 'OVER' && actual >= projection) ||
        (direction === 'UNDER' && actual <= projection)
      ) {
        directionCorrectCount += 1;
      }
    }

    const bucket = bucketForProjection(projection);
    if (!bucket) continue;
    const bucketState = bucketStates.find(
      (candidate) => candidate.label === bucket.label,
    );
    if (!bucketState) continue;
    bucketState.count += 1;
    bucketState.actualSum += actual;
    bucketState.projectionSum += projection;
  }

  if (metrics.sample_count > 0) {
    metrics.actuals_available = true;
    metrics.mae = round(absErrorSum / metrics.sample_count);
    metrics.bias = round(signedBiasSum / metrics.sample_count);
  }
  if (metrics.directional_sample_count > 0) {
    metrics.directional_accuracy = round(
      directionCorrectCount / metrics.directional_sample_count,
    );
  }
  metrics.calibration_buckets = finalizeBuckets(bucketStates);

  return metrics;
}

function getProjectionThresholds(cardFamily) {
  return PROJECTION_FAMILY_THRESHOLDS[cardFamily] || null;
}

function collectProjectionAlerts(segment, windowName) {
  if (!PROJECTION_ALERT_WINDOWS.has(windowName)) return [];
  if (segment?.card_mode !== 'PROJECTION_ONLY') return [];

  const metrics = segment?.projection_metrics;
  const thresholds = getProjectionThresholds(segment?.card_family);
  if (!metrics?.actuals_available || !thresholds) return [];
  if (metrics.sample_count < thresholds.min_sample_count) return [];

  const severity = windowName === 'season_to_date' ? 'CRITICAL' : 'HIGH';
  const baseAlert = {
    card_family: segment.card_family,
    card_mode: segment.card_mode,
    execution_status: segment.execution_status,
    model_version: segment.model_version,
    previous_model_version: segment.previous_model_version,
    sample_count: metrics.sample_count,
    sport: segment.sport,
    window: windowName,
    severity,
  };
  const alerts = [];

  if (
    Number.isFinite(metrics.mae) &&
    metrics.mae > thresholds.max_mae
  ) {
    alerts.push({
      ...baseAlert,
      alert_type: 'PROJECTION_MAE_BREACH',
      threshold: thresholds.max_mae,
      value: metrics.mae,
    });
  }

  if (
    Number.isFinite(metrics.bias) &&
    Math.abs(metrics.bias) > thresholds.max_abs_bias
  ) {
    alerts.push({
      ...baseAlert,
      alert_type: 'PROJECTION_BIAS_BREACH',
      threshold: thresholds.max_abs_bias,
      value: metrics.bias,
    });
  }

  if (
    Number.isFinite(metrics.directional_accuracy) &&
    metrics.directional_sample_count >= thresholds.min_sample_count &&
    metrics.directional_accuracy < thresholds.min_directional_accuracy
  ) {
    alerts.push({
      ...baseAlert,
      alert_type: 'PROJECTION_DIRECTIONAL_ACCURACY_BREACH',
      threshold: thresholds.min_directional_accuracy,
      value: metrics.directional_accuracy,
    });
  }

  return alerts;
}

module.exports = {
  collectProjectionAlerts,
  evaluateProjectionRows,
  getProjectionThresholds,
  PROJECTION_CALIBRATION_BUCKETS,
  PROJECTION_FAMILY_THRESHOLDS,
  resolveActualValue,
  resolveDirection,
  resolvePredictionValue,
};
