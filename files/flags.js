/**
 * flags.js — Feature flags for the non-breaking rollout plan.
 *
 * All flags default false → zero behavior change until explicitly enabled.
 * Set in environment: ENABLE_DECISION_BASIS_TAGS=true npm run worker
 *
 * Rollout order per agent plan:
 *   Phase 1: NHL props + soccer   → ENABLE_DECISION_BASIS_TAGS + ENABLE_PROJECTION_PERF_LEDGER
 *   Phase 2: NBA + NCAAM          → ENABLE_MARKET_THRESHOLDS_V2
 *   Phase 3: MLB + NFL            → ENABLE_CLV_LEDGER
 */

'use strict';

function isTruthy(value) {
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'true' || value.trim() === '1';
}

const FLAGS = Object.freeze({
  /**
   * Phase 1: Attach decision_basis_meta to NHL prop + soccer payloads.
   * Marks projection-only cards as execution_eligible: false.
   * No change to card rendering, existing fields, or API shape.
   */
  ENABLE_DECISION_BASIS_TAGS: isTruthy(process.env.ENABLE_DECISION_BASIS_TAGS),

  /**
   * Phase 2: Sport+market-aware edge thresholds in decision-pipeline-v2.
   * Falls back to current PLAY_EDGE_MIN / LEAN_EDGE_MIN constants when off.
   */
  ENABLE_MARKET_THRESHOLDS_V2: isTruthy(process.env.ENABLE_MARKET_THRESHOLDS_V2),

  /**
   * Phase 3: CLV-style tracking for odds-backed plays.
   * Writes to clv_ledger table. No effect on card_results or settlement flow.
   */
  ENABLE_CLV_LEDGER: isTruthy(process.env.ENABLE_CLV_LEDGER),

  /**
   * Phase 1: Win-rate tracking for projection-only plays.
   * Writes to projection_perf_ledger table. Excluded from profitability rollups.
   */
  ENABLE_PROJECTION_PERF_LEDGER: isTruthy(process.env.ENABLE_PROJECTION_PERF_LEDGER),
});

module.exports = { FLAGS };
