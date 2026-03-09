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
      model_prob: 0.50,
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
});
