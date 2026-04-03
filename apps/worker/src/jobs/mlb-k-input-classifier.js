'use strict';

/**
 * MLB Pitcher-K Input Classifier
 *
 * Single source of truth for classifying model quality tier based on the
 * completeness of four input stages:
 *   - StarterSkillInput  (k_pct, whiff metrics)
 *   - OpponentContactInput (opponent k%/contact% vs handedness)
 *   - LeashInput (pitch count / IP history)
 *
 * Returns one of: FULL_MODEL | DEGRADED_MODEL | FALLBACK
 *
 * Contract: This module is intentionally dependency-free (no DB, no model code).
 * All functions are pure — same input always produces same output.
 *
 * Reference: docs/mlb_projection_input_contract.md
 * WI: WORK_QUEUE/WI-0747.md
 */

/**
 * Returns true if v is a real, finite number (not null/undefined/NaN).
 * 0 is treated as a valid value.
 * @param {*} v
 * @returns {boolean}
 */
function isRealNumber(v) {
  return typeof v === 'number' && isFinite(v);
}

/**
 * Build a per-pitcher completeness matrix for pre-model audit logging.
 *
 * @param {object} starter  - StarterSkillInput fields
 * @param {object} opponent - OpponentContactInput fields
 * @param {object} leash    - LeashInput fields
 * @returns {{ starter_profile: object, opponent_profile: object }}
 */
function buildCompletenessMatrix(starter = {}, opponent = {}, leash = {}) {
  return {
    starter_profile: {
      k_pct:           isRealNumber(starter.k_pct),
      swstr_pct:       isRealNumber(starter.swstr_pct),
      csw_pct:         isRealNumber(starter.csw_pct),
      pitch_count_avg: isRealNumber(starter.pitch_count_avg ?? leash.pitch_count_avg),
      ip_avg:          isRealNumber(starter.ip_avg ?? leash.ip_avg),
    },
    opponent_profile: {
      k_pct_vs_hand:       isRealNumber(opponent.k_pct_vs_hand),
      contact_pct_vs_hand: isRealNumber(opponent.contact_pct_vs_hand),
      projected_lineup:    Boolean(opponent.projected_lineup_status &&
                            opponent.projected_lineup_status !== 'MISSING'),
    },
  };
}

/**
 * Classify MLB pitcher-K model quality from structured inputs.
 *
 * @param {object} inputs
 * @param {object} inputs.starter  - StarterSkillInput
 * @param {object} inputs.opponent - OpponentContactInput
 * @param {object} inputs.leash    - LeashInput
 *
 * @returns {{
 *   model_quality: 'FULL_MODEL' | 'DEGRADED_MODEL' | 'FALLBACK',
 *   hardMissing: string[],
 *   proxies: string[],
 *   degraded: string[]
 * }}
 */
function classifyMlbPitcherKQuality(inputs = {}) {
  const starter  = inputs.starter  ?? {};
  const opponent = inputs.opponent ?? {};
  const leash    = inputs.leash    ?? {};

  const hardMissing = [];
  const proxies     = [];
  const degraded    = [];

  // ── CORE REQUIRED FIELDS ────────────────────────────────────────────────
  // 1. Starter K rate — no substitute
  if (!isRealNumber(starter.k_pct)) {
    hardMissing.push('starter_k_pct');
  }

  // 2. Whiff metric: swstr_pct OR csw_pct required
  //    If neither is real: either proxy was used, or completely missing
  if (!isRealNumber(starter.swstr_pct) && !isRealNumber(starter.csw_pct)) {
    if (isRealNumber(starter.whiff_proxy) || starter.whiff_proxy != null) {
      // Proxy fills the gap → FALLBACK trigger
      proxies.push('starter_whiff_proxy');
    } else {
      // Completely absent
      hardMissing.push('starter_whiff_metric');
    }
  }

  // 3. Leash metric: pitch_count_avg OR ip_avg required
  const hasPitchCount = isRealNumber(leash.pitch_count_avg);
  const hasIpAvg      = isRealNumber(leash.ip_avg);
  if (!hasPitchCount && !hasIpAvg) {
    if (isRealNumber(leash.ip_proxy) || leash.ip_proxy != null) {
      // Proxy fills the gap → FALLBACK trigger
      proxies.push('ip_proxy');
    } else {
      hardMissing.push('leash_metric');
    }
  }

  // 4. Opponent K% vs handedness
  if (!isRealNumber(opponent.k_pct_vs_hand)) {
    hardMissing.push('opp_k_pct_vs_hand');
  }

  // 5. Opponent contact profile vs handedness
  if (!isRealNumber(opponent.contact_pct_vs_hand)) {
    hardMissing.push('opp_contact_profile');
  }

  // ── DEGRADED_MODEL (secondary gaps — allowed) ───────────────────────────
  // 6. Chase rate vs handedness (nice-to-have)
  if (!isRealNumber(opponent.chase_pct_vs_hand)) {
    degraded.push('opp_chase_pct_missing');
  }

  // 7. Lineup status not fully confirmed
  if (opponent.projected_lineup_status === 'PROJECTED') {
    degraded.push('lineup_projected_not_confirmed');
  }

  // ── DECISION ────────────────────────────────────────────────────────────
  // Any hard miss or proxy substitution → FALLBACK
  if (hardMissing.length > 0 || proxies.length > 0) {
    return { model_quality: 'FALLBACK', hardMissing, proxies, degraded };
  }

  // Secondary gaps only → DEGRADED_MODEL
  if (degraded.length > 0) {
    return { model_quality: 'DEGRADED_MODEL', hardMissing, proxies, degraded };
  }

  return { model_quality: 'FULL_MODEL', hardMissing, proxies, degraded };
}

/**
 * Remove duplicate flag strings from a card payload flags array.
 * Preserves insertion order of first occurrence.
 *
 * @param {string[]} flags
 * @returns {string[]}
 */
function dedupeFlags(flags) {
  if (!Array.isArray(flags)) return [];
  return [...new Set(flags)];
}

module.exports = {
  classifyMlbPitcherKQuality,
  buildCompletenessMatrix,
  dedupeFlags,
};
