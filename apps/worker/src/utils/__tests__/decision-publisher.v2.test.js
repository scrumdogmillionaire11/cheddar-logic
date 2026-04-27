'use strict';

jest.mock('@cheddar-logic/data', () => ({
  getDecisionRecord: jest.fn(() => null),
  insertDecisionEvent: jest.fn(),
  updateDecisionCandidateTracking: jest.fn(),
  upsertDecisionRecord: jest.fn(),
}));

const {
  applyUiActionFields,
  assertNoDecisionMutation,
  capturePublishedDecisionState,
  computeWebhookFields,
  deriveAction,
  deriveVolEnv,
  finalizeDecisionFields,
  publishDecisionForCard,
  deriveTerminalReasonFamilyForPayload,
} = require('../decision-publisher.js');
const {
  computeCandidateHash,
  computeInputsHash,
  getSideFamily,
  normalizeMarketType,
  normalizePeriod,
} = require('@cheddar-logic/models');
const data = require('@cheddar-logic/data');

function minutesAgoIso(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function minutesFromNowIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
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
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('deriveAction legacy fallback still maps tier for non-wave1 payloads', () => {
    expect(deriveAction({ tier: 'SUPER' })).toBe('FIRE');
    expect(deriveAction({ tier: 'BEST' })).toBe('HOLD');
    expect(deriveAction({ tier: 'WATCH' })).toBe('HOLD');
    expect(deriveAction({ tier: null })).toBe('PASS');
  });

  test('applyUiActionFields is display-only once decision fields already exist', () => {
    const payload = buildWave1Payload({
      execution_status: 'PROJECTION_ONLY',
    });
    applyUiActionFields(payload);

    const strictSnapshot = capturePublishedDecisionState(payload);
    const decisionRef = payload.decision_v2;

    applyUiActionFields(payload);

    expect(capturePublishedDecisionState(payload)).toEqual(strictSnapshot);
    expect(payload.decision_v2).toBe(decisionRef);
    expect(payload.ui_display_status).toBe('WATCH');
  });

  test('projection-only cards never surface PLAY in ui_display_status', () => {
    const payload = {
      kind: 'PLAY',
      execution_status: 'PROJECTION_ONLY',
      classification: 'BASE',
      action: 'FIRE',
      status: 'FIRE',
      reason_codes: ['EDGE_CLEAR'],
      decision_v2: {
        official_status: 'PLAY',
        primary_reason_code: 'EDGE_CLEAR',
      },
    };

    applyUiActionFields(payload);

    expect(payload.ui_display_status).toBe('WATCH');
    expect(payload.decision_v2.official_status).toBe('PLAY');
  });

  test('ui_display_status treats lowercase official_status lean as WATCH', () => {
    const payload = {
      kind: 'PLAY',
      execution_status: 'EXECUTABLE',
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
      decision_v2: {
        official_status: 'lean',
      },
    };

    applyUiActionFields(payload);

    expect(payload.ui_display_status).toBe('WATCH');
  });

  test('ui_display_status treats unknown official_status as PASS', () => {
    const payload = {
      kind: 'PLAY',
      execution_status: 'EXECUTABLE',
      classification: 'BASE',
      action: 'FIRE',
      status: 'FIRE',
      decision_v2: {
        official_status: 'MAYBE',
      },
    };

    applyUiActionFields(payload);

    expect(payload.ui_display_status).toBe('PASS');
  });

  test('FIRST_PERIOD cards are always projection-only even when executable is requested', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'FIRST_PERIOD',
      period: '1P',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 1.5,
      price: -125,
      execution_status: 'EXECUTABLE',
      odds_context: {
        total_1p: 1.5,
        total_price_over_1p: -125,
        total_price_under_1p: 105,
      },
    });

    applyUiActionFields(payload);

    expect(payload.execution_status).toBe('PROJECTION_ONLY');
  });

  test('PROP cards are always projection-only and never require odds to stay visible', () => {
    const payload = {
      kind: 'PLAY',
      sport: 'NHL',
      market_type: 'PROP',
      recommended_bet_type: 'prop',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: null,
      price: null,
      tier: 'WATCH',
      confidence: 0.62,
      edge: null,
      reason_codes: [],
    };

    applyUiActionFields(payload);

    expect(payload.execution_status).toBe('PROJECTION_ONLY');
    expect(payload.ui_display_status).toBe('WATCH');
  });

  test('assertNoDecisionMutation throws when strict decision fields drift after publish', () => {
    const payload = buildWave1Payload({
      execution_status: 'EXECUTABLE',
    });
    finalizeDecisionFields(payload);
    const strictSnapshot = capturePublishedDecisionState(payload);

    payload.classification = 'PASS';

    expect(() =>
      assertNoDecisionMutation(payload, strictSnapshot, {
        label: 'test-mutation',
      }),
    ).toThrow('[INVARIANT_BREACH]');
  });

  test('attaches decision_v2 for wave1 payload and preserves the actionable decision envelope', () => {
    // Use NHL:TOTAL to avoid NBA total quarantine demoting PLAY->LEAN
    const payload = buildWave1Payload({ sport: 'NHL', market_type: 'TOTAL' });
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

  test('canonical envelope carries selection semantics for MLB rows', () => {
    const payload = buildWave1Payload({
      sport: 'MLB',
      market_type: 'MONEYLINE',
      selection: { side: 'HOME', team: 'Home Team' },
      prediction: 'HOME',
      decision_v2: {
        official_status: 'PLAY',
        primary_reason_code: 'EDGE_CLEAR',
        watchdog_status: 'READY',
      },
    });

    finalizeDecisionFields(payload);

    expect(payload.decision_v2?.canonical_envelope_v2).toMatchObject({
      direction: 'HOME',
      selection_side: 'HOME',
      selection_team: 'Home Team',
    });
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
    // Use NHL:TOTAL to avoid NBA total quarantine demoting PLAY->LEAN
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
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

  test('publishDecisionForCard preserves synthesized totals consistency envelope for NHL totals', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      consistency: {
        pace_tier: '',
        event_env: '',
        total_bias: '',
      },
    });

    publishDecisionForCard({
      card: { gameId: 'nhl-test-game', payloadData: payload },
      oddsSnapshot: { game_time_utc: minutesFromNowIso(180) },
    });

    expect(payload.consistency).toMatchObject({
      pace_tier: expect.any(String),
      event_env: 'INDOOR',
      total_bias: expect.any(String),
    });
  });

  test('does not downgrade watchdog status for mildly stale odds_context in publisher pipeline', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      odds_context: {
        captured_at: minutesAgoIso(10),
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_status).toBe('OK');
    expect(payload.decision_v2.watchdog_reason_codes).not.toContain(
      'STALE_SNAPSHOT',
    );
    expect(payload.decision_v2.official_status).toBe('PLAY');
  });

  test('stale odds do not force publisher watchdog CAUTION or BLOCKED', () => {
    const payload = buildWave1Payload({
      odds_context: {
        captured_at: minutesAgoIso(60),
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_status).toBe('OK');
    expect(payload.decision_v2.watchdog_reason_codes).not.toContain(
      'STALE_SNAPSHOT',
    );
    expect(payload.decision_v2.watchdog_reason_codes).not.toContain(
      'STALE_MARKET',
    );
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
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
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

  test('caps high-conflict PLAY rows to LEAN with explicit contradiction reason', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      driver: {
        score: 0.72,
        inputs: { conflict: 0.45 },
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'PLAY_CONTRADICTION_CAPPED',
    );
    expect(payload.decision_v2.primary_reason_code).toBe(
      'PLAY_CONTRADICTION_CAPPED',
    );
  });

  test('keeps clean NHL PLAY rows as PLAY under the new ceiling', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.watchdog_status).toBe('OK');
    expect(payload.decision_v2.official_status).toBe('PLAY');
    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'PLAY_REQUIRES_FRESH_MARKET',
    );
    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'PLAY_CONTRADICTION_CAPPED',
    );
  });

  test('NCAAM retains legacy action/status while still stamping decision_v2', () => {
    const payload = buildWave1Payload({
      sport: 'NCAAM',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      odds_context: {
        captured_at: minutesAgoIso(10),
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2).toBeDefined();
    expect(payload.decision_v2.official_status).toBe('PLAY');
    expect(payload.action).toBe('FIRE');
    expect(payload.status).toBe('FIRE');
  });

  test('downgrades heavy-favorite moneyline PLAY to LEAN at -300 band when edge is below 2x play threshold', () => {
    const payload = buildWave1Payload({
      sport: 'NBA',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: null,
      price: -300,
      model_prob: 0.83,
      edge: null,
      p_fair: null,
      driver: {
        score: 0.8,
        inputs: { conflict: 0.1 },
      },
      odds_context: {
        captured_at: minutesAgoIso(1),
        h2h_home: -300,
        h2h_away: 240,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.decision_v2.primary_reason_code).toBe(
      'HEAVY_FAVORITE_PRICE_CAP',
    );
    expect(payload.decision_v2.price_reason_codes).toContain(
      'HEAVY_FAVORITE_PRICE_CAP',
    );
  });

  test('hard-PASSes heavy-favorite moneyline at -500 band when edge is below 3x play threshold', () => {
    const payload = buildWave1Payload({
      sport: 'NBA',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: null,
      price: -500,
      model_prob: 0.95,
      edge: null,
      p_fair: null,
      driver: {
        score: 0.8,
        inputs: { conflict: 0.1 },
      },
      odds_context: {
        captured_at: minutesAgoIso(1),
        h2h_home: -500,
        h2h_away: 390,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.primary_reason_code).toBe(
      'HEAVY_FAVORITE_PRICE_CAP',
    );
    expect(payload.decision_v2.price_reason_codes).toContain(
      'HEAVY_FAVORITE_PRICE_CAP',
    );
  });

  test('-300 band (2x multiplier) still resolves to LEAN not PASS when gate triggers', () => {
    // Confirm the ≤-500 PASS rule does not affect the ≤-300 band
    // Re-uses same fixture as the -300 test above; this explicitly checks
    // that price=-300 goes to LEAN, not PASS.
    const payload = buildWave1Payload({
      sport: 'NBA',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: null,
      price: -300,
      model_prob: 0.83,
      edge: null,
      p_fair: null,
      driver: {
        score: 0.8,
        inputs: { conflict: 0.1 },
      },
      odds_context: {
        captured_at: minutesAgoIso(1),
        h2h_home: -300,
        h2h_away: 240,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.decision_v2.official_status).not.toBe('PASS');
  });

  test('keeps heavy-favorite moneyline as PLAY when edge clears ordered band multiplier', () => {
    const payload = buildWave1Payload({
      sport: 'NBA',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: null,
      price: -300,
      model_prob: 0.9,
      edge: null,
      p_fair: null,
      driver: {
        score: 0.82,
        inputs: { conflict: 0.08 },
      },
      odds_context: {
        captured_at: minutesAgoIso(1),
        h2h_home: -300,
        h2h_away: 240,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('PLAY');
    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'HEAVY_FAVORITE_PRICE_CAP',
    );
  });

  test('hard invalidation reasons take precedence over heavy-favorite downgrade', () => {
    const payload = buildWave1Payload({
      sport: 'NBA',
      market_type: 'MONEYLINE',
      recommended_bet_type: 'moneyline',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: null,
      price: null,
      model_prob: 0.95,
      edge: null,
      p_fair: null,
      driver: {
        score: 0.8,
        inputs: { conflict: 0.1 },
      },
      odds_context: {
        captured_at: minutesAgoIso(1),
        h2h_home: -500,
        h2h_away: 390,
      },
    });
    applyUiActionFields(payload);

    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.primary_reason_code).toBe('MARKET_PRICE_MISSING');
    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'HEAVY_FAVORITE_PRICE_CAP',
    );
  });

  test('out-of-scope markets retain legacy tier mapping while stamping decision_v2', () => {
    const payload = buildWave1Payload({
      sport: 'SOCCER',
      market_type: 'DOUBLE_CHANCE',
      tier: 'BEST',
    });

    applyUiActionFields(payload);

    expect(payload.decision_v2).toBeDefined();
    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.action).toBe('HOLD');
    expect(payload.status).toBe('WATCH');
  });

  test('blocks priced promotion when proxy edge is marked as proxy_used', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
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

    expect(payload.decision_v2.sharp_price_status).toBe('PENDING_VERIFICATION');
    expect(payload.decision_v2.official_status).toBe('PASS');
    expect(payload.decision_v2.price_reason_codes).toContain(
      'LINE_NOT_CONFIRMED',
    );
    expect(payload.decision_v2.price_reason_codes).toContain(
      'EDGE_SANITY_NON_TOTAL',
    );
    expect(payload.decision_v2.primary_reason_code).toBe(
      'LINE_NOT_CONFIRMED',
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

  test('keeps FIRST_PERIOD LEAN_OVER projection at LEAN when edge clears only the lean band', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'FIRST_PERIOD',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      classification: 'LEAN_OVER',
      period: '1P',
      line: 1.5,
      price: null,
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

    expect(payload.decision_v2.market_price).toBe(-125);
    expect(payload.decision_v2.sharp_price_status).toBe('CHEDDAR');
    expect(payload.decision_v2.official_status).toBe('LEAN');
    expect(payload.decision_v2.price_reason_codes).toContain('EDGE_CLEAR');
    expect(payload.decision_v2.price_reason_codes).not.toContain(
      'MARKET_PRICE_MISSING',
    );
  });

  test('keeps FIRST_PERIOD PASS when projection classification is PASS', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'FIRST_PERIOD',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'PASS',
      classification: 'PASS',
      period: '1P',
      line: 1.5,
      price: null,
      model_prob: null,
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

    expect(payload.decision_v2.sharp_price_status).toBe('UNPRICED');
    expect(payload.decision_v2.official_status).toBe('PASS');
    // WI-0537: compatibility reason is preserved, while missing fair prob leaves the row unpriced.
    expect(payload.decision_v2.price_reason_codes).toContain(
      'FIRST_PERIOD_NO_PROJECTION',
    );
    expect(payload.decision_v2.price_reason_codes).toContain(
      'MODEL_PROB_MISSING',
    );
  });

  test('does not backfill legacy prob fields from decision_v2 after wave-1 pipeline runs', () => {
    const payload = buildWave1Payload({
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 220.5,
      price: -110,
      // Set stale/stale values on legacy fields — they must be replaced
      model_prob: 0.42,
      p_fair: 0.42,
      p_implied: 0.48,
      edge: 0.01,
    });

    applyUiActionFields(payload);

    // decision_v2 must be present
    expect(payload.decision_v2).toBeDefined();
    const d2 = payload.decision_v2;

    // Legacy fields remain unchanged (canonical consumers should read decision_v2)
    expect(payload.model_prob).toBe(0.42);
    expect(payload.p_fair).toBe(0.42);
    expect(payload.p_implied).toBe(0.48);
  });

  // WI-0382: deriveVolEnv escalation tests
  test('deriveVolEnv returns VOLATILE when home goalie is UNKNOWN', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      homeGoalieState: { starter_state: 'UNKNOWN' },
      awayGoalieState: { starter_state: 'CONFIRMED' },
    });
    const result = deriveVolEnv(payload, payload.homeGoalieState, payload.awayGoalieState);
    expect(result).toBe('VOLATILE');
  });

  test('deriveVolEnv returns VOLATILE when away goalie is CONFLICTING', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      homeGoalieState: { starter_state: 'CONFIRMED' },
      awayGoalieState: { starter_state: 'CONFLICTING' },
    });
    const result = deriveVolEnv(payload, payload.homeGoalieState, payload.awayGoalieState);
    expect(result).toBe('VOLATILE');
  });

  test('deriveVolEnv returns STABLE for CONFIRMED both + low conflict (existing behavior preserved)', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      homeGoalieState: { starter_state: 'CONFIRMED' },
      awayGoalieState: { starter_state: 'CONFIRMED' },
      driver: { key: 'pace_signal', score: 0.72, inputs: { conflict: 0.18 } },
    });
    const result = deriveVolEnv(payload, payload.homeGoalieState, payload.awayGoalieState);
    expect(result).toBe('STABLE');
  });

  test('deriveVolEnv backward-compatible: no goalie args still uses conflict', () => {
    const payload = buildWave1Payload({
      driver: { key: 'pace_signal', score: 0.72, inputs: { conflict: 0.18 } },
    });
    const result = deriveVolEnv(payload);
    expect(result).toBe('STABLE');
  });

  // WI-0383: NHL wrapper official_eligible gate tests
  test('NHL TOTAL payload with official_eligible=false returns PASS (never FIRE or HOLD)', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 6.5,
      price: -110,
      model_prob: 0.62,
      edge: 0.12,
      tier: 'SUPER',
      official_eligible: false,
      odds_context: {
        total: 6.5,
        total_price_over: -110,
        total_price_under: -110,
      },
    });
    applyUiActionFields(payload);
    expect(payload.action).toBe('PASS');
  });

  test('FC-7: canonical CONFLICTING goalie still PASSes via starter_state', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 6.5,
      price: -110,
      model_prob: 0.62,
      edge: 0.12,
      tier: 'SUPER',
      official_eligible: false,
      homeGoalieState: { starter_state: 'CONFLICTING' },
      awayGoalieState: { starter_state: 'CONFIRMED' },
      odds_context: {
        total: 6.5,
        total_price_over: -110,
        total_price_under: -110,
      },
    });
    applyUiActionFields(payload);
    // canonical official_eligible=false wins based on starter_state inputs
    expect(payload.action).toBe('PASS');
  });

  test('NHL TOTAL payload with official_eligible=true + strong tier can FIRE', () => {
    const payload = buildWave1Payload({
      sport: 'NHL',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 6.5,
      price: -110,
      model_prob: 0.62,
      edge: 0.12,
      tier: 'SUPER',
      official_eligible: true,
      homeGoalieState: { starter_state: 'CONFIRMED' },
      awayGoalieState: { starter_state: 'CONFIRMED' },
      odds_context: {
        total: 6.5,
        total_price_over: -110,
        total_price_under: -110,
      },
    });
    applyUiActionFields(payload);
    // official_eligible=true + strong edge — should be able to FIRE or HOLD (not PASS)
    expect(payload.action).not.toBe('PASS');
  });

  test('gate-hold wager rewrite preserves period tag when original market_context.wager.period is set', () => {
    // Simulate an NHL 1P card that has market_context.wager.period already set
    // by applyNhlSettlementMarketContext.
    const { applyPublishedDecisionToPayload: _apd } =
      require.cache[
        require.resolve('../decision-publisher.js')
      ]?.exports ?? {};
    // applyPublishedDecisionToPayload is internal — test via published payload inspection.
    // We verify the spread preserves period by calling applyUiActionFields on a
    // pre-constructed payload that mirrors what applyPublishedDecisionToPayload produces.
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
      market_context: {
        version: 'v1',
        market_type: 'TOTAL',
        selection_side: 'OVER',
        wager: {
          called_line: 1.5,
          called_price: -125,
          line_source: 'odds_snapshot',
          price_source: 'odds_snapshot',
          period: '1P',
        },
      },
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

    // market_context.wager.period must survive the pipeline
    expect(payload.market_context?.wager?.period).toBe('1P');
  });

  test('publishDecisionForCard treats missing edge as unavailable (not synthetic zero)', () => {
    const payload = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'AWAY' },
      prediction: 'AWAY',
      line: -4.5,
      price: -110,
      // Intentionally omit edge to verify no 0-coercion
      edge: null,
      edge_available: false,
      confidence: 0.62,
      model_version: 'nba-drivers-v1',
      home_team: 'Home',
      away_team: 'Away',
      reason_codes: [],
      tags: [],
    };

    const card = {
      gameId: 'game-edge-unavailable',
      cardType: 'nba-spread-call',
      cardTitle: 'NBA Spread: Away -4.5',
      payloadData: payload,
    };

    const market = normalizeMarketType(
      payload.market_type,
      payload.recommended_bet_type,
    );
    const period = normalizePeriod(payload);
    const sideFamily = getSideFamily(market);
    const inputsHash = computeInputsHash(payload);
    const candidateHash = computeCandidateHash({
      side: payload.selection.side,
      line: payload.line,
      price: payload.price,
      inputsHash,
      market,
      period,
      sideFamily,
    });

    data.getDecisionRecord.mockReturnValue({
      decision_key: 'nba|game-edge-unavailable|spread|full_game|home_away',
      recommended_side: 'HOME',
      recommended_line: -4.5,
      recommended_price: -110,
      edge: 0.04,
      confidence: 0.58,
      locked_status: 'SOFT',
      locked_at: null,
      last_candidate_hash: candidateHash,
      candidate_seen_count: 1,
    });

    const outcome = publishDecisionForCard({
      card,
      oddsSnapshot: {
        game_time_utc: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      },
    });

    expect(outcome.gated).toBe(true);
    expect(outcome.allow).toBe(false);
    expect(outcome.reasonCode).toBe('EDGE_UNAVAILABLE');
    expect(card.payloadData.gate_reason_codes).toEqual(
      expect.arrayContaining(['DECISION_HELD', 'EDGE_UNAVAILABLE']),
    );
    expect(card.payloadData.reason_codes).not.toContain('DECISION_HELD');
    expect(card.payloadData.selection.side).toBe(card.payloadData.prediction);

    expect(data.insertDecisionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonCode: 'EDGE_UNAVAILABLE',
        candEdge: null,
        edgeUnits: 'decimal_fraction',
      }),
    );
  });

  test('publishDecisionForCard adds price staleness warning inside T-60 when current price drifts from locked price', () => {
    const payload = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'AWAY' },
      prediction: 'AWAY',
      line: -4.5,
      price: -130,
      edge: null,
      edge_available: false,
      confidence: 0.62,
      model_version: 'nba-drivers-v1',
      home_team: 'Home',
      away_team: 'Away',
      reason_codes: [],
      tags: [],
    };
    const card = {
      gameId: 'game-stale-price-inside-t60',
      cardType: 'nba-spread-call',
      cardTitle: 'NBA Spread: Away -4.5',
      payloadData: payload,
    };
    const market = normalizeMarketType(
      payload.market_type,
      payload.recommended_bet_type,
    );
    const period = normalizePeriod(payload);
    const sideFamily = getSideFamily(market);
    const inputsHash = computeInputsHash(payload);
    const candidateHash = computeCandidateHash({
      side: payload.selection.side,
      line: payload.line,
      price: payload.price,
      inputsHash,
      market,
      period,
      sideFamily,
    });

    data.getDecisionRecord.mockReturnValue({
      decision_key: 'nba|game-stale-price-inside-t60|spread|full_game|home_away',
      recommended_side: 'HOME',
      recommended_line: -4.5,
      recommended_price: -110,
      edge: 0.04,
      confidence: 0.58,
      locked_status: 'HARD',
      locked_at: null,
      last_candidate_hash: candidateHash,
      candidate_seen_count: 1,
    });

    const outcome = publishDecisionForCard({
      card,
      oddsSnapshot: {
        game_time_utc: minutesFromNowIso(45),
      },
    });

    expect(outcome.gated).toBe(true);
    expect(outcome.allow).toBe(false);
    expect(card.payloadData.price).toBe(-110);
    expect(card.payloadData.price_staleness_warning).toEqual({
      locked_price: -110,
      current_candidate_price: -130,
      delta_american: 20,
      minutes_to_start: 45,
      reason: 'HARD_LOCK_PRICE_DRIFT',
    });
    expect(card.payloadData.tags).toEqual(
      expect.arrayContaining(['PUBLISHED_FROM_GATE', 'PRICE_STALENESS_WARNING']),
    );
  });

  test('publishDecisionForCard does not add price staleness warning outside T-60 even when current price drifts from locked price', () => {
    const payload = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'AWAY' },
      prediction: 'AWAY',
      line: -4.5,
      price: -130,
      edge: null,
      edge_available: false,
      confidence: 0.62,
      model_version: 'nba-drivers-v1',
      home_team: 'Home',
      away_team: 'Away',
      reason_codes: [],
      tags: [],
    };
    const card = {
      gameId: 'game-stale-price-outside-t60',
      cardType: 'nba-spread-call',
      cardTitle: 'NBA Spread: Away -4.5',
      payloadData: payload,
    };
    const market = normalizeMarketType(
      payload.market_type,
      payload.recommended_bet_type,
    );
    const period = normalizePeriod(payload);
    const sideFamily = getSideFamily(market);
    const inputsHash = computeInputsHash(payload);
    const candidateHash = computeCandidateHash({
      side: payload.selection.side,
      line: payload.line,
      price: payload.price,
      inputsHash,
      market,
      period,
      sideFamily,
    });

    data.getDecisionRecord.mockReturnValue({
      decision_key: 'nba|game-stale-price-outside-t60|spread|full_game|home_away',
      recommended_side: 'HOME',
      recommended_line: -4.5,
      recommended_price: -110,
      edge: 0.04,
      confidence: 0.58,
      locked_status: 'HARD',
      locked_at: null,
      last_candidate_hash: candidateHash,
      candidate_seen_count: 1,
    });

    const outcome = publishDecisionForCard({
      card,
      oddsSnapshot: {
        game_time_utc: minutesFromNowIso(90),
      },
    });

    expect(outcome.gated).toBe(true);
    expect(outcome.allow).toBe(false);
    expect(card.payloadData.price).toBe(-110);
    expect(card.payloadData.price_staleness_warning).toBeUndefined();
    expect(card.payloadData.tags).toEqual(['PUBLISHED_FROM_GATE']);
  });

  test('publishDecisionForCard does not add price staleness warning when current price matches locked price inside T-60', () => {
    const payload = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'AWAY' },
      prediction: 'AWAY',
      line: -4.5,
      price: -110,
      edge: null,
      edge_available: false,
      confidence: 0.62,
      model_version: 'nba-drivers-v1',
      home_team: 'Home',
      away_team: 'Away',
      reason_codes: [],
      tags: [],
    };
    const card = {
      gameId: 'game-stale-price-equal-inside-t60',
      cardType: 'nba-spread-call',
      cardTitle: 'NBA Spread: Away -4.5',
      payloadData: payload,
    };
    const market = normalizeMarketType(
      payload.market_type,
      payload.recommended_bet_type,
    );
    const period = normalizePeriod(payload);
    const sideFamily = getSideFamily(market);
    const inputsHash = computeInputsHash(payload);
    const candidateHash = computeCandidateHash({
      side: payload.selection.side,
      line: payload.line,
      price: payload.price,
      inputsHash,
      market,
      period,
      sideFamily,
    });

    data.getDecisionRecord.mockReturnValue({
      decision_key: 'nba|game-stale-price-equal-inside-t60|spread|full_game|home_away',
      recommended_side: 'HOME',
      recommended_line: -4.5,
      recommended_price: -110,
      edge: 0.04,
      confidence: 0.58,
      locked_status: 'HARD',
      locked_at: null,
      last_candidate_hash: candidateHash,
      candidate_seen_count: 1,
    });

    const outcome = publishDecisionForCard({
      card,
      oddsSnapshot: {
        game_time_utc: minutesFromNowIso(45),
      },
    });

    expect(outcome.gated).toBe(true);
    expect(outcome.allow).toBe(false);
    expect(card.payloadData.price).toBe(-110);
    expect(card.payloadData.price_staleness_warning).toBeUndefined();
    expect(card.payloadData.tags).toEqual(['PUBLISHED_FROM_GATE']);
  });

  test('publishDecisionForCard emits edge_units=decimal_fraction in decision event for null-edge card', () => {
    const payload = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'TOTAL',
      recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      prediction: 'OVER',
      line: 220.5,
      price: -110,
      edge: null,
      edge_available: false,
      confidence: 0.62,
      model_version: 'nba-drivers-v1',
      home_team: 'Home',
      away_team: 'Away',
      reason_codes: [],
      tags: [],
    };
    const card = {
      gameId: 'game-units-null-edge',
      cardType: 'nba-total-call',
      cardTitle: 'NBA Totals',
      payloadData: payload,
    };
    data.getDecisionRecord.mockReturnValue(null);
    publishDecisionForCard({ card, oddsSnapshot: { game_time_utc: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() } });

    expect(data.insertDecisionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeUnits: 'decimal_fraction',
        candEdge: null,
      }),
    );
  });

  test('publishDecisionForCard emits edge_units=decimal_fraction in decision event for explicit edge', () => {
    const payload = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'SPREAD',
      recommended_bet_type: 'spread',
      selection: { side: 'HOME' },
      prediction: 'HOME',
      line: -5.5,
      price: -110,
      edge: 0.07,
      edge_available: true,
      confidence: 0.65,
      model_version: 'nba-drivers-v1',
      home_team: 'Home',
      away_team: 'Away',
      reason_codes: [],
      tags: [],
    };
    const card = {
      gameId: 'game-units-explicit-edge',
      cardType: 'nba-spread-call',
      cardTitle: 'NBA Spread',
      payloadData: payload,
    };
    data.getDecisionRecord.mockReturnValue(null);
    publishDecisionForCard({ card, oddsSnapshot: { game_time_utc: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() } });

    expect(data.insertDecisionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        edgeUnits: 'decimal_fraction',
        candEdge: 0.07,
      }),
    );
  });

  test('applyUiActionFields populates decision_v2.edge_units as decimal_fraction for wave1 payload', () => {
    const payload = buildWave1Payload();
    applyUiActionFields(payload);

    expect(payload.decision_v2).toBeDefined();
    expect(payload.decision_v2.edge_units).toBe('decimal_fraction');
  });
});

describe('computeWebhookFields', () => {
  const expectCanonicalPublish = (payload, publishStatus, bucket) => {
    expect(payload.webhook_publish_status).toBe(publishStatus);
    expect(payload.webhook_bucket).toBe(bucket);
    expect(payload.decision_trace.webhook_publish_status).toBe(publishStatus);
    expect(payload.decision_trace.webhook_bucket).toBe(bucket);
    expect(payload.decision_trace.mapping_version).toBe('v1');
  };

  it('stamps official for NHL total with final_play_state=OFFICIAL_PLAY', () => {
    const p = {
      sport: 'NHL', kind: 'PLAY', market_type: 'total', recommended_bet_type: 'total',
      selection: { side: 'OVER' }, edge: 1.2,
      final_play_state: 'OFFICIAL_PLAY',
      decision_v2: { official_status: 'PLAY' },
      nhl_totals_status: { status: 'PLAY', reasonCodes: [] },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PLAY', 'official');
    expect(p.webhook_eligible).toBe(true);
    expect(p.webhook_reason_code).toBeNull();
    expect(p.decision_trace.source_of_truth).toBe('final_play_state');
  });

  it('stamps slight edge for NHL total capped by goalie uncertainty', () => {
    const p = {
      sport: 'NHL', kind: 'PLAY', market_type: 'total', recommended_bet_type: 'total',
      selection: { side: 'OVER' }, edge: 1.1,
      final_play_state: 'LEAN',
      decision_v2: { official_status: 'LEAN' },
      nhl_totals_status: { status: 'SLIGHT EDGE', reasonCodes: ['CAP_GOALIES_UNCONFIRMED'] },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'SLIGHT_EDGE', 'lean');
    expect(p.webhook_eligible).toBe(true);
    expect(p.webhook_reason_code).toBeNull();
  });

  it('stamps pass_blocked for NHL total with final_play_state=BLOCKED', () => {
    const p = {
      sport: 'NHL', kind: 'PLAY', market_type: 'total', recommended_bet_type: 'total',
      selection: { side: 'OVER' },
      final_play_state: 'BLOCKED',
      decision_v2: { official_status: 'PASS' },
      nhl_totals_status: { status: 'PASS', reasonCodes: ['PASS_INTEGRITY_BLOCK'] },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
    expect(p.webhook_eligible).toBe(false);
    expect(p.webhook_reason_code).toBe('PASS_INTEGRITY_BLOCK');
  });

  it('stamps slight edge for NHL 1P with final_play_state=LEAN', () => {
    const p = {
      sport: 'NHL', kind: 'PLAY', market_type: 'total', period: '1p',
      prediction: 'OVER',
      final_play_state: 'LEAN',
      decision_v2: { official_status: 'LEAN' },
      nhl_1p_decision: {
        projection: { side: 'OVER' },
        surfaced_status: 'SLIGHT EDGE',
        surfaced_reason_code: 'FIRST_PERIOD_PRICE_UNAVAILABLE',
      },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'SLIGHT_EDGE', 'lean');
    expect(p.webhook_display_side).toBe('OVER');
  });

  it('stamps official for NBA total via decision_v2.official_status=PLAY', () => {
    const p = {
      sport: 'NBA', kind: 'PLAY', market_type: 'total',
      selection: { side: 'OVER' }, edge: 0.5,
      decision_v2: { official_status: 'PLAY' }, action: 'FIRE', classification: 'BASE',
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PLAY', 'official');
    expect(p.decision_trace.source_of_truth).toBe('decision_v2.official_status');
  });

  it('fails closed for legacy-only card with action=HOLD', () => {
    const p = { sport: 'MLB', kind: 'PLAY', market_type: 'total', action: 'HOLD', classification: 'LEAN', edge: 0.4 };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
    expect(p.webhook_lean_eligible).toBe(false);
    expect(p.publish_status_flags).toContain('MISSING_CANONICAL_STATUS');
    expect(p.decision_trace.source_of_truth).toBe('none');
  });

  it('final_play_state wins over legacy and NHL total status', () => {
    const p = {
      sport: 'NHL', kind: 'PLAY', market_type: 'total',
      action: 'PASS', classification: 'PASS',
      decision_v2: { official_status: 'PLAY' },
      final_play_state: 'WATCH',
      nhl_totals_status: { status: 'PLAY', reasonCodes: [] },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
    expect(p.webhook_eligible).toBe(false);
    expect(p.decision_trace.source_of_truth).toBe('final_play_state');
    expect(p.publish_status_flags).toContain('STATUS_DOWNGRADED_AFTER_MODEL');
  });

  it('stamps official for prop card via final_play_state=OFFICIAL_PLAY', () => {
    const p = {
      sport: 'NHL', card_type: 'nhl-player-shots',
      final_play_state: 'OFFICIAL_PLAY',
      decision_v2: { official_status: 'PLAY' },
      play: { action: 'FIRE', classification: 'BASE', selection: 'OVER 3.5' },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PLAY', 'official');
    expect(p.webhook_eligible).toBe(true);
  });

  it('webhook_lean_eligible false when |edge| < 0.15', () => {
    const p = {
      sport: 'NBA',
      action: 'HOLD',
      classification: 'LEAN',
      edge: 0.08,
      final_play_state: 'LEAN',
      decision_v2: { official_status: 'LEAN' },
    };
    computeWebhookFields(p);
    expect(p.webhook_lean_eligible).toBe(false);
  });

  it('webhook_lean_eligible true when edge absent', () => {
    const p = {
      sport: 'NBA',
      action: 'HOLD',
      classification: 'LEAN',
      final_play_state: 'LEAN',
      decision_v2: { official_status: 'LEAN' },
    };
    computeWebhookFields(p);
    expect(p.webhook_lean_eligible).toBe(true);
  });

  it('webhook_display_side from nhl_1p_decision.projection.side beats selection.side', () => {
    const p = {
      selection: { side: 'UNDER' }, period: '1p',
      nhl_1p_decision: { projection: { side: 'over' }, surfaced_status: 'PLAY' },
      final_play_state: 'OFFICIAL_PLAY',
      decision_v2: { official_status: 'PLAY' },
      action: 'FIRE',
    };
    computeWebhookFields(p);
    expect(p.webhook_display_side).toBe('OVER');
  });

  it.each([
    ['OFFICIAL_PLAY', 'PLAY', 'official'],
    ['LEAN', 'SLIGHT_EDGE', 'lean'],
    ['WATCH', 'PASS_BLOCKED', 'pass_blocked'],
    ['BLOCKED', 'PASS_BLOCKED', 'pass_blocked'],
    ['NO_PLAY', 'PASS_BLOCKED', 'pass_blocked'],
  ])('maps final_play_state=%s exhaustively', (finalPlayState, publishStatus, bucket) => {
    const p = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'total',
      final_play_state: finalPlayState,
      decision_v2: { official_status: finalPlayState === 'OFFICIAL_PLAY' ? 'PLAY' : finalPlayState === 'LEAN' ? 'LEAN' : 'PASS' },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, publishStatus, bucket);
    expect(p.decision_trace.source_of_truth).toBe('final_play_state');
  });

  it('blocks WATCH despite LEAN official status and positive legacy aliases', () => {
    const p = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'total',
      final_play_state: 'WATCH',
      decision_v2: { official_status: 'LEAN' },
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
    expect(p.webhook_publish_status).not.toBe('SLIGHT_EDGE');
    expect(p.webhook_bucket).not.toBe('lean');
    expect(p.publish_status_flags).toContain('CANONICAL_STATUS_CONFLICT');
  });

  it('records downgrade when PLAY official status is lowered to LEAN', () => {
    const p = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'total',
      final_play_state: 'LEAN',
      decision_v2: { official_status: 'PLAY' },
      action: 'FIRE',
      classification: 'BASE',
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'SLIGHT_EDGE', 'lean');
    expect(p.publish_status_flags).toContain('STATUS_DOWNGRADED_AFTER_MODEL');
  });

  it('full precedence conflict stays blocked and diagnostic-rich', () => {
    const p = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'total',
      final_play_state: 'WATCH',
      decision_v2: { official_status: 'PLAY' },
      classification: 'LEAN',
      action: 'HOLD',
      status: 'WATCH',
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
    expect(p.decision_trace.source_of_truth).toBe('final_play_state');
    expect(p.publish_status_flags).toContain('STATUS_DOWNGRADED_AFTER_MODEL');
  });

  it('invalid final_play_state fails closed with INVALID_PUBLISH_MAPPING', () => {
    const p = {
      sport: 'NBA',
      kind: 'PLAY',
      market_type: 'total',
      final_play_state: 'MAYBE',
      decision_v2: { official_status: 'PLAY' },
    };
    computeWebhookFields(p);
    expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
    expect(p.publish_status_flags).toContain('INVALID_PUBLISH_MAPPING');
  });

  it('never treats display slight-edge tokens as canonical official status', () => {
    for (const token of ['SLIGHT_EDGE', 'SLIGHT EDGE', 'Slight Edge']) {
      const p = {
        sport: 'NBA',
        kind: 'PLAY',
        market_type: 'total',
        decision_v2: { official_status: token },
      };
      computeWebhookFields(p);
      expectCanonicalPublish(p, 'PASS_BLOCKED', 'pass_blocked');
      expect(p.publish_status_flags).toContain('INVALID_PUBLISH_MAPPING');
      expect(p.decision_v2.official_status).toBe(token);
    }
  });

  it('no-op for null or undefined payload', () => {
    expect(() => computeWebhookFields(null)).not.toThrow();
    expect(() => computeWebhookFields(undefined)).not.toThrow();
  });
});

describe('deriveTerminalReasonFamilyForPayload — granular buckets (WI-1002)', () => {
  const base = { officialStatus: 'PASS', watchdogStatus: 'OK' };

  it('returns LINE_NOT_CONFIRMED for LINE_NOT_CONFIRMED reason code', () => {
    expect(deriveTerminalReasonFamilyForPayload({ ...base, reasonCodes: ['LINE_NOT_CONFIRMED'] }))
      .toBe('LINE_NOT_CONFIRMED');
  });

  it('returns MARKET_STALE_RECHECK for PRICE_SYNC_PENDING reason code', () => {
    expect(deriveTerminalReasonFamilyForPayload({ ...base, reasonCodes: ['PRICE_SYNC_PENDING'] }))
      .toBe('MARKET_STALE_RECHECK');
  });

  it('returns MARKET_STALE_RECHECK for STALE_MARKET reason code', () => {
    expect(deriveTerminalReasonFamilyForPayload({ ...base, reasonCodes: ['STALE_MARKET'] }))
      .toBe('MARKET_STALE_RECHECK');
  });

  it('returns EDGE_MOVED for EDGE_RECHECK_PENDING reason code', () => {
    expect(deriveTerminalReasonFamilyForPayload({ ...base, reasonCodes: ['EDGE_RECHECK_PENDING'] }))
      .toBe('EDGE_MOVED');
  });

  it('returns EDGE_MOVED for EDGE_NO_LONGER_CONFIRMED reason code', () => {
    expect(deriveTerminalReasonFamilyForPayload({ ...base, reasonCodes: ['EDGE_NO_LONGER_CONFIRMED'] }))
      .toBe('EDGE_MOVED');
  });

  it('LINE_NOT_CONFIRMED takes precedence over EDGE_RECHECK_PENDING when both present', () => {
    expect(deriveTerminalReasonFamilyForPayload({ ...base, reasonCodes: ['LINE_NOT_CONFIRMED', 'EDGE_RECHECK_PENDING'] }))
      .toBe('LINE_NOT_CONFIRMED');
  });

  it('returns PLAY_ELIGIBLE when officialStatus is PLAY regardless of reason codes', () => {
    expect(deriveTerminalReasonFamilyForPayload({ officialStatus: 'PLAY', watchdogStatus: 'OK', reasonCodes: ['LINE_NOT_CONFIRMED'] }))
      .toBe('PLAY_ELIGIBLE');
  });
});
