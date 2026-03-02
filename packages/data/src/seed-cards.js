/**
 * Seed Card Payloads
 * 
 * Creates card payloads for existing games so /cards page displays data
 */

const { v4: uuidV4 } = require('uuid');
const { initDb, getDatabase, closeDatabase } = require('./db.js');

async function seedCards() {
  await initDb();
  const db = getDatabase();

  const now = new Date();
  const createdAt = now.toISOString();

  // Get all games from the database
  const gameStmt = db.prepare('SELECT game_id, sport, home_team, away_team FROM games LIMIT 20');
  const games = gameStmt.all();

  if (games.length === 0) {
    console.log('[SeedCards] ℹ️  No games found. Run seed:test-odds first.');
    closeDatabase();
    return;
  }

  console.log(`[SeedCards] Inserting cards for ${games.length} games...`);

  const cardTypes = ['nhl_moneyline', 'nba_spread', 'soccer_total', 'ncaam_moneyline'];
  const predictions = ['HOME', 'AWAY', 'OVER', 'UNDER'];
  const tiers = ['SUPER', 'BEST', 'WATCH', null];

  let inserted = 0;

  for (const game of games) {
    // Create 2-3 cards per game
    const numCards = Math.floor(Math.random() * 2) + 2;

    for (let i = 0; i < numCards; i++) {
      const cardType = cardTypes[Math.floor(Math.random() * cardTypes.length)];
      const prediction = predictions[Math.floor(Math.random() * predictions.length)];
      const tier = tiers[Math.floor(Math.random() * tiers.length)];
      const confidence = Math.round(Math.random() * 100) / 100;

      const payloadData = {
        prediction,
        recommended_bet_type: cardType.includes('spread') ? 'spread' : cardType.includes('total') ? 'total' : 'moneyline',
        confidence,
        tier,
        ev_passed: Math.random() > 0.3,
        reasoning: `Test card for ${game.home_team} vs ${game.away_team}`,
        driver: {
          key: `driver_${Math.floor(Math.random() * 5) + 1}`,
          inputs: {
            projected_total: Math.round(Math.random() * 100) / 10,
            edge: Math.round(Math.random() * 50) / 100,
          }
        },
        projection: {
          total: Math.round(Math.random() * 100) / 10
        },
        edge: Math.round(Math.random() * 50) / 100
      };

      const insertStmt = db.prepare(`
        INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, payload_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        `card-${uuidV4()}`,
        game.game_id,
        game.sport,
        cardType,
        `${game.sport} ${cardType}`,
        JSON.stringify(payloadData),
        createdAt
      );

      inserted++;
    }
  }

  console.log(`[SeedCards] ✅ Inserted ${inserted} cards`);
  closeDatabase();
}

if (require.main === module) {
  seedCards()
    .then(() => {
      console.log('[SeedCards] Done');
      process.exit(0);
    })
    .catch(err => {
      console.error('[SeedCards] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { seedCards };
