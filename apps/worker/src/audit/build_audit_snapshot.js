const nodeCrypto = require('crypto');

const {
  normalizeReasonCodes,
  normalizePeriodToken,
} = require('./audit_rules_config');

const SNAPSHOT_VERSION = 'v1';
const VOLATILE_HASH_FIELDS = new Set([
  'captured_at',
  'created_at',
  'generated_at',
  'job_run_id',
  'run_id',
  'runId',
  'updated_at',
]);

const AUDIT_STAGE_NAMES = Object.freeze({
  input: 'INPUT',
  enriched: 'ENRICHED_INPUT',
  model: 'MODEL_OUTPUT',
  decision: 'DECISION_OUTPUT',
  publish: 'PUBLISH_OUTPUT',
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cloneTrail(trail, segment) {
  if (segment.startsWith('[')) return `${trail}${segment}`;
  return trail === '$' ? `${trail}.${segment}` : `${trail}.${segment}`;
}

function deepClone(value, trail = '$', seen = new WeakMap()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.toISOString());
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return seen.get(value);
    }
    const clone = [];
    seen.set(value, clone);
    value.forEach((entry, index) => {
      clone[index] = deepClone(entry, `${trail}[${index}]`, seen);
    });
    return clone;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return seen.get(value);
    }
    const clone = {};
    seen.set(value, clone);
    Object.keys(value).forEach((key) => {
      clone[key] = deepClone(value[key], cloneTrail(trail, key), seen);
    });
    return clone;
  }
  return value;
}

function normalizeValue(
  value,
  options = {},
  trail = '$',
  seen = new WeakSet(),
) {
  const stripVolatile = options.stripVolatile === true;

  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'bigint') {
    throw new Error(`Non-serializable bigint encountered at ${trail}`);
  }

  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`Non-serializable value encountered at ${trail}`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`Circular reference encountered at ${trail}`);
    }
    seen.add(value);
    const normalized = value.map((entry, index) =>
      normalizeValue(entry, options, `${trail}[${index}]`, seen),
    );
    seen.delete(value);
    return normalized;
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error(`Circular reference encountered at ${trail}`);
    }
    seen.add(value);

    const normalized = {};
    Object.keys(value)
      .sort()
      .forEach((key) => {
        if (stripVolatile && VOLATILE_HASH_FIELDS.has(key)) {
          return;
        }
        normalized[key] = normalizeValue(
          value[key],
          options,
          cloneTrail(trail, key),
          seen,
        );
      });

    seen.delete(value);
    return normalized;
  }

  throw new Error(`Unsupported value encountered at ${trail}`);
}

function normalizeForHash(value) {
  return normalizeValue(value, { stripVolatile: true });
}

function stableHash(value) {
  return nodeCrypto
    .createHash('sha256')
    .update(JSON.stringify(normalizeForHash(value)))
    .digest('hex');
}

function snapshotStage(name, value) {
  const payload = normalizeValue(value, { stripVolatile: false });
  return {
    name,
    hash: stableHash(value),
    payload,
  };
}

function mergeStage(base, override) {
  if (override === undefined) {
    return deepClone(base);
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return deepClone(override);
  }

  const merged = deepClone(base);
  Object.keys(override).forEach((key) => {
    const overrideValue = override[key];
    if (overrideValue === undefined) {
      return;
    }
    if (isPlainObject(merged[key]) && isPlainObject(overrideValue)) {
      merged[key] = mergeStage(merged[key], overrideValue);
      return;
    }
    merged[key] = deepClone(overrideValue);
  });
  return merged;
}

function getStageOverride(fixture, stageName) {
  const containers = [
    fixture?.audit_stages,
    fixture?.input?.audit_stages,
    fixture?.input?._audit_stages,
  ].filter(isPlainObject);

  const aliases = new Set([
    stageName,
    stageName.toLowerCase(),
    stageName.toUpperCase(),
    AUDIT_STAGE_NAMES[stageName],
  ]);

  for (const container of containers) {
    for (const alias of aliases) {
      if (alias && Object.prototype.hasOwnProperty.call(container, alias)) {
        return container[alias];
      }
    }
  }

  return undefined;
}

function inferMarketType(payload) {
  const explicit =
    asNonEmptyString(payload?.market_type) ||
    asNonEmptyString(payload?.expected?.market_type);
  if (explicit) return explicit.toUpperCase();
  if (payload?.total !== undefined) return 'TOTAL';
  if (
    payload?.spread_home !== undefined ||
    payload?.spread_away !== undefined
  ) {
    return 'SPREAD';
  }
  if (payload?.h2h_home !== undefined || payload?.h2h_away !== undefined) {
    return 'MONEYLINE';
  }
  return 'UNKNOWN';
}

function inferExecutionStatus(expected = {}, modelOutput = {}) {
  const explicit =
    asNonEmptyString(expected.execution_status) ||
    asNonEmptyString(expected.stage_categories?.execution_status) ||
    asNonEmptyString(modelOutput.execution_status);

  if (explicit) return explicit.toUpperCase();
  if (expected.projection_floor === true) return 'PROJECTION_ONLY';
  return 'EXECUTABLE';
}

function inferClassification(expected = {}, executionStatus = 'EXECUTABLE') {
  const explicit =
    asNonEmptyString(expected.classification) ||
    asNonEmptyString(expected.stage_categories?.classification);
  if (explicit) return explicit.toUpperCase();
  if (executionStatus === 'BLOCKED') return 'PASS';
  if (executionStatus === 'PROJECTION_ONLY') return 'LEAN';
  return 'PLAY';
}

function inferOfficialStatus(classification) {
  if (classification === 'PLAY') return 'PLAY';
  if (classification === 'LEAN') return 'LEAN';
  return 'PASS';
}

function inferAction(classification) {
  if (classification === 'PLAY') return 'FIRE';
  if (classification === 'LEAN') return 'HOLD';
  return 'PASS';
}

function inferUiStatus(classification) {
  if (classification === 'PLAY') return 'FIRE';
  if (classification === 'LEAN') return 'WATCH';
  return 'PASS';
}

function inferReasonCodes(expected = {}, executionStatus, classification) {
  if (Array.isArray(expected.reason_codes) && expected.reason_codes.length > 0) {
    return normalizeReasonCodes(expected.reason_codes);
  }

  if (executionStatus === 'BLOCKED') return ['BLOCKED_AUDIT_STUB'];
  if (executionStatus === 'PROJECTION_ONLY') return ['PROJECTION_ONLY_AUDIT_STUB'];
  if (classification === 'PLAY') return ['EDGE_CLEAR_AUDIT_STUB'];
  if (classification === 'LEAN') return ['LEAN_SIGNAL_AUDIT_STUB'];
  return ['PASS_NO_EDGE_AUDIT_STUB'];
}

function inferSelectionSide(expected = {}, marketType) {
  const candidates = [
    expected?.selection?.side,
    expected?.selection_side,
    expected?.market_context?.selection_side,
    expected?.selection_type,
    expected?.prediction,
  ];

  for (const candidate of candidates) {
    const token = asNonEmptyString(candidate)?.toUpperCase();
    if (token) return token;
  }

  if (marketType === 'TOTAL') return 'OVER';
  if (marketType === 'SPREAD') return 'HOME';
  if (marketType === 'MONEYLINE') return 'HOME';
  return null;
}

function inferPricingStatus(expected = {}, executionStatus = 'BLOCKED') {
  const explicit = asNonEmptyString(expected?._pricing_state?.status);
  if (explicit) return explicit.toUpperCase();
  if (expected.pricing_ready === true) return 'FRESH';
  if (executionStatus === 'EXECUTABLE') return 'FRESH';
  if (executionStatus === 'PROJECTION_ONLY' || expected.projection_floor === true) {
    return 'NOT_REQUIRED';
  }
  return 'MISSING';
}

function buildCanonicalState(expected = {}, executionStatus, classification) {
  const pricingStatus = inferPricingStatus(expected, executionStatus);
  const publishReady =
    expected?._publish_state?.publish_ready !== undefined
      ? expected._publish_state.publish_ready === true
      : expected.publish_ready !== undefined
        ? expected.publish_ready === true
        : executionStatus === 'EXECUTABLE';
  const predictionState = {
    status:
      expected?._prediction_state?.status ||
      (expected.projection_ready === false ? 'UNQUALIFIED' : 'QUALIFIED'),
    reason:
      expected?._prediction_state?.reason ??
      (expected.projection_ready === false ? 'PROJECTION_INPUTS_INCOMPLETE' : null),
  };
  const pricingState = {
    status: pricingStatus,
    reason: expected?._pricing_state?.reason ?? null,
    captured_at: expected?._pricing_state?.captured_at ?? null,
  };
  const publishState = {
    publish_ready: publishReady,
        emit_allowed:
      expected?._publish_state?.emit_allowed !== undefined
        ? expected._publish_state.emit_allowed === true
        : executionStatus !== 'BLOCKED',
    execution_status: executionStatus,
    block_reason:
      expected?._publish_state?.block_reason ??
      (publishReady ? null : `pricing_status=${pricingStatus}`),
  };

  return {
    _prediction_state: predictionState,
    _pricing_state: pricingState,
    _publish_state: publishState,
  };
}

function buildPipelineState(expected = {}, canonicalState = {}) {
  const pricingReady = canonicalState?._pricing_state?.status === 'FRESH';
  const publishReady = canonicalState?._publish_state?.publish_ready === true;
  const emitAllowed = canonicalState?._publish_state?.emit_allowed === true;

  return {
    projection_ready: expected.projection_ready !== false,
    drivers_ready: expected.drivers_ready !== false,
    pricing_ready: pricingReady,
    card_ready: emitAllowed,
    publish_ready: publishReady,
  };
}

function inferExecutionMode(publishSnapshot, expected = {}) {
  return (
    asNonEmptyString(publishSnapshot?._publish_state?.execution_status) ||
    asNonEmptyString(publishSnapshot?.execution_status) ||
    asNonEmptyString(expected.execution_status) ||
    'BLOCKED'
  ).toUpperCase();
}

function defaultCardType(sport, marketType) {
  const marketToken =
    marketType === 'MONEYLINE' ? 'moneyline' : marketType.toLowerCase();
  return `${sport.toLowerCase()}-${marketToken}-audit-card`;
}

function buildProjectionShape(input, marketType) {
  if (marketType === 'TOTAL') {
    const line = Number.isFinite(input?.total) ? input.total : null;
    return { total: line === null ? null : Number((line + 1.5).toFixed(2)) };
  }
  if (marketType === 'SPREAD') {
    const line = Number.isFinite(input?.spread_home) ? input.spread_home : null;
    return { margin_home: line === null ? null : Number((-line + 1.25).toFixed(2)) };
  }
  if (marketType === 'MONEYLINE') {
    return { win_probability_home: 0.56 };
  }
  return {};
}

function buildDefaultFinalCards(publishOutput, fixture) {
  if (Array.isArray(fixture?.expected?.final_cards)) {
    return deepClone(fixture.expected.final_cards);
  }
  if (
    publishOutput?.emit_card === false ||
    publishOutput?._publish_state?.emit_allowed === false ||
    publishOutput?.publish_ready === false
  ) {
    return [];
  }
  return [deepClone(publishOutput)];
}

function createSportAdapter({ sport, runner }) {
  return {
    sport,
    runner,
    enrich(input, options = {}) {
      const fixture = options.fixture;
      const marketType = inferMarketType({
        ...input,
        expected: fixture?.expected,
      });
      const expected = fixture?.expected || {};
      const canonicalState = buildCanonicalState(
        expected,
        inferExecutionStatus(expected),
        inferClassification(expected),
      );
      const enrichedBase = {
        ...deepClone(input),
        normalized_market_type: marketType,
        tags: ['AUDIT_FIXTURE'],
        slate_context: {
          fixture_id: fixture.fixture_id,
          sport,
          input_contract: fixture.input_contract,
        },
        consistency: {
          pace_tier: 'UNKNOWN',
          event_env: sport === 'MLB' ? 'OUTDOOR' : 'INDOOR',
          event_direction_tag:
            marketType === 'TOTAL'
              ? 'FAVOR_OVER'
              : marketType === 'SPREAD'
                ? 'FAVOR_HOME'
                : 'FAVOR_HOME',
          vol_env: 'STABLE',
          total_bias: marketType === 'TOTAL' ? 'OK' : 'UNKNOWN',
        },
        _prediction_state: canonicalState._prediction_state,
        _pricing_state: canonicalState._pricing_state,
        _publish_state: canonicalState._publish_state,
        pipeline_state: buildPipelineState(expected, canonicalState),
      };

      return mergeStage(enrichedBase, getStageOverride(fixture, 'enriched'));
    },
    model(enrichedInput, options = {}) {
      const fixture = options.fixture;
      const expected = fixture?.expected || {};
      const marketType =
        inferMarketType(enrichedInput) || inferMarketType({ expected });
      const modelBase = {
        game_id: enrichedInput?.game_id || null,
        sport,
        market_type: marketType,
        model_version:
          asNonEmptyString(expected.model_version) || `${sport.toLowerCase()}-audit-stub-v1`,
        runner,
        projection: buildProjectionShape(enrichedInput, marketType),
        p_fair: 0.54,
        p_implied: 0.52,
        support_score: 0.63,
        conflict_score: 0.18,
        slate_context: deepClone(enrichedInput?.slate_context || {}),
        pipeline_state: deepClone(enrichedInput?.pipeline_state || {}),
      };

      return mergeStage(
        mergeStage(modelBase, expected.model_snapshot),
        getStageOverride(fixture, 'model'),
      );
    },
    decide(modelOutput, options = {}) {
      const fixture = options.fixture;
      const expected = fixture?.expected || {};
      const executionStatus = inferExecutionStatus(expected, modelOutput);
      const classification = inferClassification(expected, executionStatus);
      const officialStatus = inferOfficialStatus(classification);
      const reasonCodes = inferReasonCodes(
        expected,
        executionStatus,
        classification,
      );
      const marketType = inferMarketType(modelOutput);
      const selectionSide = inferSelectionSide(expected, marketType);
      const canonicalState = buildCanonicalState(
        expected,
        executionStatus,
        classification,
      );
      const pipelineState = buildPipelineState(expected, canonicalState);
      const period = normalizePeriodToken(expected);

      const decisionBase = {
        ...deepClone(modelOutput),
        card_type:
          asNonEmptyString(expected.card_type) || defaultCardType(sport, marketType),
        market_type: marketType,
        selection: {
          side: selectionSide,
        },
        prediction: selectionSide,
        period,
        classification,
        official_status: officialStatus,
        execution_status: executionStatus,
        action: inferAction(classification),
        status: inferUiStatus(classification),
        actionable:
          expected.actionable !== undefined
            ? expected.actionable === true
            : classification === 'PLAY' && executionStatus === 'EXECUTABLE',
        publish_ready: pipelineState.publish_ready,
        reason_codes: reasonCodes,
        _prediction_state: canonicalState._prediction_state,
        _pricing_state: canonicalState._pricing_state,
        _publish_state: canonicalState._publish_state,
        decision_v2: {
          official_status: officialStatus,
          primary_reason_code: reasonCodes[0] || null,
          play_tier: classification === 'PLAY' ? 'GOOD' : classification,
          watchdog_status: executionStatus === 'BLOCKED' ? 'BLOCKED' : 'OK',
          pipeline_version: 'audit-v1',
        },
        pipeline_state: pipelineState,
        stage_categories: {
          execution_status: executionStatus,
          classification,
        },
      };

      return mergeStage(
        mergeStage(decisionBase, expected.decision_snapshot),
        getStageOverride(fixture, 'decision'),
      );
    },
    publish(decisionOutput, options = {}) {
      const fixture = options.fixture;
      const expected = fixture?.expected || {};
      const publishBase = {
        ...deepClone(decisionOutput),
        generated_at:
          asNonEmptyString(expected.generated_at) ||
          asNonEmptyString(fixture?.input?.captured_at) ||
          null,
        run_id: `audit-${fixture.fixture_id}`,
      };

      return mergeStage(
        mergeStage(publishBase, expected.publish_snapshot),
        getStageOverride(fixture, 'publish'),
      );
    },
    extractFinalCards(publishOutput, options = {}) {
      if (Array.isArray(publishOutput?.final_cards)) {
        return deepClone(publishOutput.final_cards);
      }
      return buildDefaultFinalCards(publishOutput, options.fixture);
    },
  };
}

const DEFAULT_ADAPTERS = Object.freeze({
  NBA: createSportAdapter({ sport: 'NBA', runner: 'run_nba_model' }),
  MLB: createSportAdapter({ sport: 'MLB', runner: 'run_mlb_model' }),
  NHL: createSportAdapter({ sport: 'NHL', runner: 'run_nhl_model' }),
});

function getAuditStageAdapter(sport, options = {}) {
  const normalizedSport = asNonEmptyString(sport)?.toUpperCase();
  if (!normalizedSport) {
    throw new Error('Audit snapshot requires a sport');
  }

  const override = options.adapterOverrides?.[normalizedSport];
  const adapter = override || DEFAULT_ADAPTERS[normalizedSport];
  if (!adapter) {
    throw new Error(`No audit stage adapter registered for sport ${normalizedSport}`);
  }
  return adapter;
}

function buildAuditSnapshot(fixture, options = {}) {
  if (!fixture || typeof fixture !== 'object') {
    throw new Error('buildAuditSnapshot requires a fixture object');
  }

  const adapter = getAuditStageAdapter(fixture.sport, options);
  const runAt = options.runAt || new Date().toISOString();
  const fixtureInput = deepClone(fixture.input);

  const inputLive = fixtureInput;
  const inputStage = snapshotStage('input', inputLive);

  const enrichedLive = adapter.enrich(deepClone(inputLive), {
    fixture,
    options,
  });
  const enrichedStage = snapshotStage('enriched', enrichedLive);

  const modelLive = adapter.model(deepClone(enrichedLive), {
    fixture,
    options,
  });
  const modelStage = snapshotStage('model', modelLive);

  const decisionLive = adapter.decide(deepClone(modelLive), {
    fixture,
    options,
  });
  const decisionStage = snapshotStage('decision', decisionLive);

  const publishLive = adapter.publish(deepClone(decisionLive), {
    fixture,
    options,
  });
  const publishStage = snapshotStage('publish', publishLive);

  const finalCards = normalizeValue(
    adapter.extractFinalCards(deepClone(publishLive), {
      fixture,
      options,
    }),
  );

  const stageHashes = {
    input: inputStage.hash,
    enriched: enrichedStage.hash,
    model: modelStage.hash,
    decision: decisionStage.hash,
    publish: publishStage.hash,
  };

  const snapshot = {
    snapshot_version: SNAPSHOT_VERSION,
    fixture_id: fixture.fixture_id,
    sport: fixture.sport,
    model_version:
      publishStage.payload?.model_version ||
      modelStage.payload?.model_version ||
      null,
    run_at: runAt,
    stage_metadata: {
      input_contract: fixture.input_contract,
      runner: adapter.runner || null,
      execution_mode: inferExecutionMode(publishStage.payload, fixture.expected),
    },
    stages: {
      input: { hash: inputStage.hash, payload: inputStage.payload },
      enriched: { hash: enrichedStage.hash, payload: enrichedStage.payload },
      model: { hash: modelStage.hash, payload: modelStage.payload },
      decision: { hash: decisionStage.hash, payload: decisionStage.payload },
      publish: { hash: publishStage.hash, payload: publishStage.payload },
    },
    stage_hashes: stageHashes,
    model_snapshot: modelStage.payload,
    decision_snapshot: decisionStage.payload,
    publish_snapshot: publishStage.payload,
    final_cards: finalCards,
    violations:
      typeof options.invariantChecker === 'function'
        ? normalizeValue(options.invariantChecker({
            fixture,
            snapshot: {
              input: inputStage.payload,
              enriched: enrichedStage.payload,
              model: modelStage.payload,
              decision: decisionStage.payload,
              publish: publishStage.payload,
            },
          }))
        : [],
  };

  return normalizeValue(snapshot);
}

module.exports = {
  AUDIT_STAGE_NAMES,
  SNAPSHOT_VERSION,
  buildAuditSnapshot,
  deepClone,
  getAuditStageAdapter,
  normalizeForHash,
  snapshotStage,
  stableHash,
};
