'use strict';
/**
 * WI-0526 Phase 1 — SOG Price Wiring Tests
 *
 * Verifies that the price integration path in run_nhl_player_shots_model.js
 * correctly produces v2 outputs when prices are present (odds-backed) vs
 * absent (projection-only / MISSING_PRICE).
 *
 * These tests exercise projectSogV2 directly using the same input-mapping
 * pattern the model job applies.
 */

const { projectSogV2 } = require('../nhl-player-shots');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Build a projectSogV2 input object that mirrors what run_nhl_player_shots_model.js
 * produces from available shot log data.
 *
 * Corresponds to the mapping added in WI-0526:
 *   ev_shots_season_per60  = shotsPer60 (MoneyPuck season rate)
 *   ev_shots_l10_per60     = shotsPer60 (no L10 granularity; season proxy)
 *   ev_shots_l5_per60      = l5Mean / projToi * 60
 *   toi_proj_ev            = projToi
 *   shot_env_factor        = paceFactor
 *   opponent_suppression   = opponentFactor
 */
function buildModelJobInputs({
  shotsPer60 = 9.6,
  l5Sog = [3, 4, 2, 3, 3],
  projToi = 20,
  paceFactor = 1.0,
  opponentFactor = 1.0,
  availabilityTier = 'ACTIVE',
  marketLine = 3.5,
  overPrice = null,
  underPrice = null,
} = {}) {
  const l5Mean = l5Sog.reduce((a, b) => a + b, 0) / l5Sog.length;
  const l5RatePer60 = projToi > 0 ? (l5Mean / projToi) * 60 : shotsPer60;
  return {
    player_id: 999,
    game_id: 'test-game-001',
    ev_shots_season_per60: shotsPer60,
    ev_shots_l10_per60: shotsPer60,
    ev_shots_l5_per60: l5RatePer60,
    pp_shots_season_per60: 0,
    pp_shots_l10_per60: 0,
    pp_shots_l5_per60: 0,
    toi_proj_ev: projToi,
    toi_proj_pp: 0,
    shot_env_factor: paceFactor,
    opponent_suppression_factor: opponentFactor,
    role_stability: availabilityTier === 'DTD' ? 'MEDIUM' : 'HIGH',
    market_line: marketLine,
    market_price_over: overPrice,
    market_price_under: underPrice,
  };
}

// ---------------------------------------------------------------------------
// Tests: odds-backed path (prices present)
// ---------------------------------------------------------------------------

describe('SOG price wiring — odds-backed (prices present)', () => {
  let result;

  beforeEach(() => {
    result = projectSogV2(
      buildModelJobInputs({ overPrice: -115, underPrice: -105 }),
    );
  });

  it('produces non-null edge_over_pp', () => {
    expect(result.edge_over_pp).not.toBeNull();
    expect(typeof result.edge_over_pp).toBe('number');
  });

  it('produces non-null ev_over', () => {
    expect(result.ev_over).not.toBeNull();
    expect(typeof result.ev_over).toBe('number');
  });

  it('produces non-null opportunity_score', () => {
    expect(result.opportunity_score).not.toBeNull();
    expect(typeof result.opportunity_score).toBe('number');
  });

  it('does not set MISSING_PRICE flag', () => {
    expect(result.flags).not.toContain('MISSING_PRICE');
  });

  it('includes market_price_over and market_price_under in output', () => {
    expect(result.market_price_over).toBe(-115);
    expect(result.market_price_under).toBe(-105);
  });
});

// ---------------------------------------------------------------------------
// Tests: projection-only path (prices missing)
// ---------------------------------------------------------------------------

describe('SOG price wiring — projection-only (prices absent)', () => {
  let result;

  beforeEach(() => {
    result = projectSogV2(
      buildModelJobInputs({ overPrice: null, underPrice: null }),
    );
  });

  it('produces null edge_over_pp', () => {
    expect(result.edge_over_pp).toBeNull();
  });

  it('produces null ev_over', () => {
    expect(result.ev_over).toBeNull();
  });

  it('produces null opportunity_score', () => {
    expect(result.opportunity_score).toBeNull();
  });

  it('sets MISSING_PRICE flag when market_line exists but prices absent', () => {
    expect(result.flags).toContain('MISSING_PRICE');
  });
});

// ---------------------------------------------------------------------------
// Tests: priced props rank differently from projection-only props
// ---------------------------------------------------------------------------

describe('SOG price wiring — priced vs projection-only ranking', () => {
  it('opportunity_score is null for projection-only, non-null for priced', () => {
    const pricedResult = projectSogV2(
      buildModelJobInputs({ overPrice: -115, underPrice: -105 }),
    );
    const projectionResult = projectSogV2(
      buildModelJobInputs({ overPrice: null, underPrice: null }),
    );

    expect(projectionResult.opportunity_score).toBeNull();
    expect(pricedResult.opportunity_score).not.toBeNull();
  });

  it('a better-EV priced play has higher opportunity_score than a worse-EV play', () => {
    // Strong mismatch: big shooter vs suppress-heavy defense, mispriced line
    const highEdgeResult = projectSogV2(
      buildModelJobInputs({
        shotsPer60: 14.0,
        l5Sog: [5, 6, 4, 5, 4],
        projToi: 22,
        opponentFactor: 1.10, // easy opponent
        marketLine: 3.0,       // low line for a power shooter
        overPrice: -115,
        underPrice: -105,
      }),
    );

    // Weak signal: average shooter, at-market projection
    const lowEdgeResult = projectSogV2(
      buildModelJobInputs({
        shotsPer60: 6.0,
        l5Sog: [2, 2, 3, 2, 2],
        projToi: 16,
        opponentFactor: 0.95,
        marketLine: 2.5,
        overPrice: -115,
        underPrice: -105,
      }),
    );

    expect(highEdgeResult.opportunity_score).not.toBeNull();
    expect(lowEdgeResult.opportunity_score).not.toBeNull();
    expect(highEdgeResult.opportunity_score).toBeGreaterThan(
      lowEdgeResult.opportunity_score,
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: DTD player → MEDIUM role_stability
// ---------------------------------------------------------------------------

describe('SOG price wiring — availability tier mapping', () => {
  it('ACTIVE player uses HIGH role_stability (no ROLE_IN_FLUX flag)', () => {
    const result = projectSogV2(
      buildModelJobInputs({ availabilityTier: 'ACTIVE', overPrice: -110, underPrice: -110 }),
    );
    expect(result.flags).not.toContain('ROLE_IN_FLUX');
  });

  it('DTD player uses MEDIUM role_stability (no ROLE_IN_FLUX, but trend dampened)', () => {
    // MEDIUM role_stability uses weight 0.5 in trend_factor.
    // The flag ROLE_IN_FLUX is only set for LOW — DTD maps to MEDIUM.
    const result = projectSogV2(
      buildModelJobInputs({ availabilityTier: 'DTD', overPrice: -110, underPrice: -110 }),
    );
    expect(result.flags).not.toContain('ROLE_IN_FLUX');
    expect(result.role_stability).toBe('MEDIUM');
  });
});

// ---------------------------------------------------------------------------
// Tests: output shape completeness
// ---------------------------------------------------------------------------

describe('SOG price wiring — output shape', () => {
  it('always returns sog_mu, sog_sigma, and toi_proj regardless of price state', () => {
    const priced = projectSogV2(buildModelJobInputs({ overPrice: -115, underPrice: -105 }));
    const unpriced = projectSogV2(buildModelJobInputs({ overPrice: null, underPrice: null }));

    for (const result of [priced, unpriced]) {
      expect(typeof result.sog_mu).toBe('number');
      expect(typeof result.sog_sigma).toBe('number');
      expect(typeof result.toi_proj).toBe('number');
      expect(Array.isArray(result.flags)).toBe(true);
    }
  });

  it('fair_over_prob_by_line is populated for the market_line', () => {
    const result = projectSogV2(buildModelJobInputs({ marketLine: 3.5, overPrice: -110, underPrice: -110 }));
    expect(result.fair_over_prob_by_line['3.5']).toBeDefined();
    expect(result.fair_over_prob_by_line['3.5']).toBeGreaterThan(0);
    expect(result.fair_over_prob_by_line['3.5']).toBeLessThan(1);
  });
});
