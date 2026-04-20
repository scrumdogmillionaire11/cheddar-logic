'use strict';

const {
  assertFeatureTimeliness,
  applyFeatureTimelinessEnforcement,
  HIGH_RISK_FIELDS,
  FEATURE_TIMESTAMP_PASS_REASON_CODE,
  FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
} = require('../feature-time-guard');

const BET_TIME = '2026-04-06T17:00:00Z';

describe('assertFeatureTimeliness', () => {
  test('returns ok=true with empty violations when no feature_timestamps present', () => {
    const result = assertFeatureTimeliness({}, BET_TIME);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.missing).toHaveLength(HIGH_RISK_FIELDS.length);
  });

  test('returns ok=true with empty violations when feature_timestamps is empty object', () => {
    const result = assertFeatureTimeliness({ feature_timestamps: {} }, BET_TIME);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.missing.map((entry) => entry.field)).toEqual(HIGH_RISK_FIELDS);
  });

  test('records fields with null available_at as fail-open diagnostics', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: null } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.missing).toContainEqual({
      field: 'homeGoalieCertainty',
      available_at: null,
      bet_placed_at: BET_TIME,
    });
  });

  test('ok=true when available_at is before bet_placed_at', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: '2026-04-06T12:00:00Z' } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('ok=true when available_at equals bet_placed_at', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { umpire_factor: BET_TIME } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('records violation when available_at is after bet_placed_at', () => {
    const available = '2026-04-06T19:00:00Z'; // 2h after bet
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: available } },
      BET_TIME,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual({
      field: 'homeGoalieCertainty',
      available_at: available,
      bet_placed_at: BET_TIME,
    });
  });

  test('records multiple violations across different fields', () => {
    const result = assertFeatureTimeliness(
      {
        feature_timestamps: {
          homeGoalieCertainty: '2026-04-06T19:00:00Z',
          awayGoalieCertainty: '2026-04-06T20:00:00Z',
          umpire_factor: '2026-04-06T12:00:00Z', // clean
        },
      },
      BET_TIME,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.field).sort()).toEqual([
      'awayGoalieCertainty',
      'homeGoalieCertainty',
    ]);
  });

  test('ignores non-high-risk fields in feature_timestamps', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { some_other_field: '2026-04-07T00:00:00Z' } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('returns ok=true when betPlacedAt is invalid ISO string', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: '2026-04-06T12:00:00Z' } },
      'not-a-date',
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  test('records fields with invalid available_at timestamps as fail-open diagnostics', () => {
    const result = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: 'bad-date' } },
      BET_TIME,
    );
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.invalid).toEqual([
      {
        field: 'homeGoalieCertainty',
        available_at: 'bad-date',
        bet_placed_at: BET_TIME,
      },
    ]);
  });

  test('handles null rawData gracefully', () => {
    const result = assertFeatureTimeliness(null, BET_TIME);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  test('HIGH_RISK_FIELDS exports the expected set', () => {
    expect(HIGH_RISK_FIELDS).toContain('umpire_factor');
    expect(HIGH_RISK_FIELDS).toContain('homeGoalieCertainty');
    expect(HIGH_RISK_FIELDS).toContain('awayGoalieCertainty');
    expect(HIGH_RISK_FIELDS).toContain('homeGoalsForL5');
    expect(HIGH_RISK_FIELDS).toContain('rolling_14d_wrc_plus_vs_hand');
    expect(HIGH_RISK_FIELDS).toContain('pace_anchor_total');
  });
});

describe('applyFeatureTimelinessEnforcement', () => {
  test('hard-blocks executable payloads with deterministic timestamp-leak contract', () => {
    const payload = {
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      execution_status: 'EXECUTABLE',
      ev_passed: true,
      actionable: true,
      publish_ready: true,
      reason_codes: ['EDGE_FOUND'],
      decision_v2: {
        official_status: 'PLAY',
        primary_reason_code: 'EDGE_FOUND',
        canonical_envelope_v2: {
          official_status: 'PLAY',
          primary_reason_code: 'EDGE_FOUND',
          execution_status: 'EXECUTABLE',
          publish_ready: true,
        },
      },
      execution_gate: {
        evaluated: true,
        should_bet: true,
        blocked_by: [],
      },
      _publish_state: {
        publish_ready: true,
        emit_allowed: true,
        execution_status: 'EXECUTABLE',
      },
    };
    const timeliness = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: '2026-04-06T19:00:00Z' } },
      BET_TIME,
    );

    const blocked = applyFeatureTimelinessEnforcement(payload, timeliness, {
      nowMs: new Date('2026-04-06T17:01:00Z').getTime(),
    });

    expect(blocked).toBe(true);
    expect(payload).toMatchObject({
      execution_status: 'BLOCKED',
      status: 'PASS',
      action: 'PASS',
      classification: 'PASS',
      pass_reason_code: FEATURE_TIMESTAMP_PASS_REASON_CODE,
      ev_passed: false,
      actionable: false,
      publish_ready: false,
    });
    expect(payload.decision_v2).toMatchObject({
      official_status: 'PASS',
      primary_reason_code: FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
      canonical_envelope_v2: {
        official_status: 'PASS',
        primary_reason_code: FEATURE_TIMESTAMP_PRIMARY_REASON_CODE,
        execution_status: 'BLOCKED',
        publish_ready: false,
      },
    });
    expect(payload.reason_codes).toContain(FEATURE_TIMESTAMP_PRIMARY_REASON_CODE);
    expect(payload.reason_codes).not.toContain(FEATURE_TIMESTAMP_PASS_REASON_CODE);
    expect(payload.feature_timeliness.violations).toHaveLength(1);
    expect(payload.feature_timeliness.enforced).toBe(true);
    expect(payload.execution_gate).toMatchObject({
      evaluated: true,
      should_bet: false,
      drop_reason: {
        drop_reason_code: FEATURE_TIMESTAMP_PASS_REASON_CODE,
        drop_reason_layer: 'worker_feature_time_guard',
      },
    });
  });

  test('does not mutate payloads when timeliness diagnostics are clean or fail-open missing only', () => {
    const payload = {
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      execution_status: 'EXECUTABLE',
    };
    const timeliness = assertFeatureTimeliness(
      { feature_timestamps: { homeGoalieCertainty: null } },
      BET_TIME,
    );

    expect(applyFeatureTimelinessEnforcement(payload, timeliness)).toBe(false);
    expect(payload).toEqual({
      status: 'FIRE',
      action: 'FIRE',
      classification: 'BASE',
      execution_status: 'EXECUTABLE',
    });
  });
});
