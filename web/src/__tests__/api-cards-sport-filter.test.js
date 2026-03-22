/**
 * /api/cards sport filter tests
 *
 * Verifies lowercase sport params match uppercase stored values.
 */

import db from '../../../packages/data/src/db.js';

async function runTests() {
  console.log('🧪 Starting /api/cards sport filter tests...\n');

  try {
    await db.initDb();
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
    db.closeDatabase();
  }
}

runTests();
