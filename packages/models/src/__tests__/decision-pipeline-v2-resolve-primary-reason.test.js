'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tests for WI-1225: resolvePrimaryReason explicit fallback semantics.
 *
 * Covers:
 *   - null-edge fallback → PASS_MISSING_EDGE
 *   - below-threshold explicit branch → SUPPORT_BELOW_PLAY_THRESHOLD (unchanged)
 *   - computed-edge residual fallback → PASS_NO_EDGE
 *   - resolveTerminalReasonFamily maps both fallback outcomes to EDGE_INSUFFICIENT
 */

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();

function buildNhlMlPayload(overrides = {}) {
  return {
    kind: 'PLAY',
    sport: 'NHL',
    market_type: 'MONEYLINE',
    model_prob: 0.64,
    price: -110,
    selection: { side: 'HOME' },
    prediction: 'HOME',
    driver: {
      key: 'moneyline_signal',
      score: 0.6,
      inputs: {
        conflict: 0.1,
      },
    },
    drivers_active: ['moneyline_signal'],
    consistency: {
      pace_tier: 'MEDIUM',
      event_env: 'NEUTRAL',
      event_direction_tag: 'FAVOR_HOME',
      vol_env: 'STABLE',
      total_bias: 'OK',
    },
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      h2h_home: -110,
      h2h_away: 100,
    },
    reason_codes: [],
    ...overrides,
  };
}

describe('resolvePrimaryReason fallback semantics (WI-1225)', () => {
  let resolvePrimaryReason;
  let resolveTerminalReasonFamily;
  let buildDecisionV2;

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
    ({
      buildDecisionV2,
      resolvePrimaryReason,
      resolveTerminalReasonFamily,
    } = require('../decision-pipeline-v2'));
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

  it('treats PASS_NO_EDGE as a defensive fallback, not a normal buildDecisionV2 outcome', () => {
    const result = buildDecisionV2(buildNhlMlPayload());

    expect(result).toBeDefined();
    expect(result.primary_reason_code).not.toBe('PASS_NO_EDGE');
    expect(result.reason_codes || []).not.toContain('PASS_NO_EDGE');
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

  it('removes the historical unconditional SUPPORT_BELOW_PLAY_THRESHOLD fallback from helper source', () => {
    const sourcePath = path.join(__dirname, '..', 'decision-pipeline-v2.js');
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).not.toMatch(
      /if \(edgePct !== null && edgePct < thresholds\.edge\.play_edge_min\) \{\s+return 'SUPPORT_BELOW_PLAY_THRESHOLD';\s+\}\s+return 'SUPPORT_BELOW_PLAY_THRESHOLD';/,
    );
  });
});
