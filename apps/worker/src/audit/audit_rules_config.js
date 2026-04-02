'use strict';

const KNOWN_SELECTION_TOKENS = new Set([
  'AWAY',
  'HOME',
  'NO',
  'OVER',
  'UNDER',
  'YES',
]);

const IGNORED_FIELD_NAMES = new Set([
  'captured_at',
  'countdown',
  'created_at',
  'generated_at',
  'job_run_id',
  'run_id',
  'runId',
  'start_time_local',
  'updated_at',
]);

const STRICT_FIELD_SUFFIXES = Object.freeze([
  '_pricing_state.status',
  '_publish_state.publish_ready',
  'actionable',
  'card_type',
  'classification',
  'decision_v2.official_status',
  'execution_status',
  'homeAdjustmentTrust',
  'homeGoalieCertainty',
  'market_type',
  'nhl_goalie_certainty_pair',
  'official_eligible',
  'official_status',
  'publish_ready',
  'reason_codes',
  'selection_signature',
  'awayAdjustmentTrust',
  'awayGoalieCertainty',
]);

const TOLERANCE_RULES = Object.freeze({
  confidence: 0.03,
  edge: 0.005,
  edge_pct: 0.005,
  p_fair: 0.02,
  p_implied: 0.02,
  'projection.total': 0.5,
  'projection.margin_home': 1.0,
  homeExpected: 0.2,
  awayExpected: 0.2,
  expectedTotal: 0.2,
});

const CARD_KEY_BUILDERS = Object.freeze({
  default(value, context = {}) {
    const payload = value && typeof value === 'object' ? value : {};
    const period = normalizePeriodToken(payload);
    const selectionDetails = getSelectionSignature(payload);
    const gameId = asToken(payload.game_id) || 'UNKNOWN_GAME';
    const cardType = asToken(payload.card_type || payload.cardType) || context.fallbackType || 'UNKNOWN_CARD';
    const marketType = asToken(payload.market_type) || 'UNKNOWN_MARKET';
    return [gameId, cardType, marketType, period, selectionDetails.signature || 'NO_SELECTION'].join('|');
  },
});

function asToken(value) {
  if (value === null || value === undefined) return null;
  const token = String(value).trim();
  return token.length > 0 ? token.toUpperCase() : null;
}

function normalizeReasonCodes(reasonCodes) {
  if (!Array.isArray(reasonCodes)) return [];
  return Array.from(
    new Set(
      reasonCodes
        .map((code) => asToken(code))
        .filter(Boolean),
    ),
  ).sort();
}

function normalizePeriodToken(payload = {}) {
  const candidates = [
    payload?.market_context?.wager?.period,
    payload?.market_context?.period,
    payload?.period,
  ];
  for (const candidate of candidates) {
    const token = asToken(candidate);
    if (!token) continue;
    if (token === 'P1') return '1P';
    if (token === 'FIRST_PERIOD') return '1P';
    return token;
  }
  return 'FULL_GAME';
}

function normalizeSelectionToken(rawValue) {
  const token = asToken(rawValue);
  if (!token || !KNOWN_SELECTION_TOKENS.has(token)) return null;
  return token;
}

function getSelectionSources(payload = {}) {
  return [
    ['selection.side', normalizeSelectionToken(payload?.selection?.side)],
    ['selection_type', normalizeSelectionToken(payload?.selection_type)],
    ['market_context.selection_side', normalizeSelectionToken(payload?.market_context?.selection_side)],
    ['prediction', normalizeSelectionToken(payload?.prediction)],
  ].filter(([, value]) => value);
}

function getSelectionSignature(payload = {}) {
  const sources = getSelectionSources(payload);
  const uniqueSides = Array.from(new Set(sources.map(([, value]) => value)));
  const period = normalizePeriodToken(payload);
  if (uniqueSides.length === 0) {
    return {
      conflict: false,
      period,
      side: null,
      signature: null,
      sources,
    };
  }
  if (uniqueSides.length > 1) {
    return {
      conflict: true,
      period,
      side: null,
      signature: null,
      sources,
    };
  }
  return {
    conflict: false,
    period,
    side: uniqueSides[0],
    signature: `${period}|${uniqueSides[0]}`,
    sources,
  };
}

function derivePricingStatus(payload = {}) {
  const explicit = asToken(payload?._pricing_state?.status);
  if (explicit) return explicit;
  if (payload?.pricing_ready === true) return 'FRESH';
  if (asToken(payload?.execution_status) === 'EXECUTABLE') return 'FRESH';
  if (payload?.projection_floor === true) return 'NOT_REQUIRED';
  return 'MISSING';
}

function derivePublishReady(payload = {}) {
  if (payload?._publish_state?.publish_ready !== undefined) {
    return payload._publish_state.publish_ready === true;
  }
  if (payload?.publish_ready !== undefined) {
    return payload.publish_ready === true;
  }
  return asToken(payload?.execution_status) === 'EXECUTABLE';
}

function isIgnoredField(pathSegments = []) {
  return pathSegments.some((segment) => IGNORED_FIELD_NAMES.has(segment));
}

function matchesSuffix(path, suffix) {
  return path === suffix || path.endsWith(`.${suffix}`);
}

function getToleranceRule(fieldPath) {
  const matchedKey = Object.keys(TOLERANCE_RULES).find((suffix) =>
    matchesSuffix(fieldPath, suffix),
  );
  return matchedKey ? TOLERANCE_RULES[matchedKey] : null;
}

function isStrictField(fieldPath) {
  return STRICT_FIELD_SUFFIXES.some((suffix) => matchesSuffix(fieldPath, suffix));
}

function getCardKey(value, context = {}) {
  return CARD_KEY_BUILDERS.default(value, context);
}

module.exports = {
  CARD_KEY_BUILDERS,
  IGNORED_FIELD_NAMES,
  KNOWN_SELECTION_TOKENS,
  STRICT_FIELD_SUFFIXES,
  TOLERANCE_RULES,
  asToken,
  derivePricingStatus,
  derivePublishReady,
  getCardKey,
  getSelectionSignature,
  getToleranceRule,
  isIgnoredField,
  isStrictField,
  normalizePeriodToken,
  normalizeReasonCodes,
};
