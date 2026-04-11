'use strict';

/**
 * Additive z-score aggregation engine (WI-0830).
 *
 * Replaces per-sport multiplicative adjustment stacks with a single shared
 * bounded scoring layer. Each feature is normalised to a z-score, weighted,
 * summed, and passed through a globally-clamped sigmoid producing
 * `modelScore ∈ (0.2, 0.8)`.
 *
 * Eliminates compounding amplification and non-comparable cross-sport scores.
 */

/**
 * Aggregate a feature vector into a bounded model score via additive z-scores.
 *
 * @param {Array<{value:number|null, mean:number, std:number, weight:number, name:string}>} features
 * @param {{ outputClampLow?: number, outputClampHigh?: number, k?: number }} [opts]
 * @returns {{ score: number, contributions: Record<string,number>, zScores: Record<string,number> }}
 */
function aggregate(features, opts = {}) {
  const { outputClampLow = 0.2, outputClampHigh = 0.8, k = 2.0 } = opts;

  const contributions = {};
  const zScores = {};
  let weightedSum = 0;
  let totalWeight = 0;

  for (const f of features) {
    // null value → treat as mean (z = 0, neutral contribution)
    const value = f.value != null ? f.value : f.mean;
    const std = f.std > 0 ? f.std : 1e-6;
    const z = Math.max(-3, Math.min(3, (value - f.mean) / std));
    zScores[f.name] = Math.round(z * 10000) / 10000;
    const contribution = f.weight * z;
    contributions[f.name] = Math.round(contribution * 10000) / 10000;
    weightedSum += contribution;
    totalWeight += f.weight;
  }

  const S = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const rawScore = 1 / (1 + Math.exp(-k * S));
  const score = Math.max(outputClampLow, Math.min(outputClampHigh, rawScore));

  return { score: Math.round(score * 10000) / 10000, contributions, zScores };
}

module.exports = { aggregate };
