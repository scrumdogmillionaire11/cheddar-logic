import assert from 'node:assert';
import db from '../../../packages/data/src/db.js';
import { setupIsolatedTestDb, startIsolatedNextServer } from './db-test-runtime.js';

const TEST_PREFIX = 'test-results-mlb-legacy-adapter';

function insertResultFixture(client, fixture) {
  const createdAt = fixture.createdAt || '2026-04-20T12:00:00Z';
  const gameId = `${TEST_PREFIX}-${fixture.id}-game`;
  const cardId = `${TEST_PREFIX}-${fixture.id}-card`;

  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${TEST_PREFIX}-${fixture.id}-game-row`,
      fixture.sport.toLowerCase(),
      gameId,
      `${fixture.sport} Home`,
      `${fixture.sport} Away`,
      createdAt,
      'final',
      createdAt,
      createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId,
      gameId,
      fixture.sport.toLowerCase(),
      fixture.cardType,
      fixture.title || `${fixture.sport} Fixture`,
      createdAt,
      JSON.stringify(fixture.payload),
      `${TEST_PREFIX}-run`,
    );

  client
    .prepare(
      `INSERT INTO card_display_log
       (pick_id, run_id, game_id, sport, market_type, selection, line, odds, confidence_pct, displayed_at, api_endpoint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId,
      `${TEST_PREFIX}-run`,
      gameId,
      fixture.sport,
      fixture.marketType || fixture.recommendedBetType,
      fixture.selection || 'OVER',
      fixture.line ?? 5.5,
      fixture.odds ?? -110,
      61.2,
      createdAt,
      '/api/cards',
    );

  client
    .prepare(
      `INSERT INTO card_results
       (id, card_id, game_id, sport, card_type, recommended_bet_type, status, result, settled_at, pnl_units, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${TEST_PREFIX}-${fixture.id}-result`,
      cardId,
      gameId,
      fixture.sport.toLowerCase(),
      fixture.cardType,
      fixture.recommendedBetType,
      fixture.cardResultStatus,
      fixture.result,
      fixture.cardResultStatus === 'settled' ? createdAt : null,
      fixture.result === 'win' ? 1 : fixture.result === 'loss' ? -1 : 0,
      createdAt,
      createdAt,
    );

  client
    .prepare(
      `INSERT INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${TEST_PREFIX}-${fixture.id}-game-result`,
      gameId,
      fixture.sport.toLowerCase(),
      4,
      2,
      'final',
      'manual',
      createdAt,
      createdAt,
      createdAt,
    );
}

async function fetchJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(8_000),
  });
  const payload = await response.json();
  return { response, payload };
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('api-results-mlb-legacy-adapter');
  let server = null;

  try {
    const client = db.getDatabase();

    // 1) MLB totals legacy PLAY without decision_v2 must remain fail-closed.
    insertResultFixture(client, {
      id: 'mlb-total-legacy-play',
      sport: 'MLB',
      cardType: 'mlb-full-game',
      recommendedBetType: 'total',
      cardResultStatus: 'settled',
      result: 'win',
      payload: {
        status: 'PLAY',
        recommended_bet_type: 'total',
        prediction: 'OVER',
      },
    });

    // 2) MLB moneyline legacy SLIGHT_EDGE without decision_v2 must remain fail-closed.
    insertResultFixture(client, {
      id: 'mlb-ml-legacy-slight-edge',
      sport: 'MLB',
      cardType: 'mlb-full-game-ml',
      recommendedBetType: 'moneyline',
      cardResultStatus: 'settled',
      result: 'loss',
      selection: 'HOME',
      payload: {
        status: 'SLIGHT_EDGE',
        recommended_bet_type: 'moneyline',
        prediction: 'HOME',
      },
    });

    // 3) decision_v2 must override legacy status for MLB.
    insertResultFixture(client, {
      id: 'mlb-decision-v2-wins',
      sport: 'MLB',
      cardType: 'mlb-full-game',
      recommendedBetType: 'total',
      cardResultStatus: 'settled',
      result: 'win',
      payload: {
        status: 'PLAY',
        play: {
          decision_v2: {
            official_status: 'LEAN',
            selection: { market: 'MLB_TOTAL', side: 'UNDER' },
          },
        },
        recommended_bet_type: 'total',
        prediction: 'UNDER',
      },
    });

    // 4) Non-MLB legacy status without decision_v2 must remain fail-closed.
    insertResultFixture(client, {
      id: 'nhl-legacy-play-no-decision-v2',
      sport: 'NHL',
      cardType: 'nhl-totals-call',
      recommendedBetType: 'total',
      cardResultStatus: 'settled',
      result: 'win',
      payload: {
        status: 'PLAY',
        recommended_bet_type: 'total',
        prediction: 'OVER',
      },
    });

    // 5) Unsettled MLB row without decision_v2 must remain untracked.
    insertResultFixture(client, {
      id: 'mlb-unsettled-legacy-play',
      sport: 'MLB',
      cardType: 'mlb-full-game',
      recommendedBetType: 'total',
      cardResultStatus: 'open',
      result: null,
      payload: {
        status: 'PLAY',
        recommended_bet_type: 'total',
        prediction: 'OVER',
      },
    });

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'api-results-mlb-legacy-adapter',
      readinessPath: '/api/results?limit=5',
    });

    const { response, payload } = await fetchJson(
      server.baseUrl,
      '/api/results?limit=100&_diag=1',
    );
    assert.equal(response.status, 200, 'expected /api/results to return 200');
    assert.equal(payload.success, true, 'results success=false');

    const segments = payload.data?.segments || [];
    const findSegment = (segmentId, cardFamily, betType, sport) =>
      segments.find(
        (row) =>
          row.segmentId === segmentId &&
          row.cardFamily === cardFamily &&
          row.recommendedBetType === betType &&
          String(row.sport || '').toUpperCase() === sport,
      );

    const mlbPlayTotal = findSegment('play', 'MLB_TOTAL', 'total', 'MLB');
    assert.equal(
      mlbPlayTotal,
      undefined,
      'MLB legacy-only PLAY rows must remain fail-closed and untracked',
    );

    const mlbLeanMl = findSegment('slight_edge', 'MLB_ML', 'moneyline', 'MLB');
    assert.equal(
      mlbLeanMl,
      undefined,
      'MLB legacy-only SLIGHT_EDGE rows must remain fail-closed and untracked',
    );

    const mlbLeanTotal = findSegment('slight_edge', 'MLB_TOTAL', 'total', 'MLB');
    assert.ok(
      mlbLeanTotal,
      'MLB row with decision_v2=LEAN should contribute to SLIGHT EDGE segment',
    );
    assert.equal(
      mlbLeanTotal.settledCards,
      1,
      'only canonical decision_v2 MLB row should be tracked in this fixture',
    );

    const nhlAnySegment = segments.find(
      (row) => String(row.sport || '').toUpperCase() === 'NHL',
    );
    assert.equal(
      nhlAnySegment,
      undefined,
      'non-MLB legacy-only rows must remain fail-closed and untracked',
    );

    const unsettledLeaked = segments.find(
      (row) =>
        String(row.sport || '').toUpperCase() === 'MLB' &&
        row.settledCards > 1 &&
        row.cardFamily === 'MLB_TOTAL',
    );
    assert.equal(
      unsettledLeaked,
      undefined,
      'unsettled MLB legacy rows must not leak into settled tracked segments',
    );

    console.log('✅ API results MLB legacy fail-closed tests passed');
  } finally {
    if (server) {
      await server.stop();
    }
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ API results MLB legacy fail-closed tests failed');
  console.error(error);
  process.exitCode = 1;
});