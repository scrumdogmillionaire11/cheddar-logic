// Inlines pure decision-authority logic from packages/models/src/decision-authority.js
// to avoid importing @cheddar-logic/models which pulls in better-sqlite3 (server-only).

export type RuntimeCanonicalDecision = {
  officialStatus: 'PLAY' | 'LEAN' | 'PASS';
  action: 'FIRE' | 'HOLD' | 'PASS';
  classification: 'BASE' | 'LEAN' | 'PASS';
  status: 'FIRE' | 'WATCH' | 'PASS';
  isActionable: boolean;
  reasonCode: string;
  missingCanonicalDecision: boolean;
};

type CanonicalDecisionPayload = {
  decision_v2?: Record<string, unknown> | null;
  canonical_decision?: Record<string, unknown> | null;
  action?: unknown;
  classification?: unknown;
  status?: unknown;
  pass_reason_code?: unknown;
};

type ReadRuntimeDecisionOptions = {
  stage?: 'parser' | 'model' | 'publisher' | 'watchdog' | 'read_api';
};

const CANONICAL_DECISION_SOURCE = 'decision_authority';
const MISSING_CANONICAL_DECISION_REASON = 'MISSING_CANONICAL_DECISION';

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toUpperToken(value: unknown): string {
  const token = asString(value);
  return token ? token.toUpperCase() : '';
}

function normalizeAuthorityStatus(value: unknown): 'PLAY' | 'SLIGHT_EDGE' | 'PASS' {
  const token = toUpperToken(value);
  if (token === 'PLAY' || token === 'FIRE' || token === 'OFFICIAL_PLAY') return 'PLAY';
  if (
    token === 'SLIGHT_EDGE' ||
    token === 'SLIGHT EDGE' ||
    token === 'LEAN' ||
    token === 'WATCH'
  )
    return 'SLIGHT_EDGE';
  return 'PASS';
}

function isCanonicalDecisionActionable(value: unknown): boolean {
  const normalized = normalizeAuthorityStatus(value);
  return normalized === 'PLAY' || normalized === 'SLIGHT_EDGE';
}

function mapLegacyActionToAuthorityStatus(
  payload: CanonicalDecisionPayload,
): 'PLAY' | 'SLIGHT_EDGE' | 'PASS' {
  const action = toUpperToken(payload?.action);
  const classification = toUpperToken(payload?.classification);
  const status = toUpperToken(payload?.status);

  if (
    action === 'FIRE' ||
    classification === 'BASE' ||
    status === 'FIRE' ||
    status === 'PLAY'
  )
    return 'PLAY';

  if (
    action === 'HOLD' ||
    classification === 'LEAN' ||
    status === 'WATCH' ||
    status === 'LEAN'
  )
    return 'SLIGHT_EDGE';

  return 'PASS';
}

function resolveCanonicalDecisionInternal(
  payload: CanonicalDecisionPayload | null,
  options: {
    stage: string;
    fallbackToLegacy: boolean;
    strictSource: boolean;
    missingReasonCode: string;
  },
): {
  official_status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
  is_actionable: boolean;
  reason_code: string;
} | null {
  const { fallbackToLegacy, strictSource, missingReasonCode } = options;

  const decisionV2 =
    payload?.decision_v2 && typeof payload.decision_v2 === 'object'
      ? payload.decision_v2
      : null;

  const declaredSource =
    asString(
      (payload?.canonical_decision as Record<string, unknown> | null)?.source,
    ) || asString(decisionV2?.source);
  if (strictSource && declaredSource && declaredSource !== CANONICAL_DECISION_SOURCE) {
    return null;
  }

  const explicitStatus =
    (payload?.canonical_decision as Record<string, unknown> | null)?.official_status ||
    decisionV2?.official_status ||
    null;

  if (!explicitStatus && !fallbackToLegacy) {
    return null;
  }

  const officialStatus = explicitStatus
    ? normalizeAuthorityStatus(explicitStatus)
    : mapLegacyActionToAuthorityStatus(payload!);

  const reasonCode =
    asString(
      (payload?.canonical_decision as Record<string, unknown> | null)?.reason_code,
    ) ||
    asString(decisionV2?.primary_reason_code) ||
    asString(payload?.pass_reason_code) ||
    missingReasonCode;

  return {
    official_status: officialStatus,
    is_actionable: isCanonicalDecisionActionable(officialStatus),
    reason_code: reasonCode,
  };
}

function canonicalStatusToOfficialStatus(
  status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS',
): 'PLAY' | 'LEAN' | 'PASS' {
  if (status === 'PLAY') return 'PLAY';
  if (status === 'SLIGHT_EDGE') return 'LEAN';
  return 'PASS';
}

function actionFromOfficialStatus(
  officialStatus: 'PLAY' | 'LEAN' | 'PASS',
): 'FIRE' | 'HOLD' | 'PASS' {
  if (officialStatus === 'PLAY') return 'FIRE';
  if (officialStatus === 'LEAN') return 'HOLD';
  return 'PASS';
}

function classificationFromAction(
  action: 'FIRE' | 'HOLD' | 'PASS',
): 'BASE' | 'LEAN' | 'PASS' {
  if (action === 'FIRE') return 'BASE';
  if (action === 'HOLD') return 'LEAN';
  return 'PASS';
}

function statusFromAction(
  action: 'FIRE' | 'HOLD' | 'PASS',
): 'FIRE' | 'WATCH' | 'PASS' {
  if (action === 'HOLD') return 'WATCH';
  if (action === 'FIRE') return 'FIRE';
  return 'PASS';
}

export function isCanonicalDecisionOnlyEnforced(): boolean {
  return process.env.ENFORCE_CANONICAL_DECISION_ONLY === 'true';
}

export function isCanonicalDecisionStrictTestModeEnabled(): boolean {
  return process.env.ENFORCE_CANONICAL_DECISION_ONLY_STRICT_TEST === 'true';
}

export function readRuntimeCanonicalDecision(
  payload: CanonicalDecisionPayload | null | undefined,
  options: ReadRuntimeDecisionOptions = {},
): RuntimeCanonicalDecision {
  const enforceCanonicalOnly = isCanonicalDecisionOnlyEnforced();
  const strictTestMode = isCanonicalDecisionStrictTestModeEnabled();

  const canonical = resolveCanonicalDecisionInternal(payload ?? null, {
    stage: options.stage ?? 'read_api',
    fallbackToLegacy: !enforceCanonicalOnly,
    strictSource: enforceCanonicalOnly,
    missingReasonCode: MISSING_CANONICAL_DECISION_REASON,
  });

  if (!canonical) {
    if (enforceCanonicalOnly && strictTestMode) {
      throw new Error('Canonical decision missing');
    }

    return {
      officialStatus: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      status: 'PASS',
      isActionable: false,
      reasonCode: MISSING_CANONICAL_DECISION_REASON,
      missingCanonicalDecision: true,
    };
  }

  const officialStatus = canonicalStatusToOfficialStatus(canonical.official_status);
  const action = actionFromOfficialStatus(officialStatus);

  return {
    officialStatus,
    action,
    classification: classificationFromAction(action),
    status: statusFromAction(action),
    isActionable: Boolean(canonical.is_actionable),
    reasonCode: String(canonical.reason_code || MISSING_CANONICAL_DECISION_REASON),
    missingCanonicalDecision: false,
  };
}

export type LifecycleModeForFallback = 'pregame' | 'active';

/** Active mode is fail-closed: never widen from scoped runs to global history. */
export function shouldApplyGlobalRunFallback(lifecycleMode: LifecycleModeForFallback | string): boolean {
  return lifecycleMode !== 'active';
}
