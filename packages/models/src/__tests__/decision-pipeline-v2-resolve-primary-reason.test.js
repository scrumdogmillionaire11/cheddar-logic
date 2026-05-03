'use strict';

/**
 * Tests for WI-1225: resolvePrimaryReason explicit fallback semantics.
 *
 * Covers:
 *   - null-edge fallback → PASS_MISSING_EDGE
 *   - below-threshold explicit branch → SUPPORT_BELOW_PLAY_THRESHOLD (unchanged)
 *   - computed-edge residual fallback → PASS_NO_EDGE
 *   - resolveTerminalReasonFamily maps both fallback outcomes to EDGE_INSUFFICIENT
 */

describe('resolvePrimaryReason fallback semantics (WI-1225)', () => {
  let resolvePrimaryReason;
  let resolveTerminalReasonFamily;

  // NHL MONEYLINE thresholds with ENABLE_MARKET_THRESHOLDS_V2=true (default):
  //   support.lean = 0.45, edge.play_edge_min = 0.058
  const BASE_ARGS = {
    watchdogReasonCodes: [],
    watchdogStatus: 'OK',
    sharpPriceStatus: 'CHEDDAR',
    priceReasonCodes: [],
    officialStatus: 'PASS',
    supportScore: 0.7,
    sport: 'NHL',
    marketType: 'MONEYLINE',
    proxyCapped: false,
  };

  beforeEach(() => {
    jest.resetModules();
    ({ resolvePrimaryReason, resolveTerminalReasonFamily } = require('../decision-pipeline-v2'));
  });

  it('returns PASS_MISSING_EDGE when edgePct is null and support is above lean threshold', () => {
    const result = resolvePrimaryReason({ ...BASE_ARGS, edgePct: null });
    expect(result).toBe('PASS_MISSING_EDGE');
  });

  it('returns SUPPORT_BELOW_PLAY_THRESHOLD when edgePct is below play_edge_min', () => {
    // 0.01 < 0.058 (NHL MONEYLINE play_edge_min)
    const result = resolvePrimaryReason({ ...BASE_ARGS, edgePct: 0.01 });
    expect(result).toBe('SUPPORT_BELOW_PLAY_THRESHOLD');
  });

  it('returns PASS_NO_EDGE when edgePct is above play_edge_min but status is PASS', () => {
    // 0.99 > 0.058 — residual computed-edge fallback
    const result = resolvePrimaryReason({ ...BASE_ARGS, edgePct: 0.99 });
    expect(result).toBe('PASS_NO_EDGE');
  });

  it('resolveTerminalReasonFamily maps PASS_MISSING_EDGE to EDGE_INSUFFICIENT', () => {
    const family = resolveTerminalReasonFamily({
      officialStatus: 'PASS',
      watchdogStatus: 'OK',
      priceReasonCodes: [],
      primaryReasonCode: 'PASS_MISSING_EDGE',
    });
    expect(family).toBe('EDGE_INSUFFICIENT');
  });

  it('resolveTerminalReasonFamily maps PASS_NO_EDGE to EDGE_INSUFFICIENT', () => {
    const family = resolveTerminalReasonFamily({
      officialStatus: 'PASS',
      watchdogStatus: 'OK',
      priceReasonCodes: [],
      primaryReasonCode: 'PASS_NO_EDGE',
    });
    expect(family).toBe('EDGE_INSUFFICIENT');
  });

  it('does not affect PLAY/LEAN path — still returns EDGE_CLEAR', () => {
    const result = resolvePrimaryReason({ ...BASE_ARGS, officialStatus: 'PLAY', edgePct: 0.1 });
    expect(result).toBe('EDGE_CLEAR');
  });

  it('does not affect SUPPORT_BELOW_LEAN_THRESHOLD path', () => {
    const result = resolvePrimaryReason({ ...BASE_ARGS, supportScore: 0.1, edgePct: null });
    expect(result).toBe('SUPPORT_BELOW_LEAN_THRESHOLD');
  });
});
