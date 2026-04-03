'use strict';

const {
  asToken,
  derivePricingStatus,
  derivePublishReady,
  getCardKey,
  getSelectionSignature,
  normalizeReasonCodes,
} = require('./audit_rules_config');

function buildViolation({
  invariantId,
  severity,
  fieldPath,
  expected,
  actual,
  cardKey,
  stage = 'publish',
}) {
  return {
    invariant_id: invariantId,
    severity,
    stage,
    card_key: cardKey || 'ROOT',
    field_path: fieldPath,
    expected,
    actual,
  };
}

function checkNoPostDecisionClassificationRewrite(decisionSnapshot, publishSnapshot) {
  const pairs = [
    ['classification', decisionSnapshot?.classification, publishSnapshot?.classification],
    ['action', decisionSnapshot?.action, publishSnapshot?.action],
    ['status', decisionSnapshot?.status, publishSnapshot?.status],
    ['execution_status', decisionSnapshot?.execution_status, publishSnapshot?.execution_status],
    ['decision_v2.official_status', decisionSnapshot?.decision_v2?.official_status, publishSnapshot?.decision_v2?.official_status],
    ['reason_codes', normalizeReasonCodes(decisionSnapshot?.reason_codes), normalizeReasonCodes(publishSnapshot?.reason_codes)],
  ];

  for (const [fieldPath, expected, actual] of pairs) {
    if (JSON.stringify(expected) === JSON.stringify(actual)) continue;
    return {
      passed: false,
      violation: buildViolation({
        invariantId: 'INV-001',
        severity: 'CRITICAL',
        fieldPath,
        expected,
        actual,
        cardKey: getCardKey(publishSnapshot || decisionSnapshot),
      }),
    };
  }

  return { passed: true, violation: null };
}

function checkNoPricingGap(publishSnapshot) {
  const executionStatus = asToken(publishSnapshot?.execution_status);
  const pricingStatus = derivePricingStatus(publishSnapshot);
  if (executionStatus !== 'EXECUTABLE' || pricingStatus === 'FRESH') {
    return { passed: true, violation: null };
  }
  return {
    passed: false,
    violation: buildViolation({
      invariantId: 'INV-002',
      severity: 'CRITICAL',
      fieldPath: '_pricing_state.status',
      expected: 'FRESH',
      actual: pricingStatus,
      cardKey: getCardKey(publishSnapshot),
    }),
  };
}

function checkNoPublishOnWatchdogBlock(publishSnapshot) {
  const watchdogStatus = asToken(publishSnapshot?.decision_v2?.watchdog_status);
  const publishReady = derivePublishReady(publishSnapshot);
  if (watchdogStatus !== 'BLOCKED' || publishReady !== true) {
    return { passed: true, violation: null };
  }
  return {
    passed: false,
    violation: buildViolation({
      invariantId: 'INV-003',
      severity: 'CRITICAL',
      fieldPath: '_publish_state.publish_ready',
      expected: false,
      actual: true,
      cardKey: getCardKey(publishSnapshot),
    }),
  };
}

function checkProjectionOnlyNotExecutable(publishSnapshot) {
  if (publishSnapshot?.projection_floor !== true) {
    return { passed: true, violation: null };
  }
  const executionStatus = asToken(publishSnapshot?.execution_status);
  if (executionStatus === 'PROJECTION_ONLY') {
    return { passed: true, violation: null };
  }
  return {
    passed: false,
    violation: buildViolation({
      invariantId: 'INV-004',
      severity: 'CRITICAL',
      fieldPath: 'execution_status',
      expected: 'PROJECTION_ONLY',
      actual: executionStatus,
      cardKey: getCardKey(publishSnapshot),
    }),
  };
}

function checkConsistencyFieldsPresent(publishSnapshot) {
  if (asToken(publishSnapshot?.market_type) !== 'TOTAL' || derivePublishReady(publishSnapshot) !== true) {
    return { passed: true, violation: null };
  }
  const consistency = publishSnapshot?.consistency || {};
  const required = ['pace_tier', 'event_env', 'total_bias'];
  const missing = required.filter((field) => !asToken(consistency[field]));
  if (missing.length === 0) {
    return { passed: true, violation: null };
  }
  return {
    passed: false,
    violation: buildViolation({
      invariantId: 'INV-005',
      severity: 'WARN',
      fieldPath: 'consistency',
      expected: required,
      actual: missing,
      cardKey: getCardKey(publishSnapshot),
    }),
  };
}

function checkExecutionStateConsistency(publishSnapshot) {
  const executionStatus = asToken(publishSnapshot?.execution_status) || 'UNKNOWN';
  const predictionStatus = asToken(publishSnapshot?._prediction_state?.status) || 'UNKNOWN';
  const pricingStatus = derivePricingStatus(publishSnapshot);
  const publishReady = derivePublishReady(publishSnapshot);
  const actionable = publishSnapshot?.actionable === true;
  const legacyPricingReady =
    publishSnapshot?.pricing_ready === undefined ? null : publishSnapshot.pricing_ready === true;

  const selectionDetails = getSelectionSignature(publishSnapshot);
  if (selectionDetails.conflict) {
    return {
      passed: false,
      violation: buildViolation({
        invariantId: 'INV-006',
        severity: 'CRITICAL',
        fieldPath: 'selection_signature',
        expected: 'single canonical side source',
        actual: selectionDetails.sources,
        cardKey: getCardKey(publishSnapshot),
      }),
    };
  }

  const failures = [];
  if (executionStatus === 'EXECUTABLE' && predictionStatus !== 'QUALIFIED') {
    failures.push(['_prediction_state.status', 'QUALIFIED', predictionStatus]);
  }
  if (executionStatus === 'EXECUTABLE' && pricingStatus !== 'FRESH') {
    failures.push(['_pricing_state.status', 'FRESH', pricingStatus]);
  }
  if (executionStatus === 'EXECUTABLE' && publishReady !== true) {
    failures.push(['_publish_state.publish_ready', true, publishReady]);
  }
  if (actionable !== (executionStatus === 'EXECUTABLE')) {
    failures.push(['actionable', executionStatus === 'EXECUTABLE', actionable]);
  }
  if (legacyPricingReady !== null && legacyPricingReady !== (pricingStatus === 'FRESH')) {
    failures.push(['pricing_ready', pricingStatus === 'FRESH', legacyPricingReady]);
  }

  if (failures.length === 0) {
    return { passed: true, violation: null };
  }

  const [fieldPath, expected, actual] = failures[0];
  return {
    passed: false,
    violation: buildViolation({
      invariantId: 'INV-006',
      severity: 'CRITICAL',
      fieldPath,
      expected,
      actual,
      cardKey: getCardKey(publishSnapshot),
    }),
  };
}

/**
 * INV-007 — MLB_PITCHER_K model_quality contract
 *
 * Asserts:
 *   1. prop_decision.model_quality is one of FULL_MODEL | DEGRADED_MODEL | FALLBACK
 *      (required for every MLB_PITCHER_K card where prop_decision is present)
 *   2. If prop_decision.proxy_fields is a non-empty array, model_quality MUST be FALLBACK
 *   3. prop_decision.degradation_reasons must be an array (may be empty)
 *
 * WI: WORK_QUEUE/WI-0747.md
 * Contract: docs/mlb_projection_input_contract.md
 */
function checkMlbPitcherKQualityContract(decisionSnapshot, publishSnapshot) {
  const cardType = publishSnapshot?.cardType ?? publishSnapshot?.card_type;
  const payloadData = publishSnapshot?.payloadData ?? publishSnapshot;

  // Only applies to MLB_PITCHER_K cards
  if (cardType !== 'mlb-pitcher-k') {
    return { passed: true };
  }

  const pd = payloadData?.prop_decision;
  if (!pd) {
    // prop_decision may be null for PASS cards without a model result; skip
    return { passed: true };
  }

  const VALID_QUALITY_TIERS = new Set(['FULL_MODEL', 'DEGRADED_MODEL', 'FALLBACK']);
  const cardKey = getCardKey(publishSnapshot);

  // Check 1: model_quality must be a valid enum value
  if (!VALID_QUALITY_TIERS.has(pd.model_quality)) {
    return {
      passed: false,
      violation: buildViolation({
        invariantId: 'INV-007',
        severity: 'ERROR',
        fieldPath: 'prop_decision.model_quality',
        expected: 'FULL_MODEL|DEGRADED_MODEL|FALLBACK',
        actual: pd.model_quality ?? 'MISSING',
        cardKey,
      }),
    };
  }

  // Check 2: proxy_fields present → model_quality must be FALLBACK
  if (Array.isArray(pd.proxy_fields) && pd.proxy_fields.length > 0 && pd.model_quality !== 'FALLBACK') {
    return {
      passed: false,
      violation: buildViolation({
        invariantId: 'INV-007',
        severity: 'ERROR',
        fieldPath: 'prop_decision.model_quality',
        expected: 'FALLBACK (proxy_fields is non-empty)',
        actual: pd.model_quality,
        cardKey,
      }),
    };
  }

  // Check 3: degradation_reasons must be an array
  if (!Array.isArray(pd.degradation_reasons)) {
    return {
      passed: false,
      violation: buildViolation({
        invariantId: 'INV-007',
        severity: 'WARN',
        fieldPath: 'prop_decision.degradation_reasons',
        expected: 'array (may be empty)',
        actual: typeof pd.degradation_reasons,
        cardKey,
      }),
    };
  }

  return { passed: true };
}

function runAuditInvariants({ decisionSnapshot, publishSnapshot, cards = [] } = {}) {
  const targets = [];
  if (publishSnapshot && typeof publishSnapshot === 'object') {
    targets.push({ decisionSnapshot, publishSnapshot });
  }
  if (Array.isArray(cards)) {
    cards.forEach((card) => {
      if (card && typeof card === 'object') {
        targets.push({ decisionSnapshot: card, publishSnapshot: card });
      }
    });
  }

  const checks = [
    checkNoPostDecisionClassificationRewrite,
    (_decisionSnapshot, candidate) => checkNoPricingGap(candidate),
    (_decisionSnapshot, candidate) => checkNoPublishOnWatchdogBlock(candidate),
    (_decisionSnapshot, candidate) => checkProjectionOnlyNotExecutable(candidate),
    (_decisionSnapshot, candidate) => checkConsistencyFieldsPresent(candidate),
    (_decisionSnapshot, candidate) => checkExecutionStateConsistency(candidate),
    (_decisionSnapshot, candidate) => checkMlbPitcherKQualityContract(_decisionSnapshot, candidate),
  ];

  const violations = targets.flatMap(({ decisionSnapshot: currentDecision, publishSnapshot: currentPublish }) =>
    checks
      .map((check) => check(currentDecision, currentPublish))
      .filter((result) => result.passed === false && result.violation),
  ).map((result) => result.violation);

  const seen = new Set();
  return violations.filter((violation) => {
    const key = `${violation.invariant_id}|${violation.card_key}|${violation.field_path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  checkConsistencyFieldsPresent,
  checkExecutionStateConsistency,
  checkMlbPitcherKQualityContract,
  checkNoPostDecisionClassificationRewrite,
  checkNoPricingGap,
  checkNoPublishOnWatchdogBlock,
  checkProjectionOnlyNotExecutable,
  runAuditInvariants,
};
