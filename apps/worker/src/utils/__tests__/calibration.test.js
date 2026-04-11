'use strict';

// WI-0831: calibration utility unit tests
const { fitIsotonic, applyCalibration } = require('../calibration');

describe('fitIsotonic — Pool Adjacent Violators', () => {
  test('monotone input produces correct breakpoints', () => {
    const xs = [0.4, 0.5, 0.6, 0.7];
    const ys = [0, 0, 1, 1];
    const breakpoints = fitIsotonic(xs, ys);
    expect(breakpoints).toBeDefined();
    expect(breakpoints.length).toBeGreaterThan(0);
    // Breakpoints must be sorted ascending by x
    for (let i = 1; i < breakpoints.length; i++) {
      expect(breakpoints[i].x).toBeGreaterThanOrEqual(breakpoints[i - 1].x);
    }
    // y values must be monotone non-decreasing
    for (let i = 1; i < breakpoints.length; i++) {
      expect(breakpoints[i].y).toBeGreaterThanOrEqual(breakpoints[i - 1].y);
    }
  });

  test('PAV produces lower Brier score than raw probabilities', () => {
    const xs = [0.4, 0.5, 0.6, 0.7];
    const ys = [0, 0, 1, 1];
    const breakpoints = fitIsotonic(xs, ys);

    // Brier score of raw probs
    const rawBrier = xs.reduce((sum, x, i) => sum + (x - ys[i]) ** 2, 0) / xs.length;

    // Brier score of calibrated probs
    const calibratedBrier =
      xs.reduce((sum, x, i) => {
        const { calibratedProb } = applyCalibration(x, breakpoints);
        return sum + (calibratedProb - ys[i]) ** 2;
      }, 0) / xs.length;

    expect(calibratedBrier).toBeLessThanOrEqual(rawBrier);
  });

  test('non-monotone input is pooled correctly', () => {
    // Violating sequence: second block average should be pooled with first
    const xs = [0.3, 0.45, 0.6, 0.75];
    const ys = [1, 0, 0, 1]; // non-monotone outcome pattern
    const breakpoints = fitIsotonic(xs, ys);
    // After PAV, y should be monotone non-decreasing
    for (let i = 1; i < breakpoints.length; i++) {
      expect(breakpoints[i].y).toBeGreaterThanOrEqual(breakpoints[i - 1].y - 1e-9);
    }
  });

  test('empty input returns empty breakpoints', () => {
    expect(fitIsotonic([], [])).toEqual([]);
  });

  test('single point returns single breakpoint', () => {
    const bps = fitIsotonic([0.5], [1]);
    expect(bps).toHaveLength(1);
    expect(bps[0].x).toBeCloseTo(0.5);
    expect(bps[0].y).toBeCloseTo(1.0);
  });

  test('throws on mismatched array lengths', () => {
    expect(() => fitIsotonic([0.4, 0.5], [1])).toThrow(TypeError);
  });
});

describe('applyCalibration — linear interpolation', () => {
  const breakpoints = [
    { x: 0.4, y: 0.38 },
    { x: 0.6, y: 0.55 },
  ];

  test('interpolates correctly between breakpoints', () => {
    const { calibratedProb, calibrationSource } = applyCalibration(0.5, breakpoints);
    // Midpoint between (0.4,0.38) and (0.6,0.55): 0.38 + 0.5*(0.55-0.38) = 0.465
    expect(calibratedProb).toBeCloseTo(0.465, 3);
    expect(calibrationSource).toBe('isotonic');
  });

  test('clamps rawProb=0.99 to breakpoint range then [0.01,0.99]', () => {
    const { calibratedProb } = applyCalibration(0.99, breakpoints);
    expect(calibratedProb).toBeLessThanOrEqual(0.99);
    expect(calibratedProb).toBeGreaterThanOrEqual(0.01);
  });

  test('clamps rawProb=0.01 to breakpoint range then [0.01,0.99]', () => {
    const { calibratedProb } = applyCalibration(0.01, breakpoints);
    expect(calibratedProb).toBeLessThanOrEqual(0.99);
    expect(calibratedProb).toBeGreaterThanOrEqual(0.01);
  });

  test('fallback: null breakpoints returns raw prob with source=raw', () => {
    const result = applyCalibration(0.6, null);
    expect(result.calibrationSource).toBe('raw');
    expect(result.calibratedProb).toBe(0.6);
  });

  test('fallback: empty array returns raw prob with source=raw', () => {
    const result = applyCalibration(0.6, []);
    expect(result.calibrationSource).toBe('raw');
    expect(result.calibratedProb).toBe(0.6);
  });

  test('exact match at breakpoint returns correct y', () => {
    const { calibratedProb } = applyCalibration(0.4, breakpoints);
    expect(calibratedProb).toBeCloseTo(0.38, 5);
  });

  test('output is always within [0.01, 0.99]', () => {
    const extremeBreakpoints = [
      { x: 0.01, y: 0.001 }, // would produce < 0.01 without clamping
      { x: 0.99, y: 0.999 }, // would produce > 0.99 without clamping
    ];
    const low = applyCalibration(0.01, extremeBreakpoints);
    expect(low.calibratedProb).toBeGreaterThanOrEqual(0.01);
    const high = applyCalibration(0.99, extremeBreakpoints);
    expect(high.calibratedProb).toBeLessThanOrEqual(0.99);
  });
});
