'use strict';

const { compareSnapshots } = require('../compare_audit_snapshot');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildCard(overrides = {}) {
  return {
    game_id: 'nba-20260401-bos-nyk',
    card_type: 'nba-total-call',
    market_type: 'TOTAL',
    period: 'FULL_GAME',
    selection: { side: 'OVER' },
    prediction: 'OVER',
    classification: 'PLAY',
    official_status: 'PLAY',
    execution_status: 'EXECUTABLE',
    actionable: true,
    confidence: 0.61,
    reason_codes: ['EDGE_CLEAR'],
    consistency: {
      pace_tier: 'MID',
      event_env: 'INDOOR',
      total_bias: 'OK',
    },
    _prediction_state: {
      status: 'QUALIFIED',
      reason: null,
    },
    _pricing_state: {
      status: 'FRESH',
      reason: null,
      captured_at: '2026-04-01T18:00:00Z',
    },
    _publish_state: {
      publish_ready: true,
      emit_allowed: true,
      execution_status: 'EXECUTABLE',
      block_reason: null,
    },
    decision_v2: {
      official_status: 'PLAY',
      watchdog_status: 'OK',
      primary_reason_code: 'EDGE_CLEAR',
      watchdog_reason_codes: [],
    },
    ...overrides,
  };
}

function buildSnapshot(overrides = {}) {
  const model = {
    game_id: 'nba-20260401-bos-nyk',
    market_type: 'TOTAL',
    confidence: 0.61,
    projection: { total: 226 },
    p_fair: 0.54,
    p_implied: 0.52,
  };
  const decision = buildCard();
  const publish = buildCard({
    generated_at: '2026-04-01T18:01:00Z',
    run_id: 'audit-run-1',
  });
  const base = {
    fixture_id: 'fixture_1',
    stages: {
      input: { payload: { game_id: 'nba-20260401-bos-nyk', total: 224.5 } },
      enriched: { payload: { game_id: 'nba-20260401-bos-nyk', total: 224.5, tags: ['AUDIT'] } },
      model: { payload: model },
      decision: { payload: decision },
      publish: { payload: publish },
    },
    model_snapshot: model,
    decision_snapshot: decision,
    publish_snapshot: publish,
    final_cards: [publish],
  };

  return {
    ...base,
    ...overrides,
    stages: {
      ...base.stages,
      ...(overrides.stages || {}),
    },
    model_snapshot: overrides.model_snapshot || base.model_snapshot,
    decision_snapshot: overrides.decision_snapshot || base.decision_snapshot,
    publish_snapshot: overrides.publish_snapshot || base.publish_snapshot,
    final_cards: overrides.final_cards || base.final_cards,
  };
}

describe('compareSnapshots', () => {
  test('returns HIGH for strict-field drift', () => {
    const baseline = buildSnapshot();
    const actual = buildSnapshot({
      decision_snapshot: buildCard({ classification: 'LEAN', official_status: 'LEAN' }),
      stages: {
        decision: { payload: buildCard({ classification: 'LEAN', official_status: 'LEAN' }) },
      },
    });

    const result = compareSnapshots(actual, baseline);

    expect(result.high_severity_count).toBeGreaterThan(0);
    expect(result.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field_path: 'decision.classification',
          severity: 'HIGH',
          drift_type: 'DECISION_DRIFT',
        }),
      ]),
    );
  });

  test('suppresses tolerant drift within threshold and emits WARN outside threshold', () => {
    const baseline = buildSnapshot();
    const withinTolerance = buildSnapshot({
      model_snapshot: { ...baseline.model_snapshot, confidence: 0.63 },
      stages: {
        model: { payload: { ...baseline.model_snapshot, confidence: 0.63 } },
      },
    });
    const outsideTolerance = buildSnapshot({
      model_snapshot: { ...baseline.model_snapshot, confidence: 0.68 },
      stages: {
        model: { payload: { ...baseline.model_snapshot, confidence: 0.68 } },
      },
    });

    expect(compareSnapshots(withinTolerance, baseline).warn_count).toBe(0);
    expect(compareSnapshots(outsideTolerance, baseline).diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field_path: 'model.confidence',
          severity: 'WARN',
          comparison_class: 'tolerant',
        }),
      ]),
    );
  });

  test('ignores volatile fields', () => {
    const baseline = buildSnapshot();
    const actual = buildSnapshot({
      publish_snapshot: buildCard({
        generated_at: '2026-04-02T18:01:00Z',
        run_id: 'audit-run-2',
      }),
      stages: {
        publish: {
          payload: buildCard({
            generated_at: '2026-04-02T18:01:00Z',
            run_id: 'audit-run-2',
          }),
        },
      },
      final_cards: [
        buildCard({
          generated_at: '2026-04-02T18:01:00Z',
          run_id: 'audit-run-2',
        }),
      ],
    });

    const result = compareSnapshots(actual, baseline);
    expect(result.diffs).toHaveLength(0);
  });

  test('normalizes reason code ordering, duplicates, and casing', () => {
    const baseline = buildSnapshot();
    const actualCard = buildCard({ reason_codes: ['edge_clear', 'EDGE_CLEAR', 'edge_clear'] });
    const actual = buildSnapshot({
      decision_snapshot: actualCard,
      publish_snapshot: actualCard,
      stages: {
        decision: { payload: actualCard },
        publish: { payload: actualCard },
      },
      final_cards: [actualCard],
    });

    const result = compareSnapshots(actual, baseline);
    expect(result.diffs).toHaveLength(0);
  });

  test('normalizes selection across prediction, selection.side, and selection_type', () => {
    const baselineCard = buildCard({ prediction: null, selection: { side: 'OVER' } });
    const actualCard = buildCard({ selection: {}, prediction: null, selection_type: 'OVER' });
    const baseline = buildSnapshot({
      decision_snapshot: baselineCard,
      publish_snapshot: baselineCard,
      stages: {
        decision: { payload: baselineCard },
        publish: { payload: baselineCard },
      },
      final_cards: [baselineCard],
    });
    const actual = buildSnapshot({
      decision_snapshot: actualCard,
      publish_snapshot: actualCard,
      stages: {
        decision: { payload: actualCard },
        publish: { payload: actualCard },
      },
      final_cards: [actualCard],
    });

    const result = compareSnapshots(actual, baseline);
    expect(result.diffs).toHaveLength(0);
  });

  test('emits SPEC_DRIFT when selection sources conflict', () => {
    const baseline = buildSnapshot();
    const conflicting = buildCard({
      selection: { side: 'OVER' },
      prediction: 'UNDER',
    });
    const actual = buildSnapshot({
      publish_snapshot: conflicting,
      stages: {
        publish: { payload: conflicting },
      },
      final_cards: [conflicting],
    });

    const result = compareSnapshots(actual, baseline);
    expect(result.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          drift_type: 'SPEC_DRIFT',
          field_path: 'publish.selection_signature',
        }),
      ]),
    );
  });

  test('matches cards by identity instead of array order and only reports changed cards', () => {
    const cardA = buildCard({ game_id: 'game-a' });
    const cardB = buildCard({ game_id: 'game-b' });
    const cardC = buildCard({ game_id: 'game-c' });
    const baseline = buildSnapshot({
      final_cards: [cardA, cardB, cardC],
    });
    const changedCardB = buildCard({ game_id: 'game-b', classification: 'LEAN', official_status: 'LEAN' });
    const actual = buildSnapshot({
      final_cards: [cardC, changedCardB, cardA],
    });

    const result = compareSnapshots(actual, baseline);

    expect(result.diffs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          card_key: expect.stringContaining('GAME-B'),
          field_path: 'final_cards.classification',
        }),
      ]),
    );
    expect(result.diffs.filter((diff) => String(diff.card_key).includes('GAME-A'))).toHaveLength(0);
    expect(result.diffs.filter((diff) => String(diff.card_key).includes('GAME-C'))).toHaveLength(0);
  });

  test('raises CRITICAL when decision truth changes after publish', () => {
    const baseline = buildSnapshot();
    const actual = buildSnapshot({
      publish_snapshot: buildCard({ classification: 'PASS', official_status: 'PASS' }),
      stages: {
        publish: { payload: buildCard({ classification: 'PASS', official_status: 'PASS' }) },
      },
      final_cards: [buildCard({ classification: 'PASS', official_status: 'PASS' })],
    });

    const result = compareSnapshots(actual, baseline);

    expect(result.critical_count).toBeGreaterThan(0);
    expect(result.invariant_violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant_id: 'INV-001',
          severity: 'CRITICAL',
        }),
      ]),
    );
  });

  test('raises CRITICAL for execution/pricing mismatch', () => {
    const staleCard = buildCard({
      _pricing_state: {
        status: 'STALE',
        reason: 'STALE_ODDS',
        captured_at: '2026-04-01T18:00:00Z',
      },
    });
    const actual = buildSnapshot({
      publish_snapshot: staleCard,
      decision_snapshot: staleCard,
      stages: {
        decision: { payload: staleCard },
        publish: { payload: staleCard },
      },
      final_cards: [staleCard],
    });

    const result = compareSnapshots(actual, buildSnapshot());
    expect(result.invariant_violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          invariant_id: 'INV-002',
          severity: 'CRITICAL',
        }),
      ]),
    );
  });

  test('reports only publish-stage drift when earlier stages are identical', () => {
    const baseline = buildSnapshot();
    const published = buildCard({ actionable: false, execution_status: 'PROJECTION_ONLY' });
    const actual = buildSnapshot({
      publish_snapshot: published,
      stages: {
        publish: { payload: published },
      },
      final_cards: [published],
    });

    const result = compareSnapshots(actual, baseline);
    expect(result.diffs.every((diff) => diff.stage === 'publish' || diff.stage === 'final_cards')).toBe(true);
  });
});
