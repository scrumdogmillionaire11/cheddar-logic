'use strict';

// WI-0829: Unit tests for computeResidual
const { computeResidual } = require('../residual-projection');

describe('computeResidual', () => {
  test('model > consensus OVER: residual=0.9, direction=OVER, source=MODEL_VS_MARKET', () => {
    const result = computeResidual(6.4, 5.5, 'OVER');
    expect(result).not.toBeNull();
    expect(result.residual).toBeCloseTo(0.9, 3);
    expect(result.direction).toBe('OVER');
    expect(result.source).toBe('MODEL_VS_MARKET');
    // residualProb is 1-CDF(z) where z = 0.9/1.8 = 0.5; valid probability in [0,1]
    expect(result.residualProb).toBeGreaterThanOrEqual(0);
    expect(result.residualProb).toBeLessThanOrEqual(1.0);
  });

  test('exact match: direction=NEUTRAL', () => {
    const result = computeResidual(5.5, 5.5, 'OVER');
    expect(result.direction).toBe('NEUTRAL');
    expect(result.residual).toBeCloseTo(0, 3);
  });

  test('model < consensus OVER: direction=UNDER', () => {
    const result = computeResidual(5.0, 5.5, 'OVER');
    expect(result.direction).toBe('UNDER');
    expect(result.residual).toBeCloseTo(-0.5, 3);
  });

  test('null modelFairLine returns null', () => {
    expect(computeResidual(null, 5.5, 'OVER')).toBeNull();
  });

  test('null consensusLine returns null', () => {
    expect(computeResidual(5.5, null, 'OVER')).toBeNull();
  });

  test('HOME side: model > consensus gives direction=HOME', () => {
    const result = computeResidual(105, 103, 'HOME');
    expect(result.direction).toBe('HOME');
    expect(result.residual).toBeCloseTo(2, 3);
  });

  test('HOME side: model < consensus gives direction=AWAY', () => {
    const result = computeResidual(101, 103, 'HOME');
    expect(result.direction).toBe('AWAY');
    expect(result.residual).toBeCloseTo(-2, 3);
  });

  test('residualProb is between 0 and 1 for any finite inputs', () => {
    const cases = [
      [1.0, 10.0, 'OVER'],
      [10.0, 1.0, 'OVER'],
      [100.0, 100.0, 'HOME'],
      [0.1, 0.1, 'OVER'],
    ];
    for (const [a, b, side] of cases) {
      const result = computeResidual(a, b, side);
      expect(result.residualProb).toBeGreaterThanOrEqual(0);
      expect(result.residualProb).toBeLessThanOrEqual(1);
    }
  });

  test('small residual (< 0.15 abs) gives NEUTRAL regardless of side', () => {
    const over = computeResidual(5.51, 5.5, 'OVER');
    expect(over.direction).toBe('NEUTRAL');
    const home = computeResidual(103.01, 103.0, 'HOME');
    expect(home.direction).toBe('NEUTRAL');
  });

  test('UNDER side: negative residual gives direction=UNDER when side is OVER', () => {
    const result = computeResidual(5.0, 6.0, 'UNDER');
    // residual = 5.0 - 6.0 = -1.0; side is UNDER; direction should be UNDER
    expect(result.direction).toBe('UNDER');
  });
});
