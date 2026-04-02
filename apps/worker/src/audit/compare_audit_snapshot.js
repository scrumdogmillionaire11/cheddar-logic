'use strict';

const {
  asToken,
  getCardKey,
  getSelectionSignature,
  getToleranceRule,
  isIgnoredField,
  isStrictField,
  normalizeReasonCodes,
} = require('./audit_rules_config');
const { runAuditInvariants } = require('./audit_invariants');

const STAGE_TO_DRIFT = Object.freeze({
  input: 'INPUT_SHAPE_DRIFT',
  enriched: 'INPUT_SHAPE_DRIFT',
  model: 'MODEL_DRIFT',
  decision: 'DECISION_DRIFT',
  publish: 'PUBLISH_DRIFT',
  final_cards: 'PUBLISH_DRIFT',
});

const STAGE_ORDER = Object.freeze(['input', 'enriched', 'model', 'decision', 'publish', 'final_cards']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSelectionCompatibilityPath(pathSegments = []) {
  const joined = pathSegments.join('.');
  return (
    joined.endsWith('prediction') ||
    joined.endsWith('selection_type') ||
    joined.endsWith('selection') ||
    joined.endsWith('selection.side') ||
    joined.endsWith('selection.team') ||
    joined.endsWith('market_context.selection_side')
  );
}

function getStagePayload(snapshot, stageName) {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  if (stageName === 'final_cards') return snapshot.final_cards;
  if (snapshot.stages?.[stageName]?.payload !== undefined) {
    return snapshot.stages[stageName].payload;
  }
  if (stageName === 'model') return snapshot.model_snapshot;
  if (stageName === 'decision') return snapshot.decision_snapshot;
  if (stageName === 'publish') return snapshot.publish_snapshot;
  return snapshot[stageName];
}

function compareReasonCodes(actual, expected, context) {
  const normalizedActual = normalizeReasonCodes(actual);
  const normalizedExpected = normalizeReasonCodes(expected);
  if (JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected)) {
    return [];
  }
  return [{
    card_key: context.cardKey,
    field_path: context.fieldPath,
    expected: normalizedExpected,
    actual: normalizedActual,
    drift_type: context.driftType,
    severity: 'HIGH',
    comparison_class: 'strict',
    stage: context.stage,
  }];
}

function compareSelectionSignature(actualNode, expectedNode, context) {
  const actualSelection = getSelectionSignature(actualNode);
  const expectedSelection = getSelectionSignature(expectedNode);
  if (actualSelection.conflict || expectedSelection.conflict) {
    return [{
      card_key: context.cardKey,
      field_path: `${context.basePath}.selection_signature`,
      expected: expectedSelection.conflict ? expectedSelection.sources : expectedSelection.signature,
      actual: actualSelection.conflict ? actualSelection.sources : actualSelection.signature,
      drift_type: 'SPEC_DRIFT',
      severity: 'HIGH',
      comparison_class: 'spec',
      stage: context.stage,
    }];
  }
  if (actualSelection.signature === expectedSelection.signature) {
    return [];
  }
  if (!actualSelection.signature && !expectedSelection.signature) {
    return [];
  }
  return [{
    card_key: context.cardKey,
    field_path: `${context.basePath}.selection_signature`,
    expected: expectedSelection.signature,
    actual: actualSelection.signature,
    drift_type: context.driftType,
    severity: 'HIGH',
    comparison_class: 'strict',
    stage: context.stage,
  }];
}

function comparePrimitive(actual, expected, context) {
  if (context.fieldPath.endsWith('reason_codes')) {
    return compareReasonCodes(actual, expected, context);
  }

  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return [];
  }

  const toleranceRule = getToleranceRule(context.fieldPath);
  if (
    toleranceRule &&
    typeof actual === 'number' &&
    typeof expected === 'number'
  ) {
    const delta = actual - expected;
    const up = typeof toleranceRule === 'number' ? toleranceRule : toleranceRule.up;
    const down = typeof toleranceRule === 'number' ? toleranceRule : toleranceRule.down;
    if (delta <= up && delta >= -down) {
      return [];
    }
    return [{
      card_key: context.cardKey,
      field_path: context.fieldPath,
      expected,
      actual,
      drift_type: context.driftType,
      severity: 'WARN',
      comparison_class: 'tolerant',
      stage: context.stage,
    }];
  }

  return [{
    card_key: context.cardKey,
    field_path: context.fieldPath,
    expected,
    actual,
    drift_type: isStrictField(context.fieldPath) ? context.driftType : context.driftType,
    severity: 'HIGH',
    comparison_class: isStrictField(context.fieldPath) ? 'strict' : 'default',
    stage: context.stage,
  }];
}

function compareArray(actual, expected, context) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    return [{
      card_key: context.cardKey,
      field_path: context.fieldPath,
      expected,
      actual,
      drift_type: 'SPEC_DRIFT',
      severity: 'HIGH',
      comparison_class: 'spec',
      stage: context.stage,
    }];
  }

  const containsObjects = actual.some(isPlainObject) || expected.some(isPlainObject);
  if (!containsObjects) {
    return comparePrimitive(actual, expected, context);
  }

  const actualMap = new Map();
  const expectedMap = new Map();
  const diffs = [];

  const loadMap = (entries, targetMap, sideLabel) => {
    for (const entry of entries) {
      const cardKey = getCardKey(entry, { fallbackType: context.stage.toUpperCase() });
      if (targetMap.has(cardKey)) {
        diffs.push({
          card_key: cardKey,
          field_path: context.fieldPath,
          expected: sideLabel === 'expected' ? 'unique identity' : undefined,
          actual: sideLabel === 'actual' ? 'duplicate identity' : undefined,
          drift_type: 'SPEC_DRIFT',
          severity: 'HIGH',
          comparison_class: 'spec',
          stage: context.stage,
        });
        continue;
      }
      targetMap.set(cardKey, entry);
    }
  };

  loadMap(actual, actualMap, 'actual');
  loadMap(expected, expectedMap, 'expected');

  const allKeys = Array.from(new Set([...actualMap.keys(), ...expectedMap.keys()])).sort();
  allKeys.forEach((cardKey) => {
    if (!actualMap.has(cardKey) || !expectedMap.has(cardKey)) {
      diffs.push({
        card_key: cardKey,
        field_path: context.fieldPath,
        expected: expectedMap.has(cardKey) ? expectedMap.get(cardKey) : undefined,
        actual: actualMap.has(cardKey) ? actualMap.get(cardKey) : undefined,
        drift_type: 'SPEC_DRIFT',
        severity: 'HIGH',
        comparison_class: 'spec',
        stage: context.stage,
      });
      return;
    }

    diffs.push(
      ...compareNode(actualMap.get(cardKey), expectedMap.get(cardKey), {
        ...context,
        basePath: context.fieldPath,
        cardKey,
        fieldPath: context.fieldPath,
      }),
    );
  });

  return diffs;
}

function compareObject(actual, expected, context) {
  const diffs = [];
  diffs.push(...compareSelectionSignature(actual, expected, context));

  const keys = Array.from(new Set([
    ...Object.keys(actual || {}),
    ...Object.keys(expected || {}),
  ])).sort();

  keys.forEach((key) => {
    const nextSegments = [...context.pathSegments, key];
    if (isIgnoredField(nextSegments)) return;
    if (isSelectionCompatibilityPath(nextSegments)) return;

    const nextPath = context.fieldPath ? `${context.fieldPath}.${key}` : key;
    const actualValue = actual?.[key];
    const expectedValue = expected?.[key];

    if (actualValue === undefined || expectedValue === undefined) {
      const missingIsEmptyArray =
        (actualValue === undefined && Array.isArray(expectedValue) && expectedValue.length === 0) ||
        (expectedValue === undefined && Array.isArray(actualValue) && actualValue.length === 0);
      if (!missingIsEmptyArray) {
        diffs.push({
          card_key: context.cardKey,
          field_path: nextPath,
          expected: expectedValue,
          actual: actualValue,
          drift_type: 'SPEC_DRIFT',
          severity: 'HIGH',
          comparison_class: 'spec',
          stage: context.stage,
        });
      }
      return;
    }

    diffs.push(
      ...compareNode(actualValue, expectedValue, {
        ...context,
        fieldPath: nextPath,
        pathSegments: nextSegments,
      }),
    );
  });

  return diffs;
}

function compareNode(actual, expected, context) {
  if (actual === undefined && expected === undefined) return [];
  const actualArray = Array.isArray(actual);
  const expectedArray = Array.isArray(expected);
  if (actualArray || expectedArray) {
    return compareArray(actual, expected, context);
  }

  const actualObject = isPlainObject(actual);
  const expectedObject = isPlainObject(expected);
  if (actualObject || expectedObject) {
    if (!actualObject || !expectedObject) {
      return [{
        card_key: context.cardKey,
        field_path: context.fieldPath,
        expected,
        actual,
        drift_type: 'SPEC_DRIFT',
        severity: 'HIGH',
        comparison_class: 'spec',
        stage: context.stage,
      }];
    }
    return compareObject(actual, expected, context);
  }

  if (
    actual !== null &&
    expected !== null &&
    typeof actual !== typeof expected
  ) {
    return [{
      card_key: context.cardKey,
      field_path: context.fieldPath,
      expected,
      actual,
      drift_type: 'SPEC_DRIFT',
      severity: 'HIGH',
      comparison_class: 'spec',
      stage: context.stage,
    }];
  }

  return comparePrimitive(actual, expected, context);
}

function dedupeDiffs(diffs = []) {
  const seen = new Set();
  return diffs
    .sort((left, right) =>
      STAGE_ORDER.indexOf(left.stage) - STAGE_ORDER.indexOf(right.stage),
    )
    .filter((diff) => {
      const key = `${diff.card_key || 'ROOT'}|${diff.field_path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function compareSnapshots(actualSnapshot, baselineSnapshot, options = {}) {
  const fixtureId =
    actualSnapshot?.fixture_id || baselineSnapshot?.fixture_id || options.fixture_id || 'unknown_fixture';
  const allDiffs = [];

  STAGE_ORDER.forEach((stage) => {
    const actualPayload = getStagePayload(actualSnapshot, stage);
    const baselinePayload = getStagePayload(baselineSnapshot, stage);
    if (actualPayload === undefined && baselinePayload === undefined) return;
    const stageCardKey =
      stage === 'final_cards'
        ? `${fixtureId}|FINAL_CARDS`
        : isPlainObject(actualPayload || baselinePayload)
          ? getCardKey(actualPayload || baselinePayload, {
              fallbackType: stage.toUpperCase(),
            })
          : `${fixtureId}|${stage.toUpperCase()}`;
    allDiffs.push(
      ...compareNode(actualPayload, baselinePayload, {
        basePath: stage,
        cardKey: stageCardKey,
        driftType: STAGE_TO_DRIFT[stage],
        fieldPath: stage,
        pathSegments: [stage],
        stage,
      }),
    );
  });

  const diffs = dedupeDiffs(allDiffs);
  const invariantViolations = runAuditInvariants({
    decisionSnapshot: getStagePayload(actualSnapshot, 'decision'),
    publishSnapshot: getStagePayload(actualSnapshot, 'publish'),
    cards: getStagePayload(actualSnapshot, 'final_cards'),
  });
  const criticalCount = invariantViolations.filter((violation) => violation.severity === 'CRITICAL').length;
  const highSeverityCount = diffs.filter((diff) => diff.severity === 'HIGH').length;
  const warnCount =
    diffs.filter((diff) => diff.severity === 'WARN').length +
    invariantViolations.filter((violation) => violation.severity === 'WARN').length;

  return {
    fixture_id: fixtureId,
    passed: criticalCount === 0 && highSeverityCount === 0,
    critical_count: criticalCount,
    high_severity_count: highSeverityCount,
    warn_count: warnCount,
    invariant_violations: invariantViolations,
    diffs,
  };
}

module.exports = {
  compareSnapshots,
};
