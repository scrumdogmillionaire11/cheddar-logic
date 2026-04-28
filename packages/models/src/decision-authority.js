const CANONICAL_DECISION_SOURCE = 'decision_authority';

const AUTHORITY_STATUSES = Object.freeze({
  PLAY: 'PLAY',
  SLIGHT_EDGE: 'SLIGHT_EDGE',
  PASS: 'PASS',
  INVALID: 'INVALID',
});

const PIPELINE_OFFICIAL_STATUS = Object.freeze({
  PLAY: 'PLAY',
  LEAN: 'LEAN',
  PASS: 'PASS',
  INVALID: 'INVALID',
});

const DECISION_STAGES = new Set([
  'parser',
  'model',
  'publisher',
  'watchdog',
  'read_api',
]);

const LIFECYCLE_STATUSES = new Set([
  'INVALID',
  'CLEARED',
  'DOWNGRADED',
  'BLOCKED',
  'PASS',
]);

let hasLoggedInvalidEnforcementDisabled = false;

function asString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toUpperToken(value) {
  const token = asString(value);
  return token ? token.toUpperCase() : '';
}

function normalizeAuthorityStatus(value) {
  const token = toUpperToken(value);
  if (token === 'PLAY' || token === 'FIRE' || token === 'OFFICIAL_PLAY') {
    return AUTHORITY_STATUSES.PLAY;
  }
  if (token === 'SLIGHT_EDGE' || token === 'SLIGHT EDGE' || token === 'LEAN' || token === 'WATCH') {
    return AUTHORITY_STATUSES.SLIGHT_EDGE;
  }
  if (token === 'INVALID') {
    return AUTHORITY_STATUSES.INVALID;
  }
  return AUTHORITY_STATUSES.PASS;
}

function toPipelineOfficialStatus(value) {
  const normalized = normalizeAuthorityStatus(value);
  if (normalized === AUTHORITY_STATUSES.PLAY) {
    return PIPELINE_OFFICIAL_STATUS.PLAY;
  }
  if (normalized === AUTHORITY_STATUSES.SLIGHT_EDGE) {
    return PIPELINE_OFFICIAL_STATUS.LEAN;
  }
  if (normalized === AUTHORITY_STATUSES.INVALID) {
    return PIPELINE_OFFICIAL_STATUS.INVALID;
  }
  return PIPELINE_OFFICIAL_STATUS.PASS;
}

function isCanonicalDecisionActionable(value) {
  const normalized = normalizeAuthorityStatus(value);
  return normalized === AUTHORITY_STATUSES.PLAY || normalized === AUTHORITY_STATUSES.SLIGHT_EDGE;
}

function normalizeLifecycleStage(stage) {
  const token = asString(stage);
  if (!token) return null;
  const normalized = token.toLowerCase();
  return DECISION_STAGES.has(normalized) ? normalized : null;
}

function normalizeLifecycleStatus(status) {
  const token = toUpperToken(status);
  return LIFECYCLE_STATUSES.has(token) ? token : null;
}

function buildLifecycleStage(stage, status, reasonCode) {
  const normalizedStage = normalizeLifecycleStage(stage);
  const normalizedStatus = normalizeLifecycleStatus(status);
  if (!normalizedStage || !normalizedStatus) return null;

  return {
    stage: normalizedStage,
    status: normalizedStatus,
    reason_code: asString(reasonCode) || 'UNKNOWN_REASON',
  };
}

function mapLegacyActionToAuthorityStatus(payload) {
  const action = toUpperToken(payload?.action);
  const classification = toUpperToken(payload?.classification);
  const status = toUpperToken(payload?.status);

  if (
    action === 'FIRE' ||
    classification === 'BASE' ||
    status === 'FIRE' ||
    status === 'PLAY'
  ) {
    return AUTHORITY_STATUSES.PLAY;
  }

  if (
    action === 'HOLD' ||
    classification === 'LEAN' ||
    status === 'WATCH' ||
    status === 'LEAN'
  ) {
    return AUTHORITY_STATUSES.SLIGHT_EDGE;
  }

  return AUTHORITY_STATUSES.PASS;
}

function normalizeLifecycle(lifecycle, fallbackStage, fallbackStatus, fallbackReasonCode) {
  const normalized = [];
  const seenStages = new Set();

  for (const item of Array.isArray(lifecycle) ? lifecycle : []) {
    const stage = buildLifecycleStage(item?.stage, item?.status, item?.reason_code);
    if (!stage || seenStages.has(stage.stage)) continue;
    normalized.push(stage);
    seenStages.add(stage.stage);
  }

  const fallback = buildLifecycleStage(fallbackStage, fallbackStatus, fallbackReasonCode);
  if (fallback && !seenStages.has(fallback.stage)) {
    normalized.push(fallback);
  }

  return normalized;
}

function isInvalidDecisionEnforcementEnabled() {
  const enabled = process.env.ENABLE_INVALID_DECISION_ENFORCEMENT !== 'false';
  if (!enabled && !hasLoggedInvalidEnforcementDisabled) {
    hasLoggedInvalidEnforcementDisabled = true;
    console.warn(
      '[decision-authority] ENABLE_INVALID_DECISION_ENFORCEMENT=false: missing canonical decisions will fall back to PASS',
    );
  }
  return enabled;
}

function resolveCanonicalDecision(payload, options = {}) {
  const {
    stage = 'read_api',
    fallbackToLegacy = false,
    strictSource = true,
    missingReasonCode = 'MISSING_DECISION_V2',
  } = options;

  const decisionV2 = payload?.decision_v2 && typeof payload.decision_v2 === 'object'
    ? payload.decision_v2
    : null;

  const declaredSource = asString(payload?.canonical_decision?.source) || asString(decisionV2?.source);
  if (strictSource && declaredSource && declaredSource !== CANONICAL_DECISION_SOURCE) {
    return null;
  }

  const explicitStatus =
    payload?.canonical_decision?.official_status ||
    decisionV2?.official_status ||
    null;

  const invalidEnforcementEnabled = isInvalidDecisionEnforcementEnabled();

  if (!explicitStatus && !fallbackToLegacy) {
    const fallbackStatus = invalidEnforcementEnabled
      ? AUTHORITY_STATUSES.INVALID
      : AUTHORITY_STATUSES.PASS;
    const lifecycleStatus = invalidEnforcementEnabled ? 'INVALID' : 'PASS';

    return {
      official_status: fallbackStatus,
      is_actionable: false,
      tier: fallbackStatus,
      reason_code: missingReasonCode,
      source: CANONICAL_DECISION_SOURCE,
      lifecycle: normalizeLifecycle([], stage, lifecycleStatus, missingReasonCode),
    };
  }

  const officialStatus = explicitStatus
    ? normalizeAuthorityStatus(explicitStatus)
    : mapLegacyActionToAuthorityStatus(payload);

  const reasonCode =
    asString(payload?.canonical_decision?.reason_code) ||
    asString(decisionV2?.primary_reason_code) ||
    asString(payload?.pass_reason_code) ||
    missingReasonCode;

  const rawLifecycle =
    payload?.canonical_decision?.lifecycle ||
    decisionV2?.lifecycle ||
    [];

  const canonicalStatus =
    officialStatus === AUTHORITY_STATUSES.INVALID
      ? 'INVALID'
      : officialStatus === AUTHORITY_STATUSES.PASS
        ? 'PASS'
        : decisionV2?.watchdog_status === 'BLOCKED'
          ? 'BLOCKED'
          : officialStatus === AUTHORITY_STATUSES.SLIGHT_EDGE
            ? 'DOWNGRADED'
            : 'CLEARED';

  const lifecycle = normalizeLifecycle(rawLifecycle, stage, canonicalStatus, reasonCode);

  if (lifecycle.length === 0) {
    const fallback = buildLifecycleStage(stage, canonicalStatus, reasonCode);
    if (fallback) lifecycle.push(fallback);
  }

  return {
    official_status: officialStatus,
    is_actionable: isCanonicalDecisionActionable(officialStatus),
    tier: officialStatus,
    reason_code: reasonCode,
    source: CANONICAL_DECISION_SOURCE,
    lifecycle,
  };
}

module.exports = {
  AUTHORITY_STATUSES,
  PIPELINE_OFFICIAL_STATUS,
  CANONICAL_DECISION_SOURCE,
  normalizeAuthorityStatus,
  toPipelineOfficialStatus,
  isCanonicalDecisionActionable,
  buildLifecycleStage,
  resolveCanonicalDecision,
};
