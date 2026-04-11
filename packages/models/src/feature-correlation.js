'use strict';

/**
 * Feature correlation cluster detection (WI-0833).
 *
 * Pure CommonJS module — no external dependencies, no DB reads.
 * Exports: pearsonR, computeCorrelationMatrix, detectCorrelationClusters
 */

/**
 * Compute the Pearson correlation coefficient between two equal-length arrays.
 *
 * @param {number[]} xs - First variable observations.
 * @param {number[]} ys - Second variable observations.
 * @returns {number} r in [-1, 1]. Returns 0 if either array has zero variance.
 * @throws {Error} If arrays have different lengths.
 */
function pearsonR(xs, ys) {
  if (xs.length !== ys.length) {
    throw new Error(
      `pearsonR: arrays must be same length (got ${xs.length} vs ${ys.length})`
    );
  }

  const n = xs.length;
  if (n === 0) return 0;

  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;

  let numerator = 0;
  let sumSqX = 0;
  let sumSqY = 0;

  for (let i = 0; i < n; i++) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    numerator += dx * dy;
    sumSqX += dx * dx;
    sumSqY += dy * dy;
  }

  const denominator = Math.sqrt(sumSqX * sumSqY);

  if (denominator === 0) return 0;

  // Clamp to [-1, 1] to guard against floating-point overshoot
  return Math.max(-1, Math.min(1, numerator / denominator));
}

/**
 * Compute the full N x N correlation matrix for a set of features.
 *
 * @param {number[][]} featureMatrix - Array of N arrays, each of length S (samples).
 * @param {string[]} featureNames - Array of N feature name strings.
 * @returns {{ names: string[], matrix: number[][] }} Symmetric N x N matrix of r values.
 */
function computeCorrelationMatrix(featureMatrix, featureNames) {
  const n = featureMatrix.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        matrix[i][j] = 1;
      } else if (j > i) {
        const r = pearsonR(featureMatrix[i], featureMatrix[j]);
        matrix[i][j] = r;
        matrix[j][i] = r; // symmetric
      }
    }
  }

  return { names: featureNames, matrix };
}

/**
 * Detect pairs of features whose absolute Pearson r meets or exceeds the threshold.
 *
 * @param {number[][]} featureMatrix - Array of N arrays, each of length S (samples).
 * @param {string[]} featureNames - Array of N feature name strings.
 * @param {number} [threshold=0.80] - Minimum |r| to flag a pair.
 * @returns {Array<{ feature_a: string, feature_b: string, r: number, cluster_label: string }>}
 *   Flagged pairs in (i < j) order. Empty array if no pairs breach the threshold.
 */
function detectCorrelationClusters(featureMatrix, featureNames, threshold = 0.80) {
  const { matrix } = computeCorrelationMatrix(featureMatrix, featureNames);
  const n = featureNames.length;
  const results = [];
  let clusterIndex = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const r = matrix[i][j];
      if (Math.abs(r) >= threshold) {
        results.push({
          feature_a: featureNames[i],
          feature_b: featureNames[j],
          r,
          cluster_label: 'cluster_' + clusterIndex,
        });
        clusterIndex++;
      }
    }
  }

  return results;
}

module.exports = { pearsonR, computeCorrelationMatrix, detectCorrelationClusters };
