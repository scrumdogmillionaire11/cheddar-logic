/**
 * Seed Card Payloads
 * 
 * Creates card payloads for existing games so /cards page displays data
 */

const path = require('path');
const { v4: uuidV4 } = require('uuid');

require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env')
});

const {getDatabase, closeDatabase } = require('./db.js');

async function seedCards() {
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

  // Sport-specific card type templates
  const cardTypesBySport = {
    'NHL': ['nhl-goalie', 'nhl-special-teams', 'nhl-shot-environment', 'nhl-pace-totals', 'nhl-rest-advantage'],
    'NBA': ['nba-base-projection', 'nba-pace-1p', 'nba-matchup-style', 'nba-rest-advantage', 'nba-blowout-risk'],
    'NCAAM': ['ncaam-base-projection', 'ncaam-matchup-style', 'ncaam-rest-advantage'],
    'SOCCER': ['soccer-base-projection', 'soccer-matchup'],
    'MLB': ['mlb-pitcher-matchup', 'mlb-bullpen'],
    'NFL': ['nfl-qb-matchup', 'nfl-defense-matchup']
  };

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
    `).get(game.game_id);

    if (existingCards.count > 0) {
      skipped++;
      continue;
    }

    // Get sport-specific card types, fallback to generic if sport not found
    const sportCardTypes = cardTypesBySport[game.sport] || [`${game.sport.toLowerCase()}-generic`];

    // Create 2-4 cards per game
    const numCards = Math.floor(Math.random() * 3) + 2;

    for (let i = 0; i < numCards; i++) {
      const cardType = sportCardTypes[Math.floor(Math.random() * sportCardTypes.length)];
      const prediction = predictions[Math.floor(Math.random() * predictions.length)];
      const tier = tiers[Math.floor(Math.random() * tiers.length)];
      const confidence = Math.round(Math.random() * 100) / 100;

      // Determine recommended bet type based on card type and prediction
      let recommendedBetType = 'moneyline';
      if (cardType.includes('spread') || cardType.includes('matchup')) {
        recommendedBetType = 'spread';
      } else if (cardType.includes('total') || cardType.includes('pace') || cardType.includes('projection')) {
        recommendedBetType = prediction === 'OVER' || prediction === 'UNDER' ? 'total' : 'moneyline';
      }

      const payloadData = {
        prediction,
        recommended_bet_type: recommendedBetType,
        confidence,
        confidence_pct: confidence * 100,
        tier,
        ev_passed: Math.random() > 0.3,
        reasoning: `${cardType} analysis for ${game.away_team} @ ${game.home_team}`,
        recommendation: {
          type: prediction === 'HOME' ? 'ML_HOME' : prediction === 'AWAY' ? 'ML_AWAY' : prediction === 'OVER' ? 'TOTAL_OVER' : prediction === 'UNDER' ? 'TOTAL_UNDER' : 'PASS',
          text: `${tier || 'PASS'} rating - ${(confidence * 100).toFixed(0)}% confidence`
        },
        odds_context: {
          h2h_home: -110 + Math.floor(Math.random() * 40),
          h2h_away: -110 + Math.floor(Math.random() * 40),
          total: 5.5 + Math.random() * 2,
          captured_at: createdAt
        },
        driver: {
          key: cardType,
          inputs: {
            projected_total: Math.round((Math.random() * 10 + 2) * 10) / 10,
            edge: Math.round(Math.random() * 20) / 100,
          }
        },
        projection: {
          total: Math.round((Math.random() * 10 + 2) * 10) / 10
        },
        edge: Math.round(Math.random() * 20) / 100
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
        `${game.sport} ${cardType.replace(/-/g, ' ')}`,
        JSON.stringify(payloadData),
        createdAt
      );

      if (result.changes > 0) {
        inserted++;
      }
    }
  }

  console.log(`[SeedCards] ✅ Inserted ${inserted} new cards, skipped ${skipped} games with existing cards`);
  console.log(`[SeedCards] Games by sport:`, 
    games.reduce((acc, g) => {
      acc[g.sport] = (acc[g.sport] || 0) + 1;
      return acc;
    }, {})
  );
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
