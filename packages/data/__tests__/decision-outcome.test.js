const path = require('path');
const { createRequire } = require('module');

const {
  buildDecisionOutcomeFromDecisionV2,
  mapReasonsToOutcome,
  normalizeDecisionOutcomeStatus,
  validateDecisionOutcome,
} = require('../src/decision-outcome');

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  Object.getOwnPropertyNames(value).forEach((key) => {
    const next = value[key];
    if (next && typeof next === 'object' && !Object.isFrozen(next)) {
      deepFreeze(next);
    }
  });
  return value;
}

function sampleDecisionV2(overrides) {
  return {
    official_status: 'PLAY',
    selection: {
      market: 'NHL_1P_TOTAL',
      side: 'OVER',
      line: 5.5,
      price: -110,
    },
    edge_pct: 0.071,
    confidence: 0.82,
    reason_codes: ['EDGE_FOUND', 'LINE_NOT_CONFIRMED'],
    blocking_reason_codes: ['BLOCK_INJURY_RISK'],
    watchdog_reason_codes: ['WATCHDOG_CONSISTENCY_MISSING'],
    price_reason_codes: ['PASS_NO_EDGE'],
    line_verified: true,
    data_fresh: true,
    projection_inputs_complete: true,
    model: 'nhl-v2',
    generated_at: '2026-04-27T12:00:00.000Z',
    ...overrides,
  };
}

describe('WI-1199 DecisionOutcome contract', () => {
  test('normalizes PLAY status', () => {
    expect(normalizeDecisionOutcomeStatus('PLAY')).toBe('PLAY');
  });

  test('normalizes LEAN status into SLIGHT_EDGE', () => {
    expect(normalizeDecisionOutcomeStatus('lean')).toBe('SLIGHT_EDGE');
  });

  test('normalizes unknown status to PASS', () => {
    expect(normalizeDecisionOutcomeStatus('UNKNOWN')).toBe('PASS');
  });

  test('builds PLAY outcome from decision_v2 payload', () => {
    const outcome = buildDecisionOutcomeFromDecisionV2(
      sampleDecisionV2({ official_status: 'PLAY' }),
      { model: 'canon-model', timestamp: '2026-04-27T13:00:00.000Z' },
    );
    expect(outcome.status).toBe('PLAY');
  });

  test('builds SLIGHT_EDGE outcome from LEAN threshold status', () => {
    const outcome = buildDecisionOutcomeFromDecisionV2(
      sampleDecisionV2({ official_status: 'LEAN' }),
      { model: 'canon-model', timestamp: '2026-04-27T13:00:00.000Z' },
    );
    expect(outcome.status).toBe('SLIGHT_EDGE');
  });

  test('maps PASS blockers into reasons.blockers', () => {
    const outcome = buildDecisionOutcomeFromDecisionV2(
      sampleDecisionV2({
        official_status: 'PASS',
        blocking_reason_codes: ['BLOCK_INJURY_RISK', 'PASS_EXECUTION_GATE_BLOCKED'],
        watchdog_reason_codes: [],
      }),
      { model: 'canon-model', timestamp: '2026-04-27T13:00:00.000Z' },
    );
    expect(outcome.status).toBe('PASS');
    expect(outcome.reasons.blockers).toEqual([
      'BLOCK_INJURY_RISK',
      'PASS_EXECUTION_GATE_BLOCKED',
    ]);
  });

  test('reason mapping deduplicates and preserves first-seen order', () => {
    const reasons = mapReasonsToOutcome(
      sampleDecisionV2({
        reason_codes: ['PASS_NO_EDGE', 'EDGE_FOUND', 'PASS_NO_EDGE'],
        watchdog_reason_codes: ['WATCHDOG_CONSISTENCY_MISSING', 'EDGE_FOUND'],
      }),
    );

    expect(reasons.pass).toEqual(['PASS_NO_EDGE']);
    expect(reasons.warnings).toEqual(['EDGE_FOUND']);
    expect(reasons.blockers).toEqual(['BLOCK_INJURY_RISK', 'WATCHDOG_CONSISTENCY_MISSING']);
  });

  test('maps primary_reason_code blocker when no reason arrays are populated', () => {
    const reasons = mapReasonsToOutcome({
      primary_reason_code: 'BLOCK_MISSING_INPUTS',
    });

    expect(reasons).toEqual({
      blockers: ['BLOCK_MISSING_INPUTS'],
    });
  });

  test('validator accepts valid DecisionOutcome', () => {
    const candidate = buildDecisionOutcomeFromDecisionV2(sampleDecisionV2(), {
      model: 'canon-model',
      timestamp: '2026-04-27T13:00:00.000Z',
    });
    expect(validateDecisionOutcome(candidate)).toEqual({ valid: true });
  });

  test('validator rejects invalid status enum', () => {
    const result = validateDecisionOutcome({
      status: 'INVALID',
      selection: { market: 'NHL_1P_TOTAL', side: 'OVER' },
      edge: null,
      confidence: null,
      reasons: {},
      verification: {
        line_verified: false,
        data_fresh: false,
        inputs_complete: false,
      },
      source: {
        model: 'x',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    });

    expect(result.valid).toBe(false);
    expect((result.errors || []).join('|')).toContain('status must be one of');
  });

  test('validator rejects missing required fields', () => {
    const result = validateDecisionOutcome({
      status: 'PLAY',
      edge: 0.1,
      confidence: 0.8,
      reasons: {},
      source: { model: '', timestamp: '' },
    });
    expect(result.valid).toBe(false);
    expect((result.errors || []).join('|')).toContain('selection must be an object');
    expect((result.errors || []).join('|')).toContain('verification must be an object');
  });

  test('builder defaults to stable fallback metadata when model/timestamp absent', () => {
    const outcome = buildDecisionOutcomeFromDecisionV2(
      sampleDecisionV2({ model: undefined, generated_at: undefined }),
      {},
    );
    expect(outcome.source.model).toBe('unknown');
    expect(outcome.source.timestamp).toBe('1970-01-01T00:00:00.000Z');
  });

  test('builder is pure and deterministic for identical input over repeated runs', () => {
    const decision = deepFreeze(sampleDecisionV2());
    const metadata = deepFreeze({
      model: 'canon-model',
      timestamp: '2026-04-27T13:00:00.000Z',
      line_verified: true,
      data_fresh: true,
      inputs_complete: true,
    });

    const beforeDecision = deepClone(decision);
    const beforeMetadata = deepClone(metadata);

    const runs = [];
    for (let i = 0; i < 10; i += 1) {
      runs.push(buildDecisionOutcomeFromDecisionV2(decision, metadata));
    }

    const json = runs.map((entry) => JSON.stringify(entry));
    expect(new Set(json).size).toBe(1);
    expect(decision).toEqual(beforeDecision);
    expect(metadata).toEqual(beforeMetadata);
  });

  test('cross-consumer JSON identity is byte-identical across web, worker, and package consumer', () => {
    const rootDir = path.resolve(__dirname, '..', '..', '..');
    const webRequire = createRequire(path.join(rootDir, 'web', 'package.json'));
    const workerRequire = createRequire(path.join(rootDir, 'apps', 'worker', 'package.json'));
    const packageRequire = createRequire(path.join(rootDir, 'packages', 'data', 'package.json'));

    const webBuilder = webRequire('@cheddar-logic/data').buildDecisionOutcomeFromDecisionV2;
    const workerBuilder = workerRequire('@cheddar-logic/data').buildDecisionOutcomeFromDecisionV2;
    const packageBuilder = packageRequire('@cheddar-logic/data').buildDecisionOutcomeFromDecisionV2;

    const decision = sampleDecisionV2();
    const metadata = {
      model: 'canon-model',
      timestamp: '2026-04-27T13:00:00.000Z',
      line_verified: true,
      data_fresh: true,
      inputs_complete: true,
    };

    const sequences = [
      { name: 'web', build: webBuilder },
      { name: 'worker', build: workerBuilder },
      { name: 'package', build: packageBuilder },
    ].map((entry) => {
      const outputs = [];
      for (let i = 0; i < 10; i += 1) {
        outputs.push(JSON.stringify(entry.build(decision, metadata)));
      }
      return { name: entry.name, outputs };
    });

    sequences.forEach((entry) => {
      expect(new Set(entry.outputs).size).toBe(1);
    });

    const baseline = sequences[0].outputs[0];
    sequences.forEach((entry) => {
      expect(entry.outputs[0]).toBe(baseline);
    });
  });

  test('builder carries verification booleans from metadata when absent in decision payload', () => {
    const outcome = buildDecisionOutcomeFromDecisionV2(
      sampleDecisionV2({ line_verified: undefined, data_fresh: undefined, projection_inputs_complete: undefined }),
      { line_verified: true, data_fresh: false, inputs_complete: true, model: 'canon-model', timestamp: '2026-04-27T13:00:00.000Z' },
    );
    expect(outcome.verification).toEqual({
      line_verified: true,
      data_fresh: false,
      inputs_complete: true,
    });
  });

  test('builder falls back to UNKNOWN selection tokens when missing', () => {
    const outcome = buildDecisionOutcomeFromDecisionV2(
      sampleDecisionV2({ selection: undefined, market_type: undefined, prediction: undefined }),
      { model: 'canon-model', timestamp: '2026-04-27T13:00:00.000Z' },
    );

    expect(outcome.selection.market).toBe('UNKNOWN');
    expect(outcome.selection.side).toBe('UNKNOWN');
  });
});
