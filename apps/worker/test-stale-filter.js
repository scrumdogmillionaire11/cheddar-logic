/**
 * Test script to verify getOddsWithUpcomingGames filters stale data correctly
 */
const { initDb, getOddsWithUpcomingGames, getOddsSnapshots } = require('@cheddar-logic/data');
const { DateTime } = require('luxon');

(async () => {
  await initDb();
  const nowUtc = DateTime.utc().toISO();
  
  console.log('Current UTC:', nowUtc);
  console.log('');
  
  // Old method (all odds from last 24h, may include stale games)
  const twentyFourHoursAgo = DateTime.utc().minus({ hours: 24 }).toISO();
  const allOdds = getOddsSnapshots('NHL', twentyFourHoursAgo);
  console.log(`Old method (getOddsSnapshots): ${allOdds.length} snapshots`);
  
  // New method (only upcoming games within 36h horizon)
  const horizonUtc = DateTime.utc().plus({ hours: 36 }).toISO();
  const upcomingOdds = getOddsWithUpcomingGames('NHL', nowUtc, horizonUtc);
  console.log(`New method (getOddsWithUpcomingGames): ${upcomingOdds.length} snapshots`);
  
  if (upcomingOdds.length > 0) {
    console.log('');
    console.log('Sample upcoming game:');
    console.log('  game_id:', upcomingOdds[0].game_id);
    console.log('  game_time_utc:', upcomingOdds[0].game_time_utc);
    console.log('  home_team:', upcomingOdds[0].home_team);
    console.log('  away_team:', upcomingOdds[0].away_team);
    console.log('  captured_at:', upcomingOdds[0].captured_at);
  }
  
  process.exit(0);
})().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
