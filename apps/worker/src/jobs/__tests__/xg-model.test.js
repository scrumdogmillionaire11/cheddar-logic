'use strict';

/**
 * Unit tests for packages/models/src/xg-model.js
 *
 * Coverage:
 *   - poissonPmf: accuracy, edge cases, no NaN/Infinity
 *   - computeXgWinProbs: sum-to-one, home advantage applied, league awareness
 *   - computeXgTotalProb: over+under = 1.0, direction inversion
 *   - applyLeagueHomeAdj: per-spec values, unknown league fallback
 *   - getLeagueSigma: per-spec values, unknown league fallback
 */

const {
  poissonPmf,
  computeXgWinProbs,
  computeXgTotalProb,
  applyLeagueHomeAdj,
  getLeagueSigma,
} = require('@cheddar-logic/models').xgModel;

const TOLERANCE = 0.001; // Acceptable floating-point tolerance for probability sums

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function withinTolerance(a, b, tol = TOLERANCE) {
  return Math.abs(a - b) <= tol;
}

// ---------------------------------------------------------------------------
// poissonPmf
// ---------------------------------------------------------------------------
describe('poissonPmf', () => {
  test('P(0, λ=1.5) ≈ 0.2231 (4dp accuracy)', () => {
    const p = poissonPmf(0, 1.5);
    expect(Math.round(p * 10000) / 10000).toBe(0.2231);
  });

  test('P(1, λ=1.5) ≈ 0.3347 (4dp accuracy)', () => {
    const p = poissonPmf(1, 1.5);
    expect(Math.round(p * 10000) / 10000).toBe(0.3347);
  });

  test('P(2, λ=1.5) ≈ 0.2510 (4dp accuracy)', () => {
    const p = poissonPmf(2, 1.5);
    expect(Math.round(p * 10000) / 10000).toBe(0.2510);
  });

  test('probabilities for λ=1.5 sum to approximately 1.0 over 0..20', () => {
    let sum = 0;
    for (let k = 0; k <= 20; k++) {
      sum += poissonPmf(k, 1.5);
    }
    expect(withinTolerance(sum, 1.0, 0.001)).toBe(true);
  });

  test('returns 0 for negative k', () => {
    expect(poissonPmf(-1, 1.5)).toBe(0);
  });

  test('returns 0 for non-integer k', () => {
    expect(poissonPmf(1.5, 1.5)).toBe(0);
  });

  test('returns 0 for λ <= 0', () => {
    expect(poissonPmf(0, 0)).toBe(0);
    expect(poissonPmf(0, -1)).toBe(0);
  });

  test('never returns NaN for λ in [0.5, 3.5] and k in 0..10', () => {
    for (let lambda = 0.5; lambda <= 3.5; lambda += 0.25) {
      for (let k = 0; k <= 10; k++) {
        const p = poissonPmf(k, lambda);
        expect(Number.isNaN(p)).toBe(false);
        expect(Number.isFinite(p)).toBe(true);
      }
    }
  });

  test('never returns Infinity for λ in [0.5, 3.5]', () => {
    for (let lambda = 0.5; lambda <= 3.5; lambda += 0.5) {
      for (let k = 0; k <= 7; k++) {
        expect(poissonPmf(k, lambda)).not.toBe(Infinity);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// applyLeagueHomeAdj
// ---------------------------------------------------------------------------
describe('applyLeagueHomeAdj', () => {
  test('EPL adds +0.12 to xG', () => {
    expect(applyLeagueHomeAdj(1.20, 'EPL')).toBeCloseTo(1.32, 4);
  });

  test('MLS adds +0.09 to xG', () => {
    expect(applyLeagueHomeAdj(1.00, 'MLS')).toBeCloseTo(1.09, 4);
  });

  test('UCL adds +0.10 to xG', () => {
    expect(applyLeagueHomeAdj(1.50, 'UCL')).toBeCloseTo(1.60, 4);
  });

  test('lowercase league keys are normalized', () => {
    expect(applyLeagueHomeAdj(1.00, 'epl')).toBeCloseTo(1.12, 4);
    expect(applyLeagueHomeAdj(1.00, 'mls')).toBeCloseTo(1.09, 4);
  });

  test('unknown league applies default fallback (does not throw)', () => {
    const result = applyLeagueHomeAdj(1.00, 'UNKNOWN');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(1.00);
  });

  test('returns xG unchanged when xG is not finite', () => {
    expect(applyLeagueHomeAdj(NaN, 'EPL')).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// getLeagueSigma
// ---------------------------------------------------------------------------
describe('getLeagueSigma', () => {
  test('EPL sigma = 1.18', () => {
    expect(getLeagueSigma('EPL')).toBe(1.18);
  });

  test('MLS sigma = 1.24', () => {
    expect(getLeagueSigma('MLS')).toBe(1.24);
  });

  test('UCL sigma = 1.15', () => {
    expect(getLeagueSigma('UCL')).toBe(1.15);
  });

  test('lowercase keys are normalized', () => {
    expect(getLeagueSigma('epl')).toBe(1.18);
    expect(getLeagueSigma('ucl')).toBe(1.15);
  });

  test('unknown league returns safe numeric fallback', () => {
    const sigma = getLeagueSigma('BUNDESLIGA');
    expect(Number.isFinite(sigma)).toBe(true);
    expect(sigma).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// computeXgWinProbs
// ---------------------------------------------------------------------------
describe('computeXgWinProbs', () => {
  test('homeWin + draw + awayWin sums to 1.0 within 0.001 for EPL', () => {
    const { homeWin, draw, awayWin } = computeXgWinProbs({
      homeXg: 1.4,
      awayXg: 1.1,
      league: 'EPL',
    });
    const sum = homeWin + draw + awayWin;
    expect(withinTolerance(sum, 1.0)).toBe(true);
  });

  test('homeWin + draw + awayWin sums to 1.0 for MLS', () => {
    const { homeWin, draw, awayWin } = computeXgWinProbs({
      homeXg: 1.2,
      awayXg: 0.9,
      league: 'MLS',
    });
    expect(withinTolerance(homeWin + draw + awayWin, 1.0)).toBe(true);
  });

  test('homeWin + draw + awayWin sums to 1.0 for UCL', () => {
    const { homeWin, draw, awayWin } = computeXgWinProbs({
      homeXg: 1.8,
      awayXg: 1.3,
      league: 'UCL',
    });
    expect(withinTolerance(homeWin + draw + awayWin, 1.0)).toBe(true);
  });

  test('home team with higher equal xG wins more often when home advantage applied (EPL)', () => {
    const { homeWin, awayWin } = computeXgWinProbs({
      homeXg: 1.2,
      awayXg: 1.2, // equal raw xG, home gets +0.12 EPL adj
      league: 'EPL',
    });
    // EPL home advantage should make homeWin > awayWin
    expect(homeWin).toBeGreaterThan(awayWin);
  });

  test('returns null fields when homeXg is non-finite', () => {
    const result = computeXgWinProbs({ homeXg: NaN, awayXg: 1.2, league: 'EPL' });
    expect(result.homeWin).toBeNull();
    expect(result.draw).toBeNull();
    expect(result.awayWin).toBeNull();
  });

  test('returns null fields when awayXg is non-finite', () => {
    const result = computeXgWinProbs({ homeXg: 1.2, awayXg: undefined, league: 'EPL' });
    expect(result.homeWin).toBeNull();
  });

  test('all probabilities are in [0, 1]', () => {
    const { homeWin, draw, awayWin } = computeXgWinProbs({
      homeXg: 2.0,
      awayXg: 0.5,
      league: 'EPL',
    });
    expect(homeWin).toBeGreaterThanOrEqual(0);
    expect(homeWin).toBeLessThanOrEqual(1);
    expect(draw).toBeGreaterThanOrEqual(0);
    expect(draw).toBeLessThanOrEqual(1);
    expect(awayWin).toBeGreaterThanOrEqual(0);
    expect(awayWin).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// computeXgTotalProb
// ---------------------------------------------------------------------------
describe('computeXgTotalProb', () => {
  test('over + under sum to approximately 1.0 for EPL 2.5 line', () => {
    const pOver = computeXgTotalProb({
      homeXg: 1.4,
      awayXg: 1.1,
      totalLine: 2.5,
      direction: 'over',
      league: 'EPL',
    });
    const pUnder = computeXgTotalProb({
      homeXg: 1.4,
      awayXg: 1.1,
      totalLine: 2.5,
      direction: 'under',
      league: 'EPL',
    });
    expect(withinTolerance(pOver + pUnder, 1.0)).toBe(true);
  });

  test('high combined xG → over probability > 0.5 for low line', () => {
    const pOver = computeXgTotalProb({
      homeXg: 2.0,
      awayXg: 2.0,
      totalLine: 1.5,
      direction: 'over',
      league: 'EPL',
    });
    expect(pOver).toBeGreaterThan(0.5);
  });

  test('low combined xG → under probability > 0.5 for high line', () => {
    const pUnder = computeXgTotalProb({
      homeXg: 0.5,
      awayXg: 0.5,
      totalLine: 4.5,
      direction: 'under',
      league: 'MLS',
    });
    expect(pUnder).toBeGreaterThan(0.5);
  });

  test('returns null for invalid direction', () => {
    const result = computeXgTotalProb({
      homeXg: 1.4,
      awayXg: 1.1,
      totalLine: 2.5,
      direction: 'sideways',
    });
    expect(result).toBeNull();
  });

  test('returns null when homeXg is non-finite', () => {
    const result = computeXgTotalProb({
      homeXg: NaN,
      awayXg: 1.1,
      totalLine: 2.5,
      direction: 'over',
    });
    expect(result).toBeNull();
  });

  test('returns null when totalLine is non-finite', () => {
    const result = computeXgTotalProb({
      homeXg: 1.4,
      awayXg: 1.1,
      totalLine: null,
      direction: 'over',
    });
    expect(result).toBeNull();
  });

  test('result is always in [0, 1] for valid inputs', () => {
    for (const direction of ['over', 'under']) {
      const p = computeXgTotalProb({
        homeXg: 1.3,
        awayXg: 0.9,
        totalLine: 2.5,
        direction,
        league: 'UCL',
      });
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});
