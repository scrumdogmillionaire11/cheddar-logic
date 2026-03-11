const edgeCalculator = require('./edge-calculator');

const WAVE1_SPORTS = new Set(['NBA', 'NHL', 'NCAAM']);
const WAVE1_MARKETS = new Set([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
]);

const WATCHDOG_REASONS = {
  CONSISTENCY_MISSING: 'WATCHDOG_CONSISTENCY_MISSING',
  PARSE_FAILURE: 'WATCHDOG_PARSE_FAILURE',
  STALE_SNAPSHOT: 'WATCHDOG_STALE_SNAPSHOT',
  MARKET_UNAVAILABLE: 'WATCHDOG_MARKET_UNAVAILABLE',
};

const PRICE_REASONS = {
  EDGE_CLEAR: 'EDGE_CLEAR',
  NO_EDGE_AT_PRICE: 'NO_EDGE_AT_PRICE',
  MARKET_PRICE_MISSING: 'MARKET_PRICE_MISSING',
  MODEL_PROB_MISSING: 'MODEL_PROB_MISSING',
  MARKET_EDGE_UNAVAILABLE: 'MARKET_EDGE_UNAVAILABLE',
  EXACT_WAGER_MISMATCH: 'EXACT_WAGER_MISMATCH',
  PROXY_EDGE_BLOCKED: 'PROXY_EDGE_BLOCKED',
  PROXY_EDGE_CAPPED: 'PROXY_EDGE_CAPPED',
  NO_PRIMARY_SUPPORT: 'NO_PRIMARY_SUPPORT',
  EDGE_VERIFICATION_REQUIRED: 'EDGE_VERIFICATION_REQUIRED',
};

const PIPELINE_VERSION = 'v2';
const PIPELINE_STATE_STAGES = Object.freeze([
  'ingested',
  'team_mapping_ok',
  'odds_ok',
  'market_lines_ok',
  'projection_ready',
  'drivers_ready',
  'pricing_ready',
  'card_ready',
]);
const EDGE_SANITY_NON_TOTAL_THRESHOLD = 0.2;
const PLAY_EDGE_MIN = 0.06;
const LEAN_EDGE_MIN = 0.03;
const PROXY_SIGNAL_TAGS = new Set([
  'PROXY_MODEL_PROB_INFERRED',
  'PROXY_LEGACY_MARKET_INFERRED',
  'LEGACY_REPAIR',
  'PROXY_CARD',
]);

const FIELD_SOURCES = {
  pace_tier: ['consistency.pace_tier', 'driver.inputs.pace_tier'],
  event_env: ['consistency.event_env', 'driver.inputs.event_env'],
  event_direction_tag: [
    'consistency.event_direction_tag',
    'driver.inputs.event_direction_tag',
  ],
  vol_env: ['consistency.vol_env', 'driver.inputs.vol_env'],
  total_bias: ['consistency.total_bias', 'driver.inputs.total_bias'],
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function asNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function asString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueReasonCodes(...reasonGroups) {
  const merged = [];
  for (const group of reasonGroups) {
    if (!group) continue;
    const items = Array.isArray(group) ? group : [group];
    for (const item of items) {
      const value = asString(item);
      if (value && !merged.includes(value)) {
        merged.push(value);
      }
    }
  }
  return merged;
}

function buildPipelineState(input = {}) {
  return {
    ingested: input.ingested === true,
    team_mapping_ok: input.team_mapping_ok === true,
    odds_ok: input.odds_ok === true,
    market_lines_ok: input.market_lines_ok === true,
    projection_ready: input.projection_ready === true,
    drivers_ready: input.drivers_ready === true,
    pricing_ready: input.pricing_ready === true,
    card_ready: input.card_ready === true,
    blocking_reason_codes: uniqueReasonCodes(input.blocking_reason_codes),
  };
}

function collectDecisionReasonCodes(payload) {
  const decisionV2 = payload?.decision_v2;
  return uniqueReasonCodes(
    decisionV2?.primary_reason_code,
    decisionV2?.watchdog_reason_codes,
    decisionV2?.price_reason_codes,
    payload?.pass_reason_code,
    payload?.gate_reason,
    payload?.reason_codes,
    payload?.pipeline_state?.blocking_reason_codes,
  );
}

function readPath(obj, path) {
  const segments = path.split('.');
  let cursor = obj;
  for (const segment of segments) {
    if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

function normalizeSport(value) {
  const raw = asString(value);
  return raw ? raw.toUpperCase() : '';
}

function normalizeMarketType(value) {
  const raw = asString(value);
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (WAVE1_MARKETS.has(upper)) return upper;
  if (upper === 'ML') return 'MONEYLINE';
  if (upper === 'PUCK_LINE') return 'PUCKLINE';
  if (upper === 'TEAMTOTAL') return 'TEAM_TOTAL';
  return upper;
}

function normalizeDirection(value) {
  const raw = asString(value);
  if (!raw) return 'NONE';
  const upper = raw.toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER'
  ) {
    return upper;
  }
  return 'NONE';
}

function getDirection(payload) {
  const fromSelection = normalizeDirection(payload?.selection?.side);
  if (fromSelection !== 'NONE') return fromSelection;
  const fromPrediction = normalizeDirection(payload?.prediction);
  if (fromPrediction !== 'NONE') return fromPrediction;
  return 'NONE';
}

function detectProxyUsed(payload) {
  if (
    payload?.proxy_used === true ||
    payload?.pricing_trace?.proxy_used === true
  ) {
    return true;
  }

  if (
    Array.isArray(payload?.tags) &&
    payload.tags.some((tag) => PROXY_SIGNAL_TAGS.has(String(tag || '')))
  ) {
    return true;
  }

  const inferenceSource =
    asString(payload?.meta?.inference_source) ||
    asString(payload?.inference_source);
  if (inferenceSource === 'market_fallback') {
    return true;
  }

  if (asString(payload?.driver?.status) === 'fallback') {
    return true;
  }

  if (asString(payload?.driver?.inputs?.fallback_source) === 'market_spread') {
    return true;
  }

  const reasoning = asString(payload?.reasoning);
  if (reasoning && /fallback to market spread proxy/i.test(reasoning)) {
    return true;
  }

  return false;
}

function getSupportAndConflict(payload) {
  const score =
    asNumber(payload?.driver?.score) ??
    asNumber(payload?.expression_choice?.chosen?.score) ??
    asNumber(payload?.all_markets?.TOTAL?.score) ??
    asNumber(payload?.all_markets?.SPREAD?.score) ??
    asNumber(payload?.all_markets?.ML?.score) ??
    0;

  const conflict =
    asNumber(payload?.driver?.inputs?.conflict) ??
    asNumber(payload?.expression_choice?.chosen?.conflict) ??
    asNumber(payload?.all_markets?.TOTAL?.conflict) ??
    asNumber(payload?.all_markets?.SPREAD?.conflict) ??
    asNumber(payload?.all_markets?.ML?.conflict) ??
    0;

  return {
    support_score: clamp(Math.abs(score), 0, 1),
    conflict_score: clamp(conflict, 0, 1),
  };
}

function getDriversUsed(payload) {
  if (Array.isArray(payload?.drivers_active)) {
    return Array.from(
      new Set(
        payload.drivers_active.map((item) => asString(item)).filter(Boolean),
      ),
    );
  }

  const weights = payload?.driver_summary?.weights;
  if (Array.isArray(weights)) {
    return Array.from(
      new Set(
        weights.map((weight) => asString(weight?.driver)).filter(Boolean),
      ),
    );
  }

  const topDrivers = payload?.driver_summary?.top_drivers;
  if (Array.isArray(topDrivers)) {
    return Array.from(
      new Set(
        topDrivers
          .map((driver) => {
            const value = asString(driver);
            if (!value) return null;
            const split = value.split(':')[0];
            return asString(split);
          })
          .filter(Boolean),
      ),
    );
  }

  const fallbackDriver = asString(payload?.driver?.key);
  return fallbackDriver ? [fallbackDriver] : [];
}

function getDriverReasons(payload) {
  const reasons = [];

  const topDrivers = payload?.driver_summary?.top_drivers;
  if (Array.isArray(topDrivers)) {
    for (const entry of topDrivers) {
      if (reasons.length >= 3) break;
      const asText = asString(entry);
      if (asText) reasons.push(asText);
    }
  }

  const weights = payload?.driver_summary?.weights;
  if (Array.isArray(weights) && reasons.length < 3) {
    for (const item of weights) {
      if (reasons.length >= 3) break;
      const key = asString(item?.driver);
      const weight = asNumber(item?.weight);
      if (key) {
        reasons.push(
          weight !== null ? `${key} (weight ${weight.toFixed(2)})` : key,
        );
      }
    }
  }

  const reasoning = asString(payload?.reasoning);
  if (reasoning && reasons.length < 3) {
    const concise = reasoning.split(/[.!?]/)[0]?.trim();
    if (concise) reasons.push(concise);
  }

  return reasons.slice(0, 3);
}

function resolveConsistency(payload) {
  const consistency = {};
  const sourceAttempts = [];
  const missingFields = [];

  for (const [field, sources] of Object.entries(FIELD_SOURCES)) {
    let resolved = null;

    for (const source of sources) {
      const raw = readPath(payload, source);
      const value = asString(raw);
      if (value) {
        resolved = value;
        sourceAttempts.push({
          field,
          source,
          result: 'FOUND',
        });
        break;
      }
      sourceAttempts.push({
        field,
        source,
        result: raw === undefined || raw === null ? 'MISSING' : 'ERROR',
      });
    }

    if (!resolved) {
      consistency[field] = 'MISSING';
      missingFields.push(field);
    } else {
      consistency[field] = resolved;
    }
  }

  return { consistency, sourceAttempts, missingFields };
}

function impliedProbFromAmerican(price) {
  const odds = asNumber(price);
  if (odds === null || odds === 0) return null;
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function getSupportThresholds(marketType) {
  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    return { play: 0.65, lean: 0.5 };
  }
  if (marketType === 'TOTAL' || marketType === 'TEAM_TOTAL') {
    return { play: 0.55, lean: 0.45 };
  }
  return { play: 0.6, lean: 0.45 };
}

function classifyPrice({
  marketType,
  edgePct,
  fairProb,
  impliedProb,
  missingReason = null,
  exactWagerValid = true,
  hasPrimarySupport = true,
  proxyUsed = false,
  proxyAllowed = false,
}) {
  if (missingReason) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [missingReason],
      proxy_capped: false,
    };
  }

  if (!exactWagerValid) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.EXACT_WAGER_MISMATCH],
      proxy_capped: false,
    };
  }

  if (!hasPrimarySupport) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.NO_PRIMARY_SUPPORT],
      proxy_capped: false,
    };
  }

  if (fairProb === null) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.MODEL_PROB_MISSING],
      proxy_capped: false,
    };
  }

  if (impliedProb === null || edgePct === null) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.MARKET_PRICE_MISSING],
      proxy_capped: false,
    };
  }

  if (
    proxyUsed &&
    marketType !== 'TOTAL' &&
    edgePct > EDGE_SANITY_NON_TOTAL_THRESHOLD
  ) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.PROXY_EDGE_BLOCKED],
      proxy_capped: false,
    };
  }

  if (marketType !== 'TOTAL' && edgePct > EDGE_SANITY_NON_TOTAL_THRESHOLD) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.EDGE_VERIFICATION_REQUIRED],
      proxy_capped: false,
    };
  }

  if (proxyUsed && !proxyAllowed) {
    if (edgePct < LEAN_EDGE_MIN) {
      return {
        sharp_price_status: 'COTTAGE',
        price_reason_codes: [
          PRICE_REASONS.PROXY_EDGE_CAPPED,
          PRICE_REASONS.NO_EDGE_AT_PRICE,
        ],
        proxy_capped: true,
      };
    }
    return {
      sharp_price_status: 'CHEDDAR',
      price_reason_codes: [
        PRICE_REASONS.PROXY_EDGE_CAPPED,
        PRICE_REASONS.EDGE_CLEAR,
      ],
      proxy_capped: true,
    };
  }

  if (edgePct < LEAN_EDGE_MIN) {
    return {
      sharp_price_status: 'COTTAGE',
      price_reason_codes: [PRICE_REASONS.NO_EDGE_AT_PRICE],
      proxy_capped: false,
    };
  }

  return {
    sharp_price_status: 'CHEDDAR',
    price_reason_codes: [PRICE_REASONS.EDGE_CLEAR],
    proxy_capped: false,
  };
}

function isHomeAwayDirection(direction) {
  return direction === 'HOME' || direction === 'AWAY';
}

function isOverUnderDirection(direction) {
  return direction === 'OVER' || direction === 'UNDER';
}

function marketRequiresLine(marketType) {
  return (
    marketType === 'SPREAD' ||
    marketType === 'PUCKLINE' ||
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL'
  );
}

function marketRequiresPrice(marketType) {
  return (
    marketType === 'MONEYLINE' ||
    marketType === 'SPREAD' ||
    marketType === 'PUCKLINE' ||
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL'
  );
}

function sideValidForMarket(marketType, direction) {
  if (
    marketType === 'MONEYLINE' ||
    marketType === 'SPREAD' ||
    marketType === 'PUCKLINE'
  ) {
    return isHomeAwayDirection(direction);
  }
  if (marketType === 'TOTAL' || marketType === 'TEAM_TOTAL') {
    return isOverUnderDirection(direction);
  }
  return false;
}

function nearlyEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

function getExpectedWagerFromOddsContext(payload, marketType, direction) {
  const odds = payload?.odds_context;
  if (!odds || typeof odds !== 'object') {
    return { expectedLine: null, expectedPrice: null };
  }

  if (marketType === 'MONEYLINE') {
    return {
      expectedLine: null,
      expectedPrice:
        direction === 'HOME'
          ? asNumber(odds.h2h_home ?? odds.moneyline_home)
          : direction === 'AWAY'
            ? asNumber(odds.h2h_away ?? odds.moneyline_away)
            : null,
    };
  }

  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    return {
      expectedLine:
        direction === 'HOME'
          ? asNumber(odds.spread_home)
          : direction === 'AWAY'
            ? asNumber(odds.spread_away)
            : null,
      expectedPrice:
        direction === 'HOME'
          ? asNumber(odds.spread_price_home)
          : direction === 'AWAY'
            ? asNumber(odds.spread_price_away)
            : null,
    };
  }

  if (marketType === 'TOTAL' || marketType === 'TEAM_TOTAL') {
    return {
      expectedLine: asNumber(odds.total),
      expectedPrice:
        direction === 'OVER'
          ? asNumber(odds.total_price_over)
          : direction === 'UNDER'
            ? asNumber(odds.total_price_under)
            : null,
    };
  }

  return { expectedLine: null, expectedPrice: null };
}

function validateExactWager({ payload, marketType, direction, line, price }) {
  const trace =
    payload?.pricing_trace && typeof payload.pricing_trace === 'object'
      ? payload.pricing_trace
      : null;

  if (trace?.exact_wager_valid === false) {
    return false;
  }

  const calledMarket = normalizeMarketType(trace?.called_market_type);
  if (calledMarket && calledMarket !== marketType) {
    return false;
  }

  const calledSide = normalizeDirection(trace?.called_side);
  if (calledSide !== 'NONE' && calledSide !== direction) {
    return false;
  }

  const calledLine = asNumber(trace?.called_line);
  if (calledLine !== null && line !== null && !nearlyEqual(calledLine, line)) {
    return false;
  }

  const calledPrice = asNumber(trace?.called_price);
  if (
    calledPrice !== null &&
    price !== null &&
    !nearlyEqual(calledPrice, price)
  ) {
    return false;
  }

  const { expectedLine, expectedPrice } = getExpectedWagerFromOddsContext(
    payload,
    marketType,
    direction,
  );

  if (
    expectedLine !== null &&
    line !== null &&
    marketRequiresLine(marketType) &&
    !nearlyEqual(expectedLine, line)
  ) {
    return false;
  }

  if (
    expectedPrice !== null &&
    price !== null &&
    marketRequiresPrice(marketType) &&
    !nearlyEqual(expectedPrice, price)
  ) {
    return false;
  }

  return true;
}

function derivePlayTier(edgePct) {
  if (edgePct === null) return 'BAD';
  if (edgePct >= 0.1) return 'BEST';
  if (edgePct >= 0.06) return 'GOOD';
  if (edgePct >= 0.03) return 'OK';
  return 'BAD';
}

function computeOfficialStatus({
  watchdogStatus,
  sharpPriceStatus,
  supportScore,
  edgePct,
  marketType,
  proxyCapped = false,
}) {
  const thresholds = getSupportThresholds(marketType);

  if (watchdogStatus === 'BLOCKED') return 'PASS';
  if (sharpPriceStatus === 'UNPRICED' || sharpPriceStatus === 'COTTAGE') {
    return 'PASS';
  }
  if (edgePct === null) return 'PASS';

  if (
    sharpPriceStatus === 'CHEDDAR' &&
    supportScore >= thresholds.play &&
    edgePct >= PLAY_EDGE_MIN
  ) {
    return proxyCapped ? 'LEAN' : 'PLAY';
  }

  if (
    sharpPriceStatus === 'CHEDDAR' &&
    supportScore >= thresholds.lean &&
    edgePct >= LEAN_EDGE_MIN
  ) {
    return 'LEAN';
  }

  return 'PASS';
}

function resolvePrimaryReason({
  watchdogReasonCodes,
  watchdogStatus,
  sharpPriceStatus,
  priceReasonCodes,
  officialStatus,
  supportScore,
  edgePct,
  marketType,
  proxyCapped = false,
}) {
  const thresholds = getSupportThresholds(marketType);

  if (watchdogStatus === 'BLOCKED' && watchdogReasonCodes.length > 0) {
    return watchdogReasonCodes[0];
  }

  if (sharpPriceStatus === 'UNPRICED' || sharpPriceStatus === 'COTTAGE') {
    return priceReasonCodes[0] || PRICE_REASONS.MARKET_PRICE_MISSING;
  }

  if (proxyCapped) {
    return PRICE_REASONS.PROXY_EDGE_CAPPED;
  }

  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
    return PRICE_REASONS.EDGE_CLEAR;
  }

  if (supportScore < thresholds.lean) {
    return 'SUPPORT_BELOW_LEAN_THRESHOLD';
  }

  if (edgePct !== null && edgePct < PLAY_EDGE_MIN) {
    return 'SUPPORT_BELOW_PLAY_THRESHOLD';
  }

  return 'SUPPORT_BELOW_PLAY_THRESHOLD';
}

function computeWatchdog(payload, context = {}) {
  const watchdogReasonCodes = [];
  const { consistency, sourceAttempts, missingFields } =
    resolveConsistency(payload);

  const projectionInputsComplete = payload?.projection_inputs_complete;
  const projectionMissingInputs = Array.isArray(payload?.missing_inputs)
    ? payload.missing_inputs.filter((field) => asString(field))
    : [];

  if (
    projectionInputsComplete === false ||
    projectionMissingInputs.length > 0
  ) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.CONSISTENCY_MISSING);
    for (const field of projectionMissingInputs) {
      const normalizedField = `projection.${field}`;
      if (!missingFields.includes(normalizedField)) {
        missingFields.push(normalizedField);
      }
      sourceAttempts.push({
        field: normalizedField,
        source: 'missing_inputs',
        result: 'MISSING',
      });
    }
  }

  const direction = getDirection(payload);
  if (direction === 'NONE') {
    watchdogReasonCodes.push(WATCHDOG_REASONS.MARKET_UNAVAILABLE);
  }

  if (missingFields.length > 0) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.CONSISTENCY_MISSING);
  }

  const capturedAt =
    asString(payload?.odds_context?.captured_at) ||
    asString(context?.oddsSnapshot?.captured_at) ||
    asString(context?.oddsSnapshot?.capturedAt);

  if (!capturedAt) {
    sourceAttempts.push({
      field: 'odds_snapshot_captured_at',
      source: 'odds_context.captured_at',
      result: 'MISSING',
    });
  }

  let staleMinutes = null;
  if (capturedAt) {
    const capturedTs = Date.parse(capturedAt);
    if (Number.isNaN(capturedTs)) {
      sourceAttempts.push({
        field: 'odds_snapshot_captured_at',
        source: 'odds_context.captured_at',
        result: 'ERROR',
        note: 'invalid timestamp',
      });
      watchdogReasonCodes.push(WATCHDOG_REASONS.PARSE_FAILURE);
    } else {
      staleMinutes = (Date.now() - capturedTs) / 60000;
    }
  }

  let watchdogStatus = 'OK';
  if (staleMinutes !== null && staleMinutes > 30) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.STALE_SNAPSHOT);
  }

  const hasBlockingReason = watchdogReasonCodes.some(
    (code) =>
      code === WATCHDOG_REASONS.CONSISTENCY_MISSING ||
      code === WATCHDOG_REASONS.PARSE_FAILURE ||
      code === WATCHDOG_REASONS.MARKET_UNAVAILABLE ||
      (code === WATCHDOG_REASONS.STALE_SNAPSHOT &&
        staleMinutes !== null &&
        staleMinutes > 30),
  );

  if (hasBlockingReason) {
    watchdogStatus = 'BLOCKED';
  } else if (staleMinutes !== null && staleMinutes >= 5 && staleMinutes <= 30) {
    watchdogStatus = 'CAUTION';
    watchdogReasonCodes.push(WATCHDOG_REASONS.STALE_SNAPSHOT);
  }

  const uniqueReasonCodes = Array.from(new Set(watchdogReasonCodes));

  return {
    watchdog_status: watchdogStatus,
    watchdog_reason_codes: uniqueReasonCodes,
    missing_data: {
      missing_fields: missingFields,
      source_attempts: sourceAttempts,
      severity:
        watchdogStatus === 'BLOCKED'
          ? 'BLOCKING'
          : watchdogStatus === 'CAUTION'
            ? 'WARNING'
            : 'INFO',
    },
    consistency,
  };
}

function isWave1EligiblePayload(payload) {
  if (!payload || payload.kind !== 'PLAY') return false;
  const sport = normalizeSport(payload.sport);
  if (!WAVE1_SPORTS.has(sport)) return false;
  const marketType = normalizeMarketType(payload.market_type);
  return Boolean(marketType && WAVE1_MARKETS.has(marketType));
}

function buildDecisionV2(payload, context = {}) {
  if (!isWave1EligiblePayload(payload)) return null;

  try {
    const market_type = normalizeMarketType(
      payload?.market_type ?? payload?.recommended_bet_type,
    );

    const direction = getDirection(payload);
    const { support_score, conflict_score } = getSupportAndConflict(payload);
    const drivers_used = getDriversUsed(payload);
    const driver_reasons = getDriverReasons(payload);

    const watchdog = computeWatchdog(payload, context);

    const line = asNumber(payload?.line);
    const price = asNumber(payload?.price);
    const implied_prob = impliedProbFromAmerican(price);
    const winProbHome = asNumber(payload?.projection?.win_prob_home);
    let proxy_used = detectProxyUsed(payload);
    const proxy_allowed = payload?.proxy_policy_allow_priced === true;

    const validSide = sideValidForMarket(market_type, direction);
    const hasRequiredLine = !marketRequiresLine(market_type) || line !== null;
    const hasRequiredPrice =
      !marketRequiresPrice(market_type) || price !== null;
    const exact_wager_valid =
      validSide &&
      validateExactWager({
        payload,
        marketType: market_type,
        direction,
        line,
        price,
      });

    let missingReason = null;
    if (!validSide || !hasRequiredLine) {
      missingReason = PRICE_REASONS.MARKET_EDGE_UNAVAILABLE;
    } else if (!hasRequiredPrice) {
      missingReason = PRICE_REASONS.MARKET_PRICE_MISSING;
    }

    let fair_prob =
      asNumber(payload?.model_prob) ??
      asNumber(payload?.p_fair) ??
      (market_type === 'MONEYLINE' &&
      winProbHome !== null &&
      (direction === 'HOME' || direction === 'AWAY')
        ? direction === 'AWAY'
          ? 1 - winProbHome
          : winProbHome
        : null);

    if (
      fair_prob === null &&
      implied_prob !== null &&
      asNumber(payload?.edge) !== null &&
      exact_wager_valid &&
      !proxy_used
    ) {
      fair_prob = implied_prob + asNumber(payload.edge);
    }

    if (fair_prob !== null) {
      fair_prob = clamp(fair_prob, 0, 1);
    }

    // For SPREAD/PUCKLINE/TOTAL: if fair_prob not yet set, derive from projection data
    // using market-aware normal CDF edge (NBA/NHL don't set model_prob in payload)
    let edge_method = null;
    let edge_line_delta = null;
    let edge_lean = null;

    if (fair_prob === null) {
      const sport = normalizeSport(payload?.sport);
      const sigmaDefaults = edgeCalculator.getSigmaDefaults(sport);
      const oddsCtx = payload?.odds_context;

      if (market_type === 'SPREAD' || market_type === 'PUCKLINE') {
        const projectedMargin = asNumber(payload?.projection?.margin_home);
        const spreadLineHome = asNumber(oddsCtx?.spread_home);
        if (projectedMargin !== null && spreadLineHome !== null) {
          const result = edgeCalculator.computeSpreadEdge({
            projectionMarginHome: projectedMargin,
            spreadLine: spreadLineHome,
            spreadPriceHome: asNumber(oddsCtx?.spread_price_home),
            spreadPriceAway: asNumber(oddsCtx?.spread_price_away),
            sigmaMargin: sigmaDefaults.margin,
            isPredictionHome: direction === 'HOME',
          });
          if (result.p_fair !== null) {
            fair_prob = clamp(result.p_fair, 0, 1);
            edge_method = 'MARGIN_DELTA';
            edge_line_delta = result.edgePoints ?? null;
          }
        } else {
          proxy_used = true;
        }
      } else if (market_type === 'TOTAL' || market_type === 'TEAM_TOTAL') {
        const projectedTotal = asNumber(payload?.projection?.total);
        const totalLine = asNumber(oddsCtx?.total);
        if (projectedTotal !== null && totalLine !== null) {
          const result = edgeCalculator.computeTotalEdge({
            projectionTotal: projectedTotal,
            totalLine,
            totalPriceOver: asNumber(oddsCtx?.total_price_over),
            totalPriceUnder: asNumber(oddsCtx?.total_price_under),
            sigmaTotal: sigmaDefaults.total,
            isPredictionOver: direction === 'OVER',
          });
          if (result.p_fair !== null) {
            fair_prob = clamp(result.p_fair, 0, 1);
            edge_method = 'TOTAL_DELTA';
            edge_line_delta = result.edgePoints ?? null;
            edge_lean =
              result.edgePoints > 0
                ? 'OVER'
                : result.edgePoints < 0
                  ? 'UNDER'
                  : null;
          }
        } else {
          proxy_used = true;
        }
      }
    }

    // When fair_prob was resolved from model_prob/p_fair (cross-market already computed
    // market-aware CDF), set method and read line delta from payload.edge_points
    if (edge_method === null && fair_prob !== null) {
      if (market_type === 'MONEYLINE') {
        edge_method = 'ML_PROB';
      } else if (market_type === 'SPREAD' || market_type === 'PUCKLINE') {
        edge_method = 'MARGIN_DELTA';
        edge_line_delta = asNumber(payload?.edge_points);
      } else if (market_type === 'TOTAL' || market_type === 'TEAM_TOTAL') {
        edge_method = 'TOTAL_DELTA';
        edge_line_delta = asNumber(payload?.edge_points);
        if (edge_line_delta !== null) {
          edge_lean =
            edge_line_delta > 0 ? 'OVER' : edge_line_delta < 0 ? 'UNDER' : null;
        }
      }
    }

    const edge_pct =
      fair_prob !== null && implied_prob !== null
        ? fair_prob - implied_prob
        : null;

    const hasPrimarySupport =
      drivers_used.length > 0 || asString(payload?.driver?.key) !== null;

    const priceDecision = classifyPrice({
      marketType: market_type,
      edgePct: edge_pct,
      fairProb: fair_prob,
      impliedProb: implied_prob,
      missingReason,
      exactWagerValid: exact_wager_valid,
      hasPrimarySupport,
      proxyUsed: proxy_used,
      proxyAllowed: proxy_allowed,
    });
    const proxy_capped = priceDecision.proxy_capped === true;

    const official_status = computeOfficialStatus({
      watchdogStatus: watchdog.watchdog_status,
      sharpPriceStatus: priceDecision.sharp_price_status,
      supportScore: support_score,
      edgePct: edge_pct,
      marketType: market_type,
      proxyCapped: proxy_capped,
    });

    const play_tier = derivePlayTier(edge_pct);

    const primary_reason_code = resolvePrimaryReason({
      watchdogReasonCodes: watchdog.watchdog_reason_codes,
      watchdogStatus: watchdog.watchdog_status,
      sharpPriceStatus: priceDecision.sharp_price_status,
      priceReasonCodes: priceDecision.price_reason_codes,
      officialStatus: official_status,
      supportScore: support_score,
      edgePct: edge_pct,
      marketType: market_type,
      proxyCapped: proxy_capped,
    });

    return {
      direction,
      support_score,
      conflict_score,
      drivers_used,
      driver_reasons,

      watchdog_status: watchdog.watchdog_status,
      watchdog_reason_codes: watchdog.watchdog_reason_codes,
      missing_data: watchdog.missing_data,

      consistency: watchdog.consistency,

      market_type,
      market_line: line,
      market_price: price,
      fair_prob,
      implied_prob,
      edge_pct,
      edge_method,
      edge_line_delta,
      edge_lean,
      proxy_used,
      proxy_capped,
      exact_wager_valid,
      pricing_trace: {
        market_type,
        market_side: direction !== 'NONE' ? direction : null,
        market_line: line,
        market_price: price,
        line_source:
          asString(payload?.pricing_trace?.line_source) ||
          asString(payload?.line_source) ||
          'unknown',
        price_source:
          asString(payload?.pricing_trace?.price_source) ||
          asString(payload?.price_source) ||
          'unknown',
      },

      sharp_price_status: priceDecision.sharp_price_status,
      price_reason_codes: priceDecision.price_reason_codes,

      official_status,
      play_tier,
      primary_reason_code,

      pipeline_version: PIPELINE_VERSION,
      decided_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      direction: 'NONE',
      support_score: 0,
      conflict_score: 0,
      drivers_used: [],
      driver_reasons: [],

      watchdog_status: 'BLOCKED',
      watchdog_reason_codes: [WATCHDOG_REASONS.PARSE_FAILURE],
      missing_data: {
        missing_fields: [],
        source_attempts: [
          {
            field: 'payload',
            source: 'buildDecisionV2',
            result: 'ERROR',
            note:
              error instanceof Error ? error.message : 'unknown parse failure',
          },
        ],
        severity: 'BLOCKING',
      },

      consistency: {
        pace_tier: 'MISSING',
        event_env: 'MISSING',
        event_direction_tag: 'MISSING',
        vol_env: 'MISSING',
        total_bias: 'MISSING',
      },

      fair_prob: null,
      implied_prob: null,
      edge_pct: null,

      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.MARKET_PRICE_MISSING],

      official_status: 'PASS',
      play_tier: 'BAD',
      primary_reason_code: WATCHDOG_REASONS.PARSE_FAILURE,

      pipeline_version: PIPELINE_VERSION,
      decided_at: new Date().toISOString(),
    };
  }
}

module.exports = {
  PIPELINE_VERSION,
  PIPELINE_STATE_STAGES,
  WAVE1_MARKETS,
  WAVE1_SPORTS,
  WATCHDOG_REASONS,
  PRICE_REASONS,
  uniqueReasonCodes,
  buildPipelineState,
  collectDecisionReasonCodes,
  isWave1EligiblePayload,
  buildDecisionV2,
};
