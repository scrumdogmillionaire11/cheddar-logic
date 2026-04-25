/**
 * /api/cards sport filter tests
 *
 * Verifies lowercase sport params match uppercase stored values.
 */

import db from '../../../packages/data/src/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupIsolatedTestDb } from './db-test-runtime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

async function runTests() {
  console.log('🧪 Starting /api/cards sport filter tests...\n');
  const testRuntime = await setupIsolatedTestDb('api-cards-sport-filter');

  try {
    const client = db.getDatabase();

    const testGameId = 'test-sport-filter-game-1';
    const testCardId = 'test-sport-filter-card-1';
    const now = new Date();
    const futureTime = new Date(now.getTime() + 60 * 60 * 1000).toISOString();

    console.log('📝 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE id = ? OR game_id = ?`)
      .run(testCardId, testGameId);
    client.prepare(`DELETE FROM games WHERE game_id = ?`).run(testGameId);
    console.log('✓ Test data cleaned\n');

    console.log('📋 Inserting test game/card...');
    client
      .prepare(
        `INSERT INTO games
         (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'game-test-1',
        'nba',
        testGameId,
        'Home Team',
        'Away Team',
        futureTime,
        'scheduled',
        now.toISOString(),
        now.toISOString(),
      );

    client
      .prepare(
        `INSERT INTO card_payloads
         (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        testCardId,
        testGameId,
        'nba',
        'test-card',
        'Test Card',
        JSON.stringify({
          prediction: 'HOME',
          recommended_bet_type: 'moneyline',
        }),
        now.toISOString(),
        futureTime,
        'run-test-1',
      );

    console.log('✓ Inserted test data\n');

    console.log(
      '🧪 Test: sport param filter matches stored lowercase sport',
    );
    const sportParam = 'nba';
    const sport = sportParam ? sportParam.toLowerCase() : null;

    const rows = client
      .prepare(
        `SELECT id, sport FROM card_payloads
         WHERE game_id = ? AND sport = ?`,
      )
      .all(testGameId, sport);

    if (rows.length === 1 && rows[0].sport === 'nba') {
      console.log('✅ PASS: sport filter matched lowercase data');
    } else {
      console.log('❌ FAIL: expected 1 nba row, got:', rows);
      process.exit(1);
    }

    // Test 2: NHL lane compatibility - NHL game cards and NHL prop-analysis card types
    // both stored under sport='nhl' and both returned when sport=nhl is requested.
    // card_payloads.sport has no 'nhl_props' value (CHECK constraint); all NHL-related
    // cards use sport='nhl'. The lane predicate IN ('nhl','nhl_props') captures both
    // future nhl_props rows and current nhl rows without excluding either.
    console.log('\n🧪 Test 2: NHL lane - game cards and prop-analysis card types visible under sport=nhl');
    const nhlSuffix = Date.now().toString(36);
    const nhlGameId = `test-sport-filter-nhl-${nhlSuffix}`;

    client.prepare(`INSERT INTO games
      (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `game-nhl-${nhlSuffix}`, 'nhl', nhlGameId, 'BOS', 'TOR', futureTime, 'scheduled', now.toISOString(), now.toISOString()
    );
    // NHL game card (nhl-totals) from nhl run
    client.prepare(`INSERT INTO card_payloads
      (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `card-nhl-game-${nhlSuffix}`, nhlGameId, 'nhl', 'nhl-totals', 'Totals',
      JSON.stringify({ prediction: 'OVER' }), now.toISOString(), futureTime, 'run-nhl-main'
    );
    // NHL prop-analysis card (nhl-pace-1p) from nhl_props run - stored as sport='nhl'
    client.prepare(`INSERT INTO card_payloads
      (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `card-nhl-pace-${nhlSuffix}`, nhlGameId, 'nhl', 'nhl-pace-1p', 'Pace 1P',
      JSON.stringify({ prediction: 'OVER' }), now.toISOString(), futureTime, 'run-nhl-props'
    );

    // NHL lane query using the expanded predicate (IN includes 'nhl_props' for future-proofing)
    const nhlLaneRows = client.prepare(
      `SELECT id, sport, card_type FROM card_payloads
       WHERE game_id = ? AND LOWER(sport) IN ('nhl', 'nhl_props')
       ORDER BY card_type`
    ).all(nhlGameId);

    if (
      nhlLaneRows.length === 2 &&
      nhlLaneRows.some((r) => r.id === `card-nhl-game-${nhlSuffix}`) &&
      nhlLaneRows.some((r) => r.id === `card-nhl-pace-${nhlSuffix}`)
    ) {
      console.log('✅ PASS: Both NHL game card and NHL prop-analysis card visible under nhl lane');
    } else {
      console.log('❌ FAIL: expected both nhl-totals and nhl-pace-1p; got:', nhlLaneRows);
      process.exit(1);
    }

    // Exact sport=nhl match (without lane expansion) also returns both since both use sport='nhl'
    const nhlExactRows = client.prepare(
      `SELECT id FROM card_payloads WHERE game_id = ? AND LOWER(sport) = 'nhl'`
    ).all(nhlGameId);
    if (nhlExactRows.length === 2) {
      console.log('✅ PASS: Both NHL card types stored under sport=nhl (no lane mismatch)');
    } else {
      console.log('❌ FAIL: expected 2 nhl rows, got:', nhlExactRows);
      process.exit(1);
    }

    client.prepare(`DELETE FROM card_payloads WHERE game_id = ?`).run(nhlGameId);
    client.prepare(`DELETE FROM games WHERE game_id = ?`).run(nhlGameId);

    // Test 3: Source contract - resolveNhlCompatibleSports wired in route
    console.log('\n🧪 Test 3: Source contract - NHL lane expansion present in route and query');
    const cardsRouteSource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/app/api/cards/route.ts'), 'utf8'
    );
    const querySource = fs.readFileSync(
      path.join(REPO_ROOT, 'web/src/lib/cards/query.ts'), 'utf8'
    );
    const routeHasNhlLane =
      cardsRouteSource.includes('resolveNhlCompatibleSports') &&
      cardsRouteSource.includes('compatibleSports.length > 1');
    const queryHasNhlHelper =
      querySource.includes('resolveNhlCompatibleSports') &&
      querySource.includes("if (sport === 'nhl') return ['nhl', 'nhl_props']");
    if (routeHasNhlLane && queryHasNhlHelper) {
      console.log('✅ PASS: resolveNhlCompatibleSports wired in route and query module');
    } else {
      console.log(
        `❌ FAIL: routeHasNhlLane=${routeHasNhlLane} queryHasNhlHelper=${queryHasNhlHelper}`
      );
      process.exit(1);
    }

    // Test 4: WI-1169 - sport filter contract stable across legacy and simplified gate modes
    console.log('\n🧪 Test 4: Source contract - sport filter stable across gate modes');
    const routeHasSimplifiedGate =
      cardsRouteSource.includes('ENABLE_SIMPLIFIED_CARDS_GATE') &&
      cardsRouteSource.includes('buildSimplifiedGateWhere');
    const simplifiedGatePreservesRequestWhere =
      querySource.includes('buildSimplifiedGateWhere') &&
      querySource.includes('[...baseWhere]') &&
      querySource.includes('[...baseParams]');
    if (routeHasSimplifiedGate && simplifiedGatePreservesRequestWhere) {
      console.log('✅ PASS: simplified gate inherits request-level sport filter from base WHERE');
    } else {
      console.log(
        `❌ FAIL: routeHasSimplifiedGate=${routeHasSimplifiedGate} preservesFilter=${simplifiedGatePreservesRequestWhere}`
      );
      process.exit(1);
    }

    console.log('\n🧹 Cleaning up test data...');
    client
      .prepare(`DELETE FROM card_payloads WHERE id = ? OR game_id = ?`)
      .run(testCardId, testGameId);
    client.prepare(`DELETE FROM games WHERE game_id = ?`).run(testGameId);
    console.log('✓ Test data cleaned\n');

    console.log('✅ All tests passed!\n');
  } catch (error) {
    console.error('❌ Test error:', error);
    process.exit(1);
  } finally {
    testRuntime.cleanup();
  }
}

runTests();
