'use strict';

const { applyPlayoffSigmaMultiplier } = require('../run_nhl_model');

describe('applyPlayoffSigmaMultiplier sigma contract', () => {
  test('preserves sigma_source from the input', () => {
    const result = applyPlayoffSigmaMultiplier(
      { margin: 1.8, total: 2.0, sigma_source: 'computed', games_sampled: 24 },
      1.15,
    );

    expect(result.sigma_source).toBe('computed');
  });

  test('multiplies margin and total for NHL-shaped sigma payloads', () => {
    const result = applyPlayoffSigmaMultiplier(
      { margin: 2.0, total: 2.5, sigma_source: 'computed', games_sampled: 20 },
      1.1,
    );

    expect(result.margin).toBeCloseTo(2.2, 4);
    expect(result.total).toBeCloseTo(2.75, 4);
  });

  test('does not emit NaN fields when optional inputs are missing', () => {
    const result = applyPlayoffSigmaMultiplier(
      { margin: 1.9, total: 2.1, sigma_source: 'fallback', games_sampled: 8, spread: null },
      1.2,
    );

    Object.values(result).forEach((value) => {
      if (typeof value === 'number') {
        expect(Number.isNaN(value)).toBe(false);
      }
    });
  });

  test('marks the result as adjusted for playoffs', () => {
    const result = applyPlayoffSigmaMultiplier(
      { margin: 1.8, total: 2.0, sigma_source: 'computed' },
      1.1,
    );

    expect(result.adjusted_for_playoffs).toBe(true);
  });

  test('passes nullish sigma through unchanged', () => {
    expect(applyPlayoffSigmaMultiplier(null, 1.1)).toBeNull();
    expect(applyPlayoffSigmaMultiplier(undefined, 1.1)).toBeUndefined();
  });
});
