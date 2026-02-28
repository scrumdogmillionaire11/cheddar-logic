const db = require('@cheddar-logic/data');

(async () => {
  await db.initDb();
  const client = db.getDatabase();
  const runs = client.prepare(`
    SELECT job_name, job_key, status, started_at
    FROM job_runs
    WHERE job_name = 'run_nhl_model'
    ORDER BY started_at DESC
    LIMIT 10
  `).all();
  
  console.table(runs);
  console.log(`\nTotal NHL job runs: ${runs.length}`);
  process.exit(0);
})();
