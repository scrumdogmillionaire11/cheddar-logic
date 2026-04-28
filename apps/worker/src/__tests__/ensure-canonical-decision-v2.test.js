'use strict';

/**
 * WI-1205: Shared helper contract tests for ensureCanonicalDecisionV2.
 */

const {
  ensureCanonicalDecisionV2,
  normalizeOfficialStatusForDecisionV2,
  buildInvalidDecisionV2,
} = require('../jobs/helpers/ensure-canonical-decision-v2.js');

describe('normalizeOfficialStatusForDecisionV2', () => {
  test.each([
    ['PLAY', 'PLAY'], ['FIRE', 'PLAY'], ['BASE', 'PLAY'], ['play', 'PLAY'],
    ['LEAN', 'LEAN'], ['WATCH', 'LEAN'], ['HOLD', 'LEAN'],
    ['PASS', 'PASS'], ['pass', 'PASS'], ['anything_else', 'PASS'], ['', 'PASS'],
  ])("'%s' → '%s'", (input, expected) => {
    expect(normalizeOfficialStatusForDecisionV2(input)).toBe(expected);
  });
});

describe('buildInvalidDecisionV2', () => {
  test('writes INVALID envelope with provided reason code', () => {
    const payload = { decision_v2: {} };
    buildInvalidDecisionV2(payload, 'NO_MARKET_DATA');
    expect(payload.decision_v2.official_status).toBe('INVALID');
    expect(payload.decision_v2.primary_reason_code).toBe('NO_MARKET_DATA');
    expect(payload.decision_v2.source).toBe('decision_authority');
    expect(payload.canonical_decision).toMatchObject({
      official_status: 'INVALID', is_actionable: false, tier: 'INVALID',
      reason_code: 'NO_MARKET_DATA', source: 'decision_authority',
    });
    expect(payload.canonical_decision.lifecycle[0]).toMatchObject({
      stage: 'publisher', status: 'INVALID', reason_code: 'NO_MARKET_DATA',
    });
  });

  test('defaults reason code to MISSING_DECISION_INPUTS when none provided', () => {
    const payload = {};
    buildInvalidDecisionV2(payload);
    expect(payload.decision_v2.primary_reason_code).toBe('MISSING_DECISION_INPUTS');
  });
});

describe('ensureCanonicalDecisionV2 — PLAY card', () => {
  test('stamps full canonical envelope with PLAY status', () => {
    const payload = {
      status: 'PLAY', action: 'play', pass_reason_code: 'STRONG_EDGE',
      execution_status: 'EXECUTABLE', reason_codes: ['EDGE_ABOVE_THRESHOLD'],
      decision_v2: { price_reason_codes: ['SHARP_LINE'] },
    };
    ensureCanonicalDecisionV2(payload);
    expect(payload.decision_v2).toMatchObject({ official_status: 'PLAY', source: 'decision_authority' });
    expect(payload.decision_v2.canonical_envelope_v2).toMatchObject({
      official_status: 'PLAY', authority_status: 'PLAY',
      is_actionable: true, execution_status: 'EXECUTABLE', source: 'decision_authority',
    });
    expect(Array.isArray(payload.decision_v2.canonical_envelope_v2.reason_codes)).toBe(true);
    expect(payload.canonical_decision).toMatchObject({
      official_status: 'PLAY', is_actionable: true, tier: 'PLAY', source: 'decision_authority',
    });
    expect(payload.canonical_decision.lifecycle[0]).toMatchObject({ stage: 'publisher', status: 'PLAY' });
  });
});

describe('ensureCanonicalDecisionV2 — PASS/projection card', () => {
  test('stamps canonical envelope with PASS status and is_actionable=false', () => {
    const payload = { status: 'PASS', pass_reason_code: 'PROJECTION_ONLY', execution_status: 'BLOCKED' };
    ensureCanonicalDecisionV2(payload);
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.source).toBe('decision_authority');
    expect(payload.decision_v2.canonical_envelope_v2.is_actionable).toBe(false);
    expect(payload.canonical_decision).toMatchObject({ official_status: 'PASS', is_actionable: false });
  });
});

describe('ensureCanonicalDecisionV2 — INVALID when no status signal', () => {
  test('emits INVALID (not PASS) when payload has no status/action/classification/decision_v2.official_status', () => {
    const payload = { some_other_field: 'value' };
    ensureCanonicalDecisionV2(payload);
    expect(payload.decision_v2.official_status).toBe('INVALID');
    expect(payload.decision_v2.primary_reason_code).toBe('MISSING_DECISION_INPUTS');
    expect(payload.decision_v2.source).toBe('decision_authority');
    expect(payload.canonical_decision).toMatchObject({ official_status: 'INVALID', is_actionable: false });
    expect(payload.canonical_decision.lifecycle[0].status).toBe('INVALID');
    expect(payload.decision_v2.canonical_envelope_v2).toBeUndefined();
  });

  test('prefers payload.pass_reason_code as INVALID reason when present', () => {
    const payload = { pass_reason_code: 'CUSTOM_REASON' };
    ensureCanonicalDecisionV2(payload);
    expect(payload.decision_v2.primary_reason_code).toBe('CUSTOM_REASON');
  });
});

describe('ensureCanonicalDecisionV2 — idempotency', () => {
  test('calling twice does not change official_status', () => {
    const payload = { status: 'LEAN', execution_status: 'EXECUTABLE' };
    ensureCanonicalDecisionV2(payload);
    const afterFirst = payload.decision_v2.official_status;
    ensureCanonicalDecisionV2(payload);
    expect(payload.decision_v2.official_status).toBe(afterFirst);
    expect(payload.canonical_decision.official_status).toBe(afterFirst);
  });
});

describe('ensureCanonicalDecisionV2 — null/non-object payloads', () => {
  test.each([null, undefined, 'string', 42])('does not throw for %p', (input) => {
    expect(() => ensureCanonicalDecisionV2(input)).not.toThrow();
  });
});

describe('ensureCanonicalDecisionV2 — reason_codes deduplication', () => {
  test('deduplicates reason codes from all sources', () => {
    const payload = {
      status: 'PASS',
      reason_codes: ['CODE_A', 'CODE_B', 'CODE_A'],
      decision_v2: { price_reason_codes: ['CODE_B', 'CODE_C'], watchdog_reason_codes: ['CODE_C', 'CODE_D'] },
    };
    ensureCanonicalDecisionV2(payload);
    const { reason_codes } = payload.decision_v2.canonical_envelope_v2;
    expect(reason_codes).toEqual(expect.arrayContaining(['CODE_A', 'CODE_B', 'CODE_C', 'CODE_D']));
    expect(reason_codes.length).toBe(new Set(reason_codes).size);
  });
});
