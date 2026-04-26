const edgeCalculator = require('./edge-calculator');
const {
  resolveThresholdProfile,
  resolvePlayCleanlinessProfile,
  applyNbaTotalQuarantine,
} = require('./decision-pipeline-v2-edge-config');
// Import from package entrypoint to preserve package boundaries.
const {
  ALL_REASON_CODES: _ALL_REASON_CODES,
} = require('../../data');
const {
  normalizeMarketType: normalizeCanonicalMarketType,
} = require('../../data/src/market-contract');

// Startup check: all locally-defined reason codes must be canonical or aliased.
// This catches any future code added to WATCHDOG_REASONS / PRICE_REASONS without registration.
function _assertPipelineCodesRegistered(constantMap, label) {
  // Some worker tests mock the data package with a minimal export surface.
  // When canonical reason-code exports are absent, skip this startup assert.
  if (!Array.isArray(_ALL_REASON_CODES) || _ALL_REASON_CODES.length < 20) {
    return;
  }
  const set = new Set(_ALL_REASON_CODES);
  for (const code of Object.values(constantMap)) {
    if (!set.has(code)) {
      throw new Error(`[decision-pipeline-v2] Unregistered ${label} code: ${code}`);
    }
  }
}

// Edge unit: all edge values in this pipeline are decimal fractions.
// See CANONICAL_EDGE_CONTRACT in decision-gate.js for the authoritative definition.
const EDGE_UNITS = 'decimal_fraction';

const WAVE1_SPORTS = new Set(['NBA', 'NHL', 'MLB']);
const WAVE1_MARKETS = new Set([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
  'FIRST_PERIOD',
]);

const WATCHDOG_REASONS = {
  CONSISTENCY_MISSING: 'WATCHDOG_CONSISTENCY_MISSING',
  PARSE_FAILURE: 'WATCHDOG_PARSE_FAILURE',
  STALE_SNAPSHOT: 'STALE_SNAPSHOT',
  STALE_MARKET: 'STALE_MARKET',
  MARKET_UNAVAILABLE: 'WATCHDOG_MARKET_UNAVAILABLE',
  // WI-0383: goalie identity uncertainty reason codes
  GOALIE_UNCONFIRMED: 'GOALIE_UNCONFIRMED',
  GOALIE_CONFLICTING: 'GOALIE_CONFLICTING',
  INJURY_UNCERTAIN: 'INJURY_UNCERTAIN',
  STARTER_UNCONFIRMED: 'STARTER_UNCONFIRMED',
  STARTER_MISMATCH: 'STARTER_MISMATCH',
  BEST_LINE_UNCONFIRMED: 'BEST_LINE_UNCONFIRMED',
  WEATHER_STATUS_PENDING: 'WEATHER_STATUS_PENDING',
  MARKET_SOURCE_UNCONFIRMED: 'MARKET_SOURCE_UNCONFIRMED',
  // WI-0907 Phase 4: All-sports input validation
  ESPN_NULL_OBSERVATION: 'ESPN_NULL_OBSERVATION',
  TIMESTAMP_MISSING: 'TIMESTAMP_MISSING',
  TIMESTAMP_PARSE_ERROR: 'TIMESTAMP_PARSE_ERROR',
  TIMESTAMP_AGE_INVALID: 'TIMESTAMP_AGE_INVALID',
  GAME_ID_INVALID: 'GAME_ID_INVALID',
  AVAILABILITY_GATE_DEGRADED: 'AVAILABILITY_GATE_DEGRADED',
  LINE_DELTA_COMPUTATION_FAILED: 'LINE_DELTA_COMPUTATION_FAILED',
  LINE_CONTEXT_MISSING: 'LINE_CONTEXT_MISSING',
  CAPTURED_AT_MISSING: 'CAPTURED_AT_MISSING',
  CAPTURED_AT_MS_INVALID: 'CAPTURED_AT_MS_INVALID',
  NEUTRAL_VALUE_COERCE_SILENT: 'NEUTRAL_VALUE_COERCE_SILENT',
  PRICE_VALIDATION_FAILED: 'PRICE_VALIDATION_FAILED',
  STALE_RECOVERY_REFRESH_FAILED: 'STALE_RECOVERY_REFRESH_FAILED',
  STALE_RECOVERY_RELOAD_FAILED: 'STALE_RECOVERY_RELOAD_FAILED',
  ESPN_NULL_ALERT_FAILED: 'ESPN_NULL_ALERT_FAILED',
};
const HOLD_EQUIVALENT_WATCHDOG_REASONS = new Set([
  WATCHDOG_REASONS.GOALIE_UNCONFIRMED,
  WATCHDOG_REASONS.GOALIE_CONFLICTING,
  WATCHDOG_REASONS.INJURY_UNCERTAIN,
  WATCHDOG_REASONS.STARTER_UNCONFIRMED,
  WATCHDOG_REASONS.STARTER_MISMATCH,
  WATCHDOG_REASONS.BEST_LINE_UNCONFIRMED,
  WATCHDOG_REASONS.WEATHER_STATUS_PENDING,
  WATCHDOG_REASONS.MARKET_SOURCE_UNCONFIRMED,
]);

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
  LINE_NOT_CONFIRMED: 'LINE_NOT_CONFIRMED',
  EDGE_RECHECK_PENDING: 'EDGE_RECHECK_PENDING',
  EDGE_NO_LONGER_CONFIRMED: 'EDGE_NO_LONGER_CONFIRMED',
  STALE_MARKET: 'STALE_MARKET',
  PRICE_SYNC_PENDING: 'PRICE_SYNC_PENDING',
  EDGE_SANITY_NON_TOTAL: 'EDGE_SANITY_NON_TOTAL',
  HEAVY_FAVORITE_PRICE_CAP: 'HEAVY_FAVORITE_PRICE_CAP',
  PLAY_REQUIRES_FRESH_MARKET: 'PLAY_REQUIRES_FRESH_MARKET',
  PLAY_CONTRADICTION_CAPPED: 'PLAY_CONTRADICTION_CAPPED',
  // FIRST_PERIOD canonical reason codes (WI-0537)
  FIRST_PERIOD_PROJECTION_PLAY: 'FIRST_PERIOD_PROJECTION_PLAY',
  FIRST_PERIOD_PROJECTION_LEAN: 'FIRST_PERIOD_PROJECTION_LEAN',
  FIRST_PERIOD_NO_PROJECTION: 'FIRST_PERIOD_NO_PROJECTION',
  PRICE_STALE: 'PRICE_STALE',
  LINE_MOVE_ADVERSE: 'LINE_MOVE_ADVERSE',
  // WI-0814: emitted when PLAY is downgraded to LEAN due to fallback sigma
  SIGMA_FALLBACK_DEGRADED: 'SIGMA_FALLBACK_DEGRADED',
};

// Verify all locally-defined reason codes are registered in the canonical taxonomy.
_assertPipelineCodesRegistered(WATCHDOG_REASONS, 'WATCHDOG_REASONS');
_assertPipelineCodesRegistered(PRICE_REASONS, 'PRICE_REASONS');

/**
 * FIRST_PERIOD_POLICY (WI-0537)
 *
 * Single canonical definition of how FIRST_PERIOD market calls are priced and
 * classified.  Every function that currently contains an inline
 * `if (marketType === 'FIRST_PERIOD')` branch must delegate through these
 * methods so that a single change here propagates consistently to
 * classifyPrice, computeOfficialStatus, and play_tier derivation.
 *
 * Contract:
 *  - Direction must be OVER or UNDER (enforced by sideValidForMarket).
 *  - FIRST_PERIOD_NO_PROJECTION remains available as a PASS/no-signal
 *    compatibility reason code for downstream diagnostics.
 */
const FIRST_PERIOD_POLICY = Object.freeze({
  /**
   * Maps a projectionSignal to the single canonical price_reason_code for
   * the FIRST_PERIOD market type when preserving PASS/no-signal compatibility.
   */
  toPriceReasonCode(projectionSignal) {
    return projectionSignal === 'PASS'
      ? PRICE_REASONS.FIRST_PERIOD_NO_PROJECTION
      : null;
  },
});

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
// Unit: percentage points (pp) — NOT percent.
// Formula: abs(circa_handle_home - circa_handle_away) >= SHARP_CIRCA_DIVERGENCE_THRESHOLD_PP
// Interpretation: one side has ~70%+ of total Circa handle (70/30 or more lopsided)
// Tuning ladder: 20 pp = lean (60/40) | 40 pp = real divergence (70/30) | 60 pp = extreme (80/20)
const SHARP_CIRCA_DIVERGENCE_THRESHOLD_PP = 40;
const PROXY_SIGNAL_TAGS = new Set([
  'PROXY_MODEL_PROB_INFERRED',
  'PROXY_CARD',
]);
const HARD_INVALIDATION_PRICE_REASONS = new Set([
  PRICE_REASONS.MARKET_PRICE_MISSING,
  PRICE_REASONS.MODEL_PROB_MISSING,
  PRICE_REASONS.EXACT_WAGER_MISMATCH,
  PRICE_REASONS.MARKET_EDGE_UNAVAILABLE,
  PRICE_REASONS.PROXY_EDGE_BLOCKED,
  PRICE_REASONS.LINE_NOT_CONFIRMED,
  PRICE_REASONS.EDGE_RECHECK_PENDING,
  PRICE_REASONS.PRICE_SYNC_PENDING,
]);
const PLAY_CAPPED_PRICE_REASONS = new Set([
  PRICE_REASONS.PLAY_REQUIRES_FRESH_MARKET,
  PRICE_REASONS.PLAY_CONTRADICTION_CAPPED,
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

function normalizeDecisionMarketType(rawValue) {
  const token = asString(rawValue)
    ?.toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!token) return null;

  if (
    token === 'FIRST_PERIOD' ||
    token === '1P' ||
    token === 'P1' ||
    token === 'FIRSTPERIOD'
  ) {
    return 'FIRST_PERIOD';
  }
  if (token === 'TEAM_TOTAL' || token === 'TEAMTOTAL') {
    return 'TEAM_TOTAL';
  }
  if (token === 'PUCKLINE' || token === 'PUCK_LINE') {
    return 'PUCKLINE';
  }

  return normalizeCanonicalMarketType(rawValue);
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

function normalizeLineContext(payload, context = {}) {
  const raw =
    (context?.lineContext && typeof context.lineContext === 'object'
      ? context.lineContext
      : null) ||
    (payload?.line_context && typeof payload.line_context === 'object'
      ? payload.line_context
      : null) ||
    (payload?.lineContext && typeof payload.lineContext === 'object'
      ? payload.lineContext
      : null);

  if (!raw) return null;

  const opener_line = asNumber(raw.opener_line ?? raw.openerLine);
  const current_line = asNumber(raw.current_line ?? raw.currentLine);
  const rawDelta = asNumber(raw.delta ?? raw.lineDelta);
  const delta =
    rawDelta !== null
      ? rawDelta
      : opener_line !== null && current_line !== null
        ? current_line - opener_line
        : null;
  const delta_pct = asNumber(raw.delta_pct ?? raw.deltaPct);

  if (opener_line === null && current_line === null && delta === null) {
    return null;
  }

  return {
    opener_line,
    current_line,
    delta,
    delta_pct,
  };
}

function computeAdverseLineDelta({ marketType, direction, lineContext }) {
  if (!lineContext) return 0;

  const signedDelta =
    asNumber(lineContext.delta) ??
    (asNumber(lineContext.opener_line) !== null &&
    asNumber(lineContext.current_line) !== null
      ? asNumber(lineContext.current_line) - asNumber(lineContext.opener_line)
      : null);

  if (signedDelta === null) return 0;

  if (
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
  ) {
    if (direction === 'OVER') return Math.max(signedDelta, 0);
    if (direction === 'UNDER') return Math.max(-signedDelta, 0);
    return 0;
  }

  if (marketType === 'SPREAD' || marketType === 'PUCKLINE') {
    if (direction === 'HOME' || direction === 'AWAY') {
      return Math.max(-signedDelta, 0);
    }
  }

  return 0;
}

function applyAdverseLineMoveToEdge({
  edgePct,
  edgeLineDelta,
  adverseLineDelta,
}) {
  if (
    !Number.isFinite(edgePct) ||
    !Number.isFinite(edgeLineDelta) ||
    !Number.isFinite(adverseLineDelta) ||
    adverseLineDelta <= 0
  ) {
    return edgePct;
  }

  const edgeLineMagnitude = Math.abs(edgeLineDelta);
  if (edgeLineMagnitude <= 0) return edgePct;

  const adjustedRatio = (edgeLineMagnitude - adverseLineDelta) / edgeLineMagnitude;
  return Number((edgePct * adjustedRatio).toFixed(4));
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

function getThresholdProfile(marketType, sport, sigmaSource = null) {
  return resolveThresholdProfile({
    sport,
    marketType,
    sigmaSource,
  });
}

function deriveFirstPeriodProjectionSignal(payload) {
  const classification = asString(payload?.classification) || asString(payload?.prediction);
  const token = classification ? classification.toUpperCase() : 'PASS';
  if (token === 'PASS') return 'PASS';
  if (token.includes('OVER')) return 'PLAY';
  if (token.includes('BEST') || token.includes('PLAY')) return 'PLAY';
  if (token.includes('LEAN')) return 'LEAN';
  return 'PASS';
}

function classifyPrice({
  sport,
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
  const thresholds = getThresholdProfile(marketType, sport);

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
      sharp_price_status: 'PENDING_VERIFICATION',
      price_reason_codes: [
        PRICE_REASONS.LINE_NOT_CONFIRMED,
        PRICE_REASONS.EDGE_RECHECK_PENDING,
        PRICE_REASONS.EDGE_SANITY_NON_TOTAL,
      ],
      proxy_capped: false,
    };
  }

  if (proxyUsed && !proxyAllowed) {
    if (edgePct < thresholds.edge.lean_edge_min) {
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

  if (edgePct < thresholds.edge.lean_edge_min) {
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
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
  );
}

function marketRequiresPrice(marketType) {
  return (
    marketType === 'MONEYLINE' ||
    marketType === 'SPREAD' ||
    marketType === 'PUCKLINE' ||
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
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
  if (marketType === 'FIRST_PERIOD') {
    return isOverUnderDirection(direction);
  }
  return false;
}

function nearlyEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

function resolveWagerPeriod(payload) {
  const period =
    asString(payload?.period) ||
    asString(payload?.market?.period) ||
    asString(payload?.market_context?.period) ||
    asString(payload?.market_context?.wager?.period) ||
    asString(payload?.pricing_trace?.period);
  return period ? period.toUpperCase() : null;
}

function getFirstPeriodPriceFromOddsContext(payload, direction) {
  const odds = payload?.odds_context;
  if (!odds || typeof odds !== 'object') return null;
  if (direction === 'OVER') return asNumber(odds.total_price_over_1p);
  if (direction === 'UNDER') return asNumber(odds.total_price_under_1p);
  return null;
}

function getExpectedWagerFromOddsContext(payload, marketType, direction) {
  const odds = payload?.odds_context;
  if (!odds || typeof odds !== 'object') {
    return { expectedLine: null, expectedPrice: null };
  }

  const period = resolveWagerPeriod(payload);

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

  if (
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD'
  ) {
    const expectedTotal =
      marketType === 'FIRST_PERIOD'
        ? asNumber(payload?.line) ?? asNumber(odds.total_1p) ?? 1.5
        : period === '1P'
          ? asNumber(odds.total_1p ?? odds.total)
          : asNumber(odds.total);
    const expectedOverPrice =
      marketType === 'FIRST_PERIOD'
        ? asNumber(odds.total_price_over_1p)
        : period === '1P'
        ? asNumber(odds.total_price_over_1p ?? odds.total_price_over)
        : asNumber(odds.total_price_over);
    const expectedUnderPrice =
      marketType === 'FIRST_PERIOD'
        ? asNumber(odds.total_price_under_1p)
        : period === '1P'
        ? asNumber(odds.total_price_under_1p ?? odds.total_price_under)
        : asNumber(odds.total_price_under);

    return {
      expectedLine: expectedTotal,
      expectedPrice:
        direction === 'OVER'
          ? expectedOverPrice
          : direction === 'UNDER'
            ? expectedUnderPrice
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

  const publishedFromGate = payload?.published_from_gate === true;
  const hasPublishedDecisionKey =
    typeof payload?.published_decision_key === 'string' &&
    payload.published_decision_key.trim().length > 0;
  const isGatePublishedContext = publishedFromGate || hasPublishedDecisionKey;

  if (trace?.exact_wager_valid === false) {
    return false;
  }

  const calledMarket = normalizeDecisionMarketType(trace?.called_market_type);
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

  if (isGatePublishedContext) {
    return true;
  }

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

function derivePlayTierWithThresholds(edgePct, thresholdProfile) {
  if (edgePct === null) return 'BAD';
  const thresholds = thresholdProfile?.edge || {
    play_edge_min: PLAY_EDGE_MIN,
    lean_edge_min: LEAN_EDGE_MIN,
  };
  if (edgePct >= thresholds.play_edge_min + 0.04) return 'BEST';
  if (edgePct >= thresholds.play_edge_min) return 'GOOD';
  if (edgePct >= thresholds.lean_edge_min) return 'OK';
  return 'BAD';
}

function getHeavyFavoritePlayEdgeMultiplier(price) {
  if (!Number.isFinite(price) || price >= 0) return null;
  if (price <= -500) return 3;
  if (price <= -300) return 2;
  return null;
}

function hasHardInvalidationReason({
  watchdogStatus,
  priceReasonCodes = [],
  watchdogReasonCodes = [],
}) {
  if (watchdogStatus === 'BLOCKED') {
    const hasNonHoldBlockingReason = watchdogReasonCodes.some(
      (code) => !HOLD_EQUIVALENT_WATCHDOG_REASONS.has(code),
    );
    if (hasNonHoldBlockingReason) return true;
  }
  return priceReasonCodes.some((code) => HARD_INVALIDATION_PRICE_REASONS.has(code));
}

function computeOfficialStatus({
  watchdogStatus,
  watchdogReasonCodes = [],
  sharpPriceStatus,
  supportScore,
  edgePct,
  sport,
  marketType,
  proxyCapped = false,
  sigmaSource = null,
}) {
  const thresholds = getThresholdProfile(marketType, sport, sigmaSource);

  if (watchdogStatus === 'BLOCKED') {
    const hasNonHoldBlockingReason = watchdogReasonCodes.some(
      (code) => !HOLD_EQUIVALENT_WATCHDOG_REASONS.has(code),
    );
    return hasNonHoldBlockingReason ? 'PASS' : 'LEAN';
  }
  if (sharpPriceStatus === 'PENDING_VERIFICATION') return 'PASS';
  if (sharpPriceStatus === 'UNPRICED' || sharpPriceStatus === 'COTTAGE') {
    return 'PASS';
  }

  if (edgePct === null) return 'PASS';

  if (
    sharpPriceStatus === 'CHEDDAR' &&
    supportScore >= thresholds.support.play &&
    edgePct >= thresholds.edge.play_edge_min
  ) {
    // WI-0814: Under fallback sigma, cap official status at LEAN (never PLAY).
    if (sigmaSource === 'fallback') return 'LEAN';
    return proxyCapped ? 'LEAN' : 'PLAY';
  }

  if (
    sharpPriceStatus === 'CHEDDAR' &&
    supportScore >= thresholds.support.lean &&
    edgePct >= thresholds.edge.lean_edge_min
  ) {
    return 'LEAN';
  }

  return 'PASS';
}

function applyPlayCleanlinessCap({
  officialStatus,
  sport,
  marketType,
  watchdogStatus,
  conflictScore,
  priceReasonCodes = [],
}) {
  if (officialStatus !== 'PLAY') {
    return { officialStatus, priceReasonCodes };
  }

  const profile = resolvePlayCleanlinessProfile({ sport, marketType });
  if (!profile?.enabled) {
    return { officialStatus, priceReasonCodes };
  }

  const capReasons = [];
  if (profile.require_watchdog_ok && watchdogStatus !== 'OK') {
    capReasons.push(PRICE_REASONS.PLAY_REQUIRES_FRESH_MARKET);
  }

  if (
    Number.isFinite(profile.play_conflict_max) &&
    Number.isFinite(conflictScore) &&
    conflictScore > profile.play_conflict_max
  ) {
    capReasons.push(PRICE_REASONS.PLAY_CONTRADICTION_CAPPED);
  }

  if (capReasons.length === 0) {
    return { officialStatus, priceReasonCodes };
  }

  return {
    officialStatus: 'LEAN',
    priceReasonCodes: uniqueReasonCodes(priceReasonCodes, capReasons),
  };
}

/**
 * WI-0667: Sharp divergence annotation.
 *
 * Mutates payload.tags in-place — adds 'SHARP_MONEY_OPPOSITE' or 'SHARP_ALIGNED'
 * when Circa handle diverges >= SHARP_CIRCA_DIVERGENCE_THRESHOLD_PP from our direction.
 *
 * No status mutation — official_status is never touched.
 *
 * @param {object} payload   - Decision payload (mutated in place)
 * @param {object} oddsSnapshot - Odds snapshot from context (may be null)
 */
function computeSharpDivergenceAnnotation(payload, oddsSnapshot) {
  const home = oddsSnapshot?.circa_handle_pct_home;
  const away = oddsSnapshot?.circa_handle_pct_away;

  // No-op when either Circa column is absent
  if (home == null || away == null) return;

  // Ensure tags array exists
  if (!Array.isArray(payload.tags)) payload.tags = [];

  const direction = String(payload.direction ?? '').toUpperCase();
  const ourSide = direction === 'HOME' ? home : away;
  const oppSide = direction === 'HOME' ? away : home;
  const diff = Math.abs(ourSide - oppSide);

  if (diff < SHARP_CIRCA_DIVERGENCE_THRESHOLD_PP) return;

  if (oppSide > ourSide) {
    // Circa handle majority on the OTHER side — sharp divergence against our pick
    payload.tags.push('SHARP_MONEY_OPPOSITE');
    payload.sharp_money_opposite = true;
  } else {
    // Circa handle majority WITH our pick — sharp alignment
    payload.tags.push('SHARP_ALIGNED');
    payload.sharp_aligned = true;
  }
}

function resolvePrimaryReason({
  watchdogReasonCodes,
  watchdogStatus,
  sharpPriceStatus,
  priceReasonCodes,
  officialStatus,
  supportScore,
  edgePct,
  sport,
  marketType,
  proxyCapped = false,
}) {
  const thresholds = getThresholdProfile(marketType, sport);

  if (watchdogStatus === 'BLOCKED' && watchdogReasonCodes.length > 0) {
    return watchdogReasonCodes[0];
  }

  if (sharpPriceStatus === 'PENDING_VERIFICATION') {
    return priceReasonCodes[0] || PRICE_REASONS.LINE_NOT_CONFIRMED;
  }

  if (sharpPriceStatus === 'UNPRICED' || sharpPriceStatus === 'COTTAGE') {
    return priceReasonCodes[0] || PRICE_REASONS.MARKET_PRICE_MISSING;
  }

  const playCappedReason = priceReasonCodes.find((code) =>
    PLAY_CAPPED_PRICE_REASONS.has(code),
  );
  if (playCappedReason) {
    return playCappedReason;
  }

  if (proxyCapped) {
    return PRICE_REASONS.PROXY_EDGE_CAPPED;
  }

  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
    return PRICE_REASONS.EDGE_CLEAR;
  }

  if (supportScore < thresholds.support.lean) {
    return 'SUPPORT_BELOW_LEAN_THRESHOLD';
  }

  if (edgePct !== null && edgePct < thresholds.edge.play_edge_min) {
    return 'SUPPORT_BELOW_PLAY_THRESHOLD';
  }

  return 'SUPPORT_BELOW_PLAY_THRESHOLD';
}

function resolveTerminalReasonFamily({
  officialStatus,
  watchdogStatus,
  priceReasonCodes = [],
  primaryReasonCode,
}) {
  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
    return 'PLAY_ELIGIBLE';
  }

  if (watchdogStatus === 'BLOCKED') {
    return 'WATCHDOG_DATA_QUALITY';
  }

  if (priceReasonCodes.includes(PRICE_REASONS.EXACT_WAGER_MISMATCH)) {
    return 'EXACT_WAGER_FAIL';
  }

  if (
    priceReasonCodes.includes(PRICE_REASONS.LINE_NOT_CONFIRMED) ||
    priceReasonCodes.includes(PRICE_REASONS.EDGE_RECHECK_PENDING) ||
    priceReasonCodes.includes(PRICE_REASONS.PRICE_SYNC_PENDING)
  ) {
    return 'LINE_NOT_CONFIRMED';
  }

  if (
    priceReasonCodes.some((code) =>
      [
        PRICE_REASONS.MARKET_PRICE_MISSING,
        PRICE_REASONS.MODEL_PROB_MISSING,
        PRICE_REASONS.MARKET_EDGE_UNAVAILABLE,
        PRICE_REASONS.PROXY_EDGE_BLOCKED,
        PRICE_REASONS.NO_PRIMARY_SUPPORT,
      ].includes(code),
    )
  ) {
    return 'PRICING_UNAVAILABLE';
  }

  if (
    priceReasonCodes.some((code) =>
      [
        PRICE_REASONS.HEAVY_FAVORITE_PRICE_CAP,
        PRICE_REASONS.FIRST_PERIOD_NO_PROJECTION,
      ].includes(code),
    )
  ) {
    return 'POLICY_BLOCK';
  }

  if (
    primaryReasonCode === 'SUPPORT_BELOW_PLAY_THRESHOLD' ||
    primaryReasonCode === 'SUPPORT_BELOW_LEAN_THRESHOLD' ||
    priceReasonCodes.includes(PRICE_REASONS.NO_EDGE_AT_PRICE)
  ) {
    return 'EDGE_INSUFFICIENT';
  }

  return 'EXECUTION_GATE';
}

function buildCanonicalEnvelopeV2({
  officialStatus,
  watchdogStatus,
  primaryReasonCode,
  priceReasonCodes = [],
  watchdogReasonCodes = [],
  executionStatus,
}) {
  const reasonCodes = uniqueReasonCodes(
    primaryReasonCode,
    watchdogReasonCodes,
    priceReasonCodes,
  );
  return {
    official_status: officialStatus,
    terminal_reason_family: resolveTerminalReasonFamily({
      officialStatus,
      watchdogStatus,
      priceReasonCodes,
      primaryReasonCode,
    }),
    primary_reason_code: primaryReasonCode,
    reason_codes: reasonCodes,
    is_actionable: officialStatus === 'PLAY' || officialStatus === 'LEAN',
    execution_status: executionStatus,
    publish_ready: executionStatus === 'EXECUTABLE',
  };
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

  const payloadReasonTokens = uniqueReasonCodes(
    payload?.gate_reason,
    payload?.blocked_reason_code,
    payload?.reason_codes,
  )
    .map((code) => String(code).toUpperCase())
    .filter(Boolean);
  if (payloadReasonTokens.includes('GATE_GOALIE_UNCONFIRMED')) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.GOALIE_UNCONFIRMED);
  }
  if (payloadReasonTokens.includes('GOALIE_CONFLICTING')) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.GOALIE_CONFLICTING);
  }
  if (payloadReasonTokens.includes('BLOCK_INJURY_RISK')) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.INJURY_UNCERTAIN);
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

  // Staleness is no longer a blocking reason in the watchdog. The execution
  // gate (execution-gate.js + execution-gate-freshness-contract.js) owns all
  // staleness decisions with sport-specific contracts (NBA/NHL: 120-min
  // hardMax + allowStaleIfNoNewOdds=true). The watchdog only blocks on data
  // quality issues: missing fields, parse errors, market unavailable.
  let watchdogStatus = 'OK';
  if (staleMinutes !== null && staleMinutes >= 5) {
    watchdogReasonCodes.push(WATCHDOG_REASONS.STALE_MARKET);
    watchdogReasonCodes.push(WATCHDOG_REASONS.STALE_SNAPSHOT);
  }

  const hasBlockingReason = watchdogReasonCodes.some(
    (code) =>
      code === WATCHDOG_REASONS.CONSISTENCY_MISSING ||
      code === WATCHDOG_REASONS.PARSE_FAILURE ||
      code === WATCHDOG_REASONS.MARKET_UNAVAILABLE ||
      HOLD_EQUIVALENT_WATCHDOG_REASONS.has(code),
  );

  if (hasBlockingReason) {
    watchdogStatus = 'BLOCKED';
  } else if (staleMinutes !== null && staleMinutes >= 5) {
    watchdogStatus = 'CAUTION';
  }

  const uniqueWatchdogReasonCodes = Array.from(new Set(watchdogReasonCodes));

  return {
    watchdog_status: watchdogStatus,
    watchdog_reason_codes: uniqueWatchdogReasonCodes,
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
  const marketType = normalizeDecisionMarketType(payload.market_type);
  return Boolean(marketType && WAVE1_MARKETS.has(marketType));
}

function buildDecisionV2(payload, context = {}) {
  if (!isWave1EligiblePayload(payload)) return null;

  try {
    const sport = normalizeSport(payload?.sport);
    const market_type = normalizeDecisionMarketType(
      payload?.market_type ?? payload?.recommended_bet_type,
    );
    const firstPeriodProjectionSignal =
      market_type === 'FIRST_PERIOD'
        ? deriveFirstPeriodProjectionSignal(payload)
        : 'PASS';

    const direction = getDirection(payload);
    const { support_score, conflict_score } = getSupportAndConflict(payload);
    const drivers_used = getDriversUsed(payload);
    const driver_reasons = getDriverReasons(payload);

    const watchdog = computeWatchdog(payload, context);
    const missingFieldCount = Array.isArray(watchdog?.missing_data?.missing_fields)
      ? watchdog.missing_data.missing_fields.length
      : 0;

    const line = asNumber(payload?.line);
    const payloadPrice = asNumber(payload?.price);
    const priceFromOddsContext =
      market_type === 'FIRST_PERIOD'
        ? getFirstPeriodPriceFromOddsContext(payload, direction)
        : null;
    const price = payloadPrice ?? priceFromOddsContext;
    let implied_prob = impliedProbFromAmerican(price);
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
    // WI-0591: sigma_source exposed in return value for auditability
    let resolvedSigmaSource = 'fallback';
    // WI-0814: job-level sigma source — only set when sigmaOverride is explicitly provided.
    // Used to drive the fallback safety gate (null means gate is inactive).
    const jobSigmaSource = context?.sigmaOverride != null
      ? (context.sigmaOverride.sigma_source ?? 'fallback')
      : null;

    if (fair_prob === null) {
      const sport = normalizeSport(payload?.sport);
      const sigmaDefaults = edgeCalculator.getSigmaDefaults(sport);
      // WI-0591: accept pre-computed empirical sigma from the model job.
      // context.sigmaOverride = { margin, total, sigma_source: 'computed'|'fallback' }
      const sigmaOverride = context?.sigmaOverride;
      const resolvedSigmaMargin =
        sigmaOverride?.margin != null && Number.isFinite(sigmaOverride.margin)
          ? sigmaOverride.margin
          : sigmaDefaults.margin;
      const resolvedSigmaTotal =
        sigmaOverride?.total != null && Number.isFinite(sigmaOverride.total)
          ? sigmaOverride.total
          : sigmaDefaults.total;
      resolvedSigmaSource = sigmaOverride?.sigma_source ?? 'fallback';
      const oddsCtx = payload?.odds_context;

      if (market_type === 'SPREAD' || market_type === 'PUCKLINE') {
        const projectedMargin = asNumber(payload?.projection?.margin_home);
        const spreadLineHome = asNumber(oddsCtx?.spread_home);
        const spreadPriceHome =
          direction === 'HOME'
            ? asNumber(oddsCtx?.spread_price_home)
            : asNumber(
                oddsCtx?.spread_same_book_home_for_away ??
                  oddsCtx?.spread_price_home,
              );
        const spreadPriceAway =
          direction === 'HOME'
            ? asNumber(
                oddsCtx?.spread_same_book_away_for_home ??
                  oddsCtx?.spread_price_away,
              )
            : asNumber(oddsCtx?.spread_price_away);
        if (projectedMargin !== null && spreadLineHome !== null) {
          const result = edgeCalculator.computeSpreadEdge({
            projectionMarginHome: projectedMargin,
            spreadLine: spreadLineHome,
            spreadPriceHome,
            spreadPriceAway,
            sigmaMargin: resolvedSigmaMargin,
            isPredictionHome: direction === 'HOME',
            confidenceContext: {
              watchdogStatus: watchdog.watchdog_status,
              missingFieldCount,
              proxyUsed: proxy_used,
              conflictScore: conflict_score,
            },
          });
          if (result.p_fair !== null) {
            fair_prob = clamp(result.p_fair, 0, 1);
            edge_method = 'MARGIN_DELTA';
            edge_line_delta = result.edgePoints ?? null;
            // WI-0805: capture devigged implied prob from computeSpreadEdge
            if (result.p_implied != null) implied_prob = result.p_implied;
          }
        } else {
          proxy_used = true;
        }
      } else if (
        market_type === 'TOTAL' ||
        market_type === 'TEAM_TOTAL' ||
        market_type === 'FIRST_PERIOD'
      ) {
        const projectedTotal = asNumber(payload?.projection?.total);
        const totalLine =
          market_type === 'FIRST_PERIOD'
            ? asNumber(payload?.line) ?? 1.5
            : asNumber(oddsCtx?.total);
        const totalPriceOver =
          market_type === 'FIRST_PERIOD'
            ? asNumber(oddsCtx?.total_price_over_1p)
            : direction === 'OVER'
              ? asNumber(oddsCtx?.total_price_over)
              : asNumber(
                  oddsCtx?.total_same_book_over_for_under ??
                    oddsCtx?.total_price_over,
                );
        const totalPriceUnder =
          market_type === 'FIRST_PERIOD'
            ? asNumber(oddsCtx?.total_price_under_1p)
            : direction === 'OVER'
              ? asNumber(
                  oddsCtx?.total_same_book_under_for_over ??
                    oddsCtx?.total_price_under,
                )
              : asNumber(oddsCtx?.total_price_under);
        if (projectedTotal !== null && totalLine !== null) {
          const result = edgeCalculator.computeTotalEdge({
            projectionTotal: projectedTotal,
            totalLine,
            totalPriceOver,
            totalPriceUnder,
            sigmaTotal: resolvedSigmaTotal,
            isPredictionOver: direction === 'OVER',
            confidenceContext: {
              watchdogStatus: watchdog.watchdog_status,
              missingFieldCount,
              proxyUsed: proxy_used,
              conflictScore: conflict_score,
            },
          });
          if (result.p_fair !== null) {
            fair_prob = clamp(result.p_fair, 0, 1);
            edge_method =
              market_type === 'FIRST_PERIOD'
                ? 'ONE_PERIOD_DELTA'
                : 'TOTAL_DELTA';
            edge_line_delta = result.edgePoints ?? null;
            edge_lean =
              result.edgePoints > 0
                ? 'OVER'
                : result.edgePoints < 0
                  ? 'UNDER'
                  : null;
            // WI-0805: capture devigged implied prob from computeTotalEdge
            if (result.p_implied != null) implied_prob = result.p_implied;
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
      } else if (market_type === 'FIRST_PERIOD') {
        edge_method = 'ONE_PERIOD_DELTA';
        edge_line_delta = asNumber(payload?.edge_points);
        if (edge_line_delta !== null) {
          edge_lean =
            edge_line_delta > 0 ? 'OVER' : edge_line_delta < 0 ? 'UNDER' : null;
        }
      }
    }

    // WI-0805: for MONEYLINE, devig implied_prob using both sides from odds_context
    if (market_type === 'MONEYLINE' && implied_prob !== null && price !== null) {
      const mlOdds = payload?.odds_context;
      const oppositePrice = direction === 'HOME'
        ? asNumber(
            mlOdds?.h2h_same_book_away_for_home ??
              mlOdds?.h2h_away ??
              mlOdds?.moneyline_away,
          )
        : asNumber(
            mlOdds?.h2h_same_book_home_for_away ??
              mlOdds?.h2h_home ??
              mlOdds?.moneyline_home,
          );
      if (oppositePrice !== null) {
        const noVig = edgeCalculator.noVigImplied(price, oppositePrice);
        if (noVig != null) implied_prob = noVig.home;
      }
    }
    const raw_edge_pct =
      fair_prob !== null && implied_prob !== null
        ? fair_prob - implied_prob
        : null;
    const lineContext = normalizeLineContext(payload, context);
    const adverse_line_delta = computeAdverseLineDelta({
      marketType: market_type,
      direction,
      lineContext,
    });
    const edge_pct = applyAdverseLineMoveToEdge({
      edgePct: raw_edge_pct,
      edgeLineDelta: edge_line_delta,
      adverseLineDelta: adverse_line_delta,
    });
    const lineMoveReasonCodes =
      adverse_line_delta > 1
        ? [PRICE_REASONS.LINE_MOVE_ADVERSE]
        : [];

    const hasPrimarySupport =
      drivers_used.length > 0 || asString(payload?.driver?.key) !== null;

    const priceDecision = classifyPrice({
      sport,
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

    const computedOfficialStatus = computeOfficialStatus({
      watchdogStatus: watchdog.watchdog_status,
      watchdogReasonCodes: watchdog.watchdog_reason_codes,
      sharpPriceStatus: priceDecision.sharp_price_status,
      supportScore: support_score,
      edgePct: edge_pct,
      sport,
      marketType: market_type,
      proxyCapped: proxy_capped,
      sigmaSource: jobSigmaSource,
    });

    const thresholdProfile = getThresholdProfile(market_type, sport, jobSigmaSource);
    const playCleanlinessResult = applyPlayCleanlinessCap({
      officialStatus: computedOfficialStatus,
      sport,
      marketType: market_type,
      watchdogStatus: watchdog.watchdog_status,
      conflictScore: conflict_score,
      priceReasonCodes: priceDecision.price_reason_codes,
    });
    let finalOfficialStatus = playCleanlinessResult.officialStatus;
    let finalPriceReasonCodes = uniqueReasonCodes(
      playCleanlinessResult.priceReasonCodes,
      lineMoveReasonCodes,
    );

    // WI-0814: If sigma was fallback and the official status was downgraded from PLAY to LEAN
    // by computeOfficialStatus, inject SIGMA_FALLBACK_DEGRADED reason code so the
    // downgrade is visible in card payloads and queryable in the DB.
    if (
      jobSigmaSource === 'fallback' &&
      thresholdProfile.meta?.sigma_degraded === true &&
      computedOfficialStatus === 'LEAN' &&
      finalOfficialStatus === 'LEAN'
    ) {
      // Confirm the card would have been PLAY without the sigma gate
      // (edge_pct >= original play_edge_min and support >= play support threshold)
      const origPlayEdgeMin = thresholdProfile.meta.original_play_edge_min;
      if (
        typeof origPlayEdgeMin === 'number' &&
        typeof edge_pct === 'number' &&
        edge_pct >= origPlayEdgeMin &&
        support_score >= thresholdProfile.support.play
      ) {
        finalPriceReasonCodes = uniqueReasonCodes(
          finalPriceReasonCodes,
          PRICE_REASONS.SIGMA_FALLBACK_DEGRADED,
        );
      }
    }

    if (
      market_type === 'FIRST_PERIOD' &&
      firstPeriodProjectionSignal === 'PASS' &&
      finalOfficialStatus === 'PASS'
    ) {
      const compatibilityReason =
        FIRST_PERIOD_POLICY.toPriceReasonCode(firstPeriodProjectionSignal);
      if (compatibilityReason) {
        finalPriceReasonCodes = uniqueReasonCodes(
          compatibilityReason,
          finalPriceReasonCodes,
        );
      }
    }

    const play_tier = derivePlayTierWithThresholds(edge_pct, thresholdProfile);

    const heavyFavoriteMultiplier = getHeavyFavoritePlayEdgeMultiplier(price);
    const heavyFavoritePlayEdgeMin =
      heavyFavoriteMultiplier === null
        ? null
        : thresholdProfile.edge.play_edge_min * heavyFavoriteMultiplier;
    const heavyFavoriteGateFailed =
      market_type === 'MONEYLINE' &&
      finalOfficialStatus === 'PLAY' &&
      heavyFavoritePlayEdgeMin !== null &&
      typeof edge_pct === 'number' &&
      edge_pct < heavyFavoritePlayEdgeMin &&
      !hasHardInvalidationReason({
        watchdogStatus: watchdog.watchdog_status,
        watchdogReasonCodes: watchdog.watchdog_reason_codes,
        priceReasonCodes: finalPriceReasonCodes,
      });
    if (heavyFavoriteGateFailed) {
      // ≤-500: non-playable (PASS); ≤-300: slight edge still possible (LEAN)
      finalOfficialStatus = price !== null && price <= -500 ? 'PASS' : 'LEAN';
      finalPriceReasonCodes = uniqueReasonCodes(
        finalPriceReasonCodes,
        PRICE_REASONS.HEAVY_FAVORITE_PRICE_CAP,
      );
    }

    // WI-0588: NBA totals quarantine — demote actionable tiers one level.
    const nbaQuarantineResult = applyNbaTotalQuarantine({
      sport,
      marketType: market_type,
      officialStatus: finalOfficialStatus,
      priceReasonCodes: finalPriceReasonCodes,
    });
    finalOfficialStatus = nbaQuarantineResult.officialStatus;
    finalPriceReasonCodes = nbaQuarantineResult.priceReasonCodes;

    // WI-0667: annotate sharp/circa divergence (informational only — no status mutation)
    computeSharpDivergenceAnnotation(payload, context?.oddsSnapshot);

    let primary_reason_code = resolvePrimaryReason({
      watchdogReasonCodes: watchdog.watchdog_reason_codes,
      watchdogStatus: watchdog.watchdog_status,
      sharpPriceStatus: priceDecision.sharp_price_status,
      priceReasonCodes: finalPriceReasonCodes,
      officialStatus: finalOfficialStatus,
      supportScore: support_score,
      edgePct: edge_pct,
      sport,
      marketType: market_type,
      proxyCapped: proxy_capped,
    });
    if (heavyFavoriteGateFailed) {
      primary_reason_code = PRICE_REASONS.HEAVY_FAVORITE_PRICE_CAP;
    }

    const canonicalEnvelopeV2 = buildCanonicalEnvelopeV2({
      officialStatus: finalOfficialStatus,
      watchdogStatus: watchdog.watchdog_status,
      primaryReasonCode: primary_reason_code,
      priceReasonCodes: finalPriceReasonCodes,
      watchdogReasonCodes: watchdog.watchdog_reason_codes,
      // Only set execution_status to 'BLOCKED' if watchdog_status is 'BLOCKED', else always 'EXECUTABLE'
      executionStatus: watchdog.watchdog_status === 'BLOCKED' ? 'BLOCKED' : 'EXECUTABLE',
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
      edge_pct_raw: raw_edge_pct,
      edge_units: EDGE_UNITS,   // unit per CANONICAL_EDGE_CONTRACT
      threshold_profile: {
        source: thresholdProfile.source,
        support_play_min: thresholdProfile.support.play,
        support_lean_min: thresholdProfile.support.lean,
        play_edge_min: thresholdProfile.edge.play_edge_min,
        lean_edge_min: thresholdProfile.edge.lean_edge_min,
      },
      edge_method,
      edge_line_delta,
      edge_lean,
      line_moved:
        Number.isFinite(lineContext?.delta) && Math.abs(lineContext.delta) > 0,
      line_delta: lineContext?.delta ?? null,
      line_delta_pct: lineContext?.delta_pct ?? null,
      opener_line: lineContext?.opener_line ?? null,
      current_line:
        lineContext?.current_line ?? lineContext?.opener_line ?? null,
      adverse_line_delta:
        adverse_line_delta > 0 ? Number(adverse_line_delta.toFixed(4)) : 0,
      proxy_used,
      proxy_capped,
      exact_wager_valid,
      // WI-0591: expose which sigma source was used for auditability
      sigma_source: resolvedSigmaSource ?? 'fallback',
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
      price_reason_codes: finalPriceReasonCodes,

      official_status: finalOfficialStatus,
      play_tier,
      primary_reason_code,
      canonical_envelope_v2: canonicalEnvelopeV2,

      pipeline_version: PIPELINE_VERSION,
      decided_at: new Date().toISOString(),
    };
  } catch (error) {
    console.error('[buildDecisionV2] PARSE_FAILURE — returning synthetic BLOCKED result', {
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      sport: payload?.sport,
      market_type: payload?.market_type,
      game_id: payload?.game_id,
    });
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
      canonical_envelope_v2: buildCanonicalEnvelopeV2({
        officialStatus: 'PASS',
        watchdogStatus: 'BLOCKED',
        primaryReasonCode: WATCHDOG_REASONS.PARSE_FAILURE,
        priceReasonCodes: [PRICE_REASONS.MARKET_PRICE_MISSING],
        watchdogReasonCodes: [WATCHDOG_REASONS.PARSE_FAILURE],
        executionStatus: 'BLOCKED',
      }),

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
