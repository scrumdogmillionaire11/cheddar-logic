'use strict';

// Tests for WI-0814: Sigma fallback safety gate
// Covers:
//   1. resolveThresholdProfile — unit tests for sigmaSource='fallback' gate
//   2. buildDecisionV2 integration — PLAY downgraded to LEAN under fallback sigma
//   3. SIGMA_FALLBACK_DEGRADED reason code presence
//   4. No regression when sigmaSource='computed' or no sigmaOverride provided

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString(); // 1 min ago

/**
 * Build a minimal payload that reaches PLAY under normal (non-fallback) sigma.
 * NHL/TOTAL: play_edge_min=0.05, lean_edge_min=0.025, play support=0.52
 * price -110 → implied_prob ≈ 0.5238
 * model_prob 0.58 → edge ≈ 0.056 > play_edge_min=0.05, support 0.60 > 0.52 → PLAY
 */
function buildNhlTotalPlayPayload(overrides = {}) {
  return {
    kind: 'PLAY',
    sport: 'NHL',
    market_type: 'TOTAL',
    model_prob: 0.58,
    price: -110,
    line: 5.5,
    selection: { side: 'OVER' },
    driver: {
      score: 0.60,
      inputs: {
        pace_tier: 'FAST',
        event_env: 'NEUTRAL',
        event_direction_tag: 'OVER',
        vol_env: 'LOW',
        total_bias: 'NONE',
      },
    },
    drivers_active: ['pace_model'],
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      total: 5.5,
      total_price_over: -110,
      total_price_under: -110,
    },
    ...overrides,
  };
}

/**
 * Build a payload that reaches LEAN under normal sigma.
 * NHL/TOTAL: edge ≈ 0.03 >= lean_edge_min=0.025, but < play_edge_min=0.05
 */
function buildNhlTotalLeanPayload(overrides = {}) {
  return buildNhlTotalPlayPayload({
    model_prob: 0.554, // edge ≈ 0.554 - 0.5238 ≈ 0.030 → LEAN
    driver: {
      score: 0.45,
      inputs: {
        pace_tier: 'FAST',
        event_env: 'NEUTRAL',
        event_direction_tag: 'OVER',
        vol_env: 'LOW',
        total_bias: 'NONE',
      },
    },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Unit tests — resolveThresholdProfile sigmaSource gate
// ---------------------------------------------------------------------------

describe('resolveThresholdProfile — sigmaSource fallback gate (unit)', () => {
  let resolveThresholdProfile;

  beforeEach(() => {
    jest.resetModules();
    delete process.env.ENABLE_MARKET_THRESHOLDS_V2;
    resolveThresholdProfile = require('../decision-pipeline-v2-edge-config').resolveThresholdProfile;
  });

  it('marks profile as sigma_degraded when sigmaSource=fallback', () => {
    const profile = resolveThresholdProfile({
      sport: 'NBA',
      marketType: 'TOTAL',
      sigmaSource: 'fallback',
    });
    // Thresholds are NOT changed — only meta is annotated
    const profileNormal = resolveThresholdProfile({ sport: 'NBA', marketType: 'TOTAL' });
    expect(profile.edge.play_edge_min).toBe(profileNormal.edge.play_edge_min);
    expect(profile.edge.lean_edge_min).toBe(profileNormal.edge.lean_edge_min);
    // Meta is set
    expect(profile.meta.sigma_degraded).toBe(true);
    expect(profile.meta.sigma_degraded_reason).toBe('SIGMA_FALLBACK_DEGRADED');
    expect(typeof profile.meta.original_play_edge_min).toBe('number');
    expect(profile.meta.original_play_edge_min).toBeGreaterThan(profile.edge.lean_edge_min);
  });

  it('is unaffected when sigmaSource=computed (no meta, same thresholds)', () => {
    const profileFallback = resolveThresholdProfile({ sport: 'NBA', marketType: 'TOTAL', sigmaSource: 'fallback' });
    const profileComputed = resolveThresholdProfile({ sport: 'NBA', marketType: 'TOTAL', sigmaSource: 'computed' });
    expect(profileComputed.edge.play_edge_min).toBe(profileFallback.meta.original_play_edge_min);
    expect(profileComputed.meta).toBeUndefined();
  });

  it('is unaffected when sigmaSource is null (no override)', () => {
    const profile = resolveThresholdProfile({ sport: 'NBA', marketType: 'TOTAL', sigmaSource: null });
    expect(profile.edge.play_edge_min).toBeGreaterThan(profile.edge.lean_edge_min);
    expect(profile.meta).toBeUndefined();
  });

  it('applies sigma_degraded meta to NHL:TOTAL as well', () => {
    const profile = resolveThresholdProfile({
      sport: 'NHL',
      marketType: 'TOTAL',
      sigmaSource: 'fallback',
    });
    expect(profile.meta.sigma_degraded).toBe(true);
    // Thresholds unchanged
    const profileNormal = resolveThresholdProfile({ sport: 'NHL', marketType: 'TOTAL' });
    expect(profile.edge.play_edge_min).toBe(profileNormal.edge.play_edge_min);
  });

  it('existing call sites passing no sigmaSource remain backward-compatible', () => {
    const profile = resolveThresholdProfile({ sport: 'NBA', marketType: 'TOTAL' });
    expect(profile.edge.play_edge_min).toBeGreaterThan(profile.edge.lean_edge_min);
    expect(profile.meta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration tests — buildDecisionV2 with sigmaOverride.sigma_source
// ---------------------------------------------------------------------------

describe('buildDecisionV2 — sigma fallback safety gate integration', () => {
  let buildDecisionV2;

  beforeAll(() => {
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  // --- Fallback sigma: PLAY → LEAN ---

  it('PLAY card is downgraded to LEAN when sigmaOverride.sigma_source=fallback', () => {
    const payload = buildNhlTotalPlayPayload();
    const context = { sigmaOverride: { margin: 7, total: 10, sigma_source: 'fallback' } };

    // Without sigma gate: confirm it would be PLAY
    const baseline = buildDecisionV2(payload);
    expect(baseline.official_status).toBe('PLAY');

    // With fallback sigma: should downgrade to LEAN
    const result = buildDecisionV2(payload, context);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('LEAN');
  });

  it('PLAY card emits SIGMA_FALLBACK_DEGRADED reason code under fallback sigma', () => {
    const payload = buildNhlTotalPlayPayload();
    const context = { sigmaOverride: { margin: 7, total: 10, sigma_source: 'fallback' } };

    const result = buildDecisionV2(payload, context);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('LEAN');
    expect(result.price_reason_codes).toContain('SIGMA_FALLBACK_DEGRADED');
  });

  // --- Computed sigma: PLAY unchanged ---

  it('PLAY card is NOT downgraded when sigmaOverride.sigma_source=computed', () => {
    const payload = buildNhlTotalPlayPayload();
    const context = { sigmaOverride: { margin: 7, total: 10, sigma_source: 'computed' } };

    const result = buildDecisionV2(payload, context);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('PLAY');
    expect(result.price_reason_codes).not.toContain('SIGMA_FALLBACK_DEGRADED');
  });

  // --- No sigmaOverride: PLAY unchanged (gate inactive) ---

  it('PLAY card is NOT downgraded when no sigmaOverride is provided', () => {
    const payload = buildNhlTotalPlayPayload();

    const result = buildDecisionV2(payload);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('PLAY');
    expect(result.price_reason_codes).not.toContain('SIGMA_FALLBACK_DEGRADED');
  });

  // --- LEAN card under fallback: stays LEAN, no SIGMA_FALLBACK_DEGRADED ---

  it('LEAN card stays LEAN under fallback sigma (no false SIGMA_FALLBACK_DEGRADED)', () => {
    const payload = buildNhlTotalLeanPayload();
    const context = { sigmaOverride: { margin: 7, total: 10, sigma_source: 'fallback' } };

    // Without sigma gate: confirm it is LEAN
    const baseline = buildDecisionV2(payload);
    expect(baseline.official_status).toBe('LEAN');

    // With fallback: LEAN card is already below original play_edge_min, no SIGMA_FALLBACK_DEGRADED
    const result = buildDecisionV2(payload, context);
    expect(result).not.toBeNull();
    expect(result.official_status).toBe('LEAN');
    expect(result.price_reason_codes).not.toContain('SIGMA_FALLBACK_DEGRADED');
  });

  // --- sigma_source in return value (via sigma path, not model_prob) ---

  it('sigma_source in return value reflects sigmaOverride when edge uses sigma path', () => {
    // Use an NHL SPREAD payload without model_prob so fair_prob goes through sigma path
    const spreadPayload = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'SPREAD',
      price: -110,
      line: -1.5,
      selection: { side: 'HOME' },
      driver: {
        score: 0.6,
        inputs: {
          pace_tier: 'FAST', event_env: 'NEUTRAL',
          event_direction_tag: 'HOME', vol_env: 'LOW', total_bias: 'NONE',
        },
      },
      drivers_active: ['pace_model'],
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        spread_home: -1.5,
        spread_price_home: -110,
        spread_price_away: -110,
      },
      projection: { margin_home: 4 },
    };
    const ctxFallback = { sigmaOverride: { margin: 7, total: 10, sigma_source: 'fallback' } };
    const ctxComputed = { sigmaOverride: { margin: 7, total: 10, sigma_source: 'computed' } };

    const fallbackResult = buildDecisionV2(spreadPayload, ctxFallback);
    const computedResult = buildDecisionV2(spreadPayload, ctxComputed);

    expect(fallbackResult.sigma_source).toBe('fallback');
    expect(computedResult.sigma_source).toBe('computed');
  });
});
