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

  // Get future games from the database (prioritize upcoming games)
  const gameStmt = db.prepare(`
    SELECT game_id, sport, home_team, away_team, game_time_utc
    FROM games
    WHERE game_time_utc >= datetime('now')
    ORDER BY game_time_utc ASC
    LIMIT 100
  `);
  const games = gameStmt.all();

  if (games.length === 0) {
    console.log('[SeedCards] ℹ️  No future games found. Trying all games...');
    const allGamesStmt = db.prepare('SELECT game_id, sport, home_team, away_team, game_time_utc FROM games LIMIT 50');
    const allGames = allGamesStmt.all();
    
    if (allGames.length === 0) {
      console.log('[SeedCards] ℹ️  No games found. Run seed:test-odds first.');
      closeDatabase();
      return;
    }
    games.push(...allGames);
  }

  console.log(`[SeedCards] Inserting cards for ${games.length} games (${games.filter(g => g.game_time_utc >= now.toISOString()).length} future)...`);

  const cardTypes = ['nhl_moneyline', 'nba_spread', 'soccer_total', 'ncaam_moneyline'];
  const predictions = ['HOME', 'AWAY', 'OVER', 'UNDER'];
  const tiers = ['SUPER', 'BEST', 'WATCH', null];

  let inserted = 0;
  let skipped = 0;

  for (const game of games) {
    // Check if game already has cards
    const existingCards = db.prepare(`
      SELECT COUNT(*) as count
      FROM card_payloads
      WHERE game_id = ?
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(game.game_id);

    if (existingCards.count > 0) {
      skipped++;
      continue;
    }

    // Create 2-4 cards per game
    const numCards = Math.floor(Math.random() * 3) + 2;

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
        INSERT OR IGNORE INTO card_payloads (id, game_id, sport, card_type, card_title, payload_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const result = insertStmt.run(
        `card-seed-${uuidV4()}`,
        game.game_id,
        game.sport,
        cardType,
        `${game.sport} ${cardType}`,
        JSON.stringify(payloadData),
        createdAt
      );

      if (result.changes > 0) {
        inserted++;
      }
    }
  }

  console.log(`[SeedCards] ✅ Inserted ${inserted} new cards, skipped ${skipped} games with existing cards`);
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
