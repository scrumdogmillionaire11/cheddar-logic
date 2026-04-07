'use strict';

/**
 * Input Gate — Model status classification for all sport projection functions.
 *
 * Defines three hard model states:
 *   MODEL_OK  — all required and optional inputs present
 *   DEGRADED  — required inputs present; one or more optional inputs missing
 *   NO_BET    — one or more required inputs missing; projection must not proceed
 *
 * Usage pattern (all sport models):
 *   const gate = classifyModelStatus(featureMap, required, optional);
 *   if (gate.status === 'NO_BET') return buildNoBetResult(gate.missingCritical, context);
 *   // optional: apply DEGRADED_CONSTRAINTS when gate.status === 'DEGRADED'
 *
 * Asymmetric team failure: Because home AND away features are both listed in
 * `required`, a single-side null automatically resolves to NO_BET — no
 * special-case handling is needed by callers.
 */

/**
 * Classify model inputs into MODEL_OK / DEGRADED / NO_BET.
 *
 * @param {object} featureMap   - flat object of feature name → value
 * @param {string[]} required   - keys that must be non-null and non-NaN
 * @param {string[]} [optional] - keys that degrade confidence when missing
 * @returns {{ status: 'MODEL_OK'|'DEGRADED'|'NO_BET', missingCritical: string[], missingOptional: string[] }}
 */
function classifyModelStatus(featureMap, required, optional = []) {
  const isMissing = (v) =>
    v == null || (typeof v === 'number' && Number.isNaN(v));

  const missingCritical = required.filter((k) => isMissing(featureMap[k]));
  const missingOptional = optional.filter((k) => isMissing(featureMap[k]));

  const status =
    missingCritical.length > 0
      ? 'NO_BET'
      : missingOptional.length > 0
        ? 'DEGRADED'
        : 'MODEL_OK';

  return { status, missingCritical, missingOptional };
}

/**
 * Build a standard NO_BET return envelope.
 *
 * @param {string[]} missingCritical - required keys that were null/NaN
 * @param {object} [context={}]      - caller-supplied fields merged into envelope
 * @returns {object}
 */
function buildNoBetResult(missingCritical, context = {}) {
  return {
    status: 'NO_BET',
    reason: 'MISSING_CORE_INPUTS',
    missingCritical,
    prediction: null,
    confidence: 0,
    projection: null,
    ...context,
  };
}

/**
 * DEGRADED behavioral contract.
 *
 * Callers that receive gate.status === 'DEGRADED' MUST honor these constraints:
 *   - Cap confidence to MAX_CONFIDENCE (0.55) — overrides any computed value
 *   - Never emit a tier in FORBIDDEN_TIERS ('PLAY') — downgrade to 'LEAN' at most
 *
 * The cross-market execution layer (cross-market.js) enforces these as a
 * hard block at card-emission time in addition to enforcement at the model level.
 *
 * @type {{ MAX_CONFIDENCE: number, FORBIDDEN_TIERS: string[] }}
 */
const DEGRADED_CONSTRAINTS = Object.freeze({
  MAX_CONFIDENCE: 0.55,
  FORBIDDEN_TIERS: Object.freeze(['PLAY']),
});

module.exports = { classifyModelStatus, buildNoBetResult, DEGRADED_CONSTRAINTS };
