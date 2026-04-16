'use strict';

/**
 * Freshness contract for execution gate.
 *
 * This module defines the cadence-based freshness policy for execution gating.
 * Instead of blocking based on absolute time, snapshots are valid if they fall
 * within the expected odds-pull interval plus a grace window.
 *
 * Core principle: Don't punish the system for doing exactly what it's designed to do.
 * A snapshot is stale only if it's older than what the scheduler guarantees.
 */

/**
 * @typedef {object} ExecutionFreshnessContract
 * @property {number} cadenceMinutes - Expected odds pull interval (minutes)
 * @property {number} graceMultiplier - Tolerance buffer as multiplier (e.g., 1.25 = +25%)
 * @property {number} hardMaxMinutes - Absolute fail-safe cap (minutes)
 * @property {boolean} allowStaleIfNoNewOdds - Anti-silencing flag: do not block if no newer odds available
 */

/**
 * Sport-specific freshness contracts.
 * All sports use hourly odds pulls by default.
 * - Cadence: 60 minutes (hourly pull interval)
 * - Grace: 1.25x = 75 minutes (25% buffer for processing delays)
 * - HardMax: 120 minutes (absolute expiration: 2x cadence as fail-safe)
 * - Anti-silencing: true (never suppress valid edge due to expected staleness)
 *
 * Rationale:
 * - Within cadence (0-60m): FRESH, fully trusted
 * - Within grace (60-75m): STALE_VALID, allowed per anti-silencing flag
 * - Within hardMax (75-120m): STALE_VALID, allowed per anti-silencing flag
 * - Beyond hardMax (>120m): EXPIRED, always blocked (prevents multi-hour stale data)
 */
const SPORT_CONTRACTS = {
  mlb: {
    cadenceMinutes: 60,
    graceMultiplier: 1.25,
    hardMaxMinutes: 120,
    allowStaleIfNoNewOdds: true,
  },
  nhl: {
    cadenceMinutes: 60,
    graceMultiplier: 1.25,
    hardMaxMinutes: 120,
    allowStaleIfNoNewOdds: true,
  },
  nba: {
    cadenceMinutes: 60,
    graceMultiplier: 1.25,
    hardMaxMinutes: 120,
    allowStaleIfNoNewOdds: true,
  },
};

/**
 * Get freshness contract for a sport.
 *
 * @param {string} sport - Sport code (mlb, nhl, nba)
 * @returns {ExecutionFreshnessContract} Freshness contract for the sport
 * @throws {Error} If sport is unknown
 */
function getContractForSport(sport) {
  const contract = SPORT_CONTRACTS[String(sport).toLowerCase()];
  if (!contract) {
    throw new Error(`Unknown sport for freshness contract: ${sport}`);
  }
  return { ...contract };
}

/**
 * Parse freshness contract from environment variable.
 *
 * Env var format: JSON object with sport keys and contract values.
 * E.g., EXECUTION_FRESHNESS_CONTRACT='{"mlb":{"cadenceMinutes":60,...}}'
 *
 * On malformed input: log warning, use defaults (do NOT fall back to legacy 5-minute).
 *
 * @returns {Object|null} Parsed contract overrides, or null if env var not set
 */
function parseContractFromEnv() {
  const envStr = process.env.EXECUTION_FRESHNESS_CONTRACT;
  if (!envStr) {
    return null;
  }

  try {
    const parsed = JSON.parse(envStr);
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn(
        '[EXECUTION_FRESHNESS_CONTRACT] Env var is not a JSON object; using defaults.'
      );
      return null;
    }
    console.log('[EXECUTION_GATE_FRESHNESS] Loaded contract overrides from env var');
    return parsed;
  } catch (err) {
    console.warn(
      `[EXECUTION_FRESHNESS_CONTRACT] Malformed JSON env var (${err.message}); using defaults.`
    );
    return null;
  }
}

/**
 * Get effective contract for a sport, with optional env overrides.
 *
 * Priority:
 * 1. Env var override (if sport key exists in parsed EXECUTION_FRESHNESS_CONTRACT)
 * 2. Sport-specific default from SPORT_CONTRACTS
 *
 * @param {string} sport
 * @param {Object|null} [envOverrides]
 * @returns {ExecutionFreshnessContract}
 */
function getEffectiveContract(sport, envOverrides = null) {
  const defaultContract = getContractForSport(sport);

  if (envOverrides && envOverrides[String(sport).toLowerCase()]) {
    const override = envOverrides[String(sport).toLowerCase()];
    // Merge: override specific fields, keep defaults for unspecified
    return {
      cadenceMinutes: override.cadenceMinutes ?? defaultContract.cadenceMinutes,
      graceMultiplier: override.graceMultiplier ?? defaultContract.graceMultiplier,
      hardMaxMinutes: override.hardMaxMinutes ?? defaultContract.hardMaxMinutes,
      allowStaleIfNoNewOdds:
        override.allowStaleIfNoNewOdds ?? defaultContract.allowStaleIfNoNewOdds,
    };
  }

  return defaultContract;
}

module.exports = {
  getContractForSport,
  parseContractFromEnv,
  getEffectiveContract,
  SPORT_CONTRACTS,
};
