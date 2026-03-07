/**
 * Seed Dev Database with Test Games and Odds
 * 
 * Creates realistic test data for development/testing model runs
 * Usage: CHEDDAR_MIGRATIONS_DIR=... node apps/worker/src/jobs/__tests__/seed-dev-data.js
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const { withDb, upsertGame, insertOddsSnapshot } = require('@cheddar-logic/data');

async function seedDevData() {
  console.log('[Seed] Starting dev data population...');

  return withDb(async () => {
    const db = require('@cheddar-logic/data').getDatabase();
    
    // Check if data already exists
    const gameCount = db.prepare('SELECT COUNT(*) as c FROM games').get();
    if (gameCount.c > 5) {
      console.log(`[Seed] ✓ Database already populated with ${gameCount.c} games, skipping`);
      return { success: true, skipped: true, gameCount: gameCount.c };
    }

    const now = new Date();
    const todayMidnight = new Date(now);
    todayMidnight.setHours(0, 0, 0, 0);
    const tomorrow8pm = new Date(todayMidnight);
    tomorrow8pm.setDate(tomorrow8pm.getDate() + 1);
    tomorrow8pm.setHours(20, 30, 0, 0);
    
    const games = [
      {
        id: `game-${uuidV4()}`,
        sport: 'NBA',
        gameId: `nba-lal-bos-${now.toISOString().split('T')[0]}`,
        homeTeam: 'LAL',
        awayTeam: 'BOS',
        gameTimeUtc: tomorrow8pm.toISOString(),
        status: 'scheduled',
      },
      {
        id: `game-${uuidV4()}`,
        sport: 'NBA',
        gameId: `nba-gsw-lac-${now.toISOString().split('T')[0]}`,
        homeTeam: 'GSW',
        awayTeam: 'LAC',
        gameTimeUtc: new Date(tomorrow8pm.getTime() + 2 * 60 * 60 * 1000).toISOString(),
        status: 'scheduled',
      },
      {
        id: `game-${uuidV4()}`,
        sport: 'NHL',
        gameId: `nhl-nyr-njd-${now.toISOString().split('T')[0]}`,
        homeTeam: 'NJD',
        awayTeam: 'NYR',
        gameTimeUtc: new Date(tomorrow8pm.getTime() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'scheduled',
      },
      {
        id: `game-${uuidV4()}`,
        sport: 'NHL',
        gameId: `nhl-det-tor-${now.toISOString().split('T')[0]}`,
        homeTeam: 'TOR',
        awayTeam: 'DET',
        gameTimeUtc: new Date(tomorrow8pm.getTime() + 6 * 60 * 60 * 1000).toISOString(),
        status: 'scheduled',
      },
    ];

    let created = 0;
    for (const game of games) {
      try {
        upsertGame(game);
        console.log(`[Seed] ✓ Created game: ${game.sport} ${game.awayTeam} @ ${game.homeTeam}`);
        created++;

        // Create odds snapshot for this game
        const oddsSnapshot = {
          id: `odds-${uuidV4()}`,
          gameId: game.gameId,
          sport: game.sport,
          homeTeam: game.homeTeam,
          awayTeam: game.awayTeam,
          h2hHome: -110,
          h2hAway: -110,
          total: 215 + Math.random() * 20,
          spreadHome: -3.5 + Math.random() * 2,
          spreadAway: 3.5 - Math.random() * 2,
          spreadPriceHome: -110,
          spreadPriceAway: -110,
          totalPriceOver: -110,
          totalPriceUnder: -110,
          capturedAt: new Date().toISOString(),
          book: 'draftkings',
          rawData: {},
        };

        insertOddsSnapshot(oddsSnapshot);
        console.log(`[Seed]   ├─ Odds snapshot created (total ~${oddsSnapshot.total.toFixed(1)})`);
      } catch (error) {
        console.error(`[Seed] ✗ Failed to create game: ${error.message}`);
      }
    }

    const finalCount = db.prepare('SELECT COUNT(*) as c FROM games').get();
    const oddsCount = db.prepare('SELECT COUNT(*) as c FROM odds_snapshots').get();
    
    console.log(`[Seed] Complete: ${created} games created`);
    console.log(`[Seed] Total games in DB: ${finalCount.c}`);
    console.log(`[Seed] Total odds snapshots: ${oddsCount.c}`);

    return { 
      success: true, 
      created,
      totalGames: finalCount.c,
      totalOdds: oddsCount.c,
    };
  });
}

if (require.main === module) {
  seedDevData()
    .then(result => {
      console.log('[Seed] Result:', JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('[Seed] Error:', err.message);
      process.exit(1);
    });
}

module.exports = { seedDevData };
