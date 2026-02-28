const db = require('./db.js');
const { withDb } = require('./job-runtime');

const SEED_PREFIX = 'seed-results-2026-02-27';

async function purgeSeedResults() {
  await withDb(async (client) => {
    const rawDb = client._db;
    const gameRows = client.prepare(`
      SELECT game_id
      FROM games
      WHERE game_id LIKE '${SEED_PREFIX}%'
    `).all();

    const gameIds = gameRows.map((row) => row.game_id);
    if (gameIds.length === 0) {
      return;
    }

    const idList = gameIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');

    rawDb.run(`DELETE FROM card_results WHERE game_id IN (${idList})`);
    rawDb.run(`DELETE FROM card_payloads WHERE game_id IN (${idList})`);
    rawDb.run(`DELETE FROM game_results WHERE game_id IN (${idList})`);
    rawDb.run(`DELETE FROM games WHERE game_id IN (${idList})`);
  });
}

if (require.main === module) {
  purgeSeedResults()
    .then(() => {
      console.log('Purged seed results artifacts.');
    })
    .catch((error) => {
      console.error('Failed to purge seed results:', error.message || error);
      process.exit(1);
    });
}

module.exports = { purgeSeedResults };
