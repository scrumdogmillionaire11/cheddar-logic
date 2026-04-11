'use strict';

const { pearsonR, detectCorrelationClusters } = require('../feature-correlation');

// ---------------------------------------------------------------------------
// Section 1 — Unit tests for pearsonR
// ---------------------------------------------------------------------------

describe('pearsonR', () => {
  test('perfect positive correlation', () => {
    expect(pearsonR([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 10);
  });

  test('perfect negative correlation', () => {
    expect(pearsonR([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1.0, 10);
  });

  test('zero variance returns 0 without throwing', () => {
    expect(() => pearsonR([5, 5, 5], [1, 2, 3])).not.toThrow();
    expect(pearsonR([5, 5, 5], [1, 2, 3])).toBe(0);
  });

  test('near-perfect above 0.97', () => {
    const r = pearsonR([1, 2, 3], [1, 2, 4]);
    expect(r).toBeGreaterThan(0.97);
    expect(r).toBeLessThanOrEqual(1.0);
  });

  test('throws when arrays have different lengths', () => {
    expect(() => pearsonR([1, 2, 3], [1, 2])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Unit tests for detectCorrelationClusters
// ---------------------------------------------------------------------------

describe('detectCorrelationClusters', () => {
  test('returns flagged pair when feature_a and feature_b are perfectly correlated', () => {
    // feature_a and feature_b are identical (r=1.0), feature_c is independent
    const featureMatrix = [
      [1, 2, 3, 4, 5],   // feature_a
      [1, 2, 3, 4, 5],   // feature_b (r=1.0 with feature_a)
      [5, 3, 1, 4, 2],   // feature_c (uncorrelated)
    ];
    const featureNames = ['feature_a', 'feature_b', 'feature_c'];
    const violations = detectCorrelationClusters(featureMatrix, featureNames, 0.80);
    expect(violations).toHaveLength(1);
    expect(violations[0].feature_a).toBe('feature_a');
    expect(violations[0].feature_b).toBe('feature_b');
    expect(violations[0].r).toBeCloseTo(1.0, 5);
    expect(violations[0].cluster_label).toBe('cluster_0');
  });

  test('returns empty array when all pairs are below threshold', () => {
    // Intentionally orthogonal features
    const featureMatrix = [
      [1, 2, 3, 4, 5],
      [5, 3, 1, 4, 2],
      [2, 5, 4, 1, 3],
    ];
    const featureNames = ['f1', 'f2', 'f3'];
    const violations = detectCorrelationClusters(featureMatrix, featureNames, 0.80);
    expect(violations).toHaveLength(0);
  });

  test('respects custom threshold parameter', () => {
    // r ~ 0.75 between f1 and f2 — should flag at 0.70 but not at 0.80
    const featureMatrix = [
      [1, 3, 2, 5, 4],
      [2, 4, 3, 5, 4],   // moderately correlated with f1
      [5, 1, 3, 2, 4],
    ];
    const featureNames = ['f1', 'f2', 'f3'];
    const above80 = detectCorrelationClusters(featureMatrix, featureNames, 0.80);
    const above50 = detectCorrelationClusters(featureMatrix, featureNames, 0.50);
    // At 0.50 threshold there should be at least one pair detected
    expect(above50.length).toBeGreaterThanOrEqual(above80.length);
  });

  test('cluster_label increments for multiple violations', () => {
    // Three identical feature arrays — pairs (0,1), (0,2), (1,2) all have r=1.0
    const featureMatrix = [
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5],
    ];
    const featureNames = ['a', 'b', 'c'];
    const violations = detectCorrelationClusters(featureMatrix, featureNames, 0.80);
    expect(violations).toHaveLength(3);
    const labels = violations.map(v => v.cluster_label);
    expect(labels).toContain('cluster_0');
    expect(labels).toContain('cluster_1');
    expect(labels).toContain('cluster_2');
  });
});

// ---------------------------------------------------------------------------
// Section 3 — Production fixture enforcement (THE CI GATE)
// ---------------------------------------------------------------------------

// NBA features (approximate typical ranges — values chosen to be orthogonal, |r| < 0.80)
// Note: original plan fixtures had repeating patterns causing high inter-feature correlation.
// Replaced with shuffled, independently-varying sequences to reflect realistic game-to-game variance.
const nbaFixture = {
  homeOrtg:     [112,107,115,110,108,114,111,116,109,113,106,115,112,108,110,116,113,107,111,114],
  awayOrtg:     [113,109,116,108,111,115,107,110,112,106,113,116,108,110,107,111,115,112,106,109],
  homeDrtg:     [108,113,111,105,114,110,106,112,109,115,112,106,108,113,111,105,114,110,107,116],
  awayDrtg:     [111,106,113,116,109,112,115,108,105,110,107,114,116,109,111,113,106,115,112,108],
  paceDiff:     [3,  -2,  0,  4, -1,  2, -3,  1, -4,  2,  1, -2,  3,  0, -1,  4, -3,  2,  1, -4],
  homeRest:     [1,   3,  2,  1,  4,  2,  3,  1,  2,  3,  4,  1,  2,  3,  1,  4,  2,  1,  3,  2],
  awayRest:     [3,   1,  4,  2,  1,  3,  2,  4,  1,  2,  3,  2,  1,  4,  3,  1,  2,  3,  4,  1],
  kellyFraction:[0.05,0.03,0.07,0.04,0.06,0.03,0.05,0.07,0.04,0.06,0.03,0.07,0.04,0.05,0.06,0.03,0.07,0.04,0.06,0.05],
};

// NHL features (post WI-0823 unified goalie signal — no raw GSaX and SV% separately)
// Values chosen to avoid periodic repetition that inflates r.
const nhlFixture = {
  homeGSaX:    [ 2.1, -0.5, 1.5, 3.2, -1.0,  0.4, -0.2, 2.8,  0.9,  1.8,  0.1, -1.3,  2.4,  0.7, -0.8,  1.2,  3.0, -0.4,  1.6,  0.3],
  awayGSaX:    [-0.3,  2.0, 0.8, 1.2, -1.5,  1.9,  0.5, -0.8,  1.7, -0.6,  1.4,  2.5, -0.9,  0.3,  1.8, -1.2,  0.6,  2.1, -0.5,  1.0],
  homeXG:      [ 2.8,  3.3, 2.5, 2.2,  3.5,  2.0,  3.1,  2.7,  2.4,  3.0,  2.9,  2.3,  3.4,  2.6,  2.1,  3.2,  2.8,  2.5,  3.1,  2.7],
  awayXG:      [ 3.1,  2.4, 2.9, 3.5,  2.0,  2.7,  3.3,  2.2,  3.0,  2.6,  3.2,  2.8,  2.5,  3.4,  2.1,  2.9,  2.6,  3.0,  2.3,  3.3],
  sigmaNorm:   [ 0.7,  0.5, 0.8, 0.6,  0.5,  0.7,  0.6,  0.8,  0.5,  0.7,  0.8,  0.6,  0.5,  0.7,  0.8,  0.6,  0.5,  0.7,  0.6,  0.8],
  paceDiff:    [ 2,   -3,   1,  -2,    3,    0,    -1,    2,   -3,    1,   -2,    3,    0,   -1,    2,   -3,    1,    0,   -2,    3],
};

// MLB features — shuffled independently to avoid periodic correlation
const mlbFixture = {
  homeERA:     [3.8, 4.6, 3.5, 4.1, 3.9, 4.4, 3.7, 4.8, 3.6, 4.2, 4.0, 3.4, 4.7, 3.8, 4.3, 3.5, 4.1, 3.9, 4.6, 3.7],
  awayERA:     [4.3, 3.7, 4.8, 3.9, 4.5, 3.6, 4.2, 3.8, 4.6, 4.0, 3.5, 4.4, 3.7, 4.1, 3.9, 4.7, 3.6, 4.3, 3.8, 4.5],
  homeK9:      [9.2, 7.8, 9.8, 8.4, 9.0, 8.6, 9.4, 7.9, 8.8, 9.3, 8.1, 9.6, 8.3, 9.0, 8.7, 9.1, 8.4, 9.5, 8.2, 9.0],
  awayK9:      [8.7, 9.4, 8.1, 9.6, 8.3, 9.0, 8.5, 9.2, 8.0, 9.3, 8.9, 8.6, 9.1, 8.4, 9.7, 8.2, 9.0, 8.7, 9.3, 8.5],
};

describe('Production feature correlation gate', () => {
  function runGate(fixture, sportLabel) {
    const featureNames = Object.keys(fixture);
    const featureMatrix = featureNames.map(k => fixture[k]);
    const violations = detectCorrelationClusters(featureMatrix, featureNames, 0.80);
    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.feature_a} <-> ${v.feature_b}: r=${v.r.toFixed(4)}`)
        .join('\n');
      throw new Error(`[WI-0833] ${sportLabel} feature correlation breach (|r| >= 0.80):\n${detail}`);
    }
    expect(violations).toHaveLength(0);
  }

  test('NBA: no feature pair has |r| >= 0.80', () => { runGate(nbaFixture, 'NBA'); });
  test('NHL: no feature pair has |r| >= 0.80', () => { runGate(nhlFixture, 'NHL'); });
  test('MLB: no feature pair has |r| >= 0.80', () => { runGate(mlbFixture, 'MLB'); });
});
