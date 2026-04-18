function toUpperToken(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase();
}

// ---------------------------------------------------------------------------
// Canonical play-state contract
// ---------------------------------------------------------------------------

const CANONICAL_PLAY_STATES = Object.freeze({
  OFFICIAL_PLAY: 'OFFICIAL_PLAY',
  LEAN: 'LEAN',
  WATCH: 'WATCH',
  NO_PLAY: 'NO_PLAY',
  BLOCKED: 'BLOCKED',
});

// Reason codes indicating the market is in a waiting/unavailable state.
// A candidate with positive edge (PLAY or LEAN) AND any of these codes → WATCH.
// WATCH is not actionable until the condition resolves; it must never be
// treated as LEAN or shown as "Slight Edge".
const WATCH_REASON_CODES = Object.freeze(new Set([
  'LINE_NOT_CONFIRMED',
  'EDGE_RECHECK_PENDING',
  'PRICE_SYNC_PENDING',
  'MARKET_DATA_STALE',
  'BLOCKED_BET_VERIFICATION_REQUIRED',
  'GATE_LINE_MOVEMENT',
  'MISSING_DATA_NO_ODDS',
  'MARKET_PRICE_MISSING',
  'MARKET_EDGE_UNAVAILABLE',
  'GOALIE_UNCONFIRMED',
  'GOALIE_CONFLICTING',
  'INJURY_UNCERTAIN',
  'WATCHDOG_STALE_SNAPSHOT',
  'STALE_MARKET_INPUT',
  'PROJECTION_INPUTS_STALE_FALLBACK',
  'TEAM_METRICS_FALLBACK_PREV_DAY',
  'MISSING_DATA_PROJECTION_INPUTS',
  'MISSING_DATA_DRIVERS',
  'MISSING_DATA_TEAM_MAPPING',
  'PASS_MISSING_DRIVER_INPUTS',
  'PASS_DATA_ERROR',
]));

// Reason codes indicating a hard gate or policy block — candidate is BLOCKED.
// BLOCKED is terminal; no downstream surface may upgrade it.
const HARD_GATE_CODES = Object.freeze(new Set([
  'HEAVY_FAVORITE_PRICE_CAP',
  'FIRST_PERIOD_NO_PROJECTION',
  'EXACT_WAGER_MISMATCH',
  'NO_PRIMARY_SUPPORT',
  'MODEL_PROB_MISSING',
  'PROXY_EDGE_BLOCKED',
]));

const WEBHOOK_REASON_LABELS = Object.freeze({
  LINE_NOT_CONFIRMED: 'Line not confirmed',
  EDGE_RECHECK_PENDING: 'Edge needs recheck before action',
  EDGE_NO_LONGER_CONFIRMED: 'Edge no longer clears threshold',
  MARKET_DATA_STALE: 'Market data stale',
  PRICE_SYNC_PENDING: 'Book price still syncing',
  EDGE_SANITY_NON_TOTAL: 'Verification required — edge sanity check pending',
  BLOCKED_BET_VERIFICATION_REQUIRED: 'Verification required — bet blocked pending recheck',
  MIXED_BOOK_SOURCE_MISMATCH: 'Verification required — mixed line/price sources',
  MIXED_BOOK_INTEGRITY_GATE: 'Verification required — mixed line/price sources',
  LINE_MOVE_ADVERSE: 'Line moved against the pick — recheck required',
  MODEL_PROB_MISSING: 'Model incomplete — no play',
  MARKET_PRICE_MISSING: 'Price unavailable — no play',
  MARKET_EDGE_UNAVAILABLE: 'Edge unavailable at current market',
  NO_PRIMARY_SUPPORT: 'Insufficient model support — no play',
  PASS_NO_EDGE: 'No edge',
  NO_EDGE_AT_PRICE: 'Price not good enough yet',
  PLAY_REQUIRES_FRESH_MARKET: 'Fresh market check required',
  PLAY_CONTRADICTION_CAPPED: 'Signal contradiction cap active',
  GOALIE_UNCONFIRMED: 'Goalie not confirmed',
  GOALIE_CONFLICTING: 'Conflicting goalie reports',
  INJURY_UNCERTAIN: 'Injury status uncertain',
  WATCHDOG_STALE_SNAPSHOT: 'Snapshot stale — refresh required',
  STALE_MARKET_INPUT: 'Market input stale — refresh required',
});

function canonicalizeReasonCode(value) {
  const token = toUpperToken(value);
  if (!token) return '';
  if (token.startsWith('PASS_EXECUTION_GATE_')) {
    return token.replace('PASS_EXECUTION_GATE_', '');
  }
  return token;
}

function collectReasonCodes(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const decisionV2 =
    payload.decision_v2 && typeof payload.decision_v2 === 'object'
      ? payload.decision_v2
      : {};

  const ordered = [
    payload.blocked_reason_code,
    decisionV2.primary_reason_code,
    ...(Array.isArray(decisionV2.watchdog_reason_codes)
      ? decisionV2.watchdog_reason_codes
      : []),
    ...(Array.isArray(decisionV2.price_reason_codes)
      ? decisionV2.price_reason_codes
      : []),
    payload.pass_reason_code,
    payload.pass_reason,
    ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
    ...(Array.isArray(payload?.nhl_totals_status?.reasonCodes)
      ? payload.nhl_totals_status.reasonCodes
      : []),
    payload?.nhl_1p_decision?.surfaced_reason_code,
  ];

  const seen = new Set();
  const normalized = [];
  for (const value of ordered) {
    const code = canonicalizeReasonCode(value);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

function formatAmericanPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 0) return `+${Math.round(num)}`;
  return `${Math.round(num)}`;
}

function formatEdgeThresholdToken(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}`;
}

function deriveVerificationEdgeThreshold(payload) {
  const rawEdge = payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp;
  const edgeAbs = Math.abs(Number(rawEdge));
  if (!Number.isFinite(edgeAbs)) return null;

  // Floor to 0.05 steps to avoid noisy precision while keeping a deterministic trigger.
  const floored = Math.floor(edgeAbs * 20) / 20;
  return Math.max(0.05, floored);
}

function improvePriceTarget(priceToken) {
  const value = Number(priceToken);
  if (!Number.isFinite(value)) return null;
  if (value > 0) return `+${Math.round(value + 5)}+`;
  if (value < 0) return `${Math.round(value + 5)} or better`;
  return null;
}

function resolveMarketRef(payload) {
  const side =
    toUpperToken(payload?.selection?.side) || toUpperToken(payload?.prediction) || '';
  const line = payload?.line ?? payload?.total ?? payload?.market_line;
  const lineText = line !== null && line !== undefined ? String(line).trim() : '';
  return [side, lineText].filter(Boolean).join(' ').trim() || 'current market';
}

function formatLineToken(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return String(value || '').trim();
  return Number.isInteger(num) ? String(num) : num.toFixed(1);
}

function deriveAdverseMoveClause(payload) {
  const side = toUpperToken(payload?.selection?.side) || toUpperToken(payload?.prediction);
  const marketType = toUpperToken(payload?.market_type || payload?.recommended_bet_type);
  const rawLine = payload?.line ?? payload?.total ?? payload?.market_line;
  const line = Number(rawLine);

  const isTotalMarket =
    marketType === 'TOTAL' ||
    marketType === 'TEAM_TOTAL' ||
    marketType === 'FIRST_PERIOD' ||
    side === 'OVER' ||
    side === 'UNDER';
  if (!isTotalMarket || !Number.isFinite(line)) return 'adverse market move';

  if (side === 'OVER') return `total moves to ${formatLineToken(line + 0.5)}`;
  if (side === 'UNDER') return `total moves to ${formatLineToken(line - 0.5)}`;
  return `total moves away from ${formatLineToken(line)}`;
}

function deriveWebhookWatchState(payload) {
  const reasonCodes = collectReasonCodes(payload);
  const hasCode = (matcher) => reasonCodes.some((code) => matcher(code));

  if (
    hasCode((code) =>
      code === 'MARKET_DATA_STALE' ||
      code === 'EDGE_RECHECK_PENDING' ||
      code === 'STALE_MARKET_INPUT' ||
      code === 'WATCHDOG_STALE_SNAPSHOT',
    )
  ) {
    return 'market stale / recheck pending';
  }

  if (
    hasCode((code) =>
      code.includes('STALE') ||
      code.includes('MISSING') ||
      code.includes('INCOMPLETE') ||
      code === 'WATCHDOG_PARSE_FAILURE',
    )
  ) {
    return 'data incomplete';
  }

  if (hasCode((code) => code.includes('GOALIE') || code.includes('INJURY'))) {
    return 'pending confirmation';
  }

  if (
    hasCode((code) =>
      code === 'LINE_NOT_CONFIRMED' ||
      code === 'EDGE_RECHECK_PENDING' ||
      code === 'PRICE_SYNC_PENDING' ||
      code.includes('VERIFICATION') ||
      code.includes('LINE_MOVE_ADVERSE') ||
      code.includes('MIXED_BOOK_SOURCE_MISMATCH') ||
      code.includes('MIXED_BOOK_INTEGRITY_GATE'),
    )
  ) {
    return 'line not verified';
  }

  if (hasCode((code) => code === 'EDGE_NO_LONGER_CONFIRMED')) {
    return 'edge moved';
  }

  if (
    hasCode((code) =>
      code === 'NO_EDGE_AT_PRICE' ||
      code === 'PLAY_REQUIRES_FRESH_MARKET' ||
      code === 'PLAY_CONTRADICTION_CAPPED' ||
      code === 'HEAVY_FAVORITE_PRICE_CAP',
    )
  ) {
    return 'price not good enough';
  }

  const hasLine = payload?.line !== null && payload?.line !== undefined;
  const hasPrice = payload?.price !== null && payload?.price !== undefined;
  if (hasLine && !hasPrice) return 'number not good enough';
  if (hasLine && hasPrice) return 'price not good enough';
  return 'not a play yet';
}

function deriveWebhookWouldBecomePlay(payload, state = deriveWebhookWatchState(payload)) {
  const marketRef = resolveMarketRef(payload);
  const side =
    toUpperToken(payload?.selection?.side) || toUpperToken(payload?.prediction) || 'SIDE';
  const line = payload?.line ?? payload?.total ?? payload?.market_line;
  const lineText = line !== null && line !== undefined ? String(line).trim() : '';
  const price = formatAmericanPrice(payload?.price);
  const betterPrice = improvePriceTarget(price);

  if (state === 'price not good enough') {
    if (lineText && betterPrice) return `Would become PLAY: ${side} ${lineText} at ${betterPrice}`;
    if (betterPrice) return `Would become PLAY: at ${betterPrice}`;
    return `Would become PLAY: ${marketRef} at a better price`;
  }
  if (state === 'number not good enough') {
    return `Would become PLAY: ${side} at a better number`;
  }
  if (state === 'data incomplete') {
    return `Would become PLAY: ${marketRef} once fresh data confirms edge`;
  }
  if (state === 'line not verified') {
    const edgeThreshold = formatEdgeThresholdToken(deriveVerificationEdgeThreshold(payload));
    const hasLine = lineText.length > 0;
    const verificationClause = hasLine ? 'line verifies' : 'market verifies';
    if (lineText && edgeThreshold) {
      return `Would become PLAY: ${side} ${lineText} if ${verificationClause} and edge >= ${edgeThreshold} holds`;
    }
    if (edgeThreshold) {
      return `Would become PLAY: ${marketRef} if ${verificationClause} and edge >= ${edgeThreshold} holds`;
    }
    return `Would become PLAY: ${marketRef} if line confirms across books`;
  }
  if (state === 'market stale / recheck pending') {
    return `Would become PLAY: ${marketRef} once market refresh confirms edge`; 
  }
  if (state === 'pending confirmation') {
    return `Would become PLAY: ${marketRef} after line/model recheck`;
  }
  if (state === 'edge moved') {
    return `Would become PLAY: ${marketRef} only if refreshed edge clears threshold again`;
  }
  return `Would become PLAY: ${marketRef} once trigger conditions are met`;
}

function deriveWebhookDropToPass(payload, state = deriveWebhookWatchState(payload)) {
  const marketRef = resolveMarketRef(payload);
  const edgeThreshold = formatEdgeThresholdToken(deriveVerificationEdgeThreshold(payload));

  if (state === 'line not verified') {
    if (edgeThreshold) {
      return `Drops to PASS: edge < ${edgeThreshold} or ${deriveAdverseMoveClause(payload)}`;
    }
    return 'Drops to PASS: verification fails on recheck';
  }

  if (state === 'price not good enough') {
    return 'Drops to PASS: price worsens or edge no longer clears threshold';
  }

  if (state === 'number not good enough') {
    return 'Drops to PASS: number worsens before recheck';
  }

  if (state === 'data incomplete') {
    return 'Drops to PASS: missing/invalid data persists at recheck';
  }

  if (state === 'market stale / recheck pending') {
    return 'Drops to PASS: refreshed market still fails threshold checks';
  }

  if (state === 'pending confirmation') {
    return 'Drops to PASS: confirmation fails or signal degrades';
  }

  if (state === 'edge moved') {
    return 'Drops to PASS: refreshed edge remains below threshold';
  }

  return `Drops to PASS: ${marketRef} fails trigger conditions`;
}

function describeWebhookReason(payload, bucket = 'pass_blocked') {
  const reasonCode = deriveWebhookReasonCode(payload, bucket);
  if (!reasonCode) return null;
  return WEBHOOK_REASON_LABELS[reasonCode] || 'No edge';
}

/**
 * Canonical play-state resolver — the single upstream source of truth.
 *
 * Must run after model classification, guardrails, and watchdog.
 * Must run before Discord rendering, /wedge rendering, POTD selection,
 * and any final card formatting.
 *
 * Invariants:
 *   - OFFICIAL_PLAY is the only state that counts as a play.
 *   - LEAN is never an official play; POTD must not select LEAN.
 *   - WATCH is not actionable (market waiting state).
 *   - BLOCKED is terminal — no downstream surface may upgrade it.
 *   - NO_PLAY means evaluated but insufficient edge.
 */
function resolveCanonicalPlayState(payload) {
  if (!payload || typeof payload !== 'object') return 'NO_PLAY';

  const decisionV2 =
    payload.decision_v2 && typeof payload.decision_v2 === 'object'
      ? payload.decision_v2
      : {};

  const reasonCodes = collectReasonCodes(payload);

  // BLOCKED: watchdog veto or official_eligible gate — terminal, no override.
  if (toUpperToken(decisionV2.watchdog_status) === 'BLOCKED') return 'BLOCKED';
  if (payload.official_eligible === false) return 'BLOCKED';
  if (reasonCodes.some((code) => HARD_GATE_CODES.has(code))) return 'BLOCKED';

  const officialStatus = normalizeOfficialStatus(decisionV2.official_status);

  // WATCH: positive signal (PLAY or LEAN) but market is in a waiting state.
  // Positive edge + unavailable market ≠ LEAN; it is not actionable until resolved.
  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') {
    if (toUpperToken(decisionV2.sharp_price_status) === 'PENDING_VERIFICATION') {
      return 'WATCH';
    }
    if (reasonCodes.some((code) => WATCH_REASON_CODES.has(code))) return 'WATCH';
  }

  if (officialStatus === 'PLAY') return 'OFFICIAL_PLAY';
  if (officialStatus === 'LEAN') return 'LEAN';
  return 'NO_PLAY';
}

function normalizeOfficialStatus(value) {
  const token = toUpperToken(value);
  if (token === 'PLAY' || token === 'LEAN' || token === 'PASS') {
    return token;
  }
  return '';
}

function normalizeOfficialStatusFromPayload(payload) {
  return normalizeOfficialStatus(payload?.decision_v2?.official_status);
}

function isOfficialStatusActionable(value) {
  const status = normalizeOfficialStatus(value);
  return status === 'PLAY' || status === 'LEAN';
}

function rankOfficialStatus(value) {
  const status = normalizeOfficialStatus(value);
  if (status === 'PLAY') return 2;
  if (status === 'LEAN') return 1;
  return 0;
}

function deriveLegacyDecisionEnvelope(officialStatus) {
  const normalized = normalizeOfficialStatus(officialStatus);
  if (normalized === 'PLAY') {
    return {
      classification: 'BASE',
      action: 'FIRE',
      status: 'FIRE',
      passReasonCode: null,
    };
  }
  if (normalized === 'LEAN') {
    return {
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
      passReasonCode: null,
    };
  }
  return {
    classification: 'PASS',
    action: 'PASS',
    status: 'PASS',
    passReasonCode: null,
  };
}

function mapActionToClassification(action) {
  const normalizedAction = toUpperToken(action);
  if (normalizedAction === 'FIRE') return 'BASE';
  if (normalizedAction === 'HOLD') return 'LEAN';
  return 'PASS';
}

function deriveUiDisplayStatus(executionStatus, officialStatus) {
  const normalizedExecutionStatus = toUpperToken(executionStatus);
  const normalizedOfficialStatus = normalizeOfficialStatus(officialStatus);

  if (normalizedExecutionStatus === 'PROJECTION_ONLY') return 'WATCH';
  if (normalizedExecutionStatus === 'BLOCKED') return 'PASS';
  if (
    normalizedExecutionStatus === 'EXECUTABLE' &&
    normalizedOfficialStatus === 'PLAY'
  ) {
    return 'PLAY';
  }
  if (
    normalizedExecutionStatus === 'EXECUTABLE' &&
    normalizedOfficialStatus === 'LEAN'
  ) {
    return 'WATCH';
  }
  if (normalizedOfficialStatus === 'LEAN') return 'WATCH';
  return 'PASS';
}

function deriveWebhookBucket(payload, context = {}) {
  const isNhlTotal = context?.isNhlTotal === true;
  const is1P = context?.is1P === true;

  // EVIDENCE cards are context drivers — never standalone bet rows.
  if (payload?.kind === 'EVIDENCE' && !is1P) return 'pass_blocked';

  let bucket;
  if (isNhlTotal && payload?.nhl_totals_status && typeof payload.nhl_totals_status === 'object') {
    const status = toUpperToken(payload.nhl_totals_status.status);
    bucket =
      status === 'PLAY'
        ? 'official'
        : status === 'SLIGHT EDGE'
          ? 'lean'
          : 'pass_blocked';
  } else if (is1P && payload?.nhl_1p_decision && typeof payload.nhl_1p_decision === 'object') {
    const status = toUpperToken(payload.nhl_1p_decision.surfaced_status);
    bucket =
      status === 'PLAY'
        ? 'official'
        : status.includes('SLIGHT') || status === 'LEAN'
          ? 'lean'
          : 'pass_blocked';
  } else {
    // Prefer pre-resolved canonical state (set by the publish boundary).
    // This is the authoritative path; the legacy fallback below is for old
    // payloads that pre-date final_play_state.
    const finalPlayState = toUpperToken(payload?.final_play_state);
    if (finalPlayState === 'OFFICIAL_PLAY') {
      bucket = 'official';
    } else if (finalPlayState === 'LEAN') {
      bucket = 'lean';
    } else if (finalPlayState) {
      // WATCH, NO_PLAY, BLOCKED → pass_blocked in Discord.
      // WATCH is not "Slight Edge"; it is blocked until condition resolves.
      bucket = 'pass_blocked';
    } else {
      // Legacy fallback for payloads that pre-date final_play_state.
      const officialStatus = normalizeOfficialStatus(payload?.decision_v2?.official_status);
      const rootAction = toUpperToken(payload?.action || payload?.play?.action || payload?.status);
      const rootClass = toUpperToken(payload?.classification || payload?.play?.classification);

      if (officialStatus === 'PLAY' || rootAction === 'FIRE' || rootClass === 'BASE') {
        bucket = 'official';
      } else if (
        officialStatus === 'LEAN' ||
        ['HOLD', 'WATCH', 'LEAN', 'EVIDENCE'].includes(rootAction) ||
        rootClass === 'LEAN'
      ) {
        bucket = 'lean';
      } else {
        bucket = 'pass_blocked';
      }
    }
  }

  const forcePassAction = toUpperToken(payload?.action || payload?.play?.action);
  const forcePassClass = toUpperToken(payload?.classification || payload?.play?.classification);
  if (forcePassAction === 'PASS' || forcePassClass === 'PASS') {
    return 'pass_blocked';
  }

  return bucket;
}

function deriveWebhookReasonCode(payload, bucket) {
  if (bucket !== 'pass_blocked') return null;

  const reasonCodes = collectReasonCodes(payload);
  return reasonCodes[0] || 'PASS_NO_EDGE';
}

function resolveWebhookDisplaySide(payload) {
  const rawSide =
    payload?.nhl_1p_decision?.projection?.side ||
    payload?.selection?.side ||
    payload?.prediction ||
    null;
  return rawSide ? toUpperToken(rawSide) : null;
}

function isWebhookLeanEligible(payload, minEdge = 0.15) {
  const edgeRaw = payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp;
  if (edgeRaw !== null && edgeRaw !== undefined && Number.isFinite(Number(edgeRaw))) {
    return Math.abs(Number(edgeRaw)) >= Number(minEdge);
  }
  return true;
}

module.exports = {
  // Canonical play-state contract
  CANONICAL_PLAY_STATES,
  WATCH_REASON_CODES,
  HARD_GATE_CODES,
  resolveCanonicalPlayState,
  // Webhook / Discord surface helpers
  deriveWebhookBucket,
  collectReasonCodes,
  describeWebhookReason,
  deriveWebhookWatchState,
  deriveWebhookWouldBecomePlay,
  deriveWebhookDropToPass,
  deriveWebhookReasonCode,
  // Decision envelope helpers
  deriveLegacyDecisionEnvelope,
  deriveUiDisplayStatus,
  isWebhookLeanEligible,
  mapActionToClassification,
  resolveWebhookDisplaySide,
  normalizeOfficialStatus,
  normalizeOfficialStatusFromPayload,
  isOfficialStatusActionable,
  rankOfficialStatus,
};