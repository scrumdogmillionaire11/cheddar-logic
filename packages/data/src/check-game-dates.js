#!/usr/bin/env node
/**
 * Check game dates in database
 */
const { initDb, getDatabase, closeDatabase } = require('./db.js');

async function checkGameDates() {
  await initDb();
  const db = getDatabase();

  console.log('\n📅 Game Date Analysis\n');
  console.log('=' .repeat(60));

  try {
    // Get date range
    const dateRange = db.prepare(`
      SELECT 
        MIN(game_time_utc) as earliest,
        MAX(game_time_utc) as latest,
        COUNT(*) as total
      FROM games
    `).get();

    console.log(`\nTotal games: ${dateRange.total}`);
    console.log(`Earliest game: ${dateRange.earliest}`);
    console.log(`Latest game: ${dateRange.latest}`);

    // Get games by date
    const gamesByDate = db.prepare(`
      SELECT 
        DATE(game_time_utc) as game_date,
        COUNT(*) as count
      FROM games
      GROUP BY DATE(game_time_utc)
      ORDER BY game_date DESC
      LIMIT 10
    `).all();

    console.log('\nGames by date (last 10 dates):');
    gamesByDate.forEach(row => {
      console.log(`  ${row.game_date}: ${row.count} games`);
    });

    // Check if any games are in the future
    const now = new Date().toISOString();
    const futureGames = db.prepare(`
      SELECT COUNT(*) as count
      FROM games
      WHERE game_time_utc >= ?
    `).get(now);

    console.log(`\n⏰ Current time: ${now}`);
    console.log(`🔮 Games in future: ${futureGames.count}`);

    // Get next few games
    const nextGames = db.prepare(`
      SELECT game_id, sport, home_team, away_team, game_time_utc
      FROM games
      ORDER BY game_time_utc DESC
      LIMIT 5
    `).all();

    console.log('\n🎮 Most recent games:');
    nextGames.forEach(g => {
      console.log(`  ${g.game_time_utc}: ${g.sport} ${g.away_team} @ ${g.home_team}`);
    });

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Analysis complete\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  checkGameDates().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { checkGameDates };
