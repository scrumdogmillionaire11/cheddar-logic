'use strict';

const { isMarketCalibrationEnabled } = require('../calibration/calibration-gate');
const {
  getEffectiveContract,
  parseContractFromEnv,
} = require('./execution-gate-freshness-contract');

/**
 * Map the primary blocked_by entry to the bounded drop reason taxonomy.
 *
 * @param {string[]} blocked_by
 * @returns {string}
 */
function mapBlockedByToDropReasonCode(blocked_by) {
  const primary = Array.isArray(blocked_by) && blocked_by.length > 0 ? blocked_by[0] : null;
  if (!primary) return 'UNKNOWN_GATE';
  if (primary.startsWith('NO_EDGE_COMPUTED')) return 'MISSING_EDGE';
  if (primary.startsWith('NET_EDGE_INSUFFICIENT')) return 'NO_EDGE_AT_CURRENT_PRICE';
  if (primary.startsWith('MODEL_STATUS_')) return 'MODEL_STATUS_GATE';
  if (primary === 'CALIBRATION_KILL_SWITCH') return 'CALIBRATION_GATE';
  if (primary.startsWith('CONFIDENCE_BELOW_THRESHOLD')) return 'CONFIDENCE_GATE';
  if (primary.startsWith('STALE_SNAPSHOT')) return 'STALE_SNAPSHOT_GATE';
  if (primary.startsWith('MIXED_BOOK_SOURCE_MISMATCH')) return 'MIXED_BOOK_INTEGRITY_GATE';
  if (primary === 'NOT_BET_ELIGIBLE') return 'NOT_BET_ELIGIBLE';
  if (primary === 'NOT_EXECUTABLE_PATH') return 'PROJECTION_ONLY_EXCLUSION';
  return 'UNKNOWN_GATE';
}

const VIG_COST_STANDARD = 0.045;
const SLIPPAGE_ESTIMATE = 0.005;

// Cache env var overrides (parse once at module load)
let cachedEnvOverrides = null;

/**
 * Evaluate freshness tier for a snapshot (WI-0950).
 *
 * Three tiers based on freshness contract:
 * - FRESH: age <= cadence (fully trusted)
 * - STALE_VALID: cadence < age <= hardMax (allowed if flag set, prevents silent edge loss)
 * - EXPIRED: age > hardMax (always block)
 *
 * @param {number} snapshotAgeMs - Snapshot age in milliseconds
 * @param {object} contract - Freshness contract (cadenceMinutes, graceMultiplier, hardMaxMinutes, allowStaleIfNoNewOdds)
 * @returns { { tier: string, blockedByFreshness: boolean, reason: string, metadata: object } }
 */
function evaluateFreshnessTier(snapshotAgeMs, contract) {
  if (!Number.isFinite(snapshotAgeMs) || !contract) {
    return {
      tier: 'UNKNOWN',
      blockedByFreshness: false,
      reason: 'snapshot_age_or_contract_invalid',
      metadata: {},
    };
  }

  const cadenceMs = contract.cadenceMinutes * 60_000;
  const thresholdMs = cadenceMs * contract.graceMultiplier;
  const hardMaxMs = contract.hardMaxMinutes * 60_000;

  let tier = 'UNKNOWN';
  let blockedByFreshness = false;
  let reason = '';

  if (snapshotAgeMs <= cadenceMs) {
    // FRESH: within cadence window
    tier = 'FRESH';
    blockedByFreshness = false;
    reason = 'within_cadence_window';
  } else if (snapshotAgeMs <= hardMaxMs) {
    // STALE_VALID: between cadence and hardMax
    tier = 'STALE_VALID';
    blockedByFreshness = !contract.allowStaleIfNoNewOdds;
    reason = blockedByFreshness ? 'stale_beyond_grace' : 'within_cadence_grace_window';
  } else {
    // EXPIRED: beyond hardMax
    tier = 'EXPIRED';
    blockedByFreshness = true;
    reason = 'expired_beyond_hardmax';
  }

  return {
    tier,
    blockedByFreshness,
    reason,
    metadata: {
      snapshot_age_ms: snapshotAgeMs,
      cadence_ms: cadenceMs,
      threshold_ms: thresholdMs,
      hard_max_ms: hardMaxMs,
    },
  };
}

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
 * @param {string|null} [params.lineSource]
 * @param {string|null} [params.priceSource]
 * @param {number} [params.vigCost]
 * @param {number} [params.slippageCost]
 * @param {number} [params.minNetEdge]
 * @param {number} [params.minConfidence]
 * @returns {{ shouldBet: boolean, should_bet: boolean, reason: string, block_reason: string|null, netEdge: number|null, blocked_by: string[], freshness_decision: object }}
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
    lineSource = null,
    priceSource = null,
    vigCost = VIG_COST_STANDARD,
    slippageCost = SLIPPAGE_ESTIMATE,
    minNetEdge = 0.025,
    minConfidence = 0.55,
  } = params;

  const blocked_by = [];
  const hasRawEdge = rawEdge !== null && rawEdge !== undefined && Number.isFinite(rawEdge);
  const hasConfidence = confidence !== null && confidence !== undefined && Number.isFinite(confidence);
  const hasSnapshotAge = snapshotAgeMs !== null && snapshotAgeMs !== undefined && Number.isFinite(snapshotAgeMs);

  // Initialize freshness decision (non-blocking addition)
  let freshness_decision = {
    snapshot_age_ms: snapshotAgeMs,
    sport: sport || 'unknown',
    tier: 'UNKNOWN',
    blocked_by_freshness: false,
    reason: 'no_snapshot_age',
  };

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

  // Freshness evaluation (three-tier logic per WI-0950)
  if (hasSnapshotAge && sport) {
    if (!cachedEnvOverrides) {
      cachedEnvOverrides = parseContractFromEnv();
    }
    const contract = getEffectiveContract(sport, cachedEnvOverrides);
    const freshnessTier = evaluateFreshnessTier(snapshotAgeMs, contract);

    freshness_decision = {
      snapshot_age_ms: snapshotAgeMs,
      sport,
      cadence_ms: freshnessTier.metadata.cadence_ms,
      threshold_ms: freshnessTier.metadata.threshold_ms,
      tier: freshnessTier.tier,
      blocked_by_freshness: freshnessTier.blockedByFreshness,
      reason: freshnessTier.reason,
    };

    if (freshnessTier.blockedByFreshness) {
      if (freshnessTier.tier === 'EXPIRED') {
        blocked_by.push(`STALE_SNAPSHOT:EXPIRED_HARDMAX:${Math.round(snapshotAgeMs / 1000)}s`);
      } else if (freshnessTier.tier === 'STALE_VALID') {
        blocked_by.push(`STALE_SNAPSHOT:VALID_WITHIN_CADENCE:${Math.round(snapshotAgeMs / 1000)}s`);
      }
    }
  } else if (hasSnapshotAge && !sport) {
    // Legacy fallback: if sport not provided, use old 5-minute logic for backward compatibility
    const LEGACY_MAX_SNAPSHOT_AGE_MS = 5 * 60 * 1000;
    if (snapshotAgeMs > LEGACY_MAX_SNAPSHOT_AGE_MS) {
      blocked_by.push(`STALE_SNAPSHOT:${Math.round(snapshotAgeMs / 1000)}s`);
      freshness_decision.tier = 'EXPIRED';
      freshness_decision.blocked_by_freshness = true;
      freshness_decision.reason = 'legacy_5min_threshold';
    }
  }

  if (
    typeof lineSource === 'string' &&
    lineSource.trim().length > 0 &&
    typeof priceSource === 'string' &&
    priceSource.trim().length > 0 &&
    lineSource !== priceSource
  ) {
    blocked_by.push(`MIXED_BOOK_SOURCE_MISMATCH:${lineSource}->${priceSource}`);
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
    freshness_decision,
    drop_reason: shouldBet
      ? null
      : {
          drop_reason_code: mapBlockedByToDropReasonCode(blocked_by),
          drop_reason_layer: 'worker_gate',
        },
  };
}

module.exports = {
  evaluateExecution,
  evaluateFreshnessTier,
  mapBlockedByToDropReasonCode,
  VIG_COST_STANDARD,
  SLIPPAGE_ESTIMATE,
};
