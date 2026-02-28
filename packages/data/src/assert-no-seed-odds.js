const db = require('./db.js');

async function assertNoSeedOdds() {
  await db.initDb();
  const client = db.getDatabase();

  const seedRuns = client.prepare(`
    SELECT COUNT(*) AS count
    FROM job_runs
    WHERE job_name = 'seed_test_odds' OR id LIKE 'job-seed-test-%'
  `).get();

  const seedGames = client.prepare(`
    SELECT COUNT(*) AS count
    FROM games
    WHERE game_id LIKE 'nhl-2026-02-27-%'
       OR game_id LIKE 'nba-2026-02-27-%'
       OR game_id LIKE 'ncaam-2026-02-27-%'
       OR game_id LIKE 'soccer-%-2026-02-27-%'
  `).get();

  const seedOdds = client.prepare(`
    SELECT COUNT(*) AS count
    FROM odds_snapshots
    WHERE id LIKE 'odds-test-%'
       OR job_run_id LIKE 'job-seed-test-%'
  `).get();

  db.closeDatabase();

  const counts = {
    seedRuns: Number(seedRuns.count || 0),
    seedGames: Number(seedGames.count || 0),
    seedOdds: Number(seedOdds.count || 0),
  };

  if (counts.seedRuns > 0 || counts.seedGames > 0 || counts.seedOdds > 0) {
    throw new Error(`Seed artifacts still present: ${JSON.stringify(counts)}`);
  }

  return counts;
}

if (require.main === module) {
  assertNoSeedOdds()
    .then(() => {
      console.log('No seed odds artifacts found.');
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = { assertNoSeedOdds };
