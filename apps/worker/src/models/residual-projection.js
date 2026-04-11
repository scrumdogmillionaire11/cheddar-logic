'use strict';

/**
 * WI-0829: Residual projection layer for NHL and NBA total markets.
 *
 * Computes the model's expected deviation from the market consensus line.
 * Runs in parallel with the existing signal so residual predictive value
 * can be validated before replacing current logic.
 *
 * Uses Abramowitz–Stegun polynomial approximation for erf (no external deps).
 */

/**
 * Compute edge residual between model fair line and market consensus line.
 *
 * A positive residual on OVER means the model thinks the total is higher
 * than the market. The key question is whether this signal has CLV.
 *
 * @param {number|null} modelFairLine   - model's fair-value total/margin
 * @param {number|null} consensusLine   - market consensus line (vig-free midpoint)
 * @param {'OVER'|'UNDER'|'HOME'|'AWAY'} side
 * @param {number} [sigma]              - market uncertainty (used to convert line delta to prob)
 * @returns {{ residual: number, residualProb: number, direction: 'OVER'|'UNDER'|'HOME'|'AWAY'|'NEUTRAL', source: 'MODEL_VS_MARKET' } | null}
 */
function computeResidual(modelFairLine, consensusLine, side, sigma = 1.8) {
  if (modelFairLine === null || consensusLine === null) return null;

  const residual = modelFairLine - consensusLine;

  // Convert line residual to probability using normal CDF
  // P(outcome > consensusLine) when model thinks fair line is modelFairLine
  const z = residual / sigma;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z));
  const cdfValue = 0.5 * (1 + (z >= 0 ? erf : -erf));
  // P(OVER) = P(actual > line) ≈ 1 - CDF(line | model distribution)
  const overProb = 1 - cdfValue;

  const direction = Math.abs(residual) < 0.15
    ? 'NEUTRAL'
    : residual > 0
      ? (side === 'HOME' ? 'HOME' : 'OVER')
      : (side === 'HOME' ? 'AWAY' : 'UNDER');

  return {
    residual: Math.round(residual * 1000) / 1000,
    residualProb: Math.round(overProb * 10000) / 10000,
    direction,
    source: 'MODEL_VS_MARKET',
  };
}

module.exports = { computeResidual };
