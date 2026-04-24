/*
 * Settlement parity behavioral contract test
 *
 * Verifies /api/results behavioral invariants using seeded fixtures:
 *   1. Display-log backed: orphaned card_results (no display log) do not appear in ledger
 *   2. X-Settlement-Coverage header present and formatted as settledFinal/displayedFinal
 *   3. meta includes displayedFinal, settledFinalDisplayed, missingFinalDisplayed
 *   4. segmentFamilies items carry segmentId and segmentLabel
 *   5. finalDisplayedMissingResults (worker-only diagnostic) does not leak into payload
 *
 * Run: npm --prefix web run test:results:settlement-parity
 */

// @ts-ignore
import db from '../../../../packages/data/src/db.js';
// @ts-ignore
import { setupIsolatedTestDb, startIsolatedNextServer } from '../db-test-runtime.js';

import assert from 'node:assert/strict';

const TEST_PREFIX = 'test-settlement-parity';

function insertDisplayedSettledFixture(
  client: ReturnType<typeof db.getDatabase>,
  suffix: string,
  createdAt: string,
) {
  const gameId = `${TEST_PREFIX}-${suffix}-game`;
  const cardId = `${TEST_PREFIX}-${suffix}-card`;

  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-row`, 'nhl', gameId, 'Home Team', 'Away Team',
      createdAt, 'final', createdAt, createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId, gameId, 'nhl', 'nhl-totals-call', 'NHL Total',
      createdAt,
      JSON.stringify({
        confidence_pct: 62.0,
        decision_basis: 'ODDS_BACKED',
        play: { decision_v2: { official_status: 'PLAY' }, period: 'FULL_GAME' },
        recommended_bet_type: 'total',
        market_type: 'total',
        selection: 'OVER',
        line: 6.5,
        locked_price: -110,
        home_team: 'Home Team',
        away_team: 'Away Team',
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
      cardId, `${TEST_PREFIX}-run`, gameId, 'NHL', 'total', 'OVER',
      6.5, -110, 62.0, createdAt, '/api/cards',
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
      `${cardId}-result`, cardId, gameId, 'nhl', 'nhl-totals-call', 'total',
      'settled', 'win', createdAt, 1, null,
      `nhl:${gameId}:total:OVER`, 'total', 'OVER', 6.5, -110,
      createdAt, createdAt,
    );

  client
    .prepare(
      `INSERT INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-game-result`, gameId, 'nhl', 4, 3, 'final', 'manual',
      createdAt, createdAt, createdAt,
    );

  return { gameId, cardId };
}

function insertDisplayedOnlyFixture(
  client: ReturnType<typeof db.getDatabase>,
  suffix: string,
  createdAt: string,
) {
  // Displayed + final game result, but no card_results row → missingFinalDisplayed
  const gameId = `${TEST_PREFIX}-${suffix}-game`;
  const cardId = `${TEST_PREFIX}-${suffix}-card`;

  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-row`, 'nhl', gameId, 'Home B', 'Away B',
      createdAt, 'final', createdAt, createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_display_log
       (pick_id, run_id, game_id, sport, market_type, selection, line, odds, confidence_pct, displayed_at, api_endpoint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId, `${TEST_PREFIX}-run`, gameId, 'NHL', 'total', 'OVER',
      5.5, -115, 58.0, createdAt, '/api/cards',
    );

  client
    .prepare(
      `INSERT INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-game-result`, gameId, 'nhl', 3, 2, 'final', 'manual',
      createdAt, createdAt, createdAt,
    );

  return { gameId, cardId };
}

function insertOrphanedResultFixture(
  client: ReturnType<typeof db.getDatabase>,
  suffix: string,
  createdAt: string,
) {
  // card_results + game_results but NO card_display_log → orphan, must not appear in ledger
  const gameId = `${TEST_PREFIX}-${suffix}-game`;
  const cardId = `${TEST_PREFIX}-${suffix}-card`;

  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-row`, 'nhl', gameId, 'Home C', 'Away C',
      createdAt, 'final', createdAt, createdAt,
    );

  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId, gameId, 'nhl', 'nhl-totals-call', 'NHL Orphan',
      createdAt,
      JSON.stringify({
        confidence_pct: 60.0,
        decision_basis: 'ODDS_BACKED',
        play: { decision_v2: { official_status: 'PLAY' }, period: 'FULL_GAME' },
        recommended_bet_type: 'total',
        market_type: 'total',
        selection: 'OVER',
        line: 5.0,
        locked_price: -110,
        home_team: 'Home C',
        away_team: 'Away C',
      }),
      `${TEST_PREFIX}-run`,
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
      `${cardId}-result`, cardId, gameId, 'nhl', 'nhl-totals-call', 'total',
      'settled', 'loss', createdAt, -1, null,
      `nhl:${gameId}:total:OVER`, 'total', 'OVER', 5.0, -110,
      createdAt, createdAt,
    );

  client
    .prepare(
      `INSERT INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-game-result`, gameId, 'nhl', 3, 5, 'final', 'manual',
      createdAt, createdAt, createdAt,
    );

  return { gameId, cardId };
}

async function run() {
  const testRuntime = await setupIsolatedTestDb('settlement-parity');
  let server: { baseUrl: string; stop: () => Promise<void> } | null = null;

  try {
    const client = db.getDatabase();
    const createdAt = '2026-04-22T18:00:00.000Z';

    // Card A: displayed + settled + final → settledFinalDisplayed++, displayedFinal++
    insertDisplayedSettledFixture(client, 'a-settled', createdAt);
    // Card B: displayed + final but no card_results → displayedFinal++, missingFinalDisplayed++
    insertDisplayedOnlyFixture(client, 'b-missing', createdAt);
    // Orphan: settled + final but not displayed → must not appear in ledger
    insertOrphanedResultFixture(client, 'c-orphan', createdAt);

    server = await startIsolatedNextServer({
      dbPath: testRuntime.dbPath,
      label: 'settlement-parity',
      readinessPath: '/api/results?limit=5',
    });

    const response = await fetch(`${server.baseUrl}/api/results?limit=10`, {
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200, '/api/results should return 200');
    const payload = await response.json() as Record<string, unknown>;

    // Invariant 1: display-log-backed — orphaned card_results must not appear
    const data = payload.data as Record<string, unknown>;
    const ledger = data.ledger as Array<Record<string, unknown>>;
    const orphanGameId = `${TEST_PREFIX}-c-orphan-game`;
    assert.ok(
      !ledger.some((row) => row.gameId === orphanGameId),
      'orphaned card_results (no display log) must not appear in ledger',
    );
    assert.equal(ledger.length, 1, 'only the displayed+settled card should appear in ledger');

    // Invariant 2: X-Settlement-Coverage header present and formatted N/M
    const coverageHeader = response.headers.get('x-settlement-coverage');
    assert.ok(coverageHeader, 'X-Settlement-Coverage header must be present');
    assert.match(
      coverageHeader,
      /^\d+\/\d+$/,
      'X-Settlement-Coverage must be formatted as N/M',
    );
    assert.equal(
      coverageHeader,
      '1/2',
      'coverage should be 1 settled of 2 displayed-final cards',
    );

    // Invariant 3: meta settlement coverage counters present and correct
    const meta = data.meta as Record<string, unknown>;
    assert.ok(meta, 'response must include meta');
    assert.equal(typeof meta.displayedFinal, 'number', 'meta.displayedFinal must be numeric');
    assert.equal(typeof meta.settledFinalDisplayed, 'number', 'meta.settledFinalDisplayed must be numeric');
    assert.equal(typeof meta.missingFinalDisplayed, 'number', 'meta.missingFinalDisplayed must be numeric');
    assert.equal(meta.displayedFinal, 2, 'displayedFinal: 2 cards in display log with final game result');
    assert.equal(meta.settledFinalDisplayed, 1, 'settledFinalDisplayed: 1 card both displayed and settled');
    assert.equal(meta.missingFinalDisplayed, 1, 'missingFinalDisplayed: 1 displayed-final card not yet settled');

    // Invariant 4: segmentFamilies items carry segmentId and segmentLabel
    const segmentFamilies = data.segmentFamilies as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(segmentFamilies), 'segmentFamilies must be an array');
    assert.ok(segmentFamilies.length > 0, 'segmentFamilies must not be empty');
    segmentFamilies.forEach((family, i) => {
      assert.ok(
        typeof family.segmentId === 'string',
        `segmentFamilies[${i}] must have a string segmentId`,
      );
      assert.ok(
        typeof family.segmentLabel === 'string',
        `segmentFamilies[${i}] must have a string segmentLabel`,
      );
    });

    // Invariant 5: finalDisplayedMissingResults (worker-only) must not leak into payload
    const payloadStr = JSON.stringify(payload);
    assert.ok(
      !payloadStr.includes('finalDisplayedMissingResults'),
      'worker-only diagnostic "finalDisplayedMissingResults" must not appear in API response',
    );

    console.log('✅ Settlement parity behavioral contract tests passed');
  } finally {
    if (server) await server.stop();
    testRuntime.cleanup();
  }
}

run().catch((error) => {
  console.error('❌ Settlement parity behavioral contract tests failed');
  console.error(error);
  process.exit(1);
});
