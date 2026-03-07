#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Debug card insertion
 */
const { v4: uuidV4 } = require('uuid');
const { initDb, getDatabase, closeDatabase } = require('../../packages/data/src/db.js');

async function debugCardInsert() {
  await initDb();
  const db = getDatabase();

  const now = new Date();
  const createdAt = now.toISOString();

  // Get a future game without cards
  const game = db
    .prepare(`
    SELECT g.game_id, g.sport, g.home_team, g.away_team
    FROM games g
    LEFT JOIN card_payloads cp ON g.game_id = cp.game_id
      AND (cp.expires_at IS NULL OR cp.expires_at > datetime('now'))
    WHERE g.game_time_utc >= datetime('now')
      AND cp.id IS NULL
    LIMIT 1
  `)
    .get();

  if (!game) {
    console.log('No games found without cards');
    closeDatabase();
    return;
  }

  console.log(`\nFound game: ${game.game_id}`);
  console.log(`  ${game.sport}: ${game.away_team} @ ${game.home_team}\n`);

  const payloadData = {
    prediction: 'HOME',
    recommended_bet_type: 'moneyline',
    confidence: 0.75,
    tier: 'BEST',
    ev_passed: true,
    reasoning: 'Debug test card',
    driver: {
      key: 'test_driver',
      inputs: {
        projected_total: 5.5,
        edge: 0.15,
      },
    },
    projection: {
      total: 5.5,
    },
    edge: 0.15,
  };

  const cardId = `card-debug-${uuidV4()}`;

  try {
    const insertStmt = db.prepare(`
      INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, payload_data, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertStmt.run(
      cardId,
      game.game_id,
      game.sport,
      'debug_test',
      'Debug Test Card',
      JSON.stringify(payloadData),
      createdAt,
    );

    console.log(`✅ Inserted card: ${cardId}`);
    console.log(`   Changes: ${result.changes}`);
    console.log(`   Last insert row ID: ${result.lastInsertRowid}`);

    // Verify it was inserted
    const verify = db
      .prepare('SELECT COUNT(*) as count FROM card_payloads WHERE id = ?')
      .get(cardId);
    console.log(`\n✓ Verification: ${verify.count} card(s) found\n`);
  } catch (error) {
    console.error('❌ Error inserting card:', error.message);
    console.error('   Stack:', error.stack);
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  debugCardInsert().catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { debugCardInsert };
