/**
 * Multi-Database Client (Dual-Database Mode)
 * 
 * Separates "record" (reference) data from "local" (state) data:
 * 
 * RECORD DATABASE (Read-only reference):
 *   - games
 *   - odds_snapshots
 *   - card_payloads (plays)
 *   - tracking_stats (canonical)
 * 
 * LOCAL DATABASE (Environment-specific state):
 *   - card_results (settlement per environment)
 *   - game_results (settlement per environment)
 *   - job_runs (environment logs)
 */

const initSqlJs = require('sql.js/dist/sql-asm.js');
const fs = require('fs');
const path = require('path');

let SQL = null;

// Dual database mode state
let recordDb = null;
let localDb = null;
let recordPath = null;
let localPath = null;

const RECORD_TABLES = new Set([
  'games',
  'odds_snapshots',
  'card_payloads',
  'tracking_stats',
  'job_runs'
]);

const LOCAL_TABLES = new Set([
  'card_results',
  'game_results'
]);

/**
 * Initialize SQL.js
 */
async function initSqlJs() {
  if (SQL) return;
  SQL = await initSqlJs();
}

/**
 * Load a database file
 */
function loadDbFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return new SQL.Database();
  }

  try {
    const buffer = fs.readFileSync(filePath);
    return new SQL.Database(buffer);
  } catch (e) {
    console.warn(`[DB-Multi] Could not load ${filePath}: ${e.message}`);
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
    console.error(`[DB-Multi] Failed to save ${filePath}: ${e.message}`);
    throw e;
  }
}

/**
 * Initialize dual-database mode
 */
function initDualMode(recordDatabasePath, localDatabasePath) {
  recordPath = recordDatabasePath;
  localPath = localDatabasePath;

  // Load both databases
  recordDb = loadDbFile(recordPath);
  localDb = loadDbFile(localPath);

  console.log(`[DB-Multi] Record DB: ${recordPath}`);
  console.log(`[DB-Multi] Local DB: ${localPath}`);

  return {
    record: new DatabaseWrapper(recordDb, 'record'),
    local: new DatabaseWrapper(localDb, 'local')
  };
}

/**
 * Statement wrapper
 */
class Statement {
  constructor(db, query, source) {
    this.db = db;
    this.query = query;
    this.source = source;
    this.stmt = db.prepare(query);
  }

  run(...params) {
    if (this.source === 'record') {
      throw new Error(`Cannot write to record database. Query: ${this.query}`);
    }

    try {
      this.stmt.bind(params);
      this.stmt.step();
      this.stmt.reset();

      if (this.source === 'local') {
        saveDbFile(this.db, localPath);
      }

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
 * Database wrapper with automatic routing
 */
class DatabaseWrapper {
  constructor(db, source) {
    this._db = db;
    this._source = source;
  }

  prepare(query) {
    return new Statement(this._db, query, this._source);
  }

  exec(sql) {
    if (this._source === 'record') {
      throw new Error('Cannot execute on record database');
    }

    try {
      this._db.run(sql);
      if (this._source === 'local') {
        saveDbFile(this._db, localPath);
      }
    } catch (e) {
      throw new Error(`Exec error: ${e.message}`);
    }
  }

  getForWrite(tableName) {
    if (RECORD_TABLES.has(tableName)) {
      throw new Error(`Table ${tableName} is read-only (record database)`);
    }
    if (!LOCAL_TABLES.has(tableName)) {
      console.warn(`[DB-Multi] Table ${tableName} not in either database. Writing to local.`);
    }
    return this;
  }
}

/**
 * Auto-routing database that selects based on table name
 */
class AutoRoutingDb {
  constructor(databases) {
    this.databases = databases;
  }

  prepare(query) {
    // Try to detect table from query
    const recordMatch = this._extractTableName(query);
    
    if (RECORD_TABLES.has(recordMatch)) {
      return this.databases.record.prepare(query);
    }
    
    if (LOCAL_TABLES.has(recordMatch)) {
      return this.databases.local.prepare(query);
    }

    // Default to local for writes, record for reads
    if (/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(query)) {
      return this.databases.local.prepare(query);
    }

    return this.databases.record.prepare(query);
  }

  exec(sql) {
    // Writes go to local
    return this.databases.local.exec(sql);
  }

  _extractTableName(query) {
    const fromMatch = query.match(/FROM\s+(\w+)/i);
    const intoMatch = query.match(/INTO\s+(\w+)/i);
    const updateMatch = query.match(/UPDATE\s+(\w+)/i);
    
    return (fromMatch?.[1] || intoMatch?.[1] || updateMatch?.[1] || '').toLowerCase();
  }

  saveAll() {
    saveDbFile(recordDb, recordPath);
    saveDbFile(localDb, localPath);
  }

  closeAll() {
    if (recordDb) recordDb.close();
    if (localDb) localDb.close();
  }
}

module.exports = {
  initSqlJs,
  initDualMode,
  AutoRoutingDb,
  DatabaseWrapper,
  RECORD_TABLES,
  LOCAL_TABLES
};
