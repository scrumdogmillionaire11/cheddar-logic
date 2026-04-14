'use strict';

const {
  deriveWebhookBucket,
  deriveWebhookReasonCode,
  isOfficialStatusActionable,
  normalizeOfficialStatus,
  rankOfficialStatus,
} = require('../decision-policy');

describe('decision-policy helpers', () => {
  test('normalizeOfficialStatus accepts canonical values and uppercases', () => {
    expect(normalizeOfficialStatus('play')).toBe('PLAY');
    expect(normalizeOfficialStatus('LEAN')).toBe('LEAN');
    expect(normalizeOfficialStatus(' pass ')).toBe('PASS');
  });

  test('normalizeOfficialStatus returns empty token for unknown values', () => {
    expect(normalizeOfficialStatus('WATCH')).toBe('');
    expect(normalizeOfficialStatus(null)).toBe('');
    expect(normalizeOfficialStatus(undefined)).toBe('');
  });

  test('isOfficialStatusActionable only allows PLAY and LEAN', () => {
    expect(isOfficialStatusActionable('PLAY')).toBe(true);
    expect(isOfficialStatusActionable('lean')).toBe(true);
    expect(isOfficialStatusActionable('PASS')).toBe(false);
    expect(isOfficialStatusActionable('WATCH')).toBe(false);
  });

  test('rankOfficialStatus keeps deterministic ordering', () => {
    expect(rankOfficialStatus('PLAY')).toBe(2);
    expect(rankOfficialStatus('LEAN')).toBe(1);
    expect(rankOfficialStatus('PASS')).toBe(0);
    expect(rankOfficialStatus('UNKNOWN')).toBe(0);
  });

  test('deriveWebhookBucket maps NHL totals status using canonical policy', () => {
    const payload = {
      nhl_totals_status: { status: 'SLIGHT EDGE' },
      action: 'HOLD',
      classification: 'LEAN',
    };

    expect(deriveWebhookBucket(payload, { isNhlTotal: true })).toBe('lean');
  });

  test('deriveWebhookBucket maps 1P surfaced status with slight edge handling', () => {
    const payload = {
      nhl_1p_decision: { surfaced_status: 'SLIGHT EDGE' },
    };

    expect(deriveWebhookBucket(payload, { is1P: true })).toBe('lean');
  });

  test('deriveWebhookBucket applies pass override regardless of prior bucket', () => {
    const payload = {
      decision_v2: { official_status: 'PLAY' },
      action: 'PASS',
    };

    expect(deriveWebhookBucket(payload)).toBe('pass_blocked');
  });

  test('deriveWebhookReasonCode emits reason only for pass_blocked bucket', () => {
    const payload = {
      pass_reason_code: 'PASS_POLICY_GATE',
      nhl_totals_status: { reasonCodes: ['NHL_TOTALS_PASS'] },
    };

    expect(deriveWebhookReasonCode(payload, 'pass_blocked')).toBe('PASS_POLICY_GATE');
    expect(deriveWebhookReasonCode(payload, 'official')).toBeNull();
  });
});
