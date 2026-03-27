'use strict';

const RECENT_CAPTURED_AT = new Date(Date.now() - 60_000).toISOString();

function buildSpreadPayload(overrides = {}) {
  const lineContextOverrides = overrides.line_context || {};
  const oddsContextOverrides = overrides.odds_context || {};
  const mergedDriver = {
    score: 0.6,
    inputs: {
      pace_tier: 'MID',
      event_env: 'INDOOR',
      event_direction_tag: 'FAVOR_HOME',
      vol_env: 'STABLE',
      total_bias: 'OK',
      conflict: 0.1,
    },
    ...(overrides.driver || {}),
  };

  if (overrides.driver?.inputs) {
    mergedDriver.inputs = {
      pace_tier: 'MID',
      event_env: 'INDOOR',
      event_direction_tag: 'FAVOR_HOME',
      vol_env: 'STABLE',
      total_bias: 'OK',
      conflict: 0.1,
      ...overrides.driver.inputs,
    };
  }

  return {
    kind: 'PLAY',
    sport: 'NBA',
    market_type: 'SPREAD',
    recommended_bet_type: 'spread',
    selection: { side: 'HOME' },
    prediction: 'HOME',
    classification: 'HOME',
    line: -3.5,
    price: -110,
    model_prob: 0.564,
    p_fair: 0.564,
    edge_points: 1.5,
    projection: { margin_home: 5.0 },
    driver: mergedDriver,
    drivers_active: ['base_projection'],
    line_context: {
      opener_line: -3.5,
      current_line: -3.5,
      delta: 0,
      delta_pct: 0,
      ...lineContextOverrides,
    },
    odds_context: {
      spread_home: -3.5,
      spread_away: 3.5,
      spread_price_home: -110,
      spread_price_away: -110,
      captured_at: RECENT_CAPTURED_AT,
      ...oddsContextOverrides,
    },
    ...overrides,
  };
}

describe('buildDecisionV2 line-move adjustment', () => {
  let buildDecisionV2;

  beforeAll(() => {
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  test('adverse line move can consume a lean edge and force PASS', () => {
    const baseline = buildDecisionV2(buildSpreadPayload());
    const adjusted = buildDecisionV2(
      buildSpreadPayload({
        line_context: {
          opener_line: -3.5,
          current_line: -4.7,
          delta: -1.2,
          delta_pct: -0.3429,
        },
      }),
    );

    expect(baseline.official_status).toBe('LEAN');
    expect(baseline.edge_pct_raw).toBeGreaterThan(0.03);
    expect(adjusted.edge_pct).toBeLessThan(0.031);
    expect(adjusted.official_status).toBe('PASS');
    expect(adjusted.price_reason_codes).toContain('NO_EDGE_AT_PRICE');
    expect(adjusted.price_reason_codes).toContain('LINE_MOVE_ADVERSE');
    expect(adjusted.line_delta).toBe(-1.2);
    expect(adjusted.adverse_line_delta).toBe(1.2);
  });

  test('favorable line move does not upgrade or otherwise change the verdict', () => {
    const baseline = buildDecisionV2(buildSpreadPayload());
    const favorable = buildDecisionV2(
      buildSpreadPayload({
        line_context: {
          opener_line: -3.5,
          current_line: -2.3,
          delta: 1.2,
          delta_pct: 0.3429,
        },
      }),
    );

    expect(favorable.official_status).toBe(baseline.official_status);
    expect(favorable.edge_pct).toBeCloseTo(baseline.edge_pct, 6);
    expect(favorable.edge_pct_raw).toBeCloseTo(baseline.edge_pct_raw, 6);
    expect(favorable.price_reason_codes).not.toContain('LINE_MOVE_ADVERSE');
    expect(favorable.adverse_line_delta).toBe(0);
  });

  test('zero line delta leaves edge and verdict unchanged', () => {
    const baseline = buildDecisionV2(buildSpreadPayload());
    const zeroDelta = buildDecisionV2(
      buildSpreadPayload({
        line_context: {
          opener_line: -3.5,
          current_line: -3.5,
          delta: 0,
          delta_pct: 0,
        },
      }),
    );

    expect(zeroDelta.edge_pct).toBeCloseTo(baseline.edge_pct, 6);
    expect(zeroDelta.edge_pct_raw).toBeCloseTo(baseline.edge_pct_raw, 6);
    expect(zeroDelta.official_status).toBe(baseline.official_status);
    expect(zeroDelta.line_delta).toBe(0);
    expect(zeroDelta.adverse_line_delta).toBe(0);
  });
});
