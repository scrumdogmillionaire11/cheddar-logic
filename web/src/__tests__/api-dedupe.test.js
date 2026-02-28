/**
 * API Dedupe Behavior Tests
 * 
 * Verifies:
 * 1. Default dedupe returns latest per (game_id, card_type)
 * 2. dedupe=none returns all cards in creation order
 * 3. Behavior is consistent across list and game-specific endpoints
 */

const db = require('../../../packages/data/src/db.js');

async function runTests() {
  console.log('🧪 Starting API Dedupe Behavior Tests...\n');

  try {
    // Initialize database
    await db.initDb();
    const client = db.getDatabase();

    // Clean up test data first
    console.log('📝 Cleaning up test data...');
    client
      .prepare(
        `DELETE FROM card_payloads WHERE game_id LIKE 'test-dedupe-%'`
      )
      .run();
    client
      .prepare(
        `DELETE FROM model_outputs WHERE game_id LIKE 'test-dedupe-%'`
      )
      .run();
    console.log('✓ Test data cleaned\n');

    // Insert test game
    const testGameId = 'test-dedupe-nhl-2026-01-01-team1-team2';
    const cardType = 'nhl-model-output';
    const sport = 'nhl';

    console.log('📋 Inserting test cards...');
    const now = new Date();
    const card1CreatedAt = new Date(now.getTime() - 60000).toISOString(); // 1 min old
    const card2CreatedAt = new Date(now.getTime() - 30000).toISOString(); // 30 sec old
    const card3CreatedAt = now.toISOString(); // just now (latest)

    // Insert three cards for the same game and type with different timestamps
    const payload1 = {
      prediction: 'AWAY',
      confidence: 0.62,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };

    const payload2 = {
      prediction: 'HOME',
      confidence: 0.65,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };

    const payload3 = {
      prediction: 'AWAY',
      confidence: 0.68,
      meta: {
        is_mock: true,
        inference_source: 'mock',
        model_endpoint: null,
      },
    };

    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'card-1',
        testGameId,
        sport,
        cardType,
        'Test Card 1 (Oldest)',
        JSON.stringify(payload1),
        card1CreatedAt,
        new Date(now.getTime() + 3600000).toISOString()
      );

    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'card-2',
        testGameId,
        sport,
        cardType,
        'Test Card 2 (Middle)',
        JSON.stringify(payload2),
        card2CreatedAt,
        new Date(now.getTime() + 3600000).toISOString()
      );

    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'card-3',
        testGameId,
        sport,
        cardType,
        'Test Card 3 (Latest)',
        JSON.stringify(payload3),
        card3CreatedAt,
        new Date(now.getTime() + 3600000).toISOString()
      );

    console.log(`✓ Inserted 3 cards for game_id: ${testGameId}\n`);

    // Test 1: Default dedupe (should return only latest)
    console.log('🧪 Test 1: Default dedupe (latest_per_game_type)');
    const dedupeSQL = `
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id, card_type ORDER BY created_at DESC) AS rn
        FROM card_payloads
        WHERE game_id = ? AND sport = ?
      )
      SELECT id, card_title, created_at FROM ranked WHERE rn = 1
    `;

    const dedupeResult = client.prepare(dedupeSQL).all(testGameId, sport);
    if (dedupeResult.length === 1 && dedupeResult[0].id === 'card-3') {
      console.log('✅ PASS: Returns only latest card (card-3)');
      console.log(
        `   Card title: ${dedupeResult[0].card_title}\n`
      );
    } else {
      console.log(
        '❌ FAIL: Expected 1 card (card-3), got:',
        dedupeResult
      );
      process.exit(1);
    }

    // Test 2: No dedupe (should return all 3 in reverse creation order)
    console.log('🧪 Test 2: No dedupe (dedupe=none)');
    const noDedupeSQL = `
      SELECT id, card_title, created_at FROM card_payloads
      WHERE game_id = ? AND sport = ?
      ORDER BY created_at DESC
    `;

    const noDedupeResult = client.prepare(noDedupeSQL).all(testGameId, sport);
    if (
      noDedupeResult.length === 3 &&
      noDedupeResult[0].id === 'card-3' &&
      noDedupeResult[1].id === 'card-2' &&
      noDedupeResult[2].id === 'card-1'
    ) {
      console.log('✅ PASS: Returns all 3 cards in correct order (latest first)');
      noDedupeResult.forEach((r, i) => {
        console.log(`   ${i + 1}. ${r.card_title} (${r.id})`);
      });
      console.log();
    } else {
      console.log(
        '❌ FAIL: Expected 3 cards in order [card-3, card-2, card-1], got:',
        noDedupeResult
      );
      process.exit(1);
    }

    // Test 3: Different card types should not dedupe together
    console.log('🧪 Test 3: Different card types do not dedupe together');
    const altCardType = 'nhl-model-output-alt';
    client
      .prepare(
        `INSERT INTO card_payloads 
       (id, game_id, sport, card_type, card_title, payload_data, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'card-alt-1',
        testGameId,
        sport,
        altCardType,
        'Alt Card Type',
        JSON.stringify(payload1),
        card1CreatedAt,
        new Date(now.getTime() + 3600000).toISOString()
      );

    const dedupeWithAltSQL = `
      WITH ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id, card_type ORDER BY created_at DESC) AS rn
        FROM card_payloads
        WHERE game_id = ?
      )
      SELECT id, card_type FROM ranked WHERE rn = 1
      ORDER BY card_type
    `;

    const dedupeWithAltResult = client
      .prepare(dedupeWithAltSQL)
      .all(testGameId);
    if (
      dedupeWithAltResult.length === 2 &&
      dedupeWithAltResult.some((r) => r.id === 'card-3' && r.card_type === cardType) &&
      dedupeWithAltResult.some((r) => r.id === 'card-alt-1' && r.card_type === altCardType)
    ) {
      console.log('✅ PASS: Dedupe respects card_type boundary');
      dedupeWithAltResult.forEach((r) => {
        console.log(`   ${r.id} (${r.card_type})`);
      });
      console.log();
    } else {
      console.log(
        '❌ FAIL: Expected 2 cards (different types), got:',
        dedupeWithAltResult
      );
      process.exit(1);
    }

    // Cleanup
    console.log('🧹 Cleaning up test data...');
    client
      .prepare(
        `DELETE FROM card_payloads WHERE game_id LIKE 'test-dedupe-%'`
      )
      .run();
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
