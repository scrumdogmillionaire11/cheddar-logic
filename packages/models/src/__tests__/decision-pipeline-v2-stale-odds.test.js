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

  test('stale snapshot sets watchdog_status CAUTION but does NOT block in buildDecisionV2', () => {
    // Staleness blocking was removed from computeWatchdog. The execution gate
    // (execution-gate-freshness-contract.js) owns all staleness decisions with
    // sport-specific contracts (NBA/NHL: 120-min hardMax + allowStaleIfNoNewOdds=true).
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

    // Staleness is now owned entirely by execution gate, not watchdog
    // watchdog_status is 'OK' (not BLOCKED); execution gate owns freshness decisions
    expect(result.watchdog_status).toBe('OK');
    expect(result.watchdog_reason_codes).not.toContain('STALE_MARKET');
    expect(result.watchdog_reason_codes).not.toContain('STALE_SNAPSHOT');
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
