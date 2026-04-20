/*
 * NOT currently activated in production.
 * Single-DB path via resolveDatabasePath is the active runtime path.
 * This module is retained for future dual-DB deployment and is safe to call
 * only after `initDualDb()` is invoked in the entry point.
 */

/**
 * Dual-Database Initialization Module
 *
 * Separates "record" (reference) database from "local" (state) database.
 *
 * RECORD DATABASE (Read-only reference - shared across environments):
 *   - games
 *   - odds_snapshots
 *   - card_payloads (plays)
 *   - tracking_stats (canonical)
 *
 * LOCAL DATABASE (Environment-specific state - per-instance):
 *   - card_results (settlement per environment)
 *   - game_results (settlement per environment)
 *   - job_runs (environment logs)
 *
 * Usage:
 *   const { initDualDb, getDb } = require('./db-dual-init');
 *   await initDualDb({
 *     recordDbPath: '/opt/cheddar-logic/packages/data/cheddar.db',
 *     localDbPath: process.env.LOCAL_DB_PATH
 *   });
 *   const db = getDb('record'); // or 'local' or 'auto' (routes based on table)
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

let recordDb = null;
let localDb = null;
let recordPath = null;
let localPath = null;
let dualModeActive = false;

const RECORD_TABLES = new Set([
  'games',
  'odds_snapshots',
  'card_payloads',
  'tracking_stats',
  'game_id_map',
]);

const LOCAL_TABLES = new Set([
  'card_results',
  'game_results',
  'job_runs',
  'card_display_log',
  'run_state',
  'migrations',
]);

/**
 * Load a database file with better-sqlite3.
 * @param {string} filePath
 * @param {boolean} [readonly=false]
 */
function loadDbFile(filePath, readonly) {
  if (!filePath) {
    throw new Error('[DB-Dual] Missing file path.');
  }

  if (readonly === undefined) {
    readonly = false;
  }

  const dir = path.dirname(filePath);
  if (!readonly && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(filePath) && readonly) {
    console.warn(`[DB-Dual] File does not exist: ${filePath}. Creating empty database.`);
    // Create the file first so better-sqlite3 can open it read-only after
    const tmpDb = new Database(filePath);
    tmpDb.close();
  }

  try {
    const db = new Database(filePath, { readonly });
    if (!readonly) {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
    } else {
      db.pragma('foreign_keys = ON');
    }
    return db;
  } catch (e) {
    console.error(`[DB-Dual] Could not load ${filePath}: ${e.message}`);
    throw e;
  }
}

/**
 * Initialize dual-database mode.
 * Preserved as async for caller back-compat; opens both DBs synchronously internally.
 *
 * @param {object} options
 * @param {string} options.recordDbPath - Path to shared record database (read-only)
 * @param {string} options.localDbPath - Path to local state database (writable)
 * @returns {Promise<void>}
 */
async function initDualDb(options) {
  if (options === undefined) options = {};
  console.log(`[DB-Dual] Initializing dual-database mode...`);

  if (!options.recordDbPath) {
    throw new Error('[DB-Dual] recordDbPath is required');
  }
  if (!options.localDbPath) {
    throw new Error('[DB-Dual] localDbPath is required');
  }

  recordPath = options.recordDbPath;
  localPath = options.localDbPath;

  console.log(`[DB-Dual] Loading record database from ${recordPath}...`);
  recordDb = loadDbFile(recordPath, true);

  console.log(`[DB-Dual] Loading local database from ${localPath}...`);
  localDb = loadDbFile(localPath, false);

  dualModeActive = true;
  console.log(`[DB-Dual] Dual-database mode active`);
  console.log(`[DB-Dual]   Record (read-only): ${recordPath}`);
  console.log(`[DB-Dual]   Local (writable): ${localPath}`);
}

/**
 * Check if dual-mode is active.
 */
function isDualModeActive() {
  return dualModeActive;
}

/**
 * Get a database instance.
 *
 * @param {string} mode - 'record' | 'local' | 'auto' (default: 'auto')
 * @returns {DatabaseWrapper|AutoRoutingDb}
 */
function getDb(mode) {
  if (mode === undefined) mode = 'auto';
  if (!dualModeActive) {
    throw new Error('[DB-Dual] Dual-database mode not initialized. Call initDualDb() first.');
  }

  if (mode === 'record') {
    if (!recordDb) throw new Error('[DB-Dual] Record database not loaded');
    return new DatabaseWrapper(recordDb, 'record', recordPath);
  }

  if (mode === 'local') {
    if (!localDb) throw new Error('[DB-Dual] Local database not loaded');
    return new DatabaseWrapper(localDb, 'local', localPath);
  }

  if (mode === 'auto') {
    return new AutoRoutingDb(recordDb, localDb, recordPath, localPath);
  }

  throw new Error(`[DB-Dual] Invalid mode: ${mode}. Use 'record', 'local', or 'auto'.`);
}

/**
 * Database wrapper.
 * Provides write-guard on the record (read-only) database.
 */
class DatabaseWrapper {
  constructor(db, mode, filePath) {
    this._db = db;
    this._mode = mode;
    this._filePath = filePath;
  }

  prepare(query) {
    if (this._mode === 'record') {
      return new RecordStatement(this._db, query);
    }
    return this._db.prepare(query);
  }

  exec(sql) {
    if (this._mode === 'record') {
      throw new Error('[DB-Dual] Cannot execute on record database');
    }
    this._db.exec(sql);
  }

  getRowsModified() {
    // Legacy shim. Callers should use stmt.run().changes from better-sqlite3.
    return 0;
  }

  save() {
    // No-op: better-sqlite3 writes directly to disk.
  }
}

/**
 * Statement shim that blocks writes on the record database.
 */
class RecordStatement {
  constructor(db, query) {
    this._stmt = db.prepare(query);
    this._query = query;
  }

  run() {
    throw new Error(`[DB-Dual] Cannot write to record database. Query: ${this._query}`);
  }

  get(...params) {
    return this._stmt.get(...params);
  }

  all(...params) {
    return this._stmt.all(...params);
  }
}

/**
 * Auto-routing database.
 * Automatically selects record or local DB based on table name.
 */
class AutoRoutingDb {
  constructor(recordDbInstance, localDbInstance, recPath, locPath) {
    this.recordDb = new DatabaseWrapper(recordDbInstance, 'record', recPath);
    this.localDb = new DatabaseWrapper(localDbInstance, 'local', locPath);
  }

  prepare(query) {
    const tableName = this._extractTableName(query);

    if (RECORD_TABLES.has(tableName)) {
      return this.recordDb.prepare(query);
    }

    // Default to local for unknown tables and all writes
    return this.localDb.prepare(query);
  }

  exec(sql) {
    return this.localDb.exec(sql);
  }

  _extractTableName(query) {
    const q = query.trim();

    // PRAGMA table_info(tableName) — route based on the target table
    const pragmaMatch = q.match(/PRAGMA\s+table_info\s*\(\s*(\w+)\s*\)/i);
    if (pragmaMatch) return pragmaMatch[1].toLowerCase();

    // sqlite_master queries checking for a specific table name in WHERE clause
    if (/sqlite_master/i.test(q)) {
      const nameMatch = q.match(/name\s*=\s*['"](\w+)['"]/i);
      if (nameMatch) return nameMatch[1].toLowerCase();
      // Generic sqlite_master query — use record DB
      return 'games';
    }

    const matches = [
      q.match(/FROM\s+(\w+)/i),
      q.match(/INTO\s+(\w+)/i),
      q.match(/UPDATE\s+(\w+)/i),
      q.match(/JOIN\s+(\w+)/i)
    ];

    for (const match of matches) {
      if (match) return match[1].toLowerCase();
    }

    return '';
  }

  saveAll() {
    // No-op: better-sqlite3 writes directly to disk.
  }

  getRecordDb() {
    return this.recordDb;
  }

  getLocalDb() {
    return this.localDb;
  }
}

/**
 * Graceful shutdown.
 */
function closeDualDb() {
  console.log('[DB-Dual] Closing databases...');

  try {
    if (recordDb) {
      recordDb.close();
      recordDb = null;
    }
  } catch (e) {
    console.error(`[DB-Dual] Error closing record DB: ${e.message}`);
  }

  try {
    if (localDb) {
      localDb.close();
      localDb = null;
    }
  } catch (e) {
    console.error(`[DB-Dual] Error closing local DB: ${e.message}`);
  }

  dualModeActive = false;
  console.log('[DB-Dual] Databases closed');
}

module.exports = {
  // Initialization
  initDualDb,
  closeDualDb,
  isDualModeActive,

  // Access
  getDb,

  // Constants
  RECORD_TABLES,
  LOCAL_TABLES,

  // Classes (for advanced use)
  DatabaseWrapper,
  AutoRoutingDb
};
