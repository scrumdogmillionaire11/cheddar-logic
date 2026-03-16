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

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

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
  'game_results',
  'card_display_log'
]);

function toFiniteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function normalizeConfidencePct(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) {
    return Number((value * 100).toFixed(2));
  }
  return value;
}

function logCardDisplay(db, payload) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO card_display_log (
      pick_id,
      run_id,
      game_id,
      sport,
      market_type,
      selection,
      line,
      odds,
      odds_book,
      confidence_pct,
      displayed_at,
      api_endpoint
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return stmt.run(
    String(payload.pick_id),
    payload.run_id ?? null,
    payload.game_id ?? null,
    payload.sport ?? null,
    payload.market_type ?? null,
    payload.selection ?? null,
    toFiniteNumber(payload.line),
    toFiniteNumber(payload.odds),
    payload.odds_book ?? null,
    normalizeConfidencePct(payload.confidence_pct),
    new Date().toISOString(),
    payload.endpoint ?? null
  );
}

function getDisplayedPickIds(db, runId) {
  const stmt = db.prepare(
    `SELECT pick_id FROM card_display_log WHERE run_id = ? ORDER BY displayed_at ASC`
  );
  return stmt.all(runId).map((row) => row.pick_id);
}

function getSettlementLedger(db, sport, minDate, maxDate) {
  const where = [];
  const params = [];

  if (sport) {
    where.push('sport = ?');
    params.push(sport);
  }
  if (minDate) {
    where.push('datetime(displayed_at) >= datetime(?)');
    params.push(minDate);
  }
  if (maxDate) {
    where.push('datetime(displayed_at) <= datetime(?)');
    params.push(maxDate);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const stmt = db.prepare(
    `SELECT * FROM card_display_log ${whereSql} ORDER BY datetime(displayed_at) DESC`
  );

  return stmt.all(...params);
}

function getCurrentRunId(db) {
  const stmt = db.prepare(
    `SELECT current_run_id FROM run_state WHERE id = 'singleton' LIMIT 1`
  );
  const row = stmt.get();
  return row?.current_run_id ?? null;
}

function setCurrentRunId(db, runId) {
  const stmt = db.prepare(`
    UPDATE run_state
    SET current_run_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 'singleton'
  `);
  return stmt.run(runId ?? null);
}

function insertRun(db, runId, status, itemsCount = 0) {
  const stmt = db.prepare(`
    INSERT INTO job_runs (id, job_name, status, started_at, metadata)
    VALUES (?, 'snapshot_publish', ?, CURRENT_TIMESTAMP, ?)
  `);
  return stmt.run(
    String(runId),
    String(status),
    JSON.stringify({ items_count: itemsCount })
  );
}

function getRun(db, runId) {
  const stmt = db.prepare(`SELECT * FROM job_runs WHERE id = ? LIMIT 1`);
  return stmt.get(runId) ?? null;
}

function markRunSuccess(db, runId) {
  const stmt = db.prepare(`
    UPDATE job_runs
    SET status = 'success', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  return stmt.run(runId);
}

function markRunFailure(db, runId, errorMessage) {
  const stmt = db.prepare(`
    UPDATE job_runs
    SET status = 'failed', completed_at = CURRENT_TIMESTAMP, error_message = ?
    WHERE id = ?
  `);
  return stmt.run(errorMessage ?? null, runId);
}

/**
 * Load a database file with better-sqlite3.
 * @param {string} filePath
 * @param {boolean} [readonly=false]
 */
function loadDbFile(filePath, readonly = false) {
  if (!filePath) {
    throw new Error('[DB-Multi] Missing file path.');
  }

  const dir = path.dirname(filePath);
  if (!readonly && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
    console.warn(`[DB-Multi] Could not load ${filePath}: ${e.message}`);
    throw e;
  }
}

/**
 * Initialize dual-database mode.
 * Both databases are opened synchronously.
 */
function initDualMode(recordDatabasePath, localDatabasePath) {
  recordPath = recordDatabasePath;
  localPath = localDatabasePath;

  // Open record DB as read-only, local DB as writable
  recordDb = loadDbFile(recordPath, true);
  localDb = loadDbFile(localPath, false);

  console.log(`[DB-Multi] Record DB: ${recordPath}`);
  console.log(`[DB-Multi] Local DB: ${localPath}`);

  return {
    record: recordDb,
    local: localDb,
  };
}

/**
 * Database wrapper with write-guard for the record (read-only) database.
 * Preserved so existing callers of initDualMode() that use .prepare() work unchanged.
 */
class DatabaseWrapper {
  constructor(db, source) {
    this._db = db;
    this._source = source;
  }

  prepare(query) {
    if (this._source === 'record') {
      // Return a read-only-guarded statement wrapper
      return new RecordStatement(this._db, query);
    }
    return this._db.prepare(query);
  }

  exec(sql) {
    if (this._source === 'record') {
      throw new Error('Cannot execute on record database');
    }
    this._db.exec(sql);
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
 * Statement shim that blocks writes on the record database.
 */
class RecordStatement {
  constructor(db, query) {
    this._stmt = db.prepare(query);
    this._query = query;
  }

  run() {
    throw new Error(`[DB-Multi] Cannot write to record database. Query: ${this._query}`);
  }

  get(...params) {
    return this._stmt.get(...params);
  }

  all(...params) {
    return this._stmt.all(...params);
  }
}

/**
 * Auto-routing database that selects record or local DB based on table name.
 */
class AutoRoutingDb {
  constructor(databases) {
    this.databases = databases;
  }

  prepare(query) {
    const recordMatch = this._extractTableName(query);

    if (RECORD_TABLES.has(recordMatch)) {
      return new RecordStatement(this.databases.record, query);
    }

    if (LOCAL_TABLES.has(recordMatch)) {
      return this.databases.local.prepare(query);
    }

    // Default to local for writes, record for reads
    if (/^\s*(INSERT|UPDATE|DELETE|CREATE|DROP)/i.test(query)) {
      return this.databases.local.prepare(query);
    }

    return new RecordStatement(this.databases.record, query);
  }

  exec(sql) {
    // Writes go to local
    this.databases.local.exec(sql);
  }

  _extractTableName(query) {
    const fromMatch = query.match(/FROM\s+(\w+)/i);
    const intoMatch = query.match(/INTO\s+(\w+)/i);
    const updateMatch = query.match(/UPDATE\s+(\w+)/i);

    return (fromMatch?.[1] || intoMatch?.[1] || updateMatch?.[1] || '').toLowerCase();
  }

  saveAll() {
    // No-op: better-sqlite3 writes directly to disk.
  }

  closeAll() {
    if (recordDb) { try { recordDb.close(); } catch {} recordDb = null; }
    if (localDb) { try { localDb.close(); } catch {} localDb = null; }
  }
}

module.exports = {
  initDualMode,
  AutoRoutingDb,
  DatabaseWrapper,
  RECORD_TABLES,
  LOCAL_TABLES,
  logCardDisplay,
  getDisplayedPickIds,
  getSettlementLedger,
  getCurrentRunId,
  setCurrentRunId,
  insertRun,
  getRun,
  markRunSuccess,
  markRunFailure
};
