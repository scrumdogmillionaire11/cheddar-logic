'use strict';

const {
  deriveLegacyDecisionEnvelope,
  deriveUiDisplayStatus,
  deriveWebhookBucket,
  collectReasonCodes,
  describeWebhookReason,
  deriveWebhookWatchState,
  deriveWebhookWouldBecomePlay,
  deriveWebhookDropToPass,
  deriveWebhookReasonCode,
  isOfficialStatusActionable,
  isWebhookLeanEligible,
  mapActionToClassification,
  normalizeOfficialStatus,
  rankOfficialStatus,
  resolveWebhookDisplaySide,
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

  test('deriveLegacyDecisionEnvelope maps official status to legacy fields', () => {
    expect(deriveLegacyDecisionEnvelope('PLAY')).toEqual({
      classification: 'BASE',
      action: 'FIRE',
      status: 'FIRE',
      passReasonCode: null,
    });
    expect(deriveLegacyDecisionEnvelope('LEAN')).toEqual({
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
      passReasonCode: null,
    });
    expect(deriveLegacyDecisionEnvelope('PASS')).toEqual({
      classification: 'PASS',
      action: 'PASS',
      status: 'PASS',
      passReasonCode: null,
    });
    expect(deriveLegacyDecisionEnvelope('wat')).toEqual({
      classification: 'PASS',
      action: 'PASS',
      status: 'PASS',
      passReasonCode: null,
    });
  });

  test('mapActionToClassification keeps legacy action contract', () => {
    expect(mapActionToClassification('FIRE')).toBe('BASE');
    expect(mapActionToClassification('hold')).toBe('LEAN');
    expect(mapActionToClassification('PASS')).toBe('PASS');
    expect(mapActionToClassification('UNKNOWN')).toBe('PASS');
  });

  test('deriveUiDisplayStatus preserves execution-status and official-status mapping', () => {
    expect(deriveUiDisplayStatus('PROJECTION_ONLY', 'PLAY')).toBe('WATCH');
    expect(deriveUiDisplayStatus('BLOCKED', 'PLAY')).toBe('PASS');
    expect(deriveUiDisplayStatus('EXECUTABLE', 'PLAY')).toBe('PLAY');
    expect(deriveUiDisplayStatus('EXECUTABLE', 'LEAN')).toBe('WATCH');
    expect(deriveUiDisplayStatus('EXECUTABLE', 'PASS')).toBe('PASS');
    expect(deriveUiDisplayStatus('', 'LEAN')).toBe('WATCH');
    expect(deriveUiDisplayStatus('', 'UNKNOWN')).toBe('PASS');
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

  test('collectReasonCodes normalizes and de-duplicates canonical reason order', () => {
    const payload = {
      blocked_reason_code: 'LINE_NOT_CONFIRMED',
      pass_reason_code: 'PASS_EXECUTION_GATE_MIXED_BOOK_SOURCE_MISMATCH',
      reason_codes: ['NO_EDGE_AT_PRICE', 'NO_EDGE_AT_PRICE'],
      decision_v2: {
        primary_reason_code: 'LINE_NOT_CONFIRMED',
      },
    };

    expect(collectReasonCodes(payload)).toEqual([
      'LINE_NOT_CONFIRMED',
      'MIXED_BOOK_SOURCE_MISMATCH',
      'NO_EDGE_AT_PRICE',
    ]);
  });

  test('watch-state helpers derive line-verification state and promotion condition', () => {
    const payload = {
      pass_reason_code: 'LINE_NOT_CONFIRMED',
      selection: { side: 'OVER' },
      line: 8,
      price: 105,
      edge: 0.21,
    };

    expect(deriveWebhookWatchState(payload)).toBe('line not verified');
    expect(deriveWebhookWouldBecomePlay(payload)).toBe(
      'Would become PLAY: OVER 8 if line verifies and edge >= +0.20 holds',
    );
    expect(deriveWebhookDropToPass(payload)).toBe(
      'Drops to PASS: edge < +0.20 or total moves to 8.5',
    );
    expect(describeWebhookReason(payload)).toBe(
      'Line not confirmed',
    );
  });

  test('resolveWebhookDisplaySide prefers nhl_1p projection side then selection then prediction', () => {
    expect(
      resolveWebhookDisplaySide({
        nhl_1p_decision: { projection: { side: 'over' } },
        selection: { side: 'under' },
        prediction: 'under',
      }),
    ).toBe('OVER');

    expect(
      resolveWebhookDisplaySide({
        selection: { side: 'under' },
        prediction: 'over',
      }),
    ).toBe('UNDER');

    expect(resolveWebhookDisplaySide({ prediction: 'over' })).toBe('OVER');
    expect(resolveWebhookDisplaySide({})).toBeNull();
  });

  test('isWebhookLeanEligible enforces absolute edge threshold when edge exists', () => {
    expect(isWebhookLeanEligible({ edge: 0.2 }, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge: -0.2 }, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge: 0.1 }, 0.15)).toBe(false);
  });

  test('isWebhookLeanEligible falls back to true when edge is missing or non-finite', () => {
    expect(isWebhookLeanEligible({}, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge_pct: null }, 0.15)).toBe(true);
    expect(isWebhookLeanEligible({ edge_over_pp: 'abc' }, 0.15)).toBe(true);
  });
});
