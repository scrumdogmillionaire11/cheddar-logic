/**
 * Job Runtime Helpers
 * 
 * Ensures DB is initialized, migrations are run, and connections are closed.
 */

const { initDb, getDatabase, closeDatabase } = require('./db');
const { runMigrations } = require('./migrate');

/**
 * Run a function with an initialized DB and guaranteed cleanup.
 * @param {function} fn - async function that receives db client
 * @returns {Promise<any>} Result of fn
 */
async function withDb(fn) {
  await initDb();
  await runMigrations();
  const db = getDatabase();

  try {
    return await fn(db);
  } finally {
    closeDatabase();
  }
}

module.exports = {
  withDb
};
