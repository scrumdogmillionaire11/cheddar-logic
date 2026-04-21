'use strict';

/**
 * recovery-flow.js
 *
 * Centralized recovery + retry decision logic for the MLB runner.
 * Extracted from run_mlb_model.js (WI-1108).
 *
 * CONTRACT:
 *   - Classifies failure type (transient vs terminal)
 *   - Determines retry eligibility
 *   - Produces structured recovery action (retry / skip / abort)
 *   - Returns warning/error codes — does NOT log directly
 *
 * Hard constraints:
 *   - Must NOT alter model outputs
 *   - Must NOT alter play/pass eligibility
 *   - Must NOT introduce new fallback behavior
 *   - Must NOT change stale-data policy
 *   - No direct logging (runner owns logging)
 *   - No implicit retries (only returns decisions)
 */

const { WATCHDOG_REASONS } = require('@cheddar-logic/models');
const { resolveSnapshotAge } = require('@cheddar-logic/data');
const {
  parseContractFromEnv,
  getEffectiveContract,
} = require('../execution-gate-freshness-contract');

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STALE_RECOVERY_MAX_ATTEMPTS = 1;
const STALE_RECOVERY_DEDUP_TTL_MS = 10 * 60 * 1000;

// Lazily initialized env overrides for freshness contract (module-level cache).
let _cachedFreshnessEnvOverrides = null;

// ─────────────────────────────────────────────────────────────────────────────
// Pure classification helpers
// ─────────────────────────────────────────────────────────────────────────────

function hasOnlyStaleBlockers(blockedBy = []) {
  if (!Array.isArray(blockedBy) || blockedBy.length === 0) return false;
  return blockedBy.every((reason) => String(reason || '').startsWith('STALE_SNAPSHOT'));
}

function normalizeSlotStartIso(value) {
  const parsed = new Date(value || Date.now());
  if (!Number.isFinite(parsed.getTime())) {
    return new Date(Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  parsed.setUTCSeconds(0, 0);
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildStaleRecoveryKey({ sport, gameId, slotStartIso, modelRunUuid }) {
  return `${String(sport || '').toLowerCase()}:${String(gameId || 'unknown')}:${normalizeSlotStartIso(slotStartIso)}:${String(modelRunUuid || 'unknown')}`;
}

function claimStaleRecoveryKey(cache, key, nowMs = Date.now(), ttlMs = STALE_RECOVERY_DEDUP_TTL_MS) {
  for (const [existingKey, expiresAt] of cache.entries()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      cache.delete(existingKey);
    }
  }
  if (cache.has(key)) {
    return false;
  }
  cache.set(key, nowMs + ttlMs);
  return true;
}

function shouldAttemptStaleRecoveryFromGate({ gate, sport }) {
  if (!gate || gate.should_bet !== false) {
    return { shouldAttempt: false, reason: 'not_blocked' };
  }

  const freshnessDecision = gate.freshness_decision || null;
  const tier = String(freshnessDecision?.tier || '').toUpperCase();
  const blockedByFreshness = freshnessDecision?.blocked_by_freshness === true;

  if (!blockedByFreshness) {
    return { shouldAttempt: false, reason: 'freshness_not_primary' };
  }
  if (!hasOnlyStaleBlockers(gate.blocked_by)) {
    return { shouldAttempt: false, reason: 'mixed_blockers' };
  }
  if (tier === 'STALE_VALID') {
    return { shouldAttempt: true, reason: 'stale_valid' };
  }
  if (tier !== 'EXPIRED') {
    return { shouldAttempt: false, reason: 'unsupported_tier' };
  }

  if (!_cachedFreshnessEnvOverrides) {
    _cachedFreshnessEnvOverrides = parseContractFromEnv();
  }
  const contract = getEffectiveContract(
    String(sport || '').toLowerCase(),
    _cachedFreshnessEnvOverrides,
  );
  if (contract?.allowStaleIfNoNewOdds === true) {
    return { shouldAttempt: true, reason: 'expired_allow_stale' };
  }
  return { shouldAttempt: false, reason: 'expired_disallowed' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload seed helpers (capture / restore for retry)
// ─────────────────────────────────────────────────────────────────────────────

function _cloneValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function captureMlbExecutionRetrySeed(payload) {
  return {
    status: payload.status,
    action: payload.action,
    classification: payload.classification,
    ev_passed: payload.ev_passed,
    execution_status: payload.execution_status,
    actionable: payload.actionable,
    publish_ready: payload.publish_ready,
    pass_reason_code: payload.pass_reason_code,
    reason_codes: _cloneValue(payload.reason_codes),
    _publish_state: _cloneValue(payload._publish_state),
  };
}

function restoreMlbExecutionRetrySeed(payload, seed) {
  Object.assign(payload, {
    status: seed.status,
    action: seed.action,
    classification: seed.classification,
    ev_passed: seed.ev_passed,
    execution_status: seed.execution_status,
    actionable: seed.actionable,
    publish_ready: seed.publish_ready,
    pass_reason_code: seed.pass_reason_code,
    reason_codes: _cloneValue(seed.reason_codes),
    _publish_state: _cloneValue(seed._publish_state),
  });
  delete payload.execution_gate;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main recovery function
//
// Accepts injected dependencies to avoid circular imports:
//   applyGateFn   — applyExecutionGateToMlbPayload from run_mlb_model.js
//   appendReasonCodeFn — appendMlbReasonCode from run_mlb_model.js
//   refreshOddsFn — refreshStaleOdds from refresh_stale_odds.js
// ─────────────────────────────────────────────────────────────────────────────

async function applyExecutionGateWithStaleRecoveryToMlbPayload(
  payload,
  {
    oddsSnapshot,
    nowMs = Date.now(),
    gameId,
    slotStartIso,
    modelRunUuid,
    attemptCount = 0,
    refreshOddsFn,
    fetchLatestSnapshotFn = null,
    dedupCache,
    logger = console,
    applyGateFn,
    appendReasonCodeFn,
  } = {},
) {
  const retrySeed = captureMlbExecutionRetrySeed(payload);
  const initialOutcome = applyGateFn(payload, { oddsSnapshot, nowMs });
  if (initialOutcome.blocked !== true) {
    return initialOutcome;
  }

  const attemptDecision = shouldAttemptStaleRecoveryFromGate({
    gate: payload.execution_gate,
    sport: payload.sport || 'MLB',
  });
  if (!attemptDecision.shouldAttempt) {
    return initialOutcome;
  }
  if (attemptCount >= STALE_RECOVERY_MAX_ATTEMPTS) {
    logger.log('[MLBModel] stale recovery skipped: attempt count exceeded');
    return initialOutcome;
  }

  if (!gameId && !payload?.game_id) {
    appendReasonCodeFn(payload, WATCHDOG_REASONS.GAME_ID_INVALID);
    logger.warn('[MLBModel] stale recovery skipped: GAME_ID_INVALID');
    return initialOutcome;
  }

  const recoveryKey = buildStaleRecoveryKey({
    sport: payload.sport || 'MLB',
    gameId: gameId || payload.game_id,
    slotStartIso: slotStartIso || payload.start_time_utc || oddsSnapshot?.game_time_utc,
    modelRunUuid,
  });
  if (!claimStaleRecoveryKey(dedupCache, recoveryKey, nowMs)) {
    logger.log(`[MLBModel] stale recovery dedup hit on key ${recoveryKey}`);
    return initialOutcome;
  }

  const recoveryMeta = {
    attempted: true,
    triggered_at: new Date(nowMs).toISOString(),
    refresh_executed: false,
    refresh_snapshot_age_before_ms: payload.execution_gate?.snapshot_age_ms ?? null,
    refresh_snapshot_age_after_ms: payload.execution_gate?.snapshot_age_ms ?? null,
    refresh_duration_ms: null,
    retry_executed: false,
    retry_gate_result: payload.pass_reason_code || 'PASS_EXECUTION_GATE_BLOCKED',
    final_status: payload.execution_status || 'BLOCKED',
    attempt_count: 1,
    dedup_key: recoveryKey,
  };

  const refreshStartedAt = Date.now();
  try {
    recoveryMeta.refresh_executed = true;
    await refreshOddsFn({
      jobKey: `pull_odds:${String(payload.sport || 'MLB').toLowerCase()}:emergency:${modelRunUuid || 'run'}`,
      dryRun: false,
    });
    recoveryMeta.refresh_duration_ms = Date.now() - refreshStartedAt;
  } catch (error) {
    recoveryMeta.refresh_duration_ms = Date.now() - refreshStartedAt;
    recoveryMeta.retry_gate_result = 'BLOCKED_AFTER_RETRY';
    recoveryMeta.final_status = 'BLOCKED';
    recoveryMeta.reason_code = WATCHDOG_REASONS.STALE_RECOVERY_REFRESH_FAILED;
    payload.stale_recovery = recoveryMeta;
    appendReasonCodeFn(payload, WATCHDOG_REASONS.STALE_RECOVERY_REFRESH_FAILED);
    logger.warn(`[MLBModel] stale recovery refresh failed: ${error.message}`);
    return initialOutcome;
  }

  let latestSnapshot = oddsSnapshot;
  if (typeof fetchLatestSnapshotFn === 'function') {
    try {
      latestSnapshot = (await fetchLatestSnapshotFn()) || oddsSnapshot;
    } catch (error) {
      recoveryMeta.reason_code = WATCHDOG_REASONS.STALE_RECOVERY_RELOAD_FAILED;
      appendReasonCodeFn(payload, WATCHDOG_REASONS.STALE_RECOVERY_RELOAD_FAILED);
      logger.warn(`[MLBModel] stale recovery snapshot reload failed: ${error.message}`);
    }
  }

  const refreshedAge = resolveSnapshotAge(
    latestSnapshot,
    `run_mlb_model:${String(payload.sport || 'MLB').toLowerCase()}:stale_recovery`,
  );
  recoveryMeta.refresh_snapshot_age_after_ms =
    refreshedAge?.age_ms ?? payload.execution_gate?.snapshot_age_ms ?? null;

  restoreMlbExecutionRetrySeed(payload, retrySeed);
  recoveryMeta.retry_executed = true;
  const retryNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const retryOutcome = applyGateFn(payload, {
    oddsSnapshot: latestSnapshot,
    nowMs: retryNowMs,
  });
  recoveryMeta.retry_gate_result = payload.execution_gate?.should_bet
    ? 'PASS_EXECUTION_GATE'
    : payload.pass_reason_code || 'BLOCKED_AFTER_RETRY';
  recoveryMeta.final_status =
    payload.execution_status || (retryOutcome.blocked ? 'BLOCKED' : 'EXECUTABLE');
  payload.stale_recovery = recoveryMeta;
  return retryOutcome;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  STALE_RECOVERY_MAX_ATTEMPTS,
  STALE_RECOVERY_DEDUP_TTL_MS,
  hasOnlyStaleBlockers,
  normalizeSlotStartIso,
  buildStaleRecoveryKey,
  claimStaleRecoveryKey,
  shouldAttemptStaleRecoveryFromGate,
  captureMlbExecutionRetrySeed,
  restoreMlbExecutionRetrySeed,
  applyExecutionGateWithStaleRecoveryToMlbPayload,
};
