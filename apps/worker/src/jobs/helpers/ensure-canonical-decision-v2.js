'use strict';

/**
 * WI-1205: Shared worker-layer helper for guaranteeing decision_v2 canonical envelope.
 *
 * RULES:
 * - Only model jobs (run_*_model.js) may call this.
 * - No web/, packages/data/, packages/models/ imports allowed here.
 * - This is the single truth builder for model-layer decision_v2 production.
 * - MLB/NHL/NBA must import from here — do NOT duplicate this logic in each runner.
 *
 * Contract:
 * - Every payload written via insertCardPayload must pass through ensureCanonicalDecisionV2.
 * - If no valid status signal exists → official_status = 'INVALID', not 'PASS'.
 * - Idempotent: safe to call on payloads that already have decision_v2.
 */

const CANONICAL_DECISION_SOURCE = 'decision_authority';

/**
 * Deduplicate and filter an array of string reason codes.
 * @param {unknown[]} codes
 * @returns {string[]}
 */
function _uniqueReasonCodes(codes = []) {
  return Array.from(
    new Set(
      (Array.isArray(codes) ? codes : [codes]).filter(
        (code) => typeof code === 'string' && code.length > 0,
      ),
    ),
  );
}

/**
 * Normalize a raw status string to a canonical DecisionOutcomeStatus token.
 * Returns 'PLAY', 'LEAN', or 'PASS'. Never returns 'INVALID' (caller handles that case).
 * @param {string} value
 * @returns {'PLAY'|'LEAN'|'PASS'}
 */
function normalizeOfficialStatusForDecisionV2(value) {
  const token = String(value || '').toUpperCase();
  if (token === 'PLAY' || token === 'FIRE' || token === 'BASE') return 'PLAY';
  if (token === 'LEAN' || token === 'WATCH' || token === 'HOLD') return 'LEAN';
  return 'PASS';
}

/**
 * Build a minimal INVALID decision_v2 + canonical_decision for a payload that has no
 * valid status signal. Mutates payload in place.
 * @param {object} payload
 * @param {string} [reasonCode]
 */
function buildInvalidDecisionV2(payload, reasonCode = 'MISSING_DECISION_INPUTS') {
  if (!payload || typeof payload !== 'object') return;
  if (!payload.decision_v2 || typeof payload.decision_v2 !== 'object') {
    payload.decision_v2 = {};
  }
  const rc = payload.decision_v2.primary_reason_code || reasonCode;
  payload.decision_v2.official_status = 'INVALID';
  payload.decision_v2.primary_reason_code = rc;
  payload.decision_v2.source = CANONICAL_DECISION_SOURCE;
  payload.canonical_decision = {
    official_status: 'INVALID',
    is_actionable: false,
    tier: 'INVALID',
    reason_code: rc,
    source: CANONICAL_DECISION_SOURCE,
    lifecycle: [
      {
        stage: 'publisher',
        status: 'INVALID',
        reason_code: rc,
      },
    ],
  };
}

/**
 * Stamp a full canonical decision_v2 envelope on a card payload before DB write.
 *
 * - Reads official_status from decision_v2.official_status, then falls back to
 *   payload.status / payload.action / payload.classification (legacy fields).
 * - If NO valid status signal exists: emits INVALID, not PASS.
 * - Sets decision_v2.source = 'decision_authority' and canonical_decision envelope.
 * - Safe to call on payloads already having decision_v2 (idempotent envelope rebuild).
 *
 * @param {object} payload  card.payloadData (mutated in place)
 */
function ensureCanonicalDecisionV2(payload) {
  if (!payload || typeof payload !== 'object') return;

  if (!payload.decision_v2 || typeof payload.decision_v2 !== 'object') {
    payload.decision_v2 = {};
  }

  const rawStatusSource =
    payload.decision_v2.official_status ||
    payload.status ||
    payload.action ||
    payload.classification;

  // No status signal at all → INVALID, not a silent PASS.
  if (!rawStatusSource) {
    const reasonCode =
      payload.pass_reason_code ||
      payload.gate_reason ||
      payload.blocked_reason_code ||
      payload.decision_v2.primary_reason_code ||
      'MISSING_DECISION_INPUTS';
    buildInvalidDecisionV2(payload, reasonCode);
    return;
  }

  const officialStatus = normalizeOfficialStatusForDecisionV2(rawStatusSource);

  const fallbackReasonCode =
    payload.pass_reason_code ||
    payload.gate_reason ||
    payload.blocked_reason_code ||
    payload.decision_v2.primary_reason_code ||
    'UNKNOWN_REASON';

  const isActionable = officialStatus !== 'PASS';
  const executionStatus =
    payload.execution_status || (officialStatus === 'PASS' ? 'BLOCKED' : 'EXECUTABLE');
  const selectionSide = payload?.selection?.side || payload?.prediction || null;
  const selectionTeam = payload?.selection?.team || null;
  const reasonCodes = _uniqueReasonCodes([
    payload.decision_v2.primary_reason_code,
    payload.pass_reason_code,
    ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
    ...(Array.isArray(payload.decision_v2.price_reason_codes)
      ? payload.decision_v2.price_reason_codes
      : []),
    ...(Array.isArray(payload.decision_v2.watchdog_reason_codes)
      ? payload.decision_v2.watchdog_reason_codes
      : []),
  ]);

  payload.canonical_decision = {
    official_status: officialStatus,
    is_actionable: isActionable,
    tier: officialStatus,
    reason_code: fallbackReasonCode,
    source: CANONICAL_DECISION_SOURCE,
    lifecycle: [
      {
        stage: 'publisher',
        status: officialStatus,
        reason_code: fallbackReasonCode,
      },
    ],
  };
  payload.decision_v2.official_status = officialStatus;
  payload.decision_v2.primary_reason_code =
    payload.decision_v2.primary_reason_code || fallbackReasonCode;
  payload.decision_v2.source = CANONICAL_DECISION_SOURCE;
  payload.decision_v2.canonical_envelope_v2 = {
    official_status: officialStatus,
    authority_status: officialStatus,
    primary_reason_code: payload.decision_v2.primary_reason_code || fallbackReasonCode,
    reason_codes: reasonCodes,
    is_actionable: isActionable,
    execution_status: executionStatus,
    direction: selectionSide,
    selection_side: selectionSide,
    selection_team: selectionTeam,
    source: CANONICAL_DECISION_SOURCE,
    lifecycle: [
      {
        stage: 'publisher',
        status: officialStatus,
        reason_code: payload.decision_v2.primary_reason_code || fallbackReasonCode,
      },
    ],
    publish_ready:
      payload.publish_ready === true || (isActionable && executionStatus === 'EXECUTABLE'),
  };
}

module.exports = {
  ensureCanonicalDecisionV2,
  normalizeOfficialStatusForDecisionV2,
  buildInvalidDecisionV2,
};
