/**
 * Database Client — better-sqlite3 wrapper
 * Provides the same exported interface as the former sql.js wrapper.
 *
 * Note: better-sqlite3 writes directly to disk — no manual saveDatabase() flush needed.
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { resolveDatabasePath } = require('./db-path');

let dbInstance = null;
let dbPath = null;

/**
 * Initialize the database.
 * Preserved as an async function for caller back-compat.
 */
async function initDatabase() {
  // better-sqlite3 opens synchronously — nothing to await.
}

/**
 * Load database from disk or create new.
 */
function loadDatabase() {
  const resolved = resolveDatabasePath();
  const dbFile = dbPath || resolved.dbPath;

  if (resolved.isExplicitFile && !fs.existsSync(dbFile)) {
    console.warn(`[DB] ${resolved.source} points to missing DB file. Creating new DB at: ${dbFile}`);
  }

  dbPath = dbFile;
  const dir = path.dirname(dbFile);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * No-op: better-sqlite3 writes directly to disk on every statement.run().
 * Preserved so existing callers compile without error.
 */
function saveDatabase() {
  // No-op.
}

/**
 * Get database instance.
 * Opens synchronously on first call; returns the same singleton thereafter.
 */
function getDatabase() {
  if (dbInstance) return dbInstance;
  dbInstance = loadDatabase();
  return dbInstance;
}

/**
 * Close and save database.
 */
function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

module.exports = {
  initDatabase,
  getDatabase,
  closeDatabase,
  saveDatabase,
};
