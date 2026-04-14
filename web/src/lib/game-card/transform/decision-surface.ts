import type { DecisionV2, FinalMarketDecision } from '../../types';

type GoalieStatus = 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null | undefined;

interface BuildFinalMarketDecisionInput {
  decisionV2?: DecisionV2 | null;
  reasonCodes?: string[];
  passReasonCode?: string | null;
  edge?: number | null;
  goalieHomeStatus?: GoalieStatus;
  goalieAwayStatus?: GoalieStatus;
}

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
  const allCodes = new Set((codes || []).map((code) => toToken(code)));
  if (toToken(decisionV2?.sharp_price_status) === 'PENDING_VERIFICATION') return 'PENDING';
  if (allCodes.has('EDGE_VERIFICATION_REQUIRED') || allCodes.has('BLOCKED_BET_VERIFICATION_REQUIRED')) return 'PENDING';
  if (allCodes.has('PASS_DATA_ERROR') || allCodes.has('MISSING_DATA_NO_ODDS')) return 'FAILED';
  return 'VERIFIED';
}

function resolveMarketStable(codes?: string[]): boolean {
  const allCodes = new Set((codes || []).map((code) => toToken(code)));
  return !(
    allCodes.has('EDGE_VERIFICATION_REQUIRED') ||
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
  if (code === 'EDGE_VERIFICATION_REQUIRED') return 'Waiting on line verification';
  if (code.includes('GOALIE')) return 'Waiting on goalie confirmation';
  if (code === 'GATE_LINE_MOVEMENT') return 'Line moved - re-evaluating';
  return code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
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

  let surfacedStatus = mapOfficialToSurfaced(decisionV2?.official_status);
  const certaintyState = resolveCertaintyState(input.goalieHomeStatus, input.goalieAwayStatus);
  const verificationState = resolveVerificationState(decisionV2, reasonCodes);
  const marketStable = resolveMarketStable(reasonCodes);

  if (verificationState === 'FAILED') surfacedStatus = 'PASS';
  if (verificationState === 'PENDING' && surfacedStatus === 'PLAY') surfacedStatus = 'SLIGHT EDGE';

  if (certaintyState === 'UNCONFIRMED') surfacedStatus = 'PASS';
  if (certaintyState === 'PARTIAL' && surfacedStatus === 'PLAY') surfacedStatus = 'SLIGHT EDGE';

  if (!marketStable && surfacedStatus === 'PLAY') surfacedStatus = 'SLIGHT EDGE';

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
    certaintyState !== 'UNCONFIRMED' &&
    marketStable;

  return {
    surfaced_status: surfacedStatus,
    surfaced_reason: mapSurfacedReason(decisionV2?.primary_reason_code, input.passReasonCode),
    model_strength: mapModelStrength(decisionV2?.play_tier),
    model_edge_pct: modelEdgePct,
    fair_price: fairPrice,
    verification_state: verificationState,
    certainty_state: certaintyState,
    market_stable: marketStable,
    line_verified: verificationState === 'VERIFIED' && marketStable,
    show_model_context: showModelContext,
  };
}
