'use strict';

describe('stale odds threshold configuration', () => {
  let buildDecisionV2;

  beforeAll(() => {
    jest.resetModules();
    buildDecisionV2 = require('../decision-pipeline-v2').buildDecisionV2;
  });

  afterEach(() => {
    delete process.env.WATCHDOG_STALE_THRESHOLD_MINUTES;
  });

  function resolveThreshold() {
    return Math.max(
      15,
      parseInt(process.env.WATCHDOG_STALE_THRESHOLD_MINUTES ?? '30', 10) || 30,
    );
  }

  test('defaults to 30 when env var is unset', () => {
    delete process.env.WATCHDOG_STALE_THRESHOLD_MINUTES;
    expect(resolveThreshold()).toBe(30);
  });

  test('enforces a floor of 15 minutes', () => {
    process.env.WATCHDOG_STALE_THRESHOLD_MINUTES = '5';
    expect(resolveThreshold()).toBe(15);
  });

  test('accepts an operator override', () => {
    process.env.WATCHDOG_STALE_THRESHOLD_MINUTES = '150';
    expect(resolveThreshold()).toBe(150);
  });

  test('falls back to 30 for non-numeric values', () => {
    process.env.WATCHDOG_STALE_THRESHOLD_MINUTES = 'bad_value';
    expect(resolveThreshold()).toBe(30);
  });

  test('default 30-minute threshold blocks a 60-minute-old snapshot in buildDecisionV2', () => {
    const result = buildDecisionV2({
      kind: 'PLAY',
      sport: 'NBA',
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      price: -110,
      line: 220.5,
      model_prob: 0.59,
      edge: 0.09,
      driver: {
        score: 0.72,
        inputs: {
          conflict: 0.18,
          pace_tier: 'HIGH',
          event_env: 'INDOOR',
          event_direction_tag: 'FAVOR_OVER',
          vol_env: 'STABLE',
          total_bias: 'OK',
        },
      },
      drivers_active: ['pace_signal'],
      consistency: {
        pace_tier: 'HIGH',
        event_env: 'INDOOR',
        event_direction_tag: 'FAVOR_OVER',
        vol_env: 'STABLE',
        total_bias: 'OK',
      },
      odds_context: {
        captured_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        total: 220.5,
        total_price_over: -110,
        total_price_under: -110,
      },
    });

    expect(result.watchdog_status).toBe('BLOCKED');
    expect(result.watchdog_reason_codes).toContain('STALE_MARKET_INPUT');
    expect(result.watchdog_reason_codes).toContain('WATCHDOG_STALE_SNAPSHOT');
    expect(result.official_status).toBe('PASS');
  });

  test('goalie uncertainty reason code produces LEAN instead of PASS', () => {
    const result = buildDecisionV2({
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      price: -110,
      line: 6.5,
      model_prob: 0.58,
      edge: 0.08,
      reason_codes: ['GATE_GOALIE_UNCONFIRMED'],
      driver: {
        score: 0.71,
        inputs: {
          conflict: 0.12,
          pace_tier: 'HIGH',
          event_env: 'INDOOR',
          event_direction_tag: 'FAVOR_OVER',
          vol_env: 'STABLE',
          total_bias: 'OK',
        },
      },
      drivers_active: ['goalie_quality', 'pace_signal'],
      consistency: {
        pace_tier: 'HIGH',
        event_env: 'INDOOR',
        event_direction_tag: 'FAVOR_OVER',
        vol_env: 'STABLE',
        total_bias: 'OK',
      },
      odds_context: {
        captured_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        total: 6.5,
        total_price_over: -110,
        total_price_under: -110,
      },
    });

    expect(result.watchdog_status).toBe('BLOCKED');
    expect(result.watchdog_reason_codes).toContain('GOALIE_UNCONFIRMED');
    expect(result.official_status).toBe('LEAN');
    expect(result.primary_reason_code).toBe('GOALIE_UNCONFIRMED');
  });
});
