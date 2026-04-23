/*
 * UI results behavioral smoke test.
 *
 * Run: npm --prefix web run test:ui:results
 */

import assert from 'node:assert/strict';
import db from '../../../packages/data/src/db.js';
import {
  setupIsolatedTestDb,
  startIsolatedNextServer,
} from './db-test-runtime.js';

const TEST_PREFIX = 'test-ui-results';

function insertSettledResultFixture(client, sport, suffix, createdAt, overrides = {}) {
  const sportLower = sport.toLowerCase();
  const gameId = `${TEST_PREFIX}-${suffix}-game`;
  const cardId = `${TEST_PREFIX}-${suffix}-card`;
  const resultId = `${TEST_PREFIX}-${suffix}-result`;
  const marketType = overrides.marketType || 'total';
  const selection = overrides.selection || 'OVER';
  const line = overrides.line ?? 8.5;
  const lockedPrice = overrides.lockedPrice ?? -110;
  const cardType = overrides.cardType || `${sportLower}-totals-call`;
  const metadata = overrides.marketPeriodToken
    ? JSON.stringify({ market_period_token: overrides.marketPeriodToken })
    : null;

  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-row`,
      sportLower,
      gameId,
      `${sport} Home`,
      `${sport} Away`,
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
      sportLower,
      cardType,
      `${sport} ${marketType}`,
      createdAt,
      JSON.stringify({
        confidence_pct: overrides.confidencePct ?? 61.5,
        decision_basis: 'ODDS_BACKED',
        play: {
          decision_v2: {
            official_status: overrides.officialStatus || 'PLAY',
          },
          period: overrides.marketPeriodToken || 'FULL_GAME',
        },
        recommended_bet_type: marketType,
        market_type: marketType,
        selection,
        line,
        locked_price: lockedPrice,
        home_team: `${sport} Home`,
        away_team: `${sport} Away`,
      }),
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
      sport,
      marketType,
      selection,
      line,
      lockedPrice,
      overrides.confidencePct ?? 61.5,
      createdAt,
      '/api/cards',
    );

  client
    .prepare(
      `INSERT INTO card_results
       (id, card_id, game_id, sport, card_type, recommended_bet_type, status,
        result, settled_at, pnl_units, metadata, market_key, market_type,
        selection, line, locked_price, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      resultId,
      cardId,
      gameId,
      sportLower,
      cardType,
      marketType,
      'settled',
      overrides.result || 'win',
      createdAt,
      overrides.pnlUnits ?? 1,
      metadata,
      `${sportLower}:${gameId}:${marketType}:${selection}`,
      marketType,
      selection,
      line,
      lockedPrice,
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
      `${gameId}-game-result`,
      gameId,
      sportLower,
      5,
      4,
      'final',
      'manual',
      createdAt,
      createdAt,
      createdAt,
    );

  if (overrides.clvPct !== undefined) {
    client
      .prepare(
        `INSERT INTO clv_ledger
         (id, card_id, game_id, sport, market_type, selection, line,
          odds_at_pick, closing_odds, clv_pct, recorded_at, closed_at, decision_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `${cardId}-clv`,
        cardId,
        gameId,
        sportLower,
        marketType,
        selection,
        line,
        lockedPrice,
        overrides.closingOdds ?? -118,
        overrides.clvPct,
        createdAt,
        createdAt,
        'ODDS_BACKED',
      );
  }

  return { gameId, cardId, resultId };
}

async function fetchJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `${path} should return 200`);
  assert.match(
    response.headers.get('content-type') || '',
    /application\/json/,
    `${path} should return JSON`,
  );
  return {
    response,
    payload: await response.json(),
  };
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('ui-results-smoke');
  let server = null;

  try {
    const client = db.getDatabase();
    const createdAt = '2026-04-22T18:00:00.000Z';

    insertSettledResultFixture(client, 'NHL', 'nhl-1p', createdAt, {
      cardType: 'nhl-totals-call',
      marketPeriodToken: '1P',
      clvPct: 0.037,
      confidencePct: 64.2,
      pnlUnits: 1.05,
    });
    insertSettledResultFixture(client, 'MLB', 'mlb-full-game', createdAt, {
      cardType: 'mlb-totals-call',
      officialStatus: 'LEAN',
      result: 'loss',
      pnlUnits: -1,
      confidencePct: 55.4,
    });
    insertSettledResultFixture(client, 'NCAAM', 'ncaam-default-excluded', createdAt, {
      cardType: 'ncaam-totals-call',
      result: 'win',
      pnlUnits: 1,
    });

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'ui-results-smoke',
      readinessPath: '/api/results?limit=5',
    });

    const { response, payload } = await fetchJson(server.baseUrl, '/api/results?limit=5');
    assert.equal(payload.success, true, 'results success=false');
    assert.ok(payload.data, 'results data is missing');
    assert.equal(
      response.headers.get('x-settlement-coverage'),
      '2/2',
      'settlement coverage should reflect displayed non-NCAAM fixtures',
    );

    const summary = payload.data.summary;
    assert.equal(summary.totalCards, 2);
    assert.equal(summary.settledCards, 2);
    assert.equal(summary.wins, 1);
    assert.equal(summary.losses, 1);
    assert.equal(summary.pushes, 0);
    assert.equal(summary.totalPnlUnits, 0.050000000000000044);
    assert.equal(summary.avgClvPct, 0.037);

    assert.deepEqual(
      payload.data.ledger
        .map((row) => String(row.sport || '').toUpperCase())
        .sort(),
      ['MLB', 'NHL'],
      'default ledger should exclude NCAAM and include deterministic NHL/MLB rows',
    );
    const nhlLedger = payload.data.ledger.find((row) => row.sport === 'nhl');
    assert.equal(nhlLedger.marketPeriodToken, '1P');
    assert.equal(nhlLedger.decisionLabel, 'PLAY');
    assert.equal(nhlLedger.confidencePct, 64.2);
    assert.equal(nhlLedger.clv.clvPct, 0.037);

    const mlbLedger = payload.data.ledger.find((row) => row.sport === 'mlb');
    assert.equal(mlbLedger.decisionTier, 'LEAN');
    assert.equal(mlbLedger.decisionLabel, 'SLIGHT EDGE');

    assert.deepEqual(
      payload.data.segmentFamilies.map((segment) => [
        segment.segmentId,
        segment.settledCards,
      ]),
      [
        ['play', 1],
        ['slight_edge', 1],
      ],
      'segmentFamilies should be derived from runtime decision tiers',
    );
    assert.ok(
      Array.isArray(payload.data.projectionSummaries),
      'projectionSummaries should be present for the UI projection lane',
    );
    assert.equal(payload.data.meta.totalSettled, 2);
    assert.equal(payload.data.meta.returnedCount, 2);
    assert.equal(payload.data.filters.sport, null);
    assert.equal(payload.data.filters.dedupe, true);

    const { payload: ncaamPayload } = await fetchJson(
      server.baseUrl,
      '/api/results?limit=5&sport=NCAAM',
    );
    assert.equal(ncaamPayload.data.summary.settledCards, 1);
    assert.deepEqual(
      ncaamPayload.data.ledger.map((row) => String(row.sport || '').toUpperCase()),
      ['NCAAM'],
      'explicit sport=NCAAM should return archival NCAAM rows',
    );

    const pageResponse = await fetch(`${server.baseUrl}/results`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(pageResponse.status, 200, '/results page should render');
    const pageHtml = await pageResponse.text();
    assert.match(pageHtml, /Betting Record/, 'results page should render the betting lane');

    console.log('✅ UI results behavioral smoke test passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ UI results behavioral smoke test failed');
  console.error(error);
  process.exit(1);
});
