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
  checkNoPostDecisionClassificationRewrite,
  checkNoPricingGap,
  checkNoPublishOnWatchdogBlock,
  checkProjectionOnlyNotExecutable,
  runAuditInvariants,
};
