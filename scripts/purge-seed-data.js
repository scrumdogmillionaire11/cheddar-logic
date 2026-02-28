/**
 * One-time script: purge seed test data from the DB.
 * Seed games are identified by fractional-second timestamps (e.g. T04:57:24.102Z)
 * which the real odds API never produces.
 */
const db = require('../packages/data/src/db.js');

async function main() {
  await db.initDb();
  const client = db.getDatabase();

  const seed = client
    .prepare("SELECT game_id FROM games WHERE game_time_utc LIKE '%T%:%:%.%'")
    .all();

  if (seed.length === 0) {
    console.log('No seed data found — DB is clean.');
    db.closeDatabase();
    return;
  }

  console.log(`Found ${seed.length} seed game(s):`);
  seed.forEach((r) => console.log(' -', r.game_id));

  const ids = seed.map((r) => r.game_id);
  // Use quoted literals — these are known-safe internal IDs, no user input
  const idList = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
  const rawDb = client._db;

  rawDb.run(`DELETE FROM card_results WHERE game_id IN (${idList})`);
  const crCount = rawDb.getRowsModified();
  rawDb.run(`DELETE FROM card_payloads WHERE game_id IN (${idList})`);
  const cpCount = rawDb.getRowsModified();
  rawDb.run(`DELETE FROM odds_snapshots WHERE game_id IN (${idList})`);
  const osCount = rawDb.getRowsModified();
  rawDb.run(`DELETE FROM games WHERE game_id IN (${idList})`);
  const gCount = rawDb.getRowsModified();

  console.log(
    `Deleted — card_results: ${crCount}, card_payloads: ${cpCount}, odds_snapshots: ${osCount}, games: ${gCount}`
  );
  console.log('Games remaining:', client.prepare('SELECT COUNT(*) as c FROM games').get().c);

  db.closeDatabase();
  console.log('Done.');
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
