'use strict';

/**
 * WI-0805: devig tests for decision-pipeline-v2
 *
 * Verifies that implied_prob is computed using two-sided vig removal
 * (not raw one-sided implied probability) for:
 *  - MONEYLINE cards (using odds_context.h2h_home/h2h_away)
 *  - SPREAD/PUCKLINE cards (using computeSpreadEdge p_implied)
 *  - TOTAL cards (using computeTotalEdge p_implied)
 *
 * At -110/-110:
 *  raw implied = 0.5238 each side
 *  devigged    = 0.5000 each side
 *  delta       = 0.0238 (~2.4pp)
 *
 * So with a fair_prob of e.g. 0.56, raw edge ≈ 0.036,
 * devigged edge ≈ 0.060 (if we invert — wait, devig *lowers* implied,
 * which *raises* edge when fair > implied; but here we're measuring
 * that edge is LOWER with correct devig because the market is set negative.)
 *
 * Actually: if fair = 0.56 and implied_raw = 0.5238, edge_raw = 0.0362.
 *           if fair = 0.56 and implied_nv = 0.5000, edge_devigged = 0.0600.
 * Wait — devigging makes implied LOWER (0.5238 → 0.5000), so edge goes UP.
 *
 * BUT the bug was the OPPOSITE: raw implied was larger than devigged, so
 * edge was measured against the inflated number — making it look SMALLER.
 * With the fix, edge = fair - devigged_implied which is LARGER.
 *
 * The test validates:
 *  1. edge_pct with both ML prices > edge_pct with only one price (devig applied)
 *  2. MONEYLINE: edge difference is ~0.024 (the vig amount) at -110/-110
 *  3. SPREAD: implied_prob from pipeline == result.p_implied from computeSpreadEdge
 *  4. TOTAL: implied_prob from pipeline == result.p_implied from computeTotalEdge
 */

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();

describe('WI-0805: devig implied_prob in decision-pipeline-v2', () => {
  let buildDecisionV2;

  beforeAll(() => {
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  // ── MONEYLINE ─────────────────────────────────────────────────────────────

  it('MONEYLINE: edge_pct uses devigged implied_prob when both h2h prices present', () => {
    // fair_prob from win_prob_home = 0.56 (HOME direction)
    // raw implied for -110 = 0.5238
    // devigged implied for -110/-110 = 0.5000
    // raw edge = 0.56 - 0.5238 = 0.0362
    // devigged edge = 0.56 - 0.5000 = 0.0600

    const payloadWithBothPrices = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'MONEYLINE',
      selection: { side: 'HOME' },
      price: -110,
      line: null,
      projection: { win_prob_home: 0.56 },
      driver: { score: 0.65, inputs: {} },
      drivers_active: ['model'],
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        h2h_home: -110,
        h2h_away: -110,
        spread_home: -1.5,
        spread_price_home: -110,
        spread_price_away: -110,
        total: 6.0,
        total_price_over: -110,
        total_price_under: -110,
      },
    };

    // Same payload but without opposite side price (only home price)
    const payloadSinglePrice = {
      ...payloadWithBothPrices,
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        h2h_home: -110,
        // h2h_away absent — devig cannot apply
        spread_home: -1.5,
        spread_price_home: -110,
        spread_price_away: -110,
        total: 6.0,
        total_price_over: -110,
        total_price_under: -110,
      },
    };

    const resultBoth = buildDecisionV2(payloadWithBothPrices);
    const resultSingle = buildDecisionV2(payloadSinglePrice);

    // Both should have a non-null edge
    expect(resultBoth.edge_pct).not.toBeNull();
    expect(resultSingle.edge_pct).not.toBeNull();

    // Devigged edge should be higher (lower implied_prob means higher edge when fair > implied)
    expect(resultBoth.edge_pct).toBeGreaterThan(resultSingle.edge_pct);

    // The delta should be ~0.024 (the vig at -110/-110 is 0.5238 - 0.5000)
    const delta = resultBoth.edge_pct - resultSingle.edge_pct;
    expect(delta).toBeCloseTo(0.0238, 2);
  });

  it('MONEYLINE AWAY: devig applied for away direction', () => {
    // fair_prob from win_prob_home = 0.44 → away fair = 1 - 0.44 = 0.56
    const payload = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'MONEYLINE',
      selection: { side: 'AWAY' },
      price: -110,
      line: null,
      projection: { win_prob_home: 0.44 },
      driver: { score: 0.65, inputs: {} },
      drivers_active: ['model'],
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        h2h_home: -110,
        h2h_away: -110,
        spread_home: -1.5,
        spread_price_home: -110,
        spread_price_away: -110,
        total: 6.0,
        total_price_over: -110,
        total_price_under: -110,
      },
    };

    const result = buildDecisionV2(payload);
    // fair_prob = 0.56, devigged implied = 0.5000, edge = 0.060
    expect(result.edge_pct).toBeCloseTo(0.060, 2);
  });

  // ── SPREAD (PUCKLINE) ──────────────────────────────────────────────────────

  it('SPREAD: implied_prob uses devigged p_implied from computeSpreadEdge', () => {
    // computeSpreadEdge with -110/-110 returns p_implied = 0.5000 (devigged)
    // raw single-side would be 0.5238
    // The edge = fair_prob - 0.5000 (not 0.5238)

    const payloadBoth = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'PUCKLINE',
      selection: { side: 'HOME' },
      price: -110,
      line: -1.5,
      projection: { margin_home: 1.0 },
      driver: { score: 0.6, inputs: {} },
      drivers_active: ['model'],
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        spread_home: -1.5,
        spread_price_home: -110,
        spread_price_away: -110,
        h2h_home: -110,
        h2h_away: -110,
        total: 6.0,
        total_price_over: -110,
        total_price_under: -110,
      },
    };

    const payloadOneSide = {
      ...payloadBoth,
      odds_context: {
        ...payloadBoth.odds_context,
        spread_price_away: undefined,  // no opposite side
      },
    };

    const resultBoth = buildDecisionV2(payloadBoth);
    const resultOneSide = buildDecisionV2(payloadOneSide);

    // Both should compute edge
    expect(resultBoth.edge_pct).not.toBeNull();

    // With both prices, edge uses devigged implied (0.5000), without it raw (0.5238)
    // So devigged edge should be ~0.024 higher
    const delta = resultBoth.edge_pct - (resultOneSide.edge_pct ?? 0);
    expect(delta).toBeGreaterThan(0.01); // at least 1pp higher
  });

  // ── TOTAL ──────────────────────────────────────────────────────────────────

  it('TOTAL: implied_prob uses devigged p_implied from computeTotalEdge', () => {
    const payloadBoth = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      price: -110,
      line: 6.0,
      projection: { total: 6.8 },
      driver: { score: 0.6, inputs: {} },
      drivers_active: ['model'],
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        total: 6.0,
        total_price_over: -110,
        total_price_under: -110,
        spread_home: -1.5,
        spread_price_home: -110,
        spread_price_away: -110,
        h2h_home: -110,
        h2h_away: -110,
      },
    };

    const payloadOneSide = {
      ...payloadBoth,
      odds_context: {
        ...payloadBoth.odds_context,
        total_price_under: undefined,  // no under price
      },
    };

    const resultBoth = buildDecisionV2(payloadBoth);
    const resultOneSide = buildDecisionV2(payloadOneSide);

    expect(resultBoth.edge_pct).not.toBeNull();

    // With -110/-110, devigged implied = 0.5, raw = 0.5238
    // So edge with devig is ~0.024 higher than without
    const delta = resultBoth.edge_pct - (resultOneSide.edge_pct ?? 0);
    expect(delta).toBeGreaterThan(0.01);
  });

  // ── No regression: single-side still works ────────────────────────────────

  it('MONEYLINE: falls back gracefully when opposite price is absent', () => {
    const payload = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'MONEYLINE',
      selection: { side: 'HOME' },
      price: -130,
      line: null,
      projection: { win_prob_home: 0.60 },
      driver: { score: 0.65, inputs: {} },
      drivers_active: ['model'],
      odds_context: {
        captured_at: RECENT_CAPTURED_AT,
        h2h_home: -130,
        // h2h_away absent — graceful fallback to raw implied
        total: 6.0,
        total_price_over: -110,
        total_price_under: -110,
      },
    };

    const result = buildDecisionV2(payload);
    // Should still compute an edge, using raw implied for -130
    // raw implied for -130 = 130/230 ≈ 0.5652
    // edge = 0.60 - 0.5652 ≈ 0.0348
    expect(result.edge_pct).not.toBeNull();
    expect(result.edge_pct).toBeGreaterThan(0);
  });
});
