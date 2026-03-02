#!/usr/bin/env node
/**
 * Test API endpoints locally
 */
const { initDb, getDatabase, closeDatabase } = require('./db.js');

function computeMidnightET() {
  const now = new Date();
  const etDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(now);
  
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName').value;
    
  const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
  const sign = offsetHours < 0 ? '-' : '+';
  const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
  const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
  const todayUtc = localMidnight.toISOString().substring(0, 19).replace('T', ' ');
  
  return { etDateStr, localMidnight, todayUtc };
}

async function testApiQuery() {
  await initDb();
  const db = getDatabase();

  console.log('\n🧪 API Query Test\n');
  console.log('=' .repeat(60));

  try {
    const now = new Date();
    const { etDateStr, localMidnight, todayUtc } = computeMidnightET();

    console.log(`\n⏰ Current time (UTC): ${now.toISOString()}`);
    console.log(`📅 ET date: ${etDateStr}`);
    console.log(`🌅 Midnight ET (UTC): ${localMidnight.toISOString()}`);
    console.log(`🔍 SQL filter value: ${todayUtc}`);

    // Test the same query as /api/games
    const sql = `
      WITH latest_odds AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at DESC) AS rn
        FROM odds_snapshots
      )
      SELECT
        g.id,
        g.game_id,
        g.sport,
        g.home_team,
        g.away_team,
        g.game_time_utc,
        g.status,
        g.created_at,
        o.h2h_home,
        o.h2h_away,
        o.total,
        o.spread_home,
        o.spread_away,
        o.captured_at AS odds_captured_at
      FROM games g
      LEFT JOIN latest_odds o ON o.game_id = g.game_id AND o.rn = 1
      WHERE datetime(g.game_time_utc) >= ?
      ORDER BY g.game_time_utc ASC
      LIMIT 10
    `;

    const games = db.prepare(sql).all(todayUtc);

    console.log(`\n🎮 Games returned: ${games.length}`);

    if (games.length > 0) {
      console.log('\n📋 First 5 games:');
      games.slice(0, 5).forEach(g => {
        console.log(`  ${g.game_time_utc}: ${g.sport} ${g.away_team} @ ${g.home_team}`);
        console.log(`     Odds: h2h=${g.h2h_home}/${g.h2h_away}, total=${g.total}`);
      });
    } else {
      console.log('\n⚠️  No games found!');
      
      // Check what games exist
      const allGames = db.prepare(`
        SELECT game_time_utc, sport, home_team, away_team
        FROM games
        ORDER BY game_time_utc DESC
        LIMIT 5
      `).all();
      
      console.log('\n📋 Latest games in DB:');
      allGames.forEach(g => {
        console.log(`  ${g.game_time_utc}: ${g.sport} ${g.away_team} @ ${g.home_team}`);
      });
    }

    // Test card payloads for first game
    if (games.length > 0) {
      const firstGame = games[0];
      const cards = db.prepare(`
        SELECT id, card_type, card_title
        FROM card_payloads
        WHERE game_id = ?
          AND (expires_at IS NULL OR expires_at > datetime('now'))
        ORDER BY created_at DESC
      `).all(firstGame.game_id);

      console.log(`\n🃏 Cards for game ${firstGame.game_id}: ${cards.length}`);
      cards.slice(0, 3).forEach(c => {
        console.log(`     ${c.card_type}: ${c.card_title}`);
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('\n✅ Test complete\n');

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    closeDatabase();
  }
}

if (require.main === module) {
  testApiQuery().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { testApiQuery };
