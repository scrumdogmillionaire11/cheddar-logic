const { BLOCKER_REASON_CODES, REASON_CODE_LABELS, getReasonCodeLabel } = require('../reason-codes');

describe('reason-codes canonical registry', () => {
  test('BLOCKER_REASON_CODES is non-empty', () => {
    expect(Array.isArray(BLOCKER_REASON_CODES)).toBe(true);
    expect(BLOCKER_REASON_CODES.length).toBeGreaterThan(0);
  });

  test('REASON_CODE_LABELS covers every BLOCKER_REASON_CODE', () => {
    for (const code of BLOCKER_REASON_CODES) {
      expect(REASON_CODE_LABELS[code]).toBeDefined();
      expect(typeof REASON_CODE_LABELS[code]).toBe('string');
    }
  });

  test('getReasonCodeLabel returns label for known code', () => {
    expect(getReasonCodeLabel('LINE_NOT_CONFIRMED')).toBe('Line not confirmed');
    expect(getReasonCodeLabel('STALE_MARKET')).toBe('Market data stale');
  });

  test('getReasonCodeLabel returns goalie label for GOALIE-prefixed codes', () => {
    expect(getReasonCodeLabel('GATE_GOALIE_UNCONFIRMED')).toBe('Waiting on goalie confirmation');
  });

  test('getReasonCodeLabel returns null for unknown code', () => {
    expect(getReasonCodeLabel('TOTALLY_UNKNOWN_CODE')).toBeNull();
  });

  test('getReasonCodeLabel returns null for empty input', () => {
    expect(getReasonCodeLabel(null)).toBeNull();
    expect(getReasonCodeLabel('')).toBeNull();
    expect(getReasonCodeLabel(undefined)).toBeNull();
  });
});
