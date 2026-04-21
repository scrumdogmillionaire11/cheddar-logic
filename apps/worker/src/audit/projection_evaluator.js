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
  MLB_F5_ML: Object.freeze({
    max_mae: 0.25,
    max_abs_bias: 0.12,
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

/**
 * Proxy lines per card family.
 *   MLB_F5_TOTAL  → 3.5 and 4.5 (two most common F5 market anchors)
 *   NHL_1P_TOTAL  → 1.5 only (canonical market; always half-integer, no pushes)
 */
const PROXY_LINES_BY_FAMILY = Object.freeze({
  MLB_F5_TOTAL: [3.5, 4.5],
  MLB_F5_ML: [0.5],
  NHL_1P_TOTAL: [1.5],
});

/**
 * Pass band and tier thresholds (based on abs(edge_vs_line)).
 */
const PROXY_TIER_BANDS = [
  { min: 0,    max: 0.25,       tier: 'PASS',   bucket: 'MICRO'  },
  { min: 0.25, max: 0.50,       tier: 'LEAN',   bucket: 'SMALL'  },
  { min: 0.50, max: 0.75,       tier: 'PLAY',   bucket: 'MEDIUM' },
  { min: 0.75, max: Infinity,   tier: 'STRONG', bucket: 'LARGE'  },
];

const PROXY_TIER_WEIGHTS = Object.freeze({
  LEAN:   1.0,
  PLAY:   1.5,
  STRONG: 2.0,
});

const MONEYLINE_PROXY_TIER_BANDS = [
  { min: 0,    max: 0.02,       tier: 'PASS',   bucket: 'MICRO'  },
  { min: 0.02, max: 0.05,       tier: 'LEAN',   bucket: 'SMALL'  },
  { min: 0.05, max: 0.08,       tier: 'PLAY',   bucket: 'MEDIUM' },
  { min: 0.08, max: Infinity,   tier: 'STRONG', bucket: 'LARGE'  },
];

/**
 * Maps card_type (DB column in card_payloads) to card_family (PROXY_LINES_BY_FAMILY key).
 * WI-0866 must import this and use CARD_TYPE_TO_FAMILY[card.card_type] to derive card_family.
 */
const CARD_TYPE_TO_FAMILY = Object.freeze({
  'mlb-f5':      'MLB_F5_TOTAL',
  'mlb-f5-ml':   'MLB_F5_ML',
  'nhl-pace-1p': 'NHL_1P_TOTAL',
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

function normalizeProbability(value) {
  const parsed = toNumber(value);
  if (parsed === null) return null;
  const probability = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return probability >= 0 && probability <= 1 ? probability : null;
}

function normalizeMoneylineSide(value) {
  const token = toUpperToken(value);
  if (token === 'HOME' || token === 'H') return 'HOME';
  if (token === 'AWAY' || token === 'A') return 'AWAY';
  return null;
}

function normalizeMoneylineConfidenceBucket(value, score = null) {
  const token = toUpperToken(value);
  if (token === 'HIGH' || token === 'MED' || token === 'LOW') return token;
  const parsedScore = toNumber(score);
  if (parsedScore === null) return null;
  const pct = parsedScore <= 1 ? parsedScore * 100 : parsedScore;
  if (pct >= 70) return 'HIGH';
  if (pct >= 55) return 'MED';
  return 'LOW';
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

function resolveMoneylineSelectedSideFromPayload(payload = {}) {
  return normalizeMoneylineSide(
    getPayloadValue(payload, ['selection', 'side']) ||
      getPayloadValue(payload, ['play', 'selection', 'side']) ||
      getPayloadValue(payload, ['market_context', 'selection_side']) ||
      getPayloadValue(payload, ['canonical_envelope_v2', 'selection_side']) ||
      getPayloadValue(payload, ['decision_v2', 'selection_side']) ||
      payload.prediction,
  );
}

function resolveSelectedSideWinProbability(payload = {}, selectedSide = null) {
  const selectedProbability = normalizeProbability(firstFiniteNumber(
    getPayloadValue(payload, ['projection_accuracy', 'win_probability']),
    payload.win_probability,
    payload.p_fair,
    payload.fair_prob,
    payload.model_prob,
  ));
  if (selectedProbability !== null) return selectedProbability;

  const homeProbability = normalizeProbability(firstFiniteNumber(
    getPayloadValue(payload, ['projection', 'projected_win_prob_home']),
    getPayloadValue(payload, ['drivers', '0', 'projected_win_prob_home']),
    getPayloadValue(payload, ['drivers', '0', 'win_prob_home']),
  ));
  if (homeProbability === null) return null;
  const side = normalizeMoneylineSide(selectedSide);
  if (side === 'HOME') return homeProbability;
  if (side === 'AWAY') return round(1 - homeProbability, 6);
  return null;
}

function resolveMoneylineConfidenceBucket(row = {}) {
  const payload = row?.payload || {};
  return normalizeMoneylineConfidenceBucket(
    row.confidence_bucket ??
      row.confidence_band ??
      payload.confidence_bucket ??
      payload.confidence_band ??
      getPayloadValue(payload, ['projection_accuracy', 'confidence_band']),
    row.confidence_score ??
      payload.confidence_score ??
      getPayloadValue(payload, ['projection_accuracy', 'confidence_score']),
  ) ?? 'LOW';
}

function resolvePredictionValue(row) {
  const payload = row?.payload || {};
  if (row?.card_family === 'MLB_F5_ML') {
    return resolveSelectedSideWinProbability(
      payload,
      resolveMoneylineSelectedSideFromPayload(payload),
    );
  }
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
  if (row?.card_family === 'MLB_F5_ML') {
    return resolveMoneylineSelectedSideFromPayload(payload);
  }
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

function resolveMlbF5MlActualValue(row) {
  const direct = toNumber(row?.actual_value);
  if (direct !== null) return direct;
  try {
    const parsed = JSON.parse(row?.actual_result || '{}');
    const actual = toNumber(parsed?.f5_ml_actual);
    if (actual !== null) return actual;
    const winner = toUpperToken(parsed?.f5_winner);
    const selectedSide = normalizeMoneylineSide(parsed?.selected_side) ??
      resolveMoneylineSelectedSideFromPayload(row?.payload || {});
    if (winner === 'PUSH') return 0.5;
    if ((winner === 'HOME' || winner === 'AWAY') && selectedSide) {
      return winner === selectedSide ? 1 : 0;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveMlbPitcherKActualValue(row) {
  try {
    const parsed = JSON.parse(row?.actual_result || '{}');
    return toNumber(parsed?.pitcher_ks);
  } catch {
    return null;
  }
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
    case 'MLB_F5_ML':
      return resolveMlbF5MlActualValue(row);
    case 'MLB_PITCHER_K':
      return resolveMlbPitcherKActualValue(row);
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
    if (row?.card_family === 'MLB_F5_ML' && (direction === 'HOME' || direction === 'AWAY')) {
      if (actual !== 0.5) {
        metrics.directional_sample_count += 1;
      }
      if (actual > 0.5) {
        directionCorrectCount += 1;
      }
    } else if (direction === 'OVER' || direction === 'UNDER') {
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

// ── Proxy-line grading functions (WI-0865) ────────────────────────────────────

/**
 * Classify a signed edge (proj_value - proxy_line) into tier, side, and bucket.
 * Returns { recommended_side, tier, confidence_bucket }.
 */
function classifyProxyEdge(edgeVsLine) {
  const absEdge = Math.abs(edgeVsLine);
  const band = PROXY_TIER_BANDS.find(
    (b) => absEdge >= b.min && absEdge < b.max,
  ) || PROXY_TIER_BANDS[PROXY_TIER_BANDS.length - 1];

  if (band.tier === 'PASS') {
    return { recommended_side: 'PASS', tier: 'PASS', confidence_bucket: 'MICRO' };
  }
  return {
    recommended_side: edgeVsLine > 0 ? 'OVER' : 'UNDER',
    tier: band.tier,
    confidence_bucket: band.bucket,
  };
}

function classifyMoneylineProxyEdge(edgeVsLine, selectedSide, confidenceBucket = 'LOW') {
  const side = normalizeMoneylineSide(selectedSide);
  const absEdge = Math.abs(edgeVsLine);
  const band = MONEYLINE_PROXY_TIER_BANDS.find(
    (b) => absEdge >= b.min && absEdge < b.max,
  ) || MONEYLINE_PROXY_TIER_BANDS[MONEYLINE_PROXY_TIER_BANDS.length - 1];

  if (!side || band.tier === 'PASS') {
    return { recommended_side: 'PASS', tier: 'PASS', confidence_bucket: confidenceBucket };
  }
  return {
    recommended_side: side === 'HOME' ? 'OVER' : 'UNDER',
    tier: band.tier,
    confidence_bucket: confidenceBucket,
  };
}

/**
 * Grade a proxy market recommendation against actual result.
 * Returns { graded_result, hit_flag }.
 * All proxy lines are half-integers so there are no pushes.
 */
function gradeProxyMarket(recommended_side, actual_value, proxy_line) {
  if (recommended_side === 'PASS') {
    return { graded_result: 'NO_BET', hit_flag: 0 };
  }
  const win =
    recommended_side === 'OVER'
      ? actual_value > proxy_line
      : actual_value < proxy_line;
  return { graded_result: win ? 'WIN' : 'LOSS', hit_flag: win ? 1 : 0 };
}

function gradeMoneylineProxyMarket(recommendedSide, actualValue) {
  if (recommendedSide === 'PASS') {
    return { graded_result: 'NO_BET', hit_flag: 0 };
  }
  if (actualValue === 0.5) return { graded_result: 'PUSH', hit_flag: 0 };
  return actualValue > 0.5
    ? { graded_result: 'WIN', hit_flag: 1 }
    : { graded_result: 'LOSS', hit_flag: 0 };
}

/**
 * Score a single proxy market decision.
 * PASS = 0. WIN = +weight, LOSS = -weight.
 */
function scoreTierResult(tier, graded_result) {
  if (graded_result === 'NO_BET') return 0;
  const weight = PROXY_TIER_WEIGHTS[tier] ?? 0;
  return graded_result === 'WIN' ? weight : -weight;
}

/**
 * Given an array of classified markets for the SAME game, derive agreement_group.
 * markets: array of { recommended_side, tier }
 *
 * CONSENSUS_OVER   — all non-PASS sides are OVER
 * CONSENSUS_UNDER  — all non-PASS sides are UNDER
 * SPLIT            — at least one OVER and one UNDER (both non-PASS)
 * PASS_ONLY        — all markets are PASS
 */
function resolveAgreementGroup(markets) {
  const activeSides = markets
    .map((m) => m.recommended_side)
    .filter((s) => s !== 'PASS');

  if (activeSides.length === 0) return 'PASS_ONLY';
  const uniqueSides = [...new Set(activeSides)];
  if (uniqueSides.length === 1) {
    return uniqueSides[0] === 'OVER' ? 'CONSENSUS_OVER' : 'CONSENSUS_UNDER';
  }
  return 'SPLIT';
}

/**
 * Compute consensus bonus for a game.
 * +1.0 if all non-PASS markets won (CONSENSUS group, all WIN).
 * -1.0 if all non-PASS markets lost (CONSENSUS group, all LOSS).
 * 0 otherwise.
 */
function computeConsensusBonus(markets) {
  const agreementGroup = resolveAgreementGroup(markets);
  if (agreementGroup !== 'CONSENSUS_OVER' && agreementGroup !== 'CONSENSUS_UNDER') {
    return 0;
  }
  const activeGrades = markets
    .filter((m) => m.graded_result !== 'NO_BET')
    .map((m) => m.graded_result);

  if (activeGrades.length === 0) return 0;
  if (activeGrades.every((g) => g === 'WIN')) return 1.0;
  if (activeGrades.every((g) => g === 'LOSS')) return -1.0;
  return 0;
}

/**
 * Build proxy-market evaluation rows for a single settled projection card.
 *
 * @param {object} row - Must have: card_id, game_id, game_date, sport,
 *   card_family, model_projection (numeric), actual_result (JSON string)
 * @returns {Array<object>} Array of proxy eval rows ready for DB insert.
 *   Returns [] if card_family has no proxy lines or projection/actual is null.
 */
function buildProjectionProxyMarketRows(row) {
  const proxyLines = PROXY_LINES_BY_FAMILY[row?.card_family];
  if (!proxyLines || proxyLines.length === 0) return [];

  const projValue = toNumber(row?.model_projection);
  // Parse actual_value from actual_result JSON string (not game_result_metadata).
  // resolveActualValue() reads row.game_result_metadata which does not exist here.
  function resolveProxyActualValue(r) {
    if (r.actual_value != null) return r.actual_value;
    try {
      const p = JSON.parse(r?.actual_result || '{}');
      if (r.card_family === 'MLB_F5_TOTAL') return toNumber(p.runs_f5);
      if (r.card_family === 'MLB_F5_ML') return toNumber(p.f5_ml_actual);
      if (r.card_family === 'NHL_1P_TOTAL') return toNumber(p.goals_1p);
      return null;
    } catch { return null; }
  }
  const actualValue = resolveProxyActualValue(row);

  if (projValue === null || actualValue === null) return [];

  if (row.card_family === 'MLB_F5_ML') {
    const proxyLine = 0.5;
    const selectedSide = normalizeMoneylineSide(row.selected_side ?? row.recommended_side);
    const edgeVsLine = round(projValue - proxyLine, 4);
    const confidenceBucket = resolveMoneylineConfidenceBucket(row);
    const { recommended_side, tier, confidence_bucket } = classifyMoneylineProxyEdge(
      edgeVsLine,
      selectedSide,
      confidenceBucket,
    );
    const { graded_result, hit_flag } = gradeMoneylineProxyMarket(
      recommended_side,
      actualValue,
    );
    return [{
      card_id: row.card_id || row.id,
      game_id: row.game_id,
      game_date: row.game_date,
      sport: row.sport,
      card_family: row.card_family,
      proj_value: projValue,
      actual_value: actualValue,
      proxy_line: proxyLine,
      edge_vs_line: edgeVsLine,
      recommended_side,
      tier,
      confidence_bucket,
      agreement_group: 'DIRECT_SELECTION',
      graded_result,
      hit_flag,
      tier_score: scoreTierResult(tier, graded_result),
      consensus_bonus: 0,
    }];
  }

  // Classify each proxy line
  const classifiedMarkets = proxyLines.map((proxyLine) => {
    const edgeVsLine = round(projValue - proxyLine, 4);
    const { recommended_side, tier, confidence_bucket } = classifyProxyEdge(edgeVsLine);
    const { graded_result, hit_flag } = gradeProxyMarket(
      recommended_side,
      actualValue,
      proxyLine,
    );
    const tier_score = scoreTierResult(tier, graded_result);
    return {
      card_id: row.card_id || row.id,
      game_id: row.game_id,
      game_date: row.game_date,
      sport: row.sport,
      card_family: row.card_family,
      proj_value: projValue,
      actual_value: actualValue,
      proxy_line: proxyLine,
      edge_vs_line: edgeVsLine,
      recommended_side,
      tier,
      confidence_bucket,
      agreement_group: '',   // filled in after all markets computed
      graded_result,
      hit_flag,
      tier_score,
      consensus_bonus: 0,   // filled in after all markets computed
    };
  });

  // Resolve agreement_group and consensus_bonus across all proxy lines for this game
  const agreementGroup = resolveAgreementGroup(classifiedMarkets);
  const consensusBonus = computeConsensusBonus(classifiedMarkets);

  return classifiedMarkets.map((m, i) => ({
    ...m,
    agreement_group: agreementGroup,
    // Only apply consensus_bonus to the first row to avoid double-counting in DB SUM queries.
    // The bonus represents a per-game score, not per-line.
    consensus_bonus: i === 0 ? consensusBonus : 0,
  }));
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
  // New proxy-line grading exports (WI-0865)
  CARD_TYPE_TO_FAMILY,
  classifyProxyEdge,
  gradeProxyMarket,
  scoreTierResult,
  resolveAgreementGroup,
  computeConsensusBonus,
  buildProjectionProxyMarketRows,
  PROXY_LINES_BY_FAMILY,
  PROXY_TIER_BANDS,
};
