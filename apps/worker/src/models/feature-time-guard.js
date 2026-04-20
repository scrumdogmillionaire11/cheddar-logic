'use strict';

/**
 * WI-0827: Feature timestamp audit — block future event-time violations.
 *
 * High-risk fields that must have available_at <= betPlacedAt.
 * Violations produce a WARN log, are recorded in card payload metadata, and
 * hard-block executable cards before write.
 */
const HIGH_RISK_FIELDS = [
  'umpire_factor',
  'homeGoalieCertainty',
  'awayGoalieCertainty',
  'homeGoalsForL5',
  'awayGoalsForL5',
  'homeGoalsAgainstL5',
  'awayGoalsAgainstL5',
  'rolling_14d_wrc_plus_vs_hand',
  'pace_anchor_total',
  'blended_total',
  'rest_days_home',
  'rest_days_away',
  'availability_flags',
];

const FEATURE_TIMESTAMP_PASS_REASON_CODE = 'PASS_FEATURE_TIMESTAMP_LEAK';
const FEATURE_TIMESTAMP_PRIMARY_REASON_CODE = 'PASS_EXECUTION_GATE_BLOCKED';

/**
 * Assert that every tracked high-risk feature was available before the bet
 * decision time. Missing/null `available_at` stays fail-open, but is returned
 * in diagnostics so operators can see which tracked fields lack provenance.
 *
 * @param {object} rawData       - parsed raw_data from odds snapshot or card
 * @param {string} betPlacedAt   - ISO8601 timestamp of bet decision
 * @returns {{ ok: boolean, violations: Array<{field: string, available_at: string, bet_placed_at: string}>, missing: Array<{field: string, available_at: null, bet_placed_at: string}>, invalid: Array<{field: string, available_at: string, bet_placed_at: string}> }}
 */
function assertFeatureTimeliness(rawData, betPlacedAt) {
  const timestamps =
    rawData?.feature_timestamps && typeof rawData.feature_timestamps === 'object'
      ? rawData.feature_timestamps
      : {};
  const betTime = new Date(betPlacedAt).getTime();
  const violations = [];
  const missing = [];
  const invalid = [];

  if (!Number.isFinite(betTime)) {
    return { ok: true, violations: [], missing: [], invalid: [] };
  }

  for (const field of HIGH_RISK_FIELDS) {
    const hasTimestamp = Object.prototype.hasOwnProperty.call(timestamps, field);
    const availableAt = timestamps[field];
    if (!hasTimestamp || availableAt == null || availableAt === '') {
      missing.push({ field, available_at: null, bet_placed_at: betPlacedAt });
      continue;
    }
    const availableTime = new Date(availableAt).getTime();
    if (!Number.isFinite(availableTime)) {
      invalid.push({ field, available_at: availableAt, bet_placed_at: betPlacedAt });
      continue;
    }
    if (availableTime > betTime) {
      violations.push({ field, available_at: availableAt, bet_placed_at: betPlacedAt });
    }
  }

  return { ok: violations.length === 0, violations, missing, invalid };
}

function uniqueCodes(codes) {
  return Array.from(new Set((Array.isArray(codes) ? codes : []).filter(Boolean))).sort();
}

function mergeObject(source) {
  return source && typeof source === 'object' ? source : {};
}

/**
 * Mutates a card payload into the deterministic feature-timestamp block state.
 *
 * `pass_reason_code` intentionally carries the operator-facing non-canonical
 * token, while `decision_v2.primary_reason_code` stays on the registered
 * canonical execution-gate token.
 *
 * @param {object} payload
 * @param {object} timeliness
 * @param {{nowMs?: number}} [options]
 * @returns {boolean} true when enforcement mutated the payload
 */
function applyFeatureTimelinessEnforcement(payload, timeliness, { nowMs = Date.now() } = {}) {
  if (!payload || typeof payload !== 'object' || !timeliness || timeliness.ok) {
    return false;
  }

  const diagnostic = {
    ...timeliness,
    enforced: true,
    enforcement_reason_code: FEATURE_TIMESTAMP_PASS_REASON_CODE,
    primary_reason_code: FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
    enforced_at: new Date(nowMs).toISOString(),
  };
  payload.feature_timeliness = diagnostic;

  payload.status = 'PASS';
  payload.action = 'PASS';
  payload.classification = 'PASS';
  payload.ui_display_status = 'PASS';
  payload.execution_status = 'BLOCKED';
  payload.ev_passed = false;
  payload.actionable = false;
  payload.publish_ready = false;
  payload.pass_reason_code = FEATURE_TIMESTAMP_PASS_REASON_CODE;
  payload.reason_codes = uniqueCodes([
    FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
    ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
  ]);

  payload.decision_v2 = {
    ...mergeObject(payload.decision_v2),
    official_status: 'PASS',
    primary_reason_code: FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
  };
  if (
    payload.decision_v2.canonical_envelope_v2 &&
    typeof payload.decision_v2.canonical_envelope_v2 === 'object'
  ) {
    payload.decision_v2.canonical_envelope_v2 = {
      ...payload.decision_v2.canonical_envelope_v2,
      official_status: 'PASS',
      primary_reason_code: FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
      execution_status: 'BLOCKED',
      publish_ready: false,
    };
  }

  const existingGate = mergeObject(payload.execution_gate);
  payload.execution_gate = {
    ...existingGate,
    evaluated: true,
    should_bet: false,
    blocked_by: uniqueCodes([
      FEATURE_TIMESTAMP_PASS_REASON_CODE,
      ...(Array.isArray(existingGate.blocked_by) ? existingGate.blocked_by : []),
    ]),
    hard_blocked_by: uniqueCodes([
      FEATURE_TIMESTAMP_PASS_REASON_CODE,
      ...(Array.isArray(existingGate.hard_blocked_by) ? existingGate.hard_blocked_by : []),
    ]),
    evaluated_at: existingGate.evaluated_at || new Date(nowMs).toISOString(),
    drop_reason: {
      drop_reason_code: FEATURE_TIMESTAMP_PASS_REASON_CODE,
      drop_reason_layer: 'worker_feature_time_guard',
    },
  };

  payload._publish_state = {
    ...mergeObject(payload._publish_state),
    publish_ready: false,
    emit_allowed: true,
    execution_status: 'BLOCKED',
    block_reason: FEATURE_TIMESTAMP_PASS_REASON_CODE,
  };

  return true;
}

module.exports = {
  assertFeatureTimeliness,
  applyFeatureTimelinessEnforcement,
  HIGH_RISK_FIELDS,
  FEATURE_TIMESTAMP_PASS_REASON_CODE,
  FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
};
