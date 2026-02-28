const db = require('./db.js');

async function purgeSeedOdds() {
  await db.initDb();
  const client = db.getDatabase();
  const rawDb = client._db;

  const gameRows = client.prepare(`
    SELECT game_id
    FROM games
    WHERE game_id LIKE 'nhl-2026-02-27-%'
       OR game_id LIKE 'nba-2026-02-27-%'
       OR game_id LIKE 'ncaam-2026-02-27-%'
       OR game_id LIKE 'soccer-%-2026-02-27-%'
  `).all();

  const idRows = client.prepare(`
    SELECT id
    FROM odds_snapshots
    WHERE id LIKE 'odds-test-%'
       OR job_run_id LIKE 'job-seed-test-%'
  `).all();

  const jobRows = client.prepare(`
    SELECT id
    FROM job_runs
    WHERE job_name = 'seed_test_odds' OR id LIKE 'job-seed-test-%'
  `).all();

  const gameIds = gameRows.map((r) => r.game_id);
  if (gameIds.length > 0) {
    const idList = gameIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    rawDb.run(`DELETE FROM card_results WHERE game_id IN (${idList})`);
    rawDb.run(`DELETE FROM card_payloads WHERE game_id IN (${idList})`);
    rawDb.run(`DELETE FROM odds_snapshots WHERE game_id IN (${idList})`);
    rawDb.run(`DELETE FROM games WHERE game_id IN (${idList})`);
  }

  const snapshotIds = idRows.map((r) => r.id);
  if (snapshotIds.length > 0) {
    const idList = snapshotIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    rawDb.run(`DELETE FROM odds_snapshots WHERE id IN (${idList})`);
  }

  const jobIds = jobRows.map((r) => r.id);
  if (jobIds.length > 0) {
    const idList = jobIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
    rawDb.run(`DELETE FROM job_runs WHERE id IN (${idList})`);
  }

  db.closeDatabase();
}

if (require.main === module) {
  purgeSeedOdds()
    .then(() => {
      console.log('Purged seed odds artifacts.');
    })
    .catch((error) => {
      console.error('Failed to purge seed odds:', error.message || error);
      process.exit(1);
    });
}

module.exports = { purgeSeedOdds };
