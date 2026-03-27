'use strict';

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();

function buildFirstPeriodPayload(overrides = {}) {
  const oddsContextOverrides = overrides.odds_context || {};
  const mergedDriver = {
    score: 0.6,
    inputs: {
      pace_tier: 'FAST',
      event_env: 'NEUTRAL',
      event_direction_tag: 'OVER',
      vol_env: 'LOW',
      total_bias: 'NONE',
    },
    ...(overrides.driver || {}),
  };

  if (overrides.driver?.inputs) {
    mergedDriver.inputs = {
      pace_tier: 'FAST',
      event_env: 'NEUTRAL',
      event_direction_tag: 'OVER',
      vol_env: 'LOW',
      total_bias: 'NONE',
      ...overrides.driver.inputs,
    };
  }

  return {
    kind: 'PLAY',
    sport: 'NHL',
    market_type: 'FIRST_PERIOD',
    recommended_bet_type: 'total',
    selection: { side: 'OVER' },
    prediction: 'PASS',
    classification: 'PASS',
    line: 1.5,
    price: null,
    projection: { total: 2.0 },
    driver: mergedDriver,
    drivers_active: ['pace_model'],
    ...overrides,
    odds_context: {
      captured_at: RECENT_CAPTURED_AT,
      total: 6.5,
      total_price_over: -110,
      total_price_under: -110,
      total_1p: 1.5,
      total_price_over_1p: -125,
      total_price_under_1p: 105,
      ...oddsContextOverrides,
      ...(overrides.odds_context || {}),
    },
  };
}

describe('FIRST_PERIOD price and edge gating', () => {
  let buildDecisionV2;

  beforeAll(() => {
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  it('uses 1P odds-context price fallback and computed edge to produce actionable FIRST_PERIOD calls', () => {
    const payload = buildFirstPeriodPayload({
      price: null,
      prediction: 'PASS',
      classification: 'PASS',
      projection: { total: 2.05 },
    });

    const result = buildDecisionV2(payload);

    expect(result.market_price).toBe(-125);
    expect(result.edge_method).toBe('ONE_PERIOD_DELTA');
    expect(result.sharp_price_status).toBe('CHEDDAR');
    expect(result.official_status).toBe('PLAY');
    expect(result.play_tier).toBe('GOOD');
    expect(result.price_reason_codes).toContain('EDGE_CLEAR');
    expect(result.price_reason_codes).not.toContain('FIRST_PERIOD_PROJECTION_PLAY');
    expect(result.price_reason_codes).not.toContain('MARKET_PRICE_MISSING');
    expect(result.edge_pct).toBeGreaterThan(0.05);
  });

  it('fails closed when neither payload price nor 1P odds-context price is present', () => {
    const payload = buildFirstPeriodPayload({
      price: null,
      projection: { total: 2.0 },
      odds_context: {
        total_1p: 1.5,
        total_price_over_1p: null,
        total_price_under_1p: null,
      },
    });

    const result = buildDecisionV2(payload);

    expect(result.market_price).toBeNull();
    expect(result.sharp_price_status).toBe('UNPRICED');
    expect(result.official_status).toBe('PASS');
    expect(result.price_reason_codes).toContain('MARKET_PRICE_MISSING');
  });

  it('caps low-edge FIRST_PERIOD cards below lean threshold', () => {
    const payload = buildFirstPeriodPayload({
      projection: { total: 1.78 },
      prediction: 'OVER',
      classification: 'OVER',
    });

    const result = buildDecisionV2(payload);

    expect(result.edge_method).toBe('ONE_PERIOD_DELTA');
    expect(result.edge_pct).toBeLessThan(0.025);
    expect(result.sharp_price_status).toBe('COTTAGE');
    expect(result.official_status).toBe('PASS');
    expect(result.play_tier).toBe('BAD');
    expect(result.price_reason_codes).toContain('NO_EDGE_AT_PRICE');
  });

  it('preserves FIRST_PERIOD_NO_PROJECTION as a PASS compatibility reason when no 1P signal exists', () => {
    const payload = buildFirstPeriodPayload({
      prediction: 'PASS',
      classification: 'PASS',
      projection: { total: 1.45 },
    });

    const result = buildDecisionV2(payload);

    expect(result.official_status).toBe('PASS');
    expect(result.price_reason_codes[0]).toBe('FIRST_PERIOD_NO_PROJECTION');
    expect(result.price_reason_codes).toContain('NO_EDGE_AT_PRICE');
    expect(result.primary_reason_code).toBe('FIRST_PERIOD_NO_PROJECTION');
  });
});
