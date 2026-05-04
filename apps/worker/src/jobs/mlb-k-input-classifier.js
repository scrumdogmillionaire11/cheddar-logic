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

function normalizeCodeList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function averageNumbers(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const realValues = values.filter(isRealNumber);
  if (realValues.length === 0) return null;
  return realValues.reduce((sum, value) => sum + value, 0) / realValues.length;
}

function normalizeLineupStatus(status) {
  const normalized = String(status || '').trim().toUpperCase();
  return normalized || 'MISSING';
}

/**
 * Build a per-pitcher completeness matrix for pre-model audit logging.
 *
 * @param {object} starter  - StarterSkillInput fields
 * @param {object} opponent - OpponentContactInput fields
 * @param {object} leash    - LeashInput fields
 * @returns {{ starter_profile: object, opponent_profile: object, leash_profile: object }}
 */
function buildCompletenessMatrix(starter = {}, opponent = {}, leash = {}) {
  const pitchCountAvg = starter.pitch_count_avg ?? leash.pitch_count_avg;
  const ipAvg = starter.ip_avg ?? leash.ip_avg;
  const lineupStatus = normalizeLineupStatus(opponent.projected_lineup_status);
  const hasDirectPitchCountHistory =
    Array.isArray(leash.last_three_pitch_counts) &&
    leash.last_three_pitch_counts.length >= 3;

  return {
    starter_profile: {
      k_pct: isRealNumber(starter.k_pct),
      swstr_pct: isRealNumber(starter.swstr_pct),
      csw_pct: isRealNumber(starter.csw_pct),
      pitch_count_avg: isRealNumber(pitchCountAvg),
      ip_avg: isRealNumber(ipAvg),
    },
    opponent_profile: {
      k_pct_vs_hand: isRealNumber(opponent.k_pct_vs_hand),
      contact_pct_vs_hand: isRealNumber(opponent.contact_pct_vs_hand),
      projected_lineup_status: lineupStatus !== 'MISSING',
    },
    leash_profile: {
      pitch_count_avg: isRealNumber(leash.pitch_count_avg),
      ip_avg: isRealNumber(leash.ip_avg),
      expected_ip: isRealNumber(leash.expected_ip),
      direct_pitch_count_history: hasDirectPitchCountHistory,
    },
  };
}

function buildLeashConfidence(leash = {}) {
  const pitchCountAvg = isRealNumber(leash.pitch_count_avg)
    ? leash.pitch_count_avg
    : averageNumbers(leash.last_three_pitch_counts);
  const ipAvg = leash.ip_avg;
  const flag = leash.leash_flag == null
    ? null
    : String(leash.leash_flag).trim().toUpperCase();
  const hasPitchCountHistory =
    Array.isArray(leash.last_three_pitch_counts) &&
    leash.last_three_pitch_counts.length >= 3;

  let source = 'MISSING';
  if (hasPitchCountHistory || isRealNumber(pitchCountAvg)) {
    source = 'PITCH_COUNT_HISTORY';
  } else if (isRealNumber(ipAvg)) {
    source = 'IP_AVG_PROXY';
  } else if (flag === 'SMALL_SAMPLE') {
    source = 'SMALL_SAMPLE_PROXY';
  }

  const proxyInUse =
    source === 'IP_AVG_PROXY' ||
    source === 'SMALL_SAMPLE_PROXY' ||
    flag === 'IP_PROXY';

  let level = 'LOW';
  if (source === 'PITCH_COUNT_HISTORY' && !flag) {
    level = 'HIGH';
  } else if (source === 'PITCH_COUNT_HISTORY' || source === 'IP_AVG_PROXY') {
    level = 'MEDIUM';
  }

  return {
    level,
    source,
    tier: leash.leash_tier ?? null,
    flag,
    expected_ip: isRealNumber(leash.expected_ip) ? leash.expected_ip : null,
    pitch_count_avg: isRealNumber(pitchCountAvg) ? Math.round(pitchCountAvg * 10) / 10 : null,
    ip_avg: isRealNumber(ipAvg) ? ipAvg : null,
    direct_pitch_count_history: hasPitchCountHistory,
    proxy_in_use: proxyInUse,
  };
}

function buildProjectionDiagnostics(inputs = {}) {
  const diagnostics = inputs.projection_diagnostics ?? {};

  return {
    projection_source: diagnostics.projection_source == null
      ? null
      : String(diagnostics.projection_source).trim().toUpperCase(),
    missing_inputs: normalizeCodeList(diagnostics.missing_inputs),
    degraded_inputs: normalizeCodeList(diagnostics.degraded_inputs),
    placeholder_fields: normalizeCodeList(diagnostics.placeholder_fields),
    status_cap: diagnostics.status_cap == null
      ? null
      : String(diagnostics.status_cap).trim().toUpperCase(),
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
 *   degraded: string[],
 *   reasonCodes: string[],
 *   input_completeness: object,
 *   leash_confidence: object,
 *   projection_diagnostics: object
 * }}
 */
function classifyMlbPitcherKQuality(inputs = {}) {
  const starter = inputs.starter ?? {};
  const opponent = inputs.opponent ?? {};
  const leash = inputs.leash ?? {};
  const inputCompleteness = buildCompletenessMatrix(starter, opponent, leash);
  const leashConfidence = buildLeashConfidence(leash);
  const projectionDiagnostics = buildProjectionDiagnostics(inputs);

  const hardMissing = [];
  const proxies = [];
  const degraded = [];
  const degradedInputSet = new Set(projectionDiagnostics.degraded_inputs);

  if (!inputCompleteness.starter_profile.k_pct) {
    hardMissing.push('starter_k_pct');
  }

  if (
    !inputCompleteness.starter_profile.swstr_pct &&
    !inputCompleteness.starter_profile.csw_pct
  ) {
    if (
      degradedInputSet.has('starter_whiff_proxy') ||
      projectionDiagnostics.missing_inputs.includes('statcast_swstr')
    ) {
      proxies.push('starter_whiff_proxy');
    } else {
      hardMissing.push('starter_whiff_metric');
    }
  }

  if (
    !inputCompleteness.starter_profile.pitch_count_avg &&
    !inputCompleteness.starter_profile.ip_avg
  ) {
    hardMissing.push('leash_metric');
  } else if (
    !inputCompleteness.starter_profile.pitch_count_avg &&
    inputCompleteness.starter_profile.ip_avg
  ) {
    proxies.push('leash_ip_avg_proxy');
  }

  if (!inputCompleteness.opponent_profile.k_pct_vs_hand) {
    hardMissing.push('opp_k_pct_vs_hand');
  }

  if (!inputCompleteness.opponent_profile.contact_pct_vs_hand) {
    hardMissing.push('opp_contact_profile');
  }

  if (!inputCompleteness.opponent_profile.projected_lineup_status) {
    degraded.push('lineup_unconfirmed');
  }

  if (projectionDiagnostics.projection_source === 'DEGRADED_MODEL') {
    degraded.push('projection_source_degraded');
  }

  if (projectionDiagnostics.status_cap === 'LEAN') {
    degraded.push('status_cap_lean');
  }

  if (projectionDiagnostics.projection_source === 'SYNTHETIC_FALLBACK') {
    hardMissing.push('projection_source_synthetic_fallback');
  }

  if (leashConfidence.proxy_in_use) {
    proxies.push(
      leashConfidence.source === 'SMALL_SAMPLE_PROXY'
        ? 'leash_small_sample_proxy'
        : 'leash_ip_avg_proxy',
    );
  }

  for (const field of projectionDiagnostics.placeholder_fields) {
    proxies.push(`placeholder_input:${field}`);
  }

  for (const degradedInput of projectionDiagnostics.degraded_inputs) {
    if (degradedInput === 'starter_whiff_proxy') continue;
    degraded.push(`diagnostic:${degradedInput}`);
  }

  const dedupedHardMissing = dedupeFlags(hardMissing);
  const dedupedProxies = dedupeFlags(proxies);
  const dedupedDegraded = dedupeFlags(degraded);
  const reasonCodes = dedupeFlags([
    ...dedupedHardMissing.map((code) => `QUALITY_HARD_MISSING:${code}`),
    ...dedupedProxies.map((code) => `QUALITY_PROXY_SUBSTITUTED:${code}`),
    ...dedupedDegraded.map((code) => `QUALITY_DEGRADED:${code}`),
  ]);

  if (hardMissing.length > 0 || proxies.length > 0) {
    return {
      model_quality: 'FALLBACK',
      hardMissing: dedupedHardMissing,
      proxies: dedupedProxies,
      degraded: dedupedDegraded,
      reasonCodes,
      input_completeness: inputCompleteness,
      leash_confidence: leashConfidence,
      projection_diagnostics: projectionDiagnostics,
    };
  }

  if (degraded.length > 0) {
    return {
      model_quality: 'DEGRADED_MODEL',
      hardMissing: dedupedHardMissing,
      proxies: dedupedProxies,
      degraded: dedupedDegraded,
      reasonCodes,
      input_completeness: inputCompleteness,
      leash_confidence: leashConfidence,
      projection_diagnostics: projectionDiagnostics,
    };
  }

  return {
    model_quality: 'FULL_MODEL',
    hardMissing: dedupedHardMissing,
    proxies: dedupedProxies,
    degraded: dedupedDegraded,
    reasonCodes,
    input_completeness: inputCompleteness,
    leash_confidence: leashConfidence,
    projection_diagnostics: projectionDiagnostics,
  };
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
  buildLeashConfidence,
  dedupeFlags,
};
