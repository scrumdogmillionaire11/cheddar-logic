const {
  normalizeLegacyDecisionStatus,
  normalizeOfficialDecisionStatus,
  resolveExplicitOfficialDecisionStatus,
  resolveLegacyDecisionStatusToken,
  resolveNormalizedDecisionStatus,
} = require('../src/decision-status');

describe('decision status normalization contract', () => {
  test('decision_v2 official_status is authoritative when explicitly present', () => {
    expect(
      resolveNormalizedDecisionStatus({
        decision_v2: { official_status: 'PLAY' },
        status: 'WATCH',
      }),
    ).toBe('PLAY');

    expect(
      resolveNormalizedDecisionStatus({
        decision_v2: { official_status: 'MAYBE' },
        status: 'FIRE',
      }),
    ).toBe('');
  });

  test('legacy fallback stays strict for actionable statuses only', () => {
    expect(resolveNormalizedDecisionStatus({ status: 'PLAY' })).toBe('PLAY');
    expect(resolveNormalizedDecisionStatus({ status: 'FIRE' })).toBe('PLAY');
    expect(resolveNormalizedDecisionStatus({ status: 'LEAN' })).toBe('LEAN');
    expect(resolveNormalizedDecisionStatus({ status: 'PASS' })).toBe('');
    expect(resolveNormalizedDecisionStatus({ status: 'WATCH' })).toBe('');
    expect(resolveNormalizedDecisionStatus({ status: 'HOLD' })).toBe('');
    expect(resolveNormalizedDecisionStatus({ status: 'MONITOR' })).toBe('');
    expect(resolveNormalizedDecisionStatus({})).toBe('');
  });

  test('normalization helpers preserve explicit PASS and expose legacy token', () => {
    expect(normalizeOfficialDecisionStatus('pass')).toBe('PASS');
    expect(normalizeLegacyDecisionStatus('pass')).toBe('');
    expect(
      resolveExplicitOfficialDecisionStatus({
        decision_v2: { official_status: 'PASS' },
      }),
    ).toBe('PASS');

    expect(
      resolveLegacyDecisionStatusToken({
        status: 'WATCH',
        action: 'FIRE',
      }),
    ).toBe('WATCH');
    expect(resolveLegacyDecisionStatusToken({ action: 'hold' })).toBe('HOLD');
  });
});