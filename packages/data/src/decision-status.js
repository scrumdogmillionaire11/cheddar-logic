function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function hasOwnNonEmptyValue(source, key) {
  return (
    source &&
    typeof source === 'object' &&
    Object.prototype.hasOwnProperty.call(source, key) &&
    source[key] !== null &&
    source[key] !== undefined &&
    String(source[key]).trim() !== ''
  );
}

function normalizeOfficialDecisionStatus(value) {
  const status = toUpperToken(value);
  if (status === 'PLAY' || status === 'LEAN' || status === 'PASS') {
    return status;
  }
  return '';
}

function normalizeLegacyDecisionStatus(value) {
  const status = toUpperToken(value);
  if (status === 'PLAY' || status === 'FIRE') return 'PLAY';
  if (status === 'LEAN') return 'LEAN';
  return '';
}

function resolveLegacyDecisionStatusToken(payloadData) {
  // DEPRECATED: Use decision_v2.official_status instead.
  // Settlement should consult decision_v2 for authoritative decision status.
  if (hasOwnNonEmptyValue(payloadData, 'status')) {
    return toUpperToken(payloadData.status);
  }
  if (hasOwnNonEmptyValue(payloadData, 'action')) {
    return toUpperToken(payloadData.action);
  }
  return '';
}

function resolveExplicitOfficialDecisionStatus(payloadData) {
  const decisionV2 =
    payloadData?.decision_v2 && typeof payloadData.decision_v2 === 'object'
      ? payloadData.decision_v2
      : null;
  if (!hasOwnNonEmptyValue(decisionV2, 'official_status')) {
    return '';
  }

  return normalizeOfficialDecisionStatus(decisionV2.official_status);
}

function resolveNormalizedDecisionStatus(payloadData) {
  const explicitOfficialStatus = resolveExplicitOfficialDecisionStatus(payloadData);
  const hasExplicitOfficialStatus = hasOwnNonEmptyValue(
    payloadData?.decision_v2,
    'official_status',
  );

  // decision_v2.official_status is authoritative whenever explicitly present.
  if (hasExplicitOfficialStatus) {
    return explicitOfficialStatus;
  }

  return normalizeLegacyDecisionStatus(resolveLegacyDecisionStatusToken(payloadData));
}

module.exports = {
  hasOwnNonEmptyValue,
  normalizeLegacyDecisionStatus,
  normalizeOfficialDecisionStatus,
  resolveExplicitOfficialDecisionStatus,
  resolveLegacyDecisionStatusToken,
  resolveNormalizedDecisionStatus,
  toUpperToken,
};