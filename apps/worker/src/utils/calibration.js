'use strict';

/**
 * WI-0831: Per-market isotonic regression calibration utility.
 *
 * Implements Pool Adjacent Violators (PAV) algorithm for isotonic regression.
 * No external dependencies — pure JS, compatible with sql.js worker environment.
 */

/**
 * Fit isotonic regression via Pool Adjacent Violators (PAV).
 *
 * @param {number[]} xs - Raw model probabilities (will be sorted internally with ys)
 * @param {number[]} ys - 0/1 outcomes aligned with xs
 * @returns {{ x: number, y: number }[]} Sorted breakpoints for linear interpolation
 */
function fitIsotonic(xs, ys) {
  if (!Array.isArray(xs) || !Array.isArray(ys) || xs.length !== ys.length) {
    throw new TypeError('fitIsotonic: xs and ys must be arrays of equal length');
  }
  if (xs.length === 0) return [];

  // Sort pairs by x ascending
  const pairs = xs.map((x, i) => ({ x, y: ys[i] }));
  pairs.sort((a, b) => a.x - b.x);

  // Build initial blocks — one block per data point
  // Each block: { xSum: number, ySum: number, count: number }
  const blocks = pairs.map((p) => ({
    xSum: p.x,
    ySum: p.y,
    count: 1,
  }));

  // Pool Adjacent Violators: merge blocks that violate monotone non-decreasing constraint
  let i = 0;
  while (i < blocks.length - 1) {
    const curr = blocks[i];
    const next = blocks[i + 1];
    const currAvg = curr.ySum / curr.count;
    const nextAvg = next.ySum / next.count;

    if (currAvg > nextAvg) {
      // Violation: merge curr and next into curr
      curr.xSum += next.xSum;
      curr.ySum += next.ySum;
      curr.count += next.count;
      blocks.splice(i + 1, 1);
      // Step back to re-check the new merged block against its predecessor
      if (i > 0) i -= 1;
    } else {
      i += 1;
    }
  }

  // Convert blocks to breakpoints sorted by x
  return blocks.map((b) => ({
    x: b.xSum / b.count,
    y: b.ySum / b.count,
  }));
}

/**
 * Apply saved calibration via linear interpolation on breakpoints.
 *
 * Returns raw prob unchanged (with calibrationSource: 'raw') if breakpoints
 * is null or empty — allows graceful fallback when calibration not yet fitted.
 *
 * @param {number} rawProb - Raw model probability [0, 1]
 * @param {{ x: number, y: number }[] | null} breakpoints - Fitted breakpoints
 * @returns {{ calibratedProb: number, calibrationSource: 'isotonic' | 'raw' }}
 */
function applyCalibration(rawProb, breakpoints) {
  if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
    return { calibratedProb: rawProb, calibrationSource: 'raw' };
  }

  const sorted = [...breakpoints].sort((a, b) => a.x - b.x);
  const minX = sorted[0].x;
  const maxX = sorted[sorted.length - 1].x;

  // Clamp to breakpoint range before interpolating
  const clampedX = Math.max(minX, Math.min(maxX, rawProb));

  // Find bracket: largest i where sorted[i].x <= clampedX
  let lo = 0;
  let hi = sorted.length - 1;
  // Binary search for lower bracket
  while (lo < hi - 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (sorted[mid].x <= clampedX) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  let calibratedProb;
  if (sorted[lo].x === sorted[hi].x) {
    // Degenerate bracket — average the y values
    calibratedProb = (sorted[lo].y + sorted[hi].y) / 2;
  } else {
    const t = (clampedX - sorted[lo].x) / (sorted[hi].x - sorted[lo].x);
    calibratedProb = sorted[lo].y + t * (sorted[hi].y - sorted[lo].y);
  }

  // Clamp final output to [0.01, 0.99]
  calibratedProb = Math.max(0.01, Math.min(0.99, calibratedProb));

  return { calibratedProb, calibrationSource: 'isotonic' };
}

module.exports = {
  fitIsotonic,
  applyCalibration,
};
