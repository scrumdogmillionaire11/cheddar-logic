#!/usr/bin/env node
/**
 * Check card coverage for future games
 */
const { initDb, getDatabase, closeDatabase } = require('./db.js');

async function checkCardCoverage() {
  await initDb();
  const db = getDatabase();

  console.log('\n🃏 Card Coverage Analysis\n');
  console.log('=' .repeat(60));

  try {
    const now = new Date().toISOString();

    // Get future games
    const futureGames = db.prepare(`
      SELECT COUNT(*) as count
      FROM games
      WHERE game_time_utc >= ?
    `).get(now);

    console.log(`\n🔮 Future games (after ${now}): ${futureGames.count}`);

    // Get future games WITH cards
    const gamesWithCards = db.prepare(`
      SELECT COUNT(DISTINCT g.game_id) as count
      FROM games g
      INNER JOIN card_payloads cp ON g.game_id = cp.game_id
      WHERE g.game_time_utc >= ?
        AND (cp.expires_at IS NULL OR cp.expires_at > datetime('now'))
    `).get(now);

    console.log(`🎴 Future games WITH cards: ${gamesWithCards.count}`);

    // Get sample future games with their cards
    const sampleGames = db.prepare(`
      SELECT 
        g.game_id,
        g.sport,
        g.home_team,
        g.away_team,
        g.game_time_utc,
        COUNT(cp.id) as card_count
      FROM games g
      LEFT JOIN card_payloads cp ON g.game_id = cp.game_id
        AND (cp.expires_at IS NULL OR cp.expires_at > datetime('now'))
      WHERE g.game_time_utc >= ?
      GROUP BY g.game_id
      ORDER BY g.game_time_utc ASC
      LIMIT 10
    `).all(now);

    console.log('\n📋 Sample future games:');
    sampleGames.forEach(g => {
      console.log(`  ${g.game_time_utc}: ${g.sport} ${g.away_team} @ ${g.home_team}`);
      console.log(`     └─ Cards: ${g.card_count}`);
    });

    // Check card expiration
    const expiredCards = db.prepare(`
      SELECT COUNT(*) as count
      FROM card_payloads
      WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')
    `).get();

    console.log(`\n⏰ Expired cards: ${expiredCards.count}`);

    // Check odds coverage
    const oddsStats = db.prepare(`
      SELECT 
        COUNT(DISTINCT g.game_id) as games_with_odds,
        COUNT(DISTINCT o.game_id) as distinct_game_ids
      FROM games g
      INNER JOIN odds_snapshots o ON g.game_id = o.game_id
      WHERE g.game_time_utc >= ?
    `).get(now);

    console.log(`\n💰 Future games with odds: ${oddsStats.games_with_odds}`);

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Analysis complete\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  checkCardCoverage().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { checkCardCoverage };
