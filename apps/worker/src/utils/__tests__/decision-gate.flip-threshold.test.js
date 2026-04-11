'use strict';

/**
 * WI-0539: Gate threshold unit audit + side-flip behavior tests
 *
 * Validates:
 * 1. CANONICAL_EDGE_CONTRACT documents unit='decimal_fraction' unambiguously
 * 2. shouldFlip edge-delta comparisons use decimal-fraction units (not percent)
 * 3. Allow/block behavior across current, moderate, aggressive threshold profiles
 * 4. EDGE_UPGRADE_MIN=0.04 (4pp) is the realistic flip floor; tests confirm
 *    it blocks small improvements while allowing genuine 50pp+ jumps
 *
 * NOTE: Do not tune threshold numbers in this file — audit and document only.
 * Follow calibration_risk guard from WI-0539.
 */

const {
  CANONICAL_EDGE_CONTRACT,
  shouldFlip,
} = require('@cheddar-logic/models/src/decision-gate');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDecision(override = {}) {
  return {
    recommended_side: 'HOME',
    edge: 0.08,         // 8% edge (decimal_fraction)
    edge_available: true,
    locked_status: null,
    ...override,
  };
}

function makeCandidate(override = {}) {
  return {
    side: 'AWAY',
    edge: 0.06,         // 6% edge (decimal_fraction)
    edge_available: true,
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Unit annotation audit
// ---------------------------------------------------------------------------

describe('CANONICAL_EDGE_CONTRACT unit audit (WI-0539)', () => {
  test('unit is decimal_fraction', () => {
    expect(CANONICAL_EDGE_CONTRACT.unit).toBe('decimal_fraction');
  });

  test('upgrade_min is expressed in decimal_fraction (0.04 = 4pp, not 4%)', () => {
    // 0.04 decimal_fraction = 4 percentage points — this is the realistic flip floor
    expect(CANONICAL_EDGE_CONTRACT.upgrade_min).toBe(0.04);
    expect(CANONICAL_EDGE_CONTRACT.upgrade_min).toBeLessThan(1);
    expect(CANONICAL_EDGE_CONTRACT.upgrade_min).toBeGreaterThan(0);
  });

  test('description references edge = p_fair - p_implied formula', () => {
    expect(CANONICAL_EDGE_CONTRACT.description).toMatch(/p_fair.*p_implied/i);
  });
});

// ---------------------------------------------------------------------------
// shouldFlip INIT (no prior decision)
// ---------------------------------------------------------------------------

describe('shouldFlip — INIT path (WI-0539)', () => {
  test('allows first decision unconditionally', () => {
    const result = shouldFlip(null, makeCandidate(), { candidateSeenCount: 1 });
    expect(result.allow).toBe(true);
    expect(result.reason_code).toBe('INIT');
  });
});

// ---------------------------------------------------------------------------
// shouldFlip — same side refresh
// ---------------------------------------------------------------------------

describe('shouldFlip — same-side refresh (WI-0539)', () => {
  test('allows same-side refresh regardless of edge delta', () => {
    const current = makeDecision({ recommended_side: 'HOME' });
    const candidate = makeCandidate({ side: 'HOME', edge: 0.01 }); // edge fell
    const result = shouldFlip(current, candidate, {
      candidateSeenCount: 3,
    });
    expect(result.allow).toBe(true);
    expect(result.reason_code).toBe('REFRESH_SAME_SIDE');
  });
});

// ---------------------------------------------------------------------------
// shouldFlip — side flip threshold profiles (WI-0539 backtest categories)
// ---------------------------------------------------------------------------

describe('shouldFlip — side flip edge-delta behavior (WI-0539)', () => {
  const stableCtx = { candidateSeenCount: 3 };

  test('BASELINE threshold: blocks flip when edge delta < 0.04 (4pp)', () => {
    // Small improvement: current=0.06, candidate=0.09 → delta=+0.03 (3pp)
    const current = makeDecision({ edge: 0.06 });
    const candidate = makeCandidate({ edge: 0.09 });
    const result = shouldFlip(current, candidate, stableCtx);
    expect(result.allow).toBe(false);
    expect(result.reason_code).toBe('EDGE_TOO_SMALL');
    // edge_delta is in decimal_fraction units
    expect(result.edge_delta).toBeCloseTo(0.03, 4);
  });

  test('BASELINE threshold: allows flip when edge delta >= 0.04 (4pp)', () => {
    // Large improvement: current=0.05, candidate=0.60 → delta=+0.55
    const current = makeDecision({ edge: 0.05 });
    const candidate = makeCandidate({ edge: 0.60 });
    const result = shouldFlip(current, candidate, stableCtx);
    expect(result.allow).toBe(true);
    expect(result.reason_code).toBe('EDGE_UPGRADE');
    expect(result.edge_delta).toBeCloseTo(0.55, 4);
  });

  test('MODERATE threshold (0.25): would allow 25pp improvement', () => {
    // Simulate a moderate threshold config override
    const current = makeDecision({ edge: 0.05 });
    const candidate = makeCandidate({ edge: 0.33 }); // delta = 0.28 > 0.25
    const result = shouldFlip(current, candidate, {
      ...stableCtx,
      EDGE_UPGRADE_MIN: 0.25,
    });
    expect(result.allow).toBe(true);
    expect(result.edge_delta).toBeCloseTo(0.28, 3);
  });

  test('AGGRESSIVE threshold (0.10): allows 15pp improvement', () => {
    const current = makeDecision({ edge: 0.05 });
    const candidate = makeCandidate({ edge: 0.20 }); // delta = 0.15 > 0.10
    const result = shouldFlip(current, candidate, {
      ...stableCtx,
      EDGE_UPGRADE_MIN: 0.10,
    });
    expect(result.allow).toBe(true);
    expect(result.edge_delta).toBeCloseTo(0.15, 3);
  });

  test('AGGRESSIVE threshold (0.10): still blocks negative delta', () => {
    const current = makeDecision({ edge: 0.30 });
    const candidate = makeCandidate({ edge: 0.10 }); // delta = -0.20
    const result = shouldFlip(current, candidate, {
      ...stableCtx,
      EDGE_UPGRADE_MIN: 0.10,
    });
    expect(result.allow).toBe(false);
    expect(result.edge_delta).toBeCloseTo(-0.20, 3);
  });
});

// ---------------------------------------------------------------------------
// shouldFlip — stability guard
// ---------------------------------------------------------------------------

describe('shouldFlip — stability guard (WI-0539)', () => {
  test('blocks flip when candidateSeenCount < REQUIRE_STABILITY_RUNS', () => {
    const current = makeDecision({ edge: 0.05 });
    const candidate = makeCandidate({ edge: 0.80 }); // huge improvement but not stable
    const result = shouldFlip(current, candidate, { candidateSeenCount: 1 });
    expect(result.allow).toBe(false);
    expect(result.reason_code).toBe('NOT_STABLE');
  });
});

// ---------------------------------------------------------------------------
// shouldFlip — edge unavailable path
// ---------------------------------------------------------------------------

describe('shouldFlip — edge unavailable (WI-0539)', () => {
  test('blocks flip when candidate edge unavailable and no line move', () => {
    const current = makeDecision();
    const candidate = makeCandidate({ edge: null, edge_available: false });
    const result = shouldFlip(current, candidate, { candidateSeenCount: 3 });
    expect(result.allow).toBe(false);
    expect(result.reason_code).toBe('EDGE_UNAVAILABLE');
    expect(result.edge_delta).toBeNull();
  });

  test('allows flip via LINE_MOVE_NO_EDGE when line moved >= 0.5 and candidate has no edge', () => {
    const current = makeDecision();
    const candidate = makeCandidate({ edge: null, edge_available: false });
    const result = shouldFlip(current, candidate, {
      candidateSeenCount: 3,
      lineMoved: true,
      lineDelta: 0.5,
    });
    expect(result.allow).toBe(true);
    expect(result.reason_code).toBe('LINE_MOVE_NO_EDGE');
  });
});

// ---------------------------------------------------------------------------
// shouldFlip — hard lock
// ---------------------------------------------------------------------------

describe('shouldFlip — hard lock (WI-0539)', () => {
  test('blocks flip when HARD locked without critical override', () => {
    const current = makeDecision({ locked_status: 'HARD' });
    const candidate = makeCandidate();
    const result = shouldFlip(current, candidate, { candidateSeenCount: 3 });
    expect(result.allow).toBe(false);
    expect(result.reason_code).toBe('HARD_LOCKED');
  });

  test('allows flip with HARD lock when criticalOverride=true', () => {
    const current = makeDecision({ locked_status: 'HARD' });
    const candidate = makeCandidate();
    const result = shouldFlip(current, candidate, {
      candidateSeenCount: 3,
      criticalOverride: true,
    });
    expect(result.allow).toBe(true);
    expect(result.reason_code).toBe('CRITICAL_OVERRIDE');
  });
});
