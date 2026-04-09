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

  test('blocks when confidence is below threshold', () => {
    const result = evaluateExecution({
      modelStatus: 'MODEL_OK',
      rawEdge: 0.1,
      confidence: 0.5,
      snapshotAgeMs: 30_000,
    });

    expect(result.shouldBet).toBe(false);
    expect(result.blocked_by).toContain('CONFIDENCE_BELOW_THRESHOLD:0.500');
  });
});
