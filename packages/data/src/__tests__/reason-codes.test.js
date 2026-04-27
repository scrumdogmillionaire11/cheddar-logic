const { BLOCKER_REASON_CODES, REASON_CODE_LABELS, getReasonCodeLabel } = require('../reason-codes');

const NHL_TOTALS_STATUS_REASON_CODES = [
  'PASS_MISSING_REQUIRED_INPUTS',
  'PASS_INTEGRITY_BLOCK',
  'PASS_DIRECTION_MISMATCH',
  'BASE_PLAY_DELTA_GTE_1_0',
  'BASE_SLIGHT_EDGE_DELTA_GTE_0_5',
  'BASE_PASS_DELTA_LT_0_5',
  'CAP_GOALIES_UNCONFIRMED',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY',
  'CAP_MAJOR_INJURY_UNCERTAINTY',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_INJURY_UNCERTAINTY',
  'DOWNGRADE_SLIGHT_EDGE_TO_PASS_INJURY_UNCERTAINTY_THIN_EDGE',
  'FRAGILITY_UNDER_5_5',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5',
  'DOWNGRADE_SLIGHT_EDGE_TO_PASS_UNDER_5_5',
  'FRAGILITY_OVER_6_5_ACCELERANT_BELOW_0_20',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_OVER_6_5',
  'DOWNGRADE_SLIGHT_EDGE_TO_PASS_OVER_6_5',
  'OVER_6_5_ACCELERANT_OK',
  'FLOOR_GUARD_FORCE_PASS_DELTA_LT_0_5',
  'ANTI_FLATTENING_RESTORE_PLAY',
];

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

  test('nhl-totals-status surfaced reason codes are in the canonical registry with labels', () => {
    for (const code of NHL_TOTALS_STATUS_REASON_CODES) {
      expect(REASON_CODE_LABELS[code]).toBeDefined();
      expect(typeof REASON_CODE_LABELS[code]).toBe('string');
      expect(getReasonCodeLabel(code)).toBe(REASON_CODE_LABELS[code]);
    }
  });
});
