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
};

const PIPELINE_VERSION = 'v2';

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
        payload.drivers_active
          .map((item) => asString(item))
          .filter(Boolean),
      ),
    );
  }

  const weights = payload?.driver_summary?.weights;
  if (Array.isArray(weights)) {
    return Array.from(
      new Set(
        weights
          .map((weight) => asString(weight?.driver))
          .filter(Boolean),
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

function classifyPrice(edgePct, fairProb, impliedProb) {
  if (fairProb === null || impliedProb === null || edgePct === null) {
    return {
      sharp_price_status: 'UNPRICED',
      price_reason_codes: [PRICE_REASONS.MARKET_PRICE_MISSING],
    };
  }

  if (edgePct < 0.03) {
    return {
      sharp_price_status: 'COTTAGE',
      price_reason_codes: [PRICE_REASONS.NO_EDGE_AT_PRICE],
    };
  }

  return {
    sharp_price_status: 'CHEDDAR',
    price_reason_codes: [PRICE_REASONS.EDGE_CLEAR],
  };
}

function derivePlayTier(edgePct) {
  if (edgePct === null) return 'BAD';
  if (edgePct >= 0.1) return 'BEST';
  if (edgePct >= 0.06) return 'GOOD';
  if (edgePct >= 0.03) return 'OK';
  return 'BAD';
}

function computeOfficialStatus({ watchdogStatus, sharpPriceStatus, supportScore, edgePct }) {
  if (watchdogStatus === 'BLOCKED') return 'PASS';
  if (sharpPriceStatus === 'UNPRICED' || sharpPriceStatus === 'COTTAGE') {
    return 'PASS';
  }
  if (
    sharpPriceStatus === 'CHEDDAR' &&
    supportScore >= 0.6 &&
    edgePct !== null &&
    edgePct >= 0.06
  ) {
    return 'PLAY';
  }
  if (
    sharpPriceStatus === 'CHEDDAR' &&
    supportScore >= 0.45 &&
    edgePct !== null &&
    edgePct >= 0.03
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
}) {
  if (watchdogStatus === 'BLOCKED' && watchdogReasonCodes.length > 0) {
    return watchdogReasonCodes[0];
  }

  if (sharpPriceStatus === 'UNPRICED' || sharpPriceStatus === 'COTTAGE') {
    return priceReasonCodes[0] || PRICE_REASONS.MARKET_PRICE_MISSING;
  }

  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
    return PRICE_REASONS.EDGE_CLEAR;
  }

  if (supportScore < 0.45) {
    return 'SUPPORT_BELOW_LEAN_THRESHOLD';
  }

  if (edgePct !== null && edgePct < 0.06) {
    return 'SUPPORT_BELOW_PLAY_THRESHOLD';
  }

  return 'SUPPORT_BELOW_PLAY_THRESHOLD';
}

function computeWatchdog(payload, context = {}) {
  const watchdogReasonCodes = [];
  const { consistency, sourceAttempts, missingFields } = resolveConsistency(payload);

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
      (code === WATCHDOG_REASONS.STALE_SNAPSHOT && staleMinutes !== null && staleMinutes > 30),
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
    const direction = getDirection(payload);
    const { support_score, conflict_score } = getSupportAndConflict(payload);
    const drivers_used = getDriversUsed(payload);
    const driver_reasons = getDriverReasons(payload);

    const watchdog = computeWatchdog(payload, context);

    const implied_prob = impliedProbFromAmerican(payload?.price);
    const winProbHome = asNumber(payload?.projection?.win_prob_home);
    let fair_prob =
      asNumber(payload?.model_prob) ??
      asNumber(payload?.p_fair) ??
      (winProbHome !== null && (direction === 'HOME' || direction === 'AWAY')
        ? direction === 'AWAY'
          ? 1 - winProbHome
          : winProbHome
        : null);

    if (
      fair_prob === null &&
      implied_prob !== null &&
      asNumber(payload?.edge) !== null
    ) {
      fair_prob = implied_prob + asNumber(payload.edge);
    }

    if (fair_prob !== null) {
      fair_prob = clamp(fair_prob, 0, 1);
    }

    const edge_pct =
      fair_prob !== null && implied_prob !== null ? fair_prob - implied_prob : null;

    const priceDecision = classifyPrice(edge_pct, fair_prob, implied_prob);

    const official_status = computeOfficialStatus({
      watchdogStatus: watchdog.watchdog_status,
      sharpPriceStatus: priceDecision.sharp_price_status,
      supportScore: support_score,
      edgePct: edge_pct,
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

      fair_prob,
      implied_prob,
      edge_pct,

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
            note: error instanceof Error ? error.message : 'unknown parse failure',
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
  WAVE1_MARKETS,
  WAVE1_SPORTS,
  WATCHDOG_REASONS,
  PRICE_REASONS,
  isWave1EligiblePayload,
  buildDecisionV2,
};
