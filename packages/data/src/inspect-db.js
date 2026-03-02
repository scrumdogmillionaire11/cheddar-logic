#!/usr/bin/env node
/**
 * Inspect database contents
 */
const { initDb, getDatabase, closeDatabase } = require('./db.js');

async function inspectDb() {
  await initDb();
  const db = getDatabase();

  console.log('\n📊 Database Inspection Report\n');
  console.log('=' .repeat(50));

  try {
    // Check games
    const gamesCount = db.prepare('SELECT COUNT(*) as count FROM games').get();
    console.log(`\n🎮 Games: ${gamesCount.count}`);
    
    if (gamesCount.count > 0) {
      const sampleGames = db.prepare('SELECT game_id, sport, home_team, away_team, game_time_utc FROM games LIMIT 3').all();
      console.log('Sample games:');
      sampleGames.forEach(g => {
        console.log(`  - ${g.game_id}: ${g.sport} ${g.away_team} @ ${g.home_team} at ${g.game_time_utc}`);
      });
    }

    // Check card_payloads
    const cardsCount = db.prepare('SELECT COUNT(*) as count FROM card_payloads').get();
    console.log(`\n🃏 Card Payloads: ${cardsCount.count}`);
    
    if (cardsCount.count > 0) {
      const sampleCards = db.prepare('SELECT id, game_id, card_type, sport FROM card_payloads LIMIT 3').all();
      console.log('Sample cards:');
      sampleCards.forEach(c => {
        console.log(`  - ${c.id}: ${c.card_type} for ${c.game_id}`);
      });
    }

    // Check card_results
    const resultsCount = db.prepare('SELECT COUNT(*) as count FROM card_results').get();
    console.log(`\n📈 Card Results: ${resultsCount.count}`);

    // Check odds_snapshots
    const oddsCount = db.prepare('SELECT COUNT(*) as count FROM odds_snapshots').get();
    console.log(`\n💰 Odds Snapshots: ${oddsCount.count}`);

    console.log('\n' + '='.repeat(50));
    console.log('\n✅ Inspection complete\n');

  } catch (error) {
    console.error('❌ Error inspecting database:', error.message);
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  inspectDb().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { inspectDb };
