'use strict';

const { isMarketCalibrationEnabled } = require('../calibration/calibration-gate');

const VIG_COST_STANDARD = 0.045;
const SLIPPAGE_ESTIMATE = 0.005;
// Default: 5 minutes for the automated pipeline (odds pull → model run back-to-back).
// Set EXECUTION_GATE_MAX_SNAPSHOT_AGE_MS env var (ms) to override for manual recovery runs
// e.g. EXECUTION_GATE_MAX_SNAPSHOT_AGE_MS=3600000 allows up to 1 hour.
const MAX_SNAPSHOT_AGE_MS =
  parseInt(process.env.EXECUTION_GATE_MAX_SNAPSHOT_AGE_MS, 10) || 5 * 60 * 1000;

/**
 * Evaluate whether a model output is executable as a live bet.
 *
 * @param {object} params
 * @param {'MODEL_OK'|'DEGRADED'|'NO_BET'} params.modelStatus
 * @param {number|null} params.rawEdge
 * @param {number|null} params.confidence
 * @param {number|null} params.snapshotAgeMs
 * @param {string|null} [params.marketKey]
 * @param {string|null} [params.sport]
 * @param {string|null} [params.recommendedBetType]
 * @param {string|null} [params.marketType]
 * @param {string|null} [params.period]
 * @param {string|null} [params.cardType]
 * @param {number} [params.vigCost]
 * @param {number} [params.slippageCost]
 * @param {number} [params.minNetEdge]
 * @param {number} [params.minConfidence]
 * @returns {{ shouldBet: boolean, should_bet: boolean, reason: string, block_reason: string|null, netEdge: number|null, blocked_by: string[] }}
 */
function evaluateExecution(params) {
  const {
    modelStatus,
    rawEdge,
    confidence,
    snapshotAgeMs,
    marketKey = null,
    sport = null,
    recommendedBetType = null,
    marketType = null,
    period = null,
    cardType = null,
    vigCost = VIG_COST_STANDARD,
    slippageCost = SLIPPAGE_ESTIMATE,
    minNetEdge = 0.025,
    minConfidence = 0.60,
  } = params;

  const blocked_by = [];
  const hasRawEdge = rawEdge !== null && rawEdge !== undefined && Number.isFinite(rawEdge);
  const hasConfidence = confidence !== null && confidence !== undefined && Number.isFinite(confidence);
  const hasSnapshotAge = snapshotAgeMs !== null && snapshotAgeMs !== undefined && Number.isFinite(snapshotAgeMs);

  if (modelStatus !== 'MODEL_OK') {
    blocked_by.push(`MODEL_STATUS_${modelStatus}`);
  }

  if (!hasRawEdge) {
    blocked_by.push('NO_EDGE_COMPUTED');
  }

  const netEdge = hasRawEdge ? rawEdge - vigCost - slippageCost : null;

  if (netEdge !== null && netEdge < minNetEdge) {
    blocked_by.push(`NET_EDGE_INSUFFICIENT:${netEdge.toFixed(4)}`);
  }

  if (hasConfidence && confidence < minConfidence) {
    blocked_by.push(`CONFIDENCE_BELOW_THRESHOLD:${confidence.toFixed(3)}`);
  }

  if (hasSnapshotAge && snapshotAgeMs > MAX_SNAPSHOT_AGE_MS) {
    blocked_by.push(`STALE_SNAPSHOT:${Math.round(snapshotAgeMs / 1000)}s`);
  }

  if (
    marketKey &&
    !isMarketCalibrationEnabled(marketKey, {
      sport,
      recommendedBetType,
      marketType,
      period,
      cardType,
    })
  ) {
    blocked_by.push('CALIBRATION_KILL_SWITCH');
  }

  const shouldBet = blocked_by.length === 0;
  const reason = shouldBet ? 'ALL_GATES_PASSED' : blocked_by[0];
  const block_reason = shouldBet ? null : blocked_by[0];

  return {
    shouldBet,
    should_bet: shouldBet,
    reason,
    block_reason,
    netEdge,
    blocked_by,
  };
}

module.exports = {
  evaluateExecution,
  VIG_COST_STANDARD,
  SLIPPAGE_ESTIMATE,
};
