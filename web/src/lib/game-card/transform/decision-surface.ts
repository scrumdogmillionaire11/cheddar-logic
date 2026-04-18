import type { DecisionV2, FinalMarketDecision } from '../../types';
import { getReasonCodeLabel } from '../reason-labels';

type GoalieStatus = 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null | undefined;

interface BuildFinalMarketDecisionInput {
  decisionV2?: DecisionV2 | null;
  fallbackOfficialStatus?: 'PLAY' | 'LEAN' | 'PASS' | null;
  reasonCodes?: string[];
  passReasonCode?: string | null;
  edge?: number | null;
  goalieHomeStatus?: GoalieStatus;
  goalieAwayStatus?: GoalieStatus;
}

type ProjectionInputStatus = 'COMPLETE' | 'INCOMPLETE' | 'STALE_FALLBACK';
type MarketVerificationStatus = 'VERIFIED' | 'UNVERIFIED';

const PROJECTION_INCOMPLETE_CODES = new Set([
  'MISSING_DATA_PROJECTION_INPUTS',
  'MISSING_DATA_DRIVERS',
  'MISSING_DATA_TEAM_MAPPING',
  'PASS_MISSING_DRIVER_INPUTS',
  'PASS_DATA_ERROR',
]);

const PROJECTION_STALE_CODES = new Set([
  'PROJECTION_INPUTS_STALE_FALLBACK',
  'TEAM_METRICS_FALLBACK_PREV_DAY',
]);

const MARKET_UNVERIFIED_CODES = new Set([
  'LINE_NOT_CONFIRMED',
  'EDGE_RECHECK_PENDING',
  'PRICE_SYNC_PENDING',
  'MARKET_DATA_STALE',
  'BLOCKED_BET_VERIFICATION_REQUIRED',
  'GATE_LINE_MOVEMENT',
  'MISSING_DATA_NO_ODDS',
  'MARKET_PRICE_MISSING',
]);

const PRIMARY_REASON_PRECEDENCE = [
  // Projection/input truth must win when missing core dependencies.
  'MISSING_DATA_PROJECTION_INPUTS',
  'MISSING_DATA_TEAM_MAPPING',
  'MISSING_DATA_DRIVERS',
  'PASS_MISSING_DRIVER_INPUTS',
  'PROJECTION_INPUTS_STALE_FALLBACK',
  'TEAM_METRICS_FALLBACK_PREV_DAY',
  // Market verification blockers come next.
  'LINE_NOT_CONFIRMED',
  'EDGE_RECHECK_PENDING',
  'EDGE_NO_LONGER_CONFIRMED',
  'PRICE_SYNC_PENDING',
  'MARKET_DATA_STALE',
  'BLOCKED_BET_VERIFICATION_REQUIRED',
  'GATE_LINE_MOVEMENT',
  'MISSING_DATA_NO_ODDS',
  // No-edge reasons are only primary when data/verification are healthy.
  'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
  'NO_EDGE_AT_PRICE',
  'PASS_NO_EDGE',
  'SUPPORT_BELOW_LEAN_THRESHOLD',
  'SUPPORT_BELOW_PLAY_THRESHOLD',
];

function toToken(value: unknown): string {
  return String(value || '').trim().toUpperCase();
}

function toAmerican(prob: number): number | null {
  if (!Number.isFinite(prob) || prob <= 0 || prob >= 1) return null;
  if (prob >= 0.5) return Math.round((-100 * prob) / (1 - prob));
  return Math.round((100 * (1 - prob)) / prob);
}

function resolveCertaintyState(home: GoalieStatus, away: GoalieStatus): FinalMarketDecision['certainty_state'] {
  const statuses = [toToken(home), toToken(away)].filter(Boolean);
  if (statuses.length === 0) return 'CONFIRMED';
  if (statuses.every((s) => s === 'CONFIRMED')) return 'CONFIRMED';
  if (statuses.some((s) => s === 'UNKNOWN' || s === 'CONFLICTING')) return 'UNCONFIRMED';
  return 'PARTIAL';
}

function resolveVerificationState(decisionV2?: DecisionV2 | null, codes?: string[]): FinalMarketDecision['verification_state'] {
  const marketVerificationStatus = resolveMarketVerificationStatus(decisionV2, codes);
  return marketVerificationStatus === 'VERIFIED' ? 'VERIFIED' : 'PENDING';
}

function resolveProjectionInputStatus(codes?: string[]): ProjectionInputStatus {
  const allCodes = new Set((codes || []).map((code) => toToken(code)));
  if (Array.from(PROJECTION_STALE_CODES).some((code) => allCodes.has(code))) {
    return 'STALE_FALLBACK';
  }
  if (Array.from(PROJECTION_INCOMPLETE_CODES).some((code) => allCodes.has(code))) {
    return 'INCOMPLETE';
  }
  return 'COMPLETE';
}

function resolveMarketVerificationStatus(
  decisionV2?: DecisionV2 | null,
  codes?: string[],
): MarketVerificationStatus {
  const allCodes = new Set((codes || []).map((code) => toToken(code)));
  if (toToken(decisionV2?.sharp_price_status) === 'PENDING_VERIFICATION') {
    return 'UNVERIFIED';
  }
  if (Array.from(MARKET_UNVERIFIED_CODES).some((code) => allCodes.has(code))) {
    return 'UNVERIFIED';
  }
  return 'VERIFIED';
}

function resolveMarketStable(codes?: string[]): boolean {
  const allCodes = new Set((codes || []).map((code) => toToken(code)));
  return !(
    allCodes.has('LINE_NOT_CONFIRMED') ||
    allCodes.has('EDGE_RECHECK_PENDING') ||
    allCodes.has('PRICE_SYNC_PENDING') ||
    allCodes.has('MARKET_DATA_STALE') ||
    allCodes.has('BLOCKED_BET_VERIFICATION_REQUIRED') ||
    allCodes.has('GATE_LINE_MOVEMENT')
  );
}

function mapModelStrength(playTier?: string | null): FinalMarketDecision['model_strength'] {
  const token = toToken(playTier);
  if (token === 'BEST') return 'BEST';
  if (token === 'GOOD') return 'GOOD';
  if (token === 'OK') return 'WATCH';
  return null;
}

function mapSurfacedReason(primaryReasonCode?: string | null, passReasonCode?: string | null): string {
  const code = toToken(primaryReasonCode || passReasonCode);
  if (!code) return 'No edge at current price';
  const label = getReasonCodeLabel(code);
  if (label) return label;
  return 'No edge at current price';
}

function resolvePrimaryReasonCode(
  codes: string[],
  primaryReasonCode?: string | null,
  passReasonCode?: string | null,
): string | null {
  const orderedCodes = [
    toToken(primaryReasonCode),
    toToken(passReasonCode),
    ...codes.map((code) => toToken(code)),
  ].filter(Boolean);
  const uniqueCodes = Array.from(new Set(orderedCodes));
  for (const preferred of PRIMARY_REASON_PRECEDENCE) {
    if (uniqueCodes.includes(preferred)) return preferred;
  }
  return uniqueCodes[0] || null;
}

function mapOfficialToSurfaced(official?: string | null): FinalMarketDecision['surfaced_status'] {
  const token = toToken(official);
  if (token === 'PLAY') return 'PLAY';
  if (token === 'LEAN') return 'SLIGHT EDGE';
  return 'PASS';
}

export function buildFinalMarketDecision(input: BuildFinalMarketDecisionInput): FinalMarketDecision {
  const decisionV2 = input.decisionV2 || null;
  const reasonCodes = [
    ...(input.reasonCodes || []),
    ...(decisionV2?.watchdog_reason_codes || []),
    ...(decisionV2?.price_reason_codes || []),
    decisionV2?.primary_reason_code || '',
  ].filter(Boolean);

  let surfacedStatus = mapOfficialToSurfaced(
    decisionV2?.official_status ?? input.fallbackOfficialStatus,
  );
  const certaintyState = resolveCertaintyState(
    input.goalieHomeStatus,
    input.goalieAwayStatus,
  );
  const projectionInputStatus = resolveProjectionInputStatus(reasonCodes);
  const marketVerificationStatus = resolveMarketVerificationStatus(
    decisionV2,
    reasonCodes,
  );
  const verificationState = resolveVerificationState(decisionV2, reasonCodes);
  const marketStable = resolveMarketStable(reasonCodes);

  if (verificationState === 'PENDING' && surfacedStatus === 'PLAY') {
    surfacedStatus = 'SLIGHT EDGE';
  }

  // Incomplete/stale projection inputs cannot be surfaced as trusted edge outcomes.
  if (projectionInputStatus !== 'COMPLETE') {
    surfacedStatus = 'PASS';
  }

  if (certaintyState === 'UNCONFIRMED') surfacedStatus = 'PASS';
  if (certaintyState === 'PARTIAL' && surfacedStatus === 'PLAY') surfacedStatus = 'SLIGHT EDGE';

  if (!marketStable && surfacedStatus === 'PLAY') surfacedStatus = 'SLIGHT EDGE';

  const surfacedReasonCode = resolvePrimaryReasonCode(
    reasonCodes,
    decisionV2?.primary_reason_code,
    input.passReasonCode,
  );

  const modelEdgePct = Number.isFinite(Number(decisionV2?.edge_delta_pct))
    ? Number(decisionV2?.edge_delta_pct)
    : Number.isFinite(Number(decisionV2?.edge_pct))
      ? Number(decisionV2?.edge_pct)
      : Number.isFinite(Number(input.edge))
        ? Number(input.edge)
        : null;

  const fairAmerican = toAmerican(Number(decisionV2?.fair_prob));
  const marketPrice = Number.isFinite(Number(decisionV2?.pricing_trace?.market_price))
    ? Number(decisionV2?.pricing_trace?.market_price)
    : null;
  const fairPrice = fairAmerican === null
    ? null
    : marketPrice === null
      ? `${fairAmerican > 0 ? '+' : ''}${fairAmerican}`
      : `${fairAmerican > 0 ? '+' : ''}${fairAmerican} vs ${marketPrice > 0 ? '+' : ''}${marketPrice}`;

  const showModelContext =
    surfacedStatus !== 'PASS' &&
    verificationState === 'VERIFIED' &&
    projectionInputStatus === 'COMPLETE' &&
    certaintyState !== 'UNCONFIRMED' &&
    marketStable;

  return {
    surfaced_status: surfacedStatus,
    surfaced_reason: mapSurfacedReason(surfacedReasonCode, input.passReasonCode),
    model_strength: mapModelStrength(decisionV2?.play_tier),
    model_edge_pct: modelEdgePct,
    fair_price: fairPrice,
    verification_state: verificationState,
    certainty_state: certaintyState,
    market_verification_status: marketVerificationStatus,
    projection_input_status: projectionInputStatus,
    market_stable: marketStable,
    line_verified: marketVerificationStatus === 'VERIFIED' && marketStable,
    show_model_context: showModelContext,
  };
}
