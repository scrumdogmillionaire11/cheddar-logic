'use strict';

const {
  evaluateExecution,
} = require('../execution-gate');

describe('evaluateExecution', () => {
  test('passes when all execution gates clear', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(true);
    expect(result.reason).toBe('ALL_GATES_PASSED');
    expect(result.netEdge).toBeCloseTo(0.05, 6);
    expect(result.blocked_by).toEqual([]);
  });

  test('blocks when model status is not MODEL_OK', () => {
    const result = evaluateExecution({
      modelStatus: 'NO_BET',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('MODEL_STATUS_NO_BET');
  });

  test('blocks when net edge is below threshold', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.05,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.netEdge).toBeCloseTo(0, 6);
    expect(result.blocked_by).toContain('NET_EDGE_INSUFFICIENT:0.0000');
  });

  test('blocks stale snapshots', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 6 * 60 * 1000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('STALE_SNAPSHOT:360s');
  });

  test('blocks when confidence is below 0.55 threshold', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.549,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('CONFIDENCE_BELOW_THRESHOLD:0.549');
  });

  // DEGRADED coupling test: input-gate caps DEGRADED confidence at 0.55.
  // The execution floor must be <=0.55 so DEGRADED plays surface as WATCH-tier.
  // If this test breaks, input-gate.js DEGRADED_CONSTRAINTS.MAX_CONFIDENCE and
  // the execution-gate default minConfidence are out of sync — fix both together.
  test('allows DEGRADED play at confidence=0.55 (DEGRADED cap) through execution gate', () => {
    const result = evaluateExecution({
      modelStatus: 'DEGRADED',
      rawEdge: 0.1,
      confidence: 0.55,
      snapshotAgeMs: 30_000,
    });

    // MODEL_STATUS_DEGRADED blocks the gate — but confidence alone should NOT
    // add a CONFIDENCE_BELOW_THRESHOLD block, so the only blocker is the model
    // status. Callers that allow DEGRADED plays through model-status gating
    // will not be double-blocked on confidence.
    expect(result.blocked_by).not.toContain('CONFIDENCE_BELOW_THRESHOLD:0.550');
    expect(result.blocked_by).toContain('MODEL_STATUS_DEGRADED');
  });

  test('blocks mixed-book line/price source mismatches before executable status', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.75,
      snapshotAgeMs: 30_000,
      lineSource: 'draftkings',
      priceSource: 'fanduel',
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain(
      'MIXED_BOOK_SOURCE_MISMATCH:draftkings->fanduel',
    );
    expect(result.drop_reason).toMatchObject({
      drop_reason_code: 'MIXED_BOOK_INTEGRITY_GATE',
      drop_reason_layer: 'worker_gate',
    });
  });
});
