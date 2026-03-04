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
 *   const { initDualDb, getDb } = require('./src/db-dual-init');
 *   await initDualDb({
 *     recordDbPath: '/opt/cheddar-logic/packages/data/cheddar.db',
 *     localDbPath: process.env.LOCAL_DB_PATH
 *   });
 *   const db = getDb('record'); // or 'local' or 'auto' (routes based on table)
 */

const initSqlJsLib = require('sql.js/dist/sql-asm.js');
const fs = require('fs');
const path = require('path');

let SQL = null;
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
]);

const LOCAL_TABLES = new Set([
  'card_results',
  'game_results',
  'job_runs'
]);

/**
 * Initialize SQL.js
 */
async function initSqlJs() {
  if (SQL) return SQL;
  SQL = await initSqlJsLib();
  return SQL;
}

/**
 * Load a database file
 */
function loadDbFile(filePath) {
  if (!filePath) {
    console.warn(`[DB-Dual] Missing file path. Creating empty in-memory database.`);
    if (!SQL) throw new Error('SQL.js not initialized. Call initSqlJs() first.');
    return new SQL.Database();
  }

  if (!fs.existsSync(filePath)) {
    console.warn(`[DB-Dual] File does not exist: ${filePath}. Creating empty database.`);
    if (!SQL) throw new Error('SQL.js not initialized. Call initSqlJs() first.');
    return new SQL.Database();
  }

  try {
    const buffer = fs.readFileSync(filePath);
    if (!SQL) throw new Error('SQL.js not initialized. Call initSqlJs() first.');
    return new SQL.Database(buffer);
  } catch (e) {
    console.error(`[DB-Dual] Could not load ${filePath}: ${e.message}`);
    if (!SQL) throw new Error('SQL.js not initialized. Call initSqlJs() first.');
    return new SQL.Database();
  }
}

/**
 * Save a database file
 */
function saveDbFile(db, filePath) {
  if (!db || !filePath) return;

  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    console.error(`[DB-Dual] Failed to save ${filePath}: ${e.message}`);
    throw e;
  }
}

/**
 * Initialize dual-database mode
 * 
 * @param {object} options
 * @param {string} options.recordDbPath - Path to shared record database (read-only)
 * @param {string} options.localDbPath - Path to local state database (writable)
 * @returns {Promise<void>}
 */
async function initDualDb(options = {}) {
  console.log(`[DB-Dual] Initializing dual-database mode...`);
  
  // Initialize SQL.js
  if (!SQL) {
    await initSqlJs();
  }

  // Validate paths
  if (!options.recordDbPath) {
    throw new Error('[DB-Dual] recordDbPath is required');
  }
  if (!options.localDbPath) {
    throw new Error('[DB-Dual] localDbPath is required');
  }

  recordPath = options.recordDbPath;
  localPath = options.localDbPath;

  // Load databases
  console.log(`[DB-Dual] Loading record database from ${recordPath}...`);
  recordDb = loadDbFile(recordPath);

  console.log(`[DB-Dual] Loading local database from ${localPath}...`);
  localDb = loadDbFile(localPath);

  dualModeActive = true;
  console.log(`[DB-Dual] ✅ Dual-database mode active`);
  console.log(`[DB-Dual]   Record (read-only): ${recordPath}`);
  console.log(`[DB-Dual]   Local (writable): ${localPath}`);
}

/**
 * Check if dual-mode is active
 */
function isDualModeActive() {
  return dualModeActive;
}

/**
 * Get a database instance
 * 
 * @param {string} mode - 'record' | 'local' | 'auto' (default: 'auto')
 * @returns {DatabaseWrapper} Wrapper around SQL.js database
 */
function getDb(mode = 'auto') {
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
 * Statement wrapper (mimics better-sqlite3)
 */
class Statement {
  constructor(db, query, mode) {
    this.db = db;
    this.query = query;
    this.mode = mode;
    this.stmt = db.prepare(query);
  }

  run(...params) {
    if (this.mode === 'record') {
      throw new Error(`[DB-Dual] Cannot write to record database. Query: ${this.query}`);
    }

    try {
      this.stmt.bind(params);
      this.stmt.step();
      this.stmt.reset();
      return { changes: this.db.getRowsModified() };
    } catch (e) {
      throw new Error(`Statement run error: ${e.message}`);
    }
  }

  get(...params) {
    try {
      this.stmt.bind(params);
      let result = null;
      if (this.stmt.step()) {
        result = this.stmt.getAsObject();
      }
      this.stmt.reset();
      return result;
    } catch (e) {
      throw new Error(`Statement get error: ${e.message}`);
    }
  }

  all(...params) {
    try {
      this.stmt.bind(params);
      const results = [];
      while (this.stmt.step()) {
        results.push(this.stmt.getAsObject());
      }
      this.stmt.reset();
      return results;
    } catch (e) {
      throw new Error(`Statement all error: ${e.message}`);
    }
  }
}

/**
 * Database wrapper
 */
class DatabaseWrapper {
  constructor(db, mode, filePath) {
    this._db = db;
    this._mode = mode;
    this._filePath = filePath;
  }

  prepare(query) {
    return new Statement(this._db, query, this._mode);
  }

  exec(sql) {
    if (this._mode === 'record') {
      throw new Error('[DB-Dual] Cannot execute on record database');
    }

    try {
      this._db.run(sql);
      this._save();
    } catch (e) {
      throw new Error(`Exec error: ${e.message}`);
    }
  }

  _save() {
    if (this._filePath && this._mode !== 'record') {
      saveDbFile(this._db, this._filePath);
    }
  }

  getRowsModified() {
    return this._db.getRowsModified();
  }

  save() {
    this._save();
  }
}

/**
 * Auto-routing database
 * Automatically selects record or local DB based on table name
 */
class AutoRoutingDb {
  constructor(recordDb, localDb, recordPath, localPath) {
    this.recordDb = new DatabaseWrapper(recordDb, 'record', recordPath);
    this.localDb = new DatabaseWrapper(localDb, 'local', localPath);
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
    const matches = [
      query.match(/FROM\s+(\w+)/i),
      query.match(/INTO\s+(\w+)/i),
      query.match(/UPDATE\s+(\w+)/i),
      query.match(/JOIN\s+(\w+)/i)
    ];

    for (const match of matches) {
      if (match) return match[1].toLowerCase();
    }

    return '';
  }

  saveAll() {
    this.recordDb.save();
    this.localDb.save();
  }

  getRecordDb() {
    return this.recordDb;
  }

  getLocalDb() {
    return this.localDb;
  }
}

/**
 * Graceful shutdown
 */
function closeDualDb() {
  console.log('[DB-Dual] Closing databases...');
  
  try {
    if (recordDb) {
      saveDbFile(recordDb, recordPath);
      recordDb.close();
      recordDb = null;
    }
  } catch (e) {
    console.error(`[DB-Dual] Error closing record DB: ${e.message}`);
  }

  try {
    if (localDb) {
      saveDbFile(localDb, localPath);
      localDb.close();
      localDb = null;
    }
  } catch (e) {
    console.error(`[DB-Dual] Error closing local DB: ${e.message}`);
  }

  dualModeActive = false;
  console.log('[DB-Dual] ✅ Databases closed');
}

module.exports = {
  // Initialization
  initSqlJs,
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
