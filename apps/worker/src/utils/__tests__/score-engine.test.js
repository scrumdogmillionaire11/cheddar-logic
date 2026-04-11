'use strict';

/**
 * Unit tests for score-engine.js (WI-0830).
 *
 * Uses Jest globals. Does NOT use node:test.
 */

const { aggregate } = require('../score-engine');

describe('score-engine aggregate()', () => {
  test('happy path: known feature vector produces expected score', () => {
    // z(wrc+) = (115 - 100) / 14 ≈ 1.071 → contribution = 0.6 * 1.071 ≈ 0.643
    // z(xwoba) = (0.340 - 0.320) / 0.018 ≈ 1.111 → contribution = 0.4 * 1.111 ≈ 0.444
    // weightedSum = 0.643 + 0.444 = 1.087, totalWeight = 1.0
    // S = 1.087, sigmoid(2 * 1.087) ≈ 0.881 → clamped to 0.8
    const result = aggregate([
      { name: 'wrc_plus', value: 115, mean: 100, std: 14, weight: 0.6 },
      { name: 'xwoba', value: 0.340, mean: 0.320, std: 0.018, weight: 0.4 },
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0.2);
    expect(result.score).toBeLessThanOrEqual(0.8);
    expect(result.contributions).toHaveProperty('wrc_plus');
    expect(result.contributions).toHaveProperty('xwoba');
    expect(result.zScores).toHaveProperty('wrc_plus');
  });

  test('zero-weight feature: contribution is zero', () => {
    const result = aggregate([
      { name: 'main', value: 115, mean: 100, std: 14, weight: 1.0 },
      { name: 'zero_weight', value: 999, mean: 0, std: 1, weight: 0 },
    ]);
    expect(result.contributions.zero_weight).toBe(0);
  });

  test('extreme z-score: clamped at ±3, score stays within [0.2, 0.8]', () => {
    const resultHigh = aggregate([
      { name: 'x', value: 1000, mean: 0, std: 1, weight: 1.0 },
    ]);
    const resultLow = aggregate([
      { name: 'x', value: -1000, mean: 0, std: 1, weight: 1.0 },
    ]);
    expect(resultHigh.score).toBeLessThanOrEqual(0.8);
    expect(resultLow.score).toBeGreaterThanOrEqual(0.2);
    // z should be clamped at 3 / -3
    expect(resultHigh.zScores.x).toBe(3);
    expect(resultLow.zScores.x).toBe(-3);
  });

  test('std=0 guard: does not throw, treats as micro-std', () => {
    expect(() => {
      aggregate([{ name: 'x', value: 1.0, mean: 1.0, std: 0, weight: 1.0 }]);
    }).not.toThrow();
  });

  test('all-neutral features (value === mean): score ≈ 0.5', () => {
    const result = aggregate([
      { name: 'a', value: 100, mean: 100, std: 10, weight: 0.5 },
      { name: 'b', value: 0.320, mean: 0.320, std: 0.020, weight: 0.5 },
    ]);
    expect(result.score).toBeCloseTo(0.5, 3);
  });

  test('outputClampLow/High opts: score respects custom clamp', () => {
    // Force S >> 0 so sigmoid >> 0.5 → approaches custom high
    const result = aggregate(
      [{ name: 'x', value: 1000, mean: 0, std: 1, weight: 1.0 }],
      { outputClampLow: 0.3, outputClampHigh: 0.7 },
    );
    expect(result.score).toBeLessThanOrEqual(0.7);
    expect(result.score).toBeGreaterThanOrEqual(0.3);
  });

  test('null feature value treated as mean (neutral z=0)', () => {
    const withNull = aggregate([
      { name: 'x', value: null, mean: 100, std: 10, weight: 1.0 },
    ]);
    const withMean = aggregate([
      { name: 'x', value: 100, mean: 100, std: 10, weight: 1.0 },
    ]);
    expect(withNull.score).toBeCloseTo(withMean.score, 4);
    expect(withNull.zScores.x).toBe(0);
  });
});
