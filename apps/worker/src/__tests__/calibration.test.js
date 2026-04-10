'use strict';

const {
  computeBrier,
  computeECE,
} = require('../calibration/calibration-tracker');
const {
  clearCalibrationGateCache,
  resolveCalibrationMarketKey,
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
