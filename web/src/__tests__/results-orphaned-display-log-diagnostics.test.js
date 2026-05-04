/*
 * WI-1238: direct query-layer diagnostics for settled rows hidden by missing
 * card_display_log enrollment.
 *
 * Run: node web/src/__tests__/results-orphaned-display-log-diagnostics.test.js
 */

import assert from 'node:assert/strict';
import cheddarData from '@cheddar-logic/data';
// @ts-expect-error -- JS module lacks type declarations
import db from '../../../packages/data/src/db.js';
// @ts-expect-error -- JS module lacks type declarations
import { setupIsolatedTestDb } from './db-test-runtime.js';

const { closeReadOnlyInstance, getDatabaseReadOnly } = cheddarData;

await import('tsx/esm');

const {
  queryResultsReportingData,
  RESULTS_UNDISPLAYED_SETTLED_BUCKET,
  RESULTS_UNDISPLAYED_SETTLED_REASON,
} = await import('../lib/results/query-layer.ts');

const TEST_PREFIX = 'wi-1238-results-diag';

function insertGame(client, { gameId, sport, createdAt }) {
  client
    .prepare(
      `INSERT INTO games
       (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-row`, sport, gameId, 'Home Team', 'Away Team',
      createdAt, 'final', createdAt, createdAt,
    );
}

function insertGameResult(client, { gameId, sport, settledAt }) {
  client
    .prepare(
      `INSERT INTO game_results
       (id, game_id, sport, final_score_home, final_score_away, status, result_source, settled_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `${gameId}-result`, gameId, sport, 4, 3, 'final', 'manual',
      settledAt, settledAt, settledAt,
    );
}

function insertDisplayedSettledCard(client, { gameId, cardId, createdAt }) {
  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId, gameId, 'nba', 'nba-model-output', 'Displayed result row', createdAt,
      JSON.stringify({
        confidence_pct: 63,
        decision_basis: 'ODDS_BACKED',
        play: { decision_v2: { official_status: 'PLAY' }, period: 'FULL_GAME' },
        recommended_bet_type: 'moneyline',
        market_type: 'moneyline',
        selection: 'HOME',
        locked_price: -110,
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
      cardId, `${TEST_PREFIX}-run`, gameId, 'NBA', 'moneyline', 'HOME',
      null, -110, 63, createdAt, '/api/cards',
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
      `${cardId}-result`, cardId, gameId, 'nba', 'nba-model-output', 'moneyline',
      'settled', 'win', createdAt, 1, null,
      `nba:${gameId}:moneyline:HOME`, 'moneyline', 'HOME', null, -110,
      createdAt, createdAt,
    );
}

function insertUndisplayedSettledCard(client, { gameId, cardId, createdAt }) {
  client
    .prepare(
      `INSERT INTO card_payloads
       (id, game_id, sport, card_type, card_title, created_at, payload_data, run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      cardId, gameId, 'nba', 'nba-model-output', 'Hidden settled row', createdAt,
      JSON.stringify({
        confidence_pct: 58,
        decision_basis: 'ODDS_BACKED',
        play: { decision_v2: { official_status: 'LEAN' }, period: 'FULL_GAME' },
        recommended_bet_type: 'moneyline',
        market_type: 'moneyline',
        selection: 'AWAY',
        locked_price: 105,
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
      `${cardId}-result`, cardId, gameId, 'nba', 'nba-model-output', 'moneyline',
      'settled', 'loss', createdAt, -1, null,
      `nba:${gameId}:moneyline:AWAY`, 'moneyline', 'AWAY', null, 105,
      createdAt, createdAt,
    );
}

async function run() {
  const runtime = await setupIsolatedTestDb('wi-1238-results-diag');
  let readOnlyDb = null;

  try {
    const client = db.getDatabase();
    const createdAt = '2026-05-03T18:00:00.000Z';

    const displayedGameId = `${TEST_PREFIX}-displayed-game`;
    const displayedCardId = `${TEST_PREFIX}-displayed-card`;
    insertGame(client, {
      gameId: displayedGameId,
      sport: 'nba',
      createdAt,
    });
    insertDisplayedSettledCard(client, {
      gameId: displayedGameId,
      cardId: displayedCardId,
      createdAt,
    });
    insertGameResult(client, {
      gameId: displayedGameId,
      sport: 'nba',
      settledAt: createdAt,
    });

    const hiddenGameId = `${TEST_PREFIX}-hidden-game`;
    const hiddenCardId = `${TEST_PREFIX}-hidden-card`;
    insertGame(client, {
      gameId: hiddenGameId,
      sport: 'nba',
      createdAt,
    });
    insertUndisplayedSettledCard(client, {
      gameId: hiddenGameId,
      cardId: hiddenCardId,
      createdAt,
    });
    insertGameResult(client, {
      gameId: hiddenGameId,
      sport: 'nba',
      settledAt: createdAt,
    });

    readOnlyDb = getDatabaseReadOnly();
    const queryData = queryResultsReportingData(
      readOnlyDb,
      {
        limit: 50,
        sport: 'NBA',
        cardCategory: null,
        minConfidence: null,
        market: null,
        includeOrphaned: false,
        dedupe: true,
        diagnosticsEnabled: true,
        includeProjectionSummaries: false,
        includeLedger: false,
      },
      [],
    );

    assert.equal(queryData.meta.totalSettled, 2, 'both settled rows must be counted');
    assert.equal(queryData.meta.withPayloadSettled, 1, 'only display-log-backed rows count as surfaced');
    assert.equal(queryData.meta.orphanedSettled, 1, 'the hidden settled row must remain orphaned');
    assert.deepEqual(queryData.dedupedIds, [`${displayedCardId}-result`], 'only displayed rows may enter the official result set');
    assert.equal(queryData.actionableRows.length, 1, 'official actionable rows must exclude hidden settled rows');

    assert.ok(queryData.meta.undisplayedSettled, 'diagnostics must expose the explicit hidden-row contract');
    assert.equal(
      queryData.meta.undisplayedSettled.bucket,
      RESULTS_UNDISPLAYED_SETTLED_BUCKET,
      'diagnostics must use the shared DISPLAY_LOG_NOT_ENROLLED bucket',
    );
    assert.equal(
      queryData.meta.undisplayedSettled.reason,
      RESULTS_UNDISPLAYED_SETTLED_REASON,
      'diagnostics must explain why the hidden row stays out of /results',
    );
    assert.equal(queryData.meta.undisplayedSettled.count, 1, 'diagnostics count must match orphanedSettled');
    assert.deepEqual(
      queryData.meta.undisplayedSettled.samples,
      [
        {
          resultId: `${hiddenCardId}-result`,
          cardId: hiddenCardId,
          gameId: hiddenGameId,
          sport: 'nba',
          cardType: 'nba-model-output',
          result: 'loss',
          settledAt: createdAt,
        },
      ],
      'diagnostics must sample the hidden settled row without widening official inclusion',
    );

    console.log('results-orphaned-display-log-diagnostics: all assertions passed');
  } finally {
    if (readOnlyDb) {
      closeReadOnlyInstance(readOnlyDb);
    }
    runtime.cleanup();
  }
}

await run();
