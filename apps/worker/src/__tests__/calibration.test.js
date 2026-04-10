'use strict';

const {
  computeBrier,
  computeECE,
} = require('../calibration/calibration-tracker');
const {
  clearCalibrationGateCache,
  resolveCalibrationMarketKey,
  isMarketCalibrationEnabled,
} = require('../calibration/calibration-gate');

describe('computeBrier', () => {
  test('returns null for empty samples', () => {
    expect(computeBrier([])).toBeNull();
  });

  test('perfect predictions produce zero brier score', () => {
    expect(computeBrier([{ fair_prob: 1, outcome: 1 }])).toBeCloseTo(0, 10);
  });

  test('matches reference brier formula', () => {
    const score = computeBrier([
      { fair_prob: 0.8, outcome: 1 },
      { fair_prob: 0.3, outcome: 0 },
    ]);

    expect(score).toBeCloseTo(0.065, 10);
  });
});

describe('computeECE', () => {
  test('returns null for empty samples', () => {
    expect(computeECE([])).toBeNull();
  });

  test('perfect calibration produces zero ece', () => {
    const samples = [
      ...Array.from({ length: 50 }, () => ({ fair_prob: 0.5, outcome: 1 })),
      ...Array.from({ length: 50 }, () => ({ fair_prob: 0.5, outcome: 0 })),
    ];

    expect(computeECE(samples)).toBeCloseTo(0, 10);
  });

  test('systematically overconfident samples produce expected ece', () => {
    const samples = [
      ...Array.from({ length: 50 }, () => ({ fair_prob: 0.7, outcome: 1 })),
      ...Array.from({ length: 50 }, () => ({ fair_prob: 0.7, outcome: 0 })),
    ];

    expect(computeECE(samples)).toBeCloseTo(0.2, 10);
  });
});

describe('resolveCalibrationMarketKey', () => {
  test('maps sport and bet type to total calibration markets', () => {
    expect(resolveCalibrationMarketKey(null, {
      sport: 'NHL',
      recommendedBetType: 'total',
    })).toBe('NHL_TOTAL');

    expect(resolveCalibrationMarketKey(null, {
      sport: 'NBA',
      recommendedBetType: 'total',
    })).toBe('NBA_TOTAL');
  });

  test('maps MLB first-period totals to MLB_F5_TOTAL', () => {
    expect(resolveCalibrationMarketKey(null, {
      sport: 'MLB',
      recommendedBetType: 'total',
      marketType: 'FIRST_PERIOD',
      cardType: 'mlb-f5',
    })).toBe('MLB_F5_TOTAL');
  });
});

describe('evaluateExecution calibration kill switch', () => {
  beforeEach(() => {
    jest.resetModules();
    clearCalibrationGateCache();
  });

  test('returns should_bet false and block_reason when calibration gate is disabled', () => {
    jest.doMock('../calibration/calibration-gate', () => ({
      isMarketCalibrationEnabled: jest.fn(() => false),
    }));

    let evaluateExecution;
    jest.isolateModules(() => {
      ({ evaluateExecution } = require('../jobs/execution-gate'));
    });

    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
      marketKey: 'NBA_TOTAL',
      sport: 'NBA',
      recommendedBetType: 'total',
    });

    expect(result.shouldBet).toBe(false);
    expect(result.should_bet).toBe(false);
    expect(result.block_reason).toBe('CALIBRATION_KILL_SWITCH');
    expect(result.blocked_by).toContain('CALIBRATION_KILL_SWITCH');
  });
});

describe('isMarketCalibrationEnabled kill switch logging (WI-0861)', () => {
  beforeEach(() => {
    clearCalibrationGateCache();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clearCalibrationGateCache();
  });

  test('emits [CALIB_GATE] warn when kill switch is active', () => {
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({
          kill_switch_active: 1,
          ece: 0.09,
          n_samples: 72,
          computed_at: '2026-04-10T04:00:00Z',
        })),
      })),
    };

    const result = isMarketCalibrationEnabled('NBA_TOTAL', { db });

    expect(result).toBe(false);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('[CALIB_GATE]'),
      'NBA_TOTAL',
      0.09,
      72,
      '2026-04-10T04:00:00Z',
    );
  });

  test('does NOT emit [CALIB_GATE] warn when kill switch is inactive', () => {
    const db = {
      prepare: jest.fn(() => ({
        get: jest.fn(() => ({
          kill_switch_active: 0,
          ece: 0.03,
          n_samples: 80,
          computed_at: '2026-04-10T04:00:00Z',
        })),
      })),
    };

    const result = isMarketCalibrationEnabled('NBA_TOTAL', { db });

    expect(result).toBe(true);
    expect(console.warn).not.toHaveBeenCalled();
  });

  test('does NOT emit [CALIB_GATE] warn on cache hit (log once per TTL)', () => {
    const getMock = jest.fn(() => ({
      kill_switch_active: 1,
      ece: 0.09,
      n_samples: 72,
      computed_at: '2026-04-10T04:00:00Z',
    }));
    const db = { prepare: jest.fn(() => ({ get: getMock })) };
    const nowMs = Date.now();

    // First call — cache miss, should warn
    isMarketCalibrationEnabled('NBA_TOTAL', { db, nowMs });
    expect(console.warn).toHaveBeenCalledTimes(1);

    // Second call within TTL — cache hit, should NOT warn again
    isMarketCalibrationEnabled('NBA_TOTAL', { db, nowMs: nowMs + 1000 });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(1); // only one DB hit
  });
});
