#!/usr/bin/env node
/**
 * Verify database has data after seeding
 */
const { initDb, getDatabase, closeDatabase } = require('./db.js');

async function verify() {
  await initDb();
  const db = getDatabase();

  const stats = {
    games: db.prepare('SELECT COUNT(*) as c FROM games').get().c,
    futureGames: db.prepare('SELECT COUNT(*) as c FROM games WHERE game_time_utc >= datetime("now")').get().c,
    cards: db.prepare('SELECT COUNT(*) as c FROM card_payloads').get().c,
    odds: db.prepare('SELECT COUNT(*) as c FROM odds_snapshots').get().c,
  };

  console.log('\n📊 Database Verification:');
  console.log(`  Games: ${stats.games} (${stats.futureGames} future)`);
  console.log(`  Card Payloads: ${stats.cards}`);
  console.log(`  Odds Snapshots: ${stats.odds}`);

  if (stats.games === 0) {
    console.error('\n❌ ERROR: No games in database!');
    process.exit(1);
  }

  if (stats.futureGames === 0) {
    console.error('\n❌ ERROR: No future games!');
    process.exit(1);
  }

  if (stats.cards === 0) {
    console.error('\n❌ ERROR: No card payloads!');
    process.exit(1);
  }

  console.log('\n✅ Database verification passed!\n');
  closeDatabase();
}

if (require.main === module) {
  verify().catch(err => {
    console.error('❌ Verification failed:', err.message);
    process.exit(1);
  });
}

module.exports = { verify };
