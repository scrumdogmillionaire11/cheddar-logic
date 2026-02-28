/**
 * Canonical verification script - uses Node DB client only
 */
const db = require('./src/db.js');

(async () => {
  await db.initDb();
  const client = db.getDatabase();
  
  console.log('=== GAMES TABLE ===');
  const games = client.prepare(`
    SELECT id, sport, game_id, game_time_utc, home_team, away_team, status
    FROM games
    WHERE sport = 'NHL'
    ORDER BY game_time_utc ASC
  `).all();
  console.table(games);
  
  console.log('\n=== NHL JOB RUNS (Last 10) ===');
  const runs = client.prepare(`
    SELECT job_name, job_key, status, started_at
    FROM job_runs
    WHERE job_name = 'run_nhl_model'
    ORDER BY started_at DESC
    LIMIT 10
  `).all();
  console.table(runs);
  
  console.log('\n=== DATA INTEGRITY CHECKS ===');
  
  // Check for duplicate game_ids
  const dups = client.prepare(`
    SELECT game_id, COUNT(*) as count
    FROM games
    WHERE sport = 'NHL'
    GROUP BY game_id
    HAVING count > 1
  `).all();
  
  if (dups.length > 0) {
    console.log('❌ DUPLICATE GAME_IDS FOUND:');
    console.table(dups);
  } else {
    console.log('✅ No duplicate game_ids');
  }
  
  // Check for orphaned odds snapshots (odds without games)
  const orphaned = client.prepare(`
    SELECT COUNT(*) as orphan_count
    FROM odds_snapshots o
    LEFT JOIN games g ON o.game_id = g.game_id
    WHERE g.game_id IS NULL
  `).get();
  
  console.log(`✅ Orphaned odds snapshots: ${orphaned.orphan_count}`);
  
  process.exit(0);
})();
