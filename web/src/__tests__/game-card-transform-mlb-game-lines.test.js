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

{
  const weakSupportEdgeSanityPass = makeBaseGame({
    id: 'game-mlb-full-game-ml-edge-sanity-pass',
    gameId: 'game-mlb-full-game-ml-edge-sanity-pass',
    plays: [
      {
        source_card_id: 'card-mlb-full-game-ml-edge-sanity-pass',
        cardType: 'mlb-full-game-ml',
        cardTitle: 'Full Game ML AWAY: NEW YORK METS @ LOS ANGELES DODGERS',
        prediction: 'AWAY',
        confidence: 0.6,
        tier: 'BEST',
        reasoning:
          'FullGameML: homeProj=3.86 awayProj=4.74 runDiff=-0.87 var=3.89 pWin(H)=35.1% implH=59.3% implA=40.7% edgeH=-24.2pp edgeA=+24.2pp support=2 conf=6/10',
        evPassed: false,
        edge: 0.242,
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: { side: 'AWAY' },
        price: 140,
        status: 'PASS',
        classification: 'PASS',
        action: 'PASS',
        pass_reason_code: 'PASS_DRIVER_SUPPORT_WEAK',
        reason_codes: [
          'PASS_DRIVER_SUPPORT_WEAK',
          'DOWNGRADED_EDGE_SANITY_NON_TOTAL',
        ],
        execution_status: 'BLOCKED',
        tags: [],
      },
    ],
  });

  const transformed = transformGames([weakSupportEdgeSanityPass]);
  assert.strictEqual(
    transformed.length,
    0,
    'non-total PASS rows downgraded by edge sanity and weak driver support should be excluded from game-line cards',
  );
}

{
  const actionableDegradedTotalLean = makeBaseGame({
    id: 'game-mlb-full-game-total-legacy-pass-diagnostic',
    gameId: 'game-mlb-full-game-total-legacy-pass-diagnostic',
    consistency: { total_bias: 'UNKNOWN' },
    odds: {
      h2hHome: -105,
      h2hAway: -104,
      total: 9.25,
      spreadHome: null,
      spreadAway: null,
      totalPriceOver: 110,
      totalPriceUnder: -102,
      capturedAt: '2026-04-17T01:48:48.067Z',
    },
    true_play: {
      source_card_id: 'card-mlb-full-game-total-legacy-pass-diagnostic',
      cardType: 'mlb-full-game',
      cardTitle: 'Full Game Total OVER: ATLANTA BRAVES @ PHILADELPHIA PHILLIES',
      prediction: 'OVER',
      confidence: 0.5,
      tier: 'WATCH',
      reasoning:
        'FG TOTAL DEGRADED_MODEL raw 10.78 recentered 10.52 shrunk 10.16 vs line 9.5 finalEdge +0.66 drivers=SP_MISMATCH conf=5/10',
      evPassed: true,
      driverKey: 'mlb-full-game',
      projectedTotal: 10.8,
      edge: 0.1238,
      p_fair: 0.6,
      p_implied: 0.4762,
      model_prob: 0.6,
      kind: 'PLAY',
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      line: 9.5,
      price: 110,
      status: 'WATCH',
      classification: 'LEAN',
      action: 'HOLD',
      pass_reason_code: null,
      reason_codes: [
        'MODEL_DEGRADED_INPUTS',
        'PASS_CONFIDENCE_GATE',
        'SOFT_DEGRADED_TOTAL_MODEL',
      ],
      execution_status: 'EXECUTABLE',
      execution_gate: {
        evaluated: true,
        should_bet: true,
        net_edge: 0.0738,
        blocked_by: [],
        model_status: 'MODEL_OK',
      },
      tags: [],
    },
    plays: [
      {
        source_card_id: 'card-mlb-full-game-total-legacy-pass-diagnostic',
        cardType: 'mlb-full-game',
        cardTitle: 'Full Game Total OVER: ATLANTA BRAVES @ PHILADELPHIA PHILLIES',
        prediction: 'OVER',
        confidence: 0.5,
        tier: 'WATCH',
        reasoning:
          'FG TOTAL DEGRADED_MODEL raw 10.78 recentered 10.52 shrunk 10.16 vs line 9.5 finalEdge +0.66 drivers=SP_MISMATCH conf=5/10',
        evPassed: true,
        driverKey: 'mlb-full-game',
        projectedTotal: 10.8,
        edge: 0.1238,
        p_fair: 0.6,
        p_implied: 0.4762,
        model_prob: 0.6,
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        line: 9.5,
        price: 110,
        status: 'WATCH',
        classification: 'LEAN',
        action: 'HOLD',
        pass_reason_code: null,
        reason_codes: [
          'MODEL_DEGRADED_INPUTS',
          'PASS_CONFIDENCE_GATE',
          'SOFT_DEGRADED_TOTAL_MODEL',
        ],
        execution_status: 'EXECUTABLE',
        execution_gate: {
          evaluated: true,
          should_bet: true,
          net_edge: 0.0738,
          blocked_by: [],
          model_status: 'MODEL_OK',
        },
        tags: [],
      },
    ],
  });

  const [card] = transformGames([actionableDegradedTotalLean]);
  assert(card, 'actionable degraded MLB total lean should create a game card');
  assert.strictEqual(
    card.play.action,
    'HOLD',
    'stored MLB total LEAN/HOLD should remain a lean after transform',
  );
  assert.strictEqual(
    card.play.betAction,
    'BET',
    'legacy PASS_CONFIDENCE_GATE diagnostic must not remove an executable MLB total bet',
  );
  assert(
    card.play.bet,
    'executable MLB total lean should retain its canonical bet',
  );
  assert.deepStrictEqual(
    card.play.gates.find((gate) => gate.code === 'PASS_CONFIDENCE_GATE'),
    {
      code: 'PASS_CONFIDENCE_GATE',
      severity: 'WARN',
      blocks_bet: false,
    },
    'legacy confidence diagnostic should stay visible as a warning, not a blocking gate',
  );
}

{
  const executableTotalGame = makeBaseGame({
    id: 'game-mlb-executable-full-game-total',
    gameId: 'game-mlb-executable-full-game-total',
    plays: [
      {
        source_card_id: 'card-mlb-full-game-over',
        cardType: 'mlb-full-game',
        cardTitle: 'Full Game Total OVER: TEXAS RANGERS @ HOUSTON ASTROS',
        prediction: 'OVER',
        confidence: 0.69,
        tier: 'BEST',
        reasoning: 'Executable full-game total',
        evPassed: true,
        driverKey: 'mlb-full-game',
        projectedTotal: 8.7,
        edge: 0.061,
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        line: 8.0,
        price: -110,
        status: 'FIRE',
        classification: 'BASE',
        action: 'FIRE',
        reason_codes: ['PLAY'],
        execution_status: 'EXECUTABLE',
      },
    ],
  });

  const executableMlGame = makeBaseGame({
    id: 'game-mlb-executable-full-game-ml',
    gameId: 'game-mlb-executable-full-game-ml',
    plays: [
      {
        source_card_id: 'card-mlb-full-game-ml-away',
        cardType: 'mlb-full-game-ml',
        cardTitle: 'Full Game ML AWAY: TEXAS RANGERS @ HOUSTON ASTROS',
        prediction: 'AWAY',
        confidence: 0.57,
        tier: 'WATCH',
        reasoning: 'Executable full-game moneyline',
        evPassed: true,
        driverKey: 'mlb-full-game-ml',
        projectedTotal: null,
        edge: 0.041,
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: { side: 'AWAY' },
        price: 128,
        status: 'WATCH',
        classification: 'LEAN',
        action: 'HOLD',
        reason_codes: ['PLAY'],
        execution_status: 'EXECUTABLE',
      },
    ],
  });

  const transformed = transformGames([executableTotalGame, executableMlGame]);
  assert.strictEqual(
    transformed.length,
    2,
    'executable MLB full-game total/ML rows should survive transform into visible game-mode cards',
  );
}

{
  const hiddenNonPublishable = makeBaseGame({
    id: 'game-mlb-hidden-nonpublishable-full-game',
    gameId: 'game-mlb-hidden-nonpublishable-full-game',
    plays: [
      {
        source_card_id: 'card-projection-only-total',
        cardType: 'mlb-full-game',
        cardTitle: 'Projection-only full game total',
        prediction: 'OVER',
        confidence: 0.5,
        tier: null,
        reasoning: 'Projection only',
        evPassed: false,
        driverKey: 'mlb-full-game',
        projectedTotal: 8.5,
        edge: null,
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        line: 8.5,
        status: 'PASS',
        classification: 'PASS',
        action: 'PASS',
        reason_codes: ['PROJECTION_ONLY', 'PASS_NO_EDGE'],
        execution_status: 'PROJECTION_ONLY',
      },
      {
        source_card_id: 'card-blocked-no-edge-ml',
        cardType: 'mlb-full-game-ml',
        cardTitle: 'Blocked no-edge full game ML',
        prediction: 'HOME',
        confidence: 0.5,
        tier: null,
        reasoning: 'No edge',
        evPassed: false,
        driverKey: 'mlb-full-game-ml',
        projectedTotal: null,
        edge: null,
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: { side: 'HOME' },
        price: -122,
        status: 'PASS',
        classification: 'PASS',
        action: 'PASS',
        pass_reason_code: 'PASS_DRIVER_SUPPORT_WEAK',
        reason_codes: [
          'PASS_DRIVER_SUPPORT_WEAK',
          'PASS_NO_EDGE',
          'DOWNGRADED_EDGE_SANITY_NON_TOTAL',
        ],
        execution_status: 'BLOCKED',
      },
    ],
  });

  const transformed = transformGames([hiddenNonPublishable]);
  assert.strictEqual(
    transformed.length,
    0,
    'blocked/no-edge/projection-only MLB full-game rows should remain hidden from active game-line views',
  );
}

console.log('✅ MLB game-line transform regressions passed');
