const {
  BLOCKER_REASON_CODES,
  REASON_CODE_LABELS,
  REASON_CODE_SCHEMA_VERSION,
  getReasonCodeLabel,
} = require('../reason-codes');

const NHL_TOTALS_STATUS_REASON_CODES = [
  'PASS_MISSING_REQUIRED_INPUTS',
  'PASS_INTEGRITY_BLOCK',
  'PASS_DIRECTION_MISMATCH',     // legacy path (flag=false); preserved for existing rows
  'PASS_NO_DIRECTIONAL_EDGE',    // WI-1183 rule 1
  'PASS_SIGNAL_DIVERGENCE',      // WI-1183 rule 2
  'PASS_LOW_CONSENSUS',          // WI-1183 rule 3
  'SIGNAL_DIVERGENCE',           // WI-1183 rule 4 flag
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

  test('mlb-model surfaced reason codes are in the canonical registry with labels', () => {
    const MLB_MODEL_REASON_CODES = [
      'PASS_SYNTHETIC_FALLBACK',
      'PASS_DEGRADED_TOTAL_MODEL',
      'PASS_CONFIDENCE_GATE',
      'PASS_MODEL_DEGRADED',
      'PASS_INPUTS_INCOMPLETE',
      'PASS_NO_DISTRIBUTION',
      'PASS_UNKNOWN',
      'PASS_PROJECTION_ONLY_NO_MARKET',
      'MODEL_DEGRADED_INPUTS',
      'MARKET_SANITY_FAIL',
      'SOFT_DEGRADED_TOTAL_MODEL',
      'SOFT_MARKET_SANITY_FAIL',
      'SOFT_WEAK_DRIVER_SUPPORT',
    ];
    for (const code of MLB_MODEL_REASON_CODES) {
      expect(REASON_CODE_LABELS[code]).toBeDefined();
      expect(typeof REASON_CODE_LABELS[code]).toBe('string');
      expect(getReasonCodeLabel(code)).toBe(REASON_CODE_LABELS[code]);
    }
  });

  test('execution-gate drop-reason codes are in the canonical registry with labels', () => {
    const EXECUTION_GATE_REASON_CODES = [
      'PROJECTION_ONLY_EXCLUSION',
    ];
    for (const code of EXECUTION_GATE_REASON_CODES) {
      expect(REASON_CODE_LABELS[code]).toBeDefined();
      expect(typeof REASON_CODE_LABELS[code]).toBe('string');
      expect(getReasonCodeLabel(code)).toBe(REASON_CODE_LABELS[code]);
    }
  });

  test('feature-time-guard reason codes are in the canonical registry with labels', () => {
    const FEATURE_TIME_GUARD_CODES = [
      'PASS_FEATURE_TIMESTAMP_LEAK',
    ];
    for (const code of FEATURE_TIME_GUARD_CODES) {
      expect(REASON_CODE_LABELS[code]).toBeDefined();
      expect(typeof REASON_CODE_LABELS[code]).toBe('string');
      expect(getReasonCodeLabel(code)).toBe(REASON_CODE_LABELS[code]);
    }
  });

  test('REASON_CODE_SCHEMA_VERSION is current (6)', () => {
    expect(REASON_CODE_SCHEMA_VERSION).toBe(6);
  });
});
