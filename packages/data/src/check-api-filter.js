#!/usr/bin/env node
const { initDb, getDatabase, closeDatabase } = require('./db.js');

async function checkApiFilter() {
  await initDb();
  const db = getDatabase();
  
  const now = new Date();
  const etDateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  const tzPart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(now).find(p => p.type === 'timeZoneName').value;
  const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
  const sign = offsetHours < 0 ? '-' : '+';
  const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
  const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
  const todayUtc = localMidnight.toISOString().substring(0, 19).replace('T', ' ');
  
  console.log('\n🔍 API Filter Analysis');
  console.log('='.repeat(60));
  console.log(`Current time: ${now.toISOString()}`);
  console.log(`ET midnight (UTC): ${todayUtc}`);
  console.log('');
  
  const gamesAfterMidnight = db.prepare(`
    SELECT sport, COUNT(*) as count, 
           MIN(game_time_utc) as earliest, 
           MAX(game_time_utc) as latest
    FROM games
    WHERE datetime(game_time_utc) >= ?
    GROUP BY sport
    ORDER BY sport
  `).all(todayUtc);
  
  console.log('Games after midnight ET (what /api/games returns):');
  if (gamesAfterMidnight.length === 0) {
    console.log('  ⚠️  NO GAMES FOUND!');
    console.log('\n  This means all games are in the past.');
    console.log('  Run: npm run seed:test-odds to create fresh games');
  } else {
    gamesAfterMidnight.forEach(s => {
      console.log(`  ${s.sport}: ${s.count} games`);
      console.log(`    └─ ${s.earliest} to ${s.latest}`);
    });
  }
  
  // Check all games
  console.log('\n📊 All games in database:');
  const allGames = db.prepare(`
    SELECT sport, COUNT(*) as count
    FROM games
    GROUP BY sport
    ORDER BY sport
  `).all();
  
  allGames.forEach(s => {
    console.log(`  ${s.sport}: ${s.count} games`);
  });
  
  // Check cards for games after midnight
  console.log('\n🃏 Cards for future games by sport:');
  const cardsBySport = db.prepare(`
    SELECT g.sport, COUNT(DISTINCT cp.id) as card_count, COUNT(DISTINCT g.game_id) as game_count
    FROM games g
    LEFT JOIN card_payloads cp ON g.game_id = cp.game_id
      AND (cp.expires_at IS NULL OR cp.expires_at > datetime('now'))
    WHERE datetime(g.game_time_utc) >= ?
    GROUP BY g.sport
    ORDER BY g.sport
  `).all(todayUtc);
  
  cardsBySport.forEach(s => {
    console.log(`  ${s.sport}: ${s.game_count} games, ${s.card_count} cards`);
  });
  
  console.log('\n' + '='.repeat(60) + '\n');
  
  closeDatabase();
}

checkApiFilter().catch(console.error);
