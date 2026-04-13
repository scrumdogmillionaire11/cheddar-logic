/*
 * Behavioral regression tests for MLB game-line transforms.
 * Run: cd web && node --import tsx/esm src/__tests__/game-card-transform-mlb-game-lines.test.js
 */

import assert from 'node:assert';
import { transformGames } from '../lib/game-card/transform/index.ts';

console.log('🧪 MLB game-line transform regressions');

function makeBaseGame(overrides = {}) {
  return {
    id: 'game-mlb-test',
    gameId: 'game-mlb-test',
    sport: 'mlb',
    homeTeam: 'BALTIMORE ORIOLES',
    awayTeam: 'ARIZONA DIAMONDBACKS',
    gameTimeUtc: '2026-04-13T22:36:00Z',
    status: 'scheduled',
    createdAt: '2026-04-13T14:06:27Z',
    projection_inputs_complete: true,
    projection_missing_inputs: [],
    source_mapping_ok: true,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    odds: {
      h2hHome: -130,
      h2hAway: 118,
      total: 8.5,
      spreadHome: null,
      spreadAway: null,
      totalPriceOver: -115,
      totalPriceUnder: 100,
      capturedAt: '2026-04-13T14:45:06.760Z',
    },
    consistency: { total_bias: 'INSUFFICIENT_DATA' },
    true_play: null,
    plays: [],
    ...overrides,
  };
}

{
  const projectionOnlyGame = makeBaseGame({
    id: 'game-mlb-projection-only',
    gameId: 'game-mlb-projection-only',
    plays: [
      {
        source_card_id: 'card-mlb-f5-projection-only',
        cardType: 'mlb-f5',
        cardTitle: 'F5 OVER: ARIZONA DIAMONDBACKS @ BALTIMORE ORIOLES',
        prediction: 'OVER',
        confidence: 0.5,
        tier: null,
        reasoning:
          'F5 SYNTHETIC_FALLBACK projection floor 4.5; PASS only until a real F5 market line is available',
        evPassed: false,
        driverKey: '',
        projectedTotal: 4.5,
        edge: null,
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        line: 4.5,
        status: 'PASS',
        classification: 'PASS',
        action: 'PASS',
        pass_reason_code: 'PASS_SYNTHETIC_FALLBACK',
        reason_codes: [
          'PASS_SYNTHETIC_FALLBACK',
          'PASS_NO_EDGE',
          'NOT_BET_ELIGIBLE',
          'MARKET_PRICE_MISSING',
        ],
        missing_inputs: ['market_line'],
        execution_status: 'PROJECTION_ONLY',
        basis: 'PROJECTION_ONLY',
        projection_source: 'SYNTHETIC_FALLBACK',
        tags: ['no_odds_mode'],
      },
    ],
  });

  const transformed = transformGames([projectionOnlyGame]);
  assert.strictEqual(
    transformed.length,
    0,
    'projection-only MLB F5 fallback rows should not create game-mode cards',
  );
}

{
  const blockedMlGame = makeBaseGame({
    id: 'game-mlb-full-game-ml-pass',
    gameId: 'game-mlb-full-game-ml-pass',
    plays: [
      {
        source_card_id: 'card-mlb-full-game-ml-pass',
        cardType: 'mlb-full-game-ml',
        cardTitle: 'Full Game ML AWAY: HOUSTON ASTROS @ SEATTLE MARINERS',
        prediction: 'AWAY',
        confidence: 0.6,
        tier: 'WATCH',
        reasoning:
          'FullGameML: homeProj=3.97 awayProj=3.78 runDiff=+0.19 pWin(H)=52.4% implH=61.0% implA=39.0% edgeH=-8.7pp edgeA=+8.7pp conf=6/10',
        evPassed: false,
        driverKey: '',
        projectedTotal: null,
        edge: 0.087,
        p_fair: 0.476,
        p_implied: 0.4,
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: { side: 'AWAY' },
        price: 150,
        status: 'PASS',
        classification: 'PASS',
        action: 'PASS',
        pass_reason_code: 'PASS_EXECUTION_GATE_NO_EDGE_COMPUTED',
        reason_codes: [
          'FULL_GAME_ML_DEGRADED',
          'PASS_EXECUTION_GATE_NO_EDGE_COMPUTED',
          'NO_EDGE_COMPUTED',
          'MISSING_EDGE',
          'MARKET_PRICE_MISSING',
        ],
        execution_status: 'BLOCKED',
        tags: [],
      },
    ],
  });

  const [card] = transformGames([blockedMlGame]);
  assert(card, 'blocked MLB moneyline row should still transform into a game card');
  assert(
    !card.play.reason_codes.includes('PASS_DATA_ERROR'),
    'NO_EDGE_COMPUTED MLB moneyline passes should not be mislabeled as PASS_DATA_ERROR',
  );
  assert.strictEqual(
    card.play.status,
    'PASS',
    'blocked MLB moneyline rows must remain PASS even when edge/fair fields are present',
  );
  assert.strictEqual(
    card.play.action,
    'PASS',
    'blocked MLB moneyline rows must keep action PASS',
  );
  assert.strictEqual(
    card.play.transform_meta?.quality,
    'OK',
    'blocked MLB moneyline no-edge passes should stay quality OK',
  );
}

console.log('✅ MLB game-line transform regressions passed');
