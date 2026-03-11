'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDecisionRecord: jest.fn(() => null),
  insertDecisionEvent: jest.fn(),
  updateDecisionCandidateTracking: jest.fn(),
  upsertDecisionRecord: jest.fn(),
}));

const {
  applyUiActionFields,
  deriveAction,
} = require('../decision-publisher.js');

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function buildWave1Payload(overrides = {}) {
  const payload = {
    sport: 'NBA',
    kind: 'PLAY',
    market_type: 'TOTAL',
    selection: { side: 'OVER' },
    prediction: 'OVER',
    line: 220.5,
    price: -110,
    edge: 0.09,
    model_prob: 0.59,
    tier: 'SUPER',
    confidence: 0.75,
    reasoning: 'Pace and efficiency alignment.',
    driver: {
      key: 'pace_signal',
      score: 0.72,
      inputs: {
        conflict: 0.18,
      },
    },
    drivers_active: ['pace_signal', 'efficiency_delta'],
    consistency: {
      pace_tier: 'HIGH',
      event_env: 'INDOOR',
      event_direction_tag: 'FAVOR_OVER',
      vol_env: 'STABLE',
      total_bias: 'OK',
    },
    odds_context: {
      captured_at: minutesAgoIso(1),
      h2h_home: -120,
      h2h_away: 100,
      spread_home: -5.5,
      spread_away: 5.5,
      spread_price_home: -110,
      spread_price_away: -110,
      total: 220.5,
      total_price_over: -110,
      total_price_under: -110,
    },
    reason_codes: [],
    ...overrides,
  };

  if (overrides.consistency) {
    payload.consistency = { ...payload.consistency, ...overrides.consistency };
  }
  if (overrides.driver && overrides.driver.inputs) {
    payload.driver = {
      ...payload.driver,
      ...overrides.driver,
      inputs: {
        ...payload.driver.inputs,
        ...overrides.driver.inputs,
      },
    };
  }
  if (overrides.odds_context) {
    payload.odds_context = {
      ...payload.odds_context,
      ...overrides.odds_context,
    };
  }

  return payload;
}

describe('decision publisher v2 pipeline', () => {
  test('deriveAction legacy fallback still maps tier for non-wave1 payloads', () => {
    expect(deriveAction({ tier: 'SUPER' })).toBe('FIRE');
    expect(deriveAction({ tier: 'BEST' })).toBe('HOLD');
    expect(deriveAction({ tier: 'WATCH' })).toBe('HOLD');
    expect(deriveAction({ tier: null })).toBe('PASS');
  });

  test('attaches decision_v2 for wave1 payload and derives PLAY', () => {
    const payload = buildWave1Payload();
    applyUiActionFields(payload);

    expect(payload.decision_v2).toBeDefined();
    expect(payload.decision_v2.pipeline_version).toBe('v2');
    expect(payload.decision_v2.official_status).toBe('PLAY');
    expect(payload.decision_v2.play_tier).toBe('GOOD');
    expect(payload.decision_v2.primary_reason_code).toBe('EDGE_CLEAR');
    expect(payload.action).toBe('FIRE');
    expect(payload.status).toBe('FIRE');
    expect(payload.classification).toBe('BASE');
  });

  test('preserves additive pipeline_state metadata', () => {
    const pipelineState = {
      ingested: true,
      team_mapping_ok: true,
      odds_ok: true,
      market_lines_ok: true,
      projection_ready: true,
      drivers_ready: true,
      pricing_ready: true,
      card_ready: false,
      blocking_reason_codes: [],
    };
    const payload = buildWave1Payload({
      pipeline_state: pipelineState,
    });

    applyUiActionFields(payload);

    expect(payload.pipeline_state).toEqual(pipelineState);
    expect(payload.decision_v2).toBeDefined();
    expect(payload.decision_v2.official_status).toBe('PLAY');
  });

  test('synthesizes required consistency fields when missing', () => {
    const payload = buildWave1Payload({
      consistency: {
        event_env: '',
        pace_tier: '',
        event_direction_tag: '',
        vol_env: '',
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_reason_codes).not.toContain(
      'WATCHDOG_CONSISTENCY_MISSING',
    );
    expect(payload.decision_v2.consistency.event_env).toBe('INDOOR');
    expect(payload.decision_v2.consistency.pace_tier).toBeTruthy();
    expect(payload.decision_v2.consistency.event_direction_tag).toBeTruthy();
    expect(payload.decision_v2.consistency.vol_env).toBeTruthy();
  });

  test('does not CAUTION or BLOCK when odds_context.captured_at is between 5 and 30 minutes old', () => {
    // applyUiActionFields strips captured_at before calling buildDecisionV2 to prevent
    // stale timestamps from being baked into stored decision records. Staleness is an
    // operational concern for the scheduler/ingest layer, not for stored decisions.
    const payload = buildWave1Payload({
      odds_context: {
        captured_at: minutesAgoIso(10),
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_status).toBe('OK');
    expect(payload.decision_v2.watchdog_reason_codes).not.toContain(
      'WATCHDOG_STALE_SNAPSHOT',
    );
    // Play should still proceed since data quality is good
    expect(payload.decision_v2.official_status).toBe('PLAY');
  });

  test('does not block when odds are stale beyond 30 minutes (staleness not stored in decision_v2)', () => {
    // applyUiActionFields strips captured_at before calling buildDecisionV2.
    // A stale timestamp in odds_context should not permanently block a stored record.
    // On the Pi's hourly cadence, odds are routinely 31-89 min old at model-run time.
    const payload = buildWave1Payload({
      odds_context: {
        captured_at: minutesAgoIso(60),
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_status).toBe('OK');
    expect(payload.decision_v2.watchdog_reason_codes).not.toContain(
      'WATCHDOG_STALE_SNAPSHOT',
    );
    // Play should still be decided based on edge/support alone
    expect(payload.decision_v2.official_status).toBe('PLAY');
  });

  test('classifies unpriced when fair/implied price inputs are missing', () => {
    const payload = buildWave1Payload({
      price: null,
      model_prob: null,
      p_fair: null,
      edge: null,
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.sharp_price_status).toBe('UNPRICED');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'MARKET_PRICE_MISSING',
    );
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.primary_reason_code).toBe(
      'MARKET_PRICE_MISSING',
    );
  });

  test('uses price failure reason precedence when not blocked', () => {
    const payload = buildWave1Payload({
      model_prob: 0.5,
      price: -110,
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.sharp_price_status).toBe('COTTAGE');
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.primary_reason_code).toBe('NO_EDGE_AT_PRICE');
  });

  test('uses watchdog reason precedence over price failures', () => {
    const payload = buildWave1Payload({
      selection: { side: 'NONE' },
      prediction: 'NEUTRAL',
      model_prob: null,
      price: null,
      edge: null,
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_status).toBe('BLOCKED');
    expect(payload.decision_v2.sharp_price_status).toBe('UNPRICED');
    expect(payload.decision_v2.primary_reason_code).toBe(
      'WATCHDOG_MARKET_UNAVAILABLE',
    );
  });

  test('maps LEAN and PASS correctly from support/edge bands', () => {
    const leanPayload = buildWave1Payload({
      driver: {
        score: 0.5,
        inputs: { conflict: 0.1 },
      },
      model_prob: 0.56,
      price: -110,
    });
    applyUiActionFields(leanPayload);
    expect(leanPayload.decision_v2.official_status).toBe('LEAN');
    expect(leanPayload.action).toBe('HOLD');

    const passPayload = buildWave1Payload({
      driver: {
        score: 0.4,
        inputs: { conflict: 0.1 },
      },
      model_prob: 0.57,
      price: -110,
    });
    applyUiActionFields(passPayload);
    expect(passPayload.decision_v2.official_status).toBe('PASS');
    expect(passPayload.action).toBe('PASS');
  });

  test('falls back to legacy tier mapping for out-of-scope markets', () => {
    const payload = buildWave1Payload({
      sport: 'SOCCER',
      market_type: 'DOUBLE_CHANCE',
      tier: 'BEST',
    });

    applyUiActionFields(payload);

    expect(payload.decision_v2).toBeUndefined();
    expect(payload.action).toBe('HOLD');
    expect(payload.status).toBe('WATCH');
  });

  test('blocks priced promotion when proxy edge is marked as proxy_used', () => {
    const payload = buildWave1Payload({
      proxy_used: true,
      edge: 0.07,
      model_prob: 0.6,
      price: -110,
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'PROXY_EDGE_CAPPED',
    );
    expect(payload.decision_v2.primary_reason_code).toBe('PROXY_EDGE_CAPPED');
  });

  test('marks fallback inference payloads as proxy-used and blocks priced promotion', () => {
    const payload = buildWave1Payload({
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: -5.5,
      price: -110,
      model_prob: 0.58,
      edge: 0.056,
      meta: { inference_source: 'market_fallback' },
      odds_context: {
        spread_home: -5.5,
        spread_away: 5.5,
        spread_price_home: -110,
        spread_price_away: -110,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.proxy_used).toBe(true);
    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'PROXY_EDGE_CAPPED',
    );
  });

  test('hard-fails proxy non-total cards with oversized edge', () => {
    const payload = buildWave1Payload({
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: -5.5,
      price: -110,
      model_prob: 0.82,
      edge: 0.296,
      proxy_used: true,
      odds_context: {
        spread_home: -5.5,
        spread_away: 5.5,
        spread_price_home: -110,
        spread_price_away: -110,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.sharp_price_status).toBe('UNPRICED');
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'PROXY_EDGE_BLOCKED',
    );
  });

  test('requires verification for oversized non-total edges and blocks priced promotion', () => {
    const payload = buildWave1Payload({
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: -5.5,
      price: -110,
      model_prob: 0.8,
      edge: 0.276,
      odds_context: {
        spread_home: -5.5,
        spread_away: 5.5,
        spread_price_home: -110,
        spread_price_away: -110,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.sharp_price_status).toBe('UNPRICED');
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'EDGE_VERIFICATION_REQUIRED',
    );
    expect(payload.decision_v2.primary_reason_code).toBe(
      'EDGE_VERIFICATION_REQUIRED',
    );
  });

  test('does not price spread from moneyline win probability fallback', () => {
    // Only win_prob_home present — no projected margin, so market-aware edge cannot fire.
    // Ensures win_prob_home alone is never used to price a spread card.
    const payload = buildWave1Payload({
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: -5.5,
      price: -110,
      edge: null,
      model_prob: null,
      p_fair: null,
      projection: { win_prob_home: 0.74 },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.fair_prob).toBeNull();
    expect(payload.decision_v2.edge_pct).toBeNull();
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'MODEL_PROB_MISSING',
    );
  });

  test('blocks pricing when called wager line mismatches odds context', () => {
    const payload = buildWave1Payload({
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 221.5,
      price: -110,
      model_prob: 0.59,
      edge: null,
      p_fair: null,
      odds_context: {
        total: 220.5,
        total_price_over: -110,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'EXACT_WAGER_MISMATCH',
    );
    expect(payload.decision_v2.primary_reason_code).toBe(
      'EXACT_WAGER_MISMATCH',
    );
  });

  test('does not flag exact wager mismatch for gate-published decisions', () => {
    const payload = buildWave1Payload({
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 221.5,
      price: -110,
      model_prob: 0.59,
      edge: null,
      p_fair: null,
      published_from_gate: true,
      published_decision_key: 'NCAAM|game-1|TOTAL|FULL_GAME|TOTAL',
      odds_context: {
        total: 220.5,
        total_price_over: -110,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'EXACT_WAGER_MISMATCH',
    );
  });

  test('allows held decisions when only live odds_context drifts but trace still matches wager', () => {
    const payload = buildWave1Payload({
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 221.5,
      price: -108,
      model_prob: 0.59,
      edge: null,
      p_fair: null,
      published_from_gate: true,
      published_decision_key: 'NCAAM|game-1|TOTAL|FULL_GAME|TOTAL',
      pricing_trace: {
        called_market_type: 'TOTAL',
        called_side: 'OVER',
        called_line: 221.5,
        called_price: -108,
      },
      odds_context: {
        total: 220.5,
        total_price_over: -110,
      },
    });

    applyUiActionFields(payload);

    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'EXACT_WAGER_MISMATCH',
    );
  });

  test('still fails held decisions when pricing_trace mismatches payload wager fields', () => {
    const payload = buildWave1Payload({
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 221.5,
      price: -108,
      model_prob: 0.59,
      edge: null,
      p_fair: null,
      published_from_gate: true,
      published_decision_key: 'NCAAM|game-1|TOTAL|FULL_GAME|TOTAL',
      pricing_trace: {
        called_market_type: 'TOTAL',
        called_side: 'OVER',
        called_line: 220.5,
        called_price: -108,
      },
      odds_context: {
        total: 221.5,
        total_price_over: -108,
      },
    });

    applyUiActionFields(payload);

    expect(payload.decision_v2.price_reason_codes).toContain(
      'EXACT_WAGER_MISMATCH',
    );
    expect(payload.decision_v2.official_status).toBe('PASS');
  });

  test('uses 1P odds context fields for NHL period-scoped totals exact-wager checks', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      period: '1P',
      line: 1.5,
      price: -125,
      model_prob: 0.59,
      edge: null,
      p_fair: null,
      odds_context: {
        total: 6.5,
        total_price_over: -110,
        total_price_under: -110,
        total_1p: 1.5,
        total_price_over_1p: -125,
        total_price_under_1p: 105,
      },
    });

    applyUiActionFields(payload);

    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'EXACT_WAGER_MISMATCH',
    );
  });
});
