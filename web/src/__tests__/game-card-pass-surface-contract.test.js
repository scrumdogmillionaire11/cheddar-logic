/*
 * Contract tests for canonical final_market_decision surface behavior.
 * Run: node --import tsx/esm web/src/__tests__/game-card-pass-surface-contract.test.js
 */

import assert from 'node:assert';

import { transformToGameCard } from '../lib/game-card/transform/index';

function buildDecisionV2(overrides = {}) {
  return {
    direction: 'OVER',
    support_score: 0.74,
    conflict_score: 0.08,
    drivers_used: ['total_projection'],
    driver_reasons: ['Model total edge'],
    watchdog_status: 'OK',
    watchdog_reason_codes: [],
    missing_data: {
      missing_fields: [],
      source_attempts: [],
      severity: 'INFO',
    },
    consistency: {
      pace_tier: 'NORMAL',
      event_env: 'NORMAL',
      event_direction_tag: 'NEUTRAL',
      vol_env: 'NORMAL',
      total_bias: 'OK',
    },
    market_type: 'TOTAL',
    market_line: 6.5,
    market_price: 100,
    fair_prob: 0.69,
    implied_prob: 0.5,
    edge_pct: 0.19,
    edge_delta_pct: 0.21,
    edge_method: 'TOTAL_DELTA',
    edge_line_delta: 1.3,
    edge_lean: 'OVER',
    proxy_used: false,
    proxy_capped: false,
    exact_wager_valid: true,
    pricing_trace: {
      market_type: 'TOTAL',
      market_side: 'OVER',
      market_line: 6.5,
      market_price: 100,
      line_source: 'odds_snapshot',
      price_source: 'odds_snapshot',
    },
    sharp_price_status: 'CHEDDAR',
    price_reason_codes: [],
    official_status: 'PLAY',
    play_tier: 'BEST',
    primary_reason_code: 'EDGE_CLEAR',
    pipeline_version: 'v2',
    decided_at: '2026-04-13T12:00:00.000Z',
    ...overrides,
  };
}

function buildPlay(overrides = {}) {
  const { decision_v2: decisionOverrides, ...restOverrides } = overrides;
  const decisionV2 = buildDecisionV2(decisionOverrides || {});
  return {
    source_card_id: 'card-1',
    cardType: 'nhl-totals-call',
    cardTitle: 'NHL Total',
    prediction: 'OVER',
    confidence: 0.82,
    tier: 'BEST',
    reasoning: 'Model likes over at current number.',
    evPassed: true,
    driverKey: 'driver-1',
    edge: 0.21,
    model_prob: 0.69,
    market_type: 'TOTAL',
    selection: { side: 'OVER' },
    kind: 'PLAY',
    line: 6.5,
    price: 100,
    status: 'FIRE',
    classification: 'BASE',
    action: 'FIRE',
    reason_codes: [],
    created_at: '2026-04-13T12:00:00.000Z',
    decision_v2: decisionV2,
    goalie_home_status: 'CONFIRMED',
    goalie_away_status: 'CONFIRMED',
    ...restOverrides,
    decision_v2: decisionV2,
  };
}

function buildGame(playOverrides = {}) {
  const play = buildPlay(playOverrides);
  return {
    id: 'game-1',
    gameId: 'game-1',
    sport: 'NHL',
    homeTeam: 'Columbus Blue Jackets',
    awayTeam: 'Washington Capitals',
    gameTimeUtc: '2026-04-13T23:00:00.000Z',
    status: 'scheduled',
    createdAt: '2026-04-13T12:00:00.000Z',
    odds: {
      h2hHome: 100,
      h2hAway: -120,
      total: 6.5,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: 100,
      totalPriceUnder: -120,
      capturedAt: '2026-04-13T12:05:00.000Z',
    },
    plays: [play],
    true_play: play,
  };
}

console.log('🧪 final_market_decision contract tests');

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
      reason_codes: ['LINE_NOT_CONFIRMED'],
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'PENDING_VERIFICATION',
        primary_reason_code: 'LINE_NOT_CONFIRMED',
      play_tier: 'BEST',
      edge_delta_pct: 0.21,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.ok(decision, 'expected final_market_decision on transformed play');
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.equal(decision?.show_model_context, false);
  assert.equal(decision?.verification_state, 'PENDING');
}

{
  const game = buildGame({
    goalie_home_status: 'EXPECTED',
    goalie_away_status: 'EXPECTED',
    decision_v2: {
      official_status: 'PLAY',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'EDGE_CLEAR',
      edge_delta_pct: 0.19,
    },
  });
  const card = transformToGameCard(game);
  assert.equal(card.play?.final_market_decision?.surfaced_status, 'SLIGHT EDGE');
  assert.equal(card.play?.final_market_decision?.certainty_state, 'PARTIAL');
}

{
  const game = buildGame({
    reason_codes: ['GATE_LINE_MOVEMENT'],
    decision_v2: {
      official_status: 'PLAY',
      primary_reason_code: 'GATE_LINE_MOVEMENT',
      sharp_price_status: 'CHEDDAR',
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'SLIGHT EDGE');
  assert.equal(decision?.market_stable, false);
  assert.match(decision?.surfaced_reason || '', /line moved/i);
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_NO_EDGE',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.equal(decision?.surfaced_reason, 'No edge');
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    reason_codes: ['MISSING_DATA_PROJECTION_INPUTS', 'PASS_NO_EDGE'],
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_NO_EDGE',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.equal(decision?.surfaced_reason, 'Missing projection inputs');
  assert.equal(decision?.projection_input_status, 'INCOMPLETE');
  assert.equal(decision?.market_verification_status, 'VERIFIED');
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_NO_EDGE',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  game.plays = [];
  game.true_play = undefined;
  game.feature_flags = ['FEATURE_BLOCK_RATES_STALE'];
  game.core_inputs_complete = true;
  game.core_missing_inputs = [];

  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.equal(decision?.surfaced_reason, 'Feature freshness stale');
  assert.equal(decision?.projection_input_status, 'COMPLETE');
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_NO_EDGE',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  game.plays[0].core_inputs_complete = true;
  game.plays[0].core_missing_inputs = [];
  game.plays[0].projection_inputs_complete = false; // conflicting legacy field
  game.plays[0].missing_inputs = ['espn_pace'];
  game.true_play = game.plays[0];

  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.projection_input_status, 'COMPLETE');
  assert.notEqual(decision?.surfaced_reason, 'Missing projection inputs');
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    reason_codes: ['PASS_NO_EDGE'],
    market_status: {
      has_odds: true,
      freshness_tier: 'fresh',
      execution_blocked: false,
    },
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_NO_EDGE',
      play_tier: null,
      edge_delta_pct: null,
    },
  });

  // Evidence/info row should not downgrade market status for the game.
  game.plays.push({
    source_card_id: 'evidence-1',
    cardType: 'nhl-model-output',
    cardTitle: 'NHL Model Output',
    kind: 'EVIDENCE',
    status: 'PASS',
    classification: 'PASS',
    action: 'PASS',
    market_status: {
      has_odds: false,
      freshness_tier: 'unknown',
      execution_blocked: false,
    },
    created_at: '2026-04-13T12:00:00.000Z',
  });

  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.doesNotMatch(decision?.surfaced_reason || '', /Odds unavailable|Market unavailable/i);
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_NO_EDGE',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  game.plays = [];
  game.true_play = undefined;
  game.market_status = {
    has_odds: false,
    freshness_tier: 'expired',
    execution_blocked: true,
  };
  game.core_inputs_complete = true;
  game.core_missing_inputs = [];

  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.match(decision?.surfaced_reason || '', /Odds unavailable|Market unavailable/i);
  assert.equal(decision?.projection_input_status, 'COMPLETE');
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_EXECUTION_GATE_NO_EDGE_COMPUTED',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.equal(decision?.surfaced_reason, 'Model incomplete');
}

{
  const game = buildGame({
    action: 'PASS',
    classification: 'PASS',
    status: 'PASS',
    decision_v2: {
      official_status: 'PASS',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'UNMAPPED_INTERNAL_REASON',
      play_tier: null,
      edge_delta_pct: null,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PASS');
  assert.equal(decision?.surfaced_reason, 'No edge at current price');
  assert.doesNotMatch(decision?.surfaced_reason || '', /UNMAPPED|INTERNAL|REASON/);
}

{
  const game = buildGame({
    goalie_home_status: 'CONFIRMED',
    goalie_away_status: 'CONFIRMED',
    decision_v2: {
      official_status: 'PLAY',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'EDGE_CLEAR',
      play_tier: 'BEST',
      edge_delta_pct: 0.08,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'PLAY');
  assert.equal(decision?.verification_state, 'VERIFIED');
  assert.equal(decision?.market_verification_status, 'VERIFIED');
  assert.equal(decision?.projection_input_status, 'COMPLETE');
  assert.equal(decision?.certainty_state, 'CONFIRMED');
  assert.equal(decision?.show_model_context, true);
}

{
  const game = buildGame({
    cardType: 'mlb-full-game',
    reason_codes: ['MODEL_DEGRADED_INPUTS'],
    action: 'HOLD',
    classification: 'LEAN',
    status: 'WATCH',
  });
  game.sport = 'MLB';
  game.true_play = game.plays[0];
  delete game.plays[0].decision_v2;

  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'SLIGHT EDGE');
  assert.equal(decision?.verification_state, 'VERIFIED');
  assert.equal(decision?.certainty_state, 'CONFIRMED');
  assert.equal(decision?.show_model_context, true);
}



{
  const game = buildGame({
    action: 'HOLD',
    classification: 'LEAN',
    status: 'WATCH',
    decision_v2: {
      official_status: 'LEAN',
      sharp_price_status: 'CHEDDAR',
      primary_reason_code: 'PASS_EXECUTION_GATE_STALE_SNAPSHOT',
      play_tier: 'GOOD',
      edge_delta_pct: 0.03,
    },
  });
  const card = transformToGameCard(game);
  const decision = card.play?.final_market_decision;
  assert.equal(decision?.surfaced_status, 'SLIGHT EDGE');
  assert.equal(
    decision?.surfaced_reason,
    'Edge clear',
    'stale gate reason should be suppressed from surfaced_reason when card is still market-valid',
  );
}

console.log('✅ final_market_decision contract tests passed');
