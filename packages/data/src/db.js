/**
 * Database Client
 * Singleton connection to the SQLite database (via better-sqlite3)
 *
 * Usage:
 *   await require('./db.js').initDb()  // no-op, preserved for back-compat
 *   const db = require('./db.js').getDatabase()
 *
 * All timestamps stored in ISO 8601 UTC format
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const {
  createMarketError,
  deriveLockedMarketContext,
  normalizeMarketPeriod,
  toRecommendedBetType,
} = require('./market-contract');
const { resolveDatabasePath } = require('./db-path');
const {
  normalizeTeamName,
  normalizeCardTitle,
  normalizeSportCode,
} = require('./normalize');

let dbInstance = null;
let dbPath = null;
let warnedDbPathContract = false;
let dbLockHandle = null;
let dbLockPath = null;
let dbLockRegistered = false;
const warnedSportValues = new Set();
let oddsContextReferenceRegistry = new WeakMap();
const EXPECTED_TABLE_NAMES = ['games', 'card_payloads', 'card_results', 'game_results'];
const REQUIRED_CARD_RESULTS_MARKET_COLUMNS = ['market_key', 'market_type', 'selection', 'line', 'locked_price'];

function normalizeConfiguredPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  // Support sqlite-style URLs as file paths:
  // sqlite:////abs/path.db | sqlite:///abs/path.db | sqlite:./relative.db
  if (trimmed.toLowerCase().startsWith('sqlite:')) {
    const raw = trimmed.slice('sqlite:'.length);
    if (!raw) return null;
    if (raw.startsWith('//')) {
      return path.normalize(`/${raw.replace(/^\/+/, '')}`);
    }
    return path.resolve(raw);
  }

  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(trimmed);
}

function inspectDatabaseStats(dbFile) {
  try {
    if (!fs.existsSync(dbFile)) {
      return {
        exists: false,
        tableCount: 0,
        rowCount: 0,
        cardPayloadCount: 0,
        hasMarketContractColumns: false,
        modifiedMs: 0,
      };
    }
    const stats = fs.statSync(dbFile);
    const db = new Database(dbFile, { readonly: true });
    const tablePlaceholders = EXPECTED_TABLE_NAMES.map(() => '?').join(', ');
    const tableRow = db.prepare(
      `SELECT COUNT(*) AS c
       FROM sqlite_master
       WHERE type='table' AND name IN (${tablePlaceholders})`
    ).get(EXPECTED_TABLE_NAMES);
    let tableCount = Number(tableRow?.c || 0);

    let rowCount = 0;
    let cardPayloadCount = 0;
    let hasMarketContractColumns = false;
    if (tableCount > 0) {
      for (const tableName of EXPECTED_TABLE_NAMES) {
        try {
          const row = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`).get();
          const count = Number(row?.c || 0);
          rowCount += count;
          if (tableName === 'card_payloads') {
            cardPayloadCount = count;
          }
        } catch {
          // Ignore missing/incompatible tables.
        }
      }

      try {
        const columns = db.prepare(`PRAGMA table_info(card_results)`).all();
        const columnNames = new Set(
          columns.map((row) => (typeof row.name === 'string' ? row.name : ''))
        );
        hasMarketContractColumns = REQUIRED_CARD_RESULTS_MARKET_COLUMNS.every((name) =>
          columnNames.has(name)
        );
      } catch {
        // Best-effort schema inspection.
      }
    }

    db.close();
    return {
      exists: true,
      tableCount,
      rowCount,
      cardPayloadCount,
      hasMarketContractColumns,
      modifiedMs: Number(stats.mtimeMs || 0),
    };
  } catch {
    return {
      exists: true,
      tableCount: 0,
      rowCount: 0,
      cardPayloadCount: 0,
      hasMarketContractColumns: false,
      modifiedMs: 0,
    };
  }
}

function shouldPreferCandidate(candidate, currentBest) {
  const candidateHasRows = candidate.rowCount > 0;
  const currentHasRows = currentBest.rowCount > 0;
  if (candidateHasRows !== currentHasRows) return candidateHasRows;

  if (candidate.rowCount !== currentBest.rowCount) {
    return candidate.rowCount > currentBest.rowCount;
  }

  if (candidate.tableCount !== currentBest.tableCount) {
    return candidate.tableCount > currentBest.tableCount;
  }

  if (candidate.modifiedMs !== currentBest.modifiedMs) {
    return candidate.modifiedMs > currentBest.modifiedMs;
  }

  if (candidate.exists !== currentBest.exists) {
    return candidate.exists;
  }

  return false;
}

function listDbFiles(directory) {
  try {
    if (!directory || !fs.existsSync(directory)) return [];
    return fs
      .readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith('.db'))
      .map((name) => path.join(directory, name));
  } catch {
    return [];
  }
}

function isTruthyEnv(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function isProcessAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check native SQLite database integrity using sqlite3 CLI.
 * This is for detecting corruption in native SQLite files (e.g., FPL Sage DB),
 * not the better-sqlite3 database used by Cheddar main DB.
 *
 * @param {string} dbPath - Absolute path to SQLite database file
 * @returns {{ ok: boolean, error: string | null }} - Integrity check result
 */
function checkSqliteIntegrity(dbPath) {
  // Handle missing or invalid path
  if (!dbPath || typeof dbPath !== 'string') {
    return { ok: true, error: null }; // Not configured = not an error
  }

  const normalizedPath = path.resolve(dbPath);

  // Handle non-existent file (not an error for new installations)
  if (!fs.existsSync(normalizedPath)) {
    return { ok: true, error: null };
  }

  try {
    // Shell out to sqlite3 CLI for integrity check
    // Using 2>&1 to capture both stdout and stderr
    const result = execSync(
      `sqlite3 "${normalizedPath}" "PRAGMA integrity_check;"`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();

    if (result === 'ok') {
      return { ok: true, error: null };
    }

    // Integrity check returned non-ok result
    return {
      ok: false,
      error: `FPL Sage DB corrupted at ${normalizedPath}. PRAGMA integrity_check returned: ${result}`,
    };
  } catch (err) {
    // Command execution failed (e.g., sqlite3 not installed, disk I/O error, corrupt file)
    const errorMsg = err.stderr || err.message || String(err);
    
    // Check if this is a "file is not a database" error (indicates corruption)
    if (errorMsg.includes('file is not a database') || 
        errorMsg.includes('database disk image is malformed') ||
        errorMsg.includes('not a database')) {
      return {
        ok: false,
        error: `FPL Sage DB corrupted at ${normalizedPath}: ${errorMsg}`,
      };
    }
    
    // Other errors (sqlite3 not installed, permission denied, etc.)
    return {
      ok: false,
      error: `Failed to check FPL Sage DB integrity at ${normalizedPath}: ${errorMsg}`,
    };
  }
}

function isLockOwnerAlive(lockInfo) {
  const pid = Number(lockInfo && lockInfo.pid);
  if (!isProcessAlive(pid)) return false;

  // On Linux, verify the process at this PID started before the lock was written.
  // If its creation time is newer than startedAt, the original owner died and the
  // PID was recycled by an unrelated process (common in container restarts).
  if (process.platform === 'linux' && lockInfo && lockInfo.startedAt) {
    try {
      const procStat = fs.statSync(`/proc/${pid}`);
      const lockCreatedMs = new Date(lockInfo.startedAt).getTime();
      if (procStat.ctimeMs > lockCreatedMs + 5000) {
        return false;
      }
    } catch {
      // /proc not available — trust isProcessAlive result.
    }
  }

  return true;
}

function releaseDbFileLock() {
  if (dbLockHandle) {
    try {
      fs.closeSync(dbLockHandle);
    } catch {
      // Best-effort cleanup.
    }
    dbLockHandle = null;
  }
  if (dbLockPath) {
    try {
      fs.unlinkSync(dbLockPath);
    } catch {
      // Best-effort cleanup.
    }
    dbLockPath = null;
  }
}

function registerDbLockCleanup() {
  if (dbLockRegistered) return;
  dbLockRegistered = true;
  const cleanup = () => releaseDbFileLock();
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

function spinSleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function acquireDbFileLock(dbFile) {
  if (!dbFile) return;
  if (process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS === 'true') {
    console.warn(
      `[DB] CHEDDAR_DB_ALLOW_MULTI_PROCESS=true — skipping DB lock for ${dbFile} (WAL mode handles concurrent access).`,
    );
    return;
  }

  const lockDir = path.dirname(dbFile);
  if (lockDir && !fs.existsSync(lockDir)) {
    fs.mkdirSync(lockDir, { recursive: true });
  }

  const lockPath = `${dbFile}.lock`;
  if (dbLockHandle && dbLockPath === lockPath) return;

  const payload = `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`;

  function tryAcquire() {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(handle, payload);
      dbLockHandle = handle;
      dbLockPath = lockPath;
      registerDbLockCleanup();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return false;
    }
  }

  function readLockInfo() {
    try {
      return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch {
      return null;
    }
  }

  function claimStaleLock() {
    try { fs.unlinkSync(lockPath); } catch { /* best-effort */ }
    return tryAcquire();
  }

  if (tryAcquire()) return;

  let lockInfo = readLockInfo();

  if (!isLockOwnerAlive(lockInfo)) {
    if (claimStaleLock()) return;
    // Lost race after unlink — fall through to retry/error path
    lockInfo = readLockInfo();
  }

  // Lock is held by a live process.
  // CHEDDAR_DB_LOCK_TIMEOUT_MS > 0 enables retry-with-backoff (intended for worker
  // processes that need to wait for the web server to release between requests).
  const lockTimeoutMs = Number(process.env.CHEDDAR_DB_LOCK_TIMEOUT_MS || 0);
  if (lockTimeoutMs > 0) {
    const retryIntervalMs = 100;
    const deadline = Date.now() + lockTimeoutMs;
    while (Date.now() < deadline) {
      spinSleepMs(retryIntervalMs);
      lockInfo = readLockInfo();
      if (!isLockOwnerAlive(lockInfo)) {
        if (claimStaleLock()) return;
        lockInfo = readLockInfo();
      } else if (tryAcquire()) {
        return;
      }
    }
  }

  const ownerPid = lockInfo && Number.isFinite(Number(lockInfo.pid)) ? lockInfo.pid : 'unknown';
  const message =
    `[DB] Refusing to open ${dbFile} because another process holds the lock (${lockPath}, pid=${ownerPid}). ` +
    'Set CHEDDAR_DB_ALLOW_MULTI_PROCESS=true to bypass.';
  if (process.env.NODE_ENV === 'production') {
    throw new Error(message);
  }
  console.warn(message);
}

function chooseBestDatabasePath(primaryPath) {
  const primaryDir = path.dirname(primaryPath);
  const configuredDataDir = normalizeConfiguredPath(process.env.CHEDDAR_DATA_DIR);

  const seedCandidates = [
    primaryPath,
    normalizeConfiguredPath(process.env.CHEDDAR_DB_PATH),
    normalizeConfiguredPath(path.join(process.env.CHEDDAR_DATA_DIR || '', 'cheddar.db')),
    normalizeConfiguredPath(path.join(primaryDir, 'backups', path.basename(primaryPath))),
    configuredDataDir ? path.join(configuredDataDir, 'backups', 'cheddar.db') : null,
    '/opt/data/backups/cheddar.db',
    '/opt/data/cheddar.db',
    '/opt/cheddar-logic/packages/data/cheddar.db',
    '/opt/cheddar-logic/packages/data/backups/cheddar.db',
    '/tmp/cheddar-logic/cheddar.db',
    '/tmp/cheddar-logic/backups/cheddar.db',
  ].filter(Boolean);

  const searchDirs = [
    primaryDir,
    path.join(primaryDir, 'backups'),
    normalizeConfiguredPath(process.env.CHEDDAR_DATA_DIR),
    configuredDataDir ? path.join(configuredDataDir, 'backups') : null,
    '/opt/data',
    '/opt/data/backups',
    '/opt/cheddar-logic/packages/data',
    '/opt/cheddar-logic/packages/data/backups',
    '/tmp/cheddar-logic',
    '/tmp/cheddar-logic/backups',
  ].filter(Boolean);

  const candidates = [
    ...seedCandidates,
    ...searchDirs.flatMap((dir) => listDbFiles(dir)),
  ]
    .filter(Boolean)
    .map((candidate) => path.normalize(candidate));

  const uniqueCandidates = [...new Set(candidates)];

  let bestPath = primaryPath;
  let bestStats = inspectDatabaseStats(primaryPath);

  const primaryLooksHealthy =
    bestStats.exists
    && bestStats.tableCount === EXPECTED_TABLE_NAMES.length
    && bestStats.cardPayloadCount > 0
    && bestStats.hasMarketContractColumns;

  if (primaryLooksHealthy) {
    return primaryPath;
  }

  for (const candidate of uniqueCandidates) {
    const stats = inspectDatabaseStats(candidate);
    if (shouldPreferCandidate(stats, bestStats)) {
      bestStats = stats;
      bestPath = candidate;
    }
  }

  if (bestPath !== primaryPath && bestStats.rowCount > 0) {
    console.warn(
      `[DB] Using populated database: ${bestPath} (tables=${bestStats.tableCount}, rows=${bestStats.rowCount}, payloads=${bestStats.cardPayloadCount}) instead of ${primaryPath}`
    );
  }

  return bestPath;
}

function normalizeSportValue(sport, context) {
  if (sport == null) return null;
  const raw = String(sport);
  const normalized = raw.trim().toLowerCase();
  if (raw !== normalized && !warnedSportValues.has(raw)) {
    console.warn(`[DB] Normalizing sport "${raw}" -> "${normalized}"${context ? ` (${context})` : ''}`);
    warnedSportValues.add(raw);
  }
  return normalized;
}

/**
 * Initialize database (preserved as async no-op for caller back-compat).
 * better-sqlite3 opens synchronously on first getDatabase() call.
 */
async function initDb() {
  // better-sqlite3 opens synchronously on first getDatabase() call.
  // Preserved as an async no-op so existing callers need no changes.
  oddsContextReferenceRegistry = new WeakMap();
}

/**
 * Load database from disk or create new
 */
function loadDatabase() {
  const resolved = resolveDatabasePath();
  if (process.env.NODE_ENV === 'production' && !warnedDbPathContract) {
    const hasCanonicalDbPath =
      typeof process.env.CHEDDAR_DB_PATH === 'string'
      && process.env.CHEDDAR_DB_PATH.trim().length > 0;
    if (!hasCanonicalDbPath || resolved.source !== 'CHEDDAR_DB_PATH') {
      console.warn(
        `[DB] Production should set CHEDDAR_DB_PATH as the single source of truth (resolved from ${resolved.source}: ${resolved.dbPath})`
      );
    }
    warnedDbPathContract = true;
  }
  const preferredPath = dbPath || resolved.dbPath;
  const autoDiscoverEnabled = isTruthyEnv(process.env.CHEDDAR_DB_AUTODISCOVER);
  // Explicit DB paths must be deterministic and should never be auto-swapped.
  const shouldAutoDiscover = autoDiscoverEnabled && !resolved.isExplicitFile && !dbPath;
  const dbFile = shouldAutoDiscover ? chooseBestDatabasePath(preferredPath) : preferredPath;

  if (resolved.isExplicitFile && !fs.existsSync(preferredPath)) {
    const message = `[DB] ${resolved.source} points to missing DB file: ${preferredPath}`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(message);
    }
    console.warn(`${message}. Creating new DB at this path.`);
  }

  if (process.env.NODE_ENV === 'production' && !autoDiscoverEnabled && dbFile !== preferredPath) {
    throw new Error(
      `[DB] Production DB path drift detected. Expected ${preferredPath}, got ${dbFile}. ` +
      `Disable fallback selection and keep one canonical database path.`
    );
  }

  if (process.env.NODE_ENV === 'production' && !autoDiscoverEnabled) {
    console.log(`[DB] Using strict DB path in production (${resolved.source}): ${dbFile}`);
  }

  dbPath = dbFile;
  acquireDbFileLock(dbFile);
  const dir = path.dirname(dbFile);

  // Only create directory if it's a reasonable path (not /ROOT or similar invalid paths)
  if (!fs.existsSync(dir)) {
    // Prevent creating directories in invalid paths
    if (!path.isAbsolute(dir) || dir === '/' || dir === '/ROOT' || dir.includes('/ROOT')) {
      console.warn(
        `[DB] Skipping invalid directory creation attempt: ${dir}\n` +
        `    Set CHEDDAR_DB_PATH explicitly to use a custom database location.\n` +
        `    Example: CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm run dev`
      );
    } else {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (mkdirError) {
        console.warn(`[DB] Failed to create directory ${dir}: ${mkdirError.message}`);
      }
    }
  }

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * No-op: better-sqlite3 writes directly to disk on every statement.run().
 * Preserved so any remaining callers compile without error.
 */
function saveDatabase() {
  // No-op: better-sqlite3 writes directly to disk on every statement.run().
}

/**
 * Wraps a better-sqlite3 prepared statement so that .get() returns null
 * instead of undefined when no row is found.  This matches the original
 * sql.js shim behaviour and avoids widespread `?? null` changes in callers.
 */
class NullOnEmptyStatement {
  constructor(stmt) {
    this._stmt = stmt;
    this.reader = stmt.reader;
  }

  get(...params) {
    const result = this._stmt.get(...params);
    return result === undefined ? null : result;
  }

  all(...params) { return this._stmt.all(...params); }
  run(...params) { return this._stmt.run(...params); }
  iterate(...params) { return this._stmt.iterate(...params); }
  bind(...params) { return this._stmt.bind(...params); }
  columns() { return this._stmt.columns(); }
  safeIntegers(val) { return this._stmt.safeIntegers(val); }
  raw(val) { return this._stmt.raw(val); }
  expand(val) { return this._stmt.expand(val); }
  pluck(val) { return this._stmt.pluck(val); }
}

/**
 * Thin proxy around the native better-sqlite3 Database instance.
 * Delegates all methods to the underlying db but:
 * - Wraps prepare() to return NullOnEmptyStatement (null vs undefined back-compat)
 * - Overrides close() so that callers (e.g. migrate.js) properly clear the module singleton.
 */
class DatabaseProxy {
  constructor(db) {
    this._db = db;
    // Expose native properties tests may rely on
    this.open = db.open;
    this.inTransaction = db.inTransaction;
    this.name = db.name;
    this.readonly = db.readonly;
    this.memory = db.memory;
  }

  prepare(sql) { return new NullOnEmptyStatement(this._db.prepare(sql)); }
  exec(sql) { return this._db.exec(sql); }
  pragma(pragma, options) { return this._db.pragma(pragma, options); }
  transaction(fn) { return this._db.transaction(fn); }
  backup(dest, options) { return this._db.backup(dest, options); }
  serialize(options) { return this._db.serialize(options); }
  function(name, options, fn) { return this._db.function(name, options, fn); }
  aggregate(name, options) { return this._db.aggregate(name, options); }
  table(name, definition) { return this._db.table(name, definition); }
  loadExtension(path) { return this._db.loadExtension(path); }
  defaultSafeIntegers(val) { return this._db.defaultSafeIntegers(val); }
  unsafeMode(unsafe) { return this._db.unsafeMode(unsafe); }

  /**
   * Close the database AND clear the module-level singleton so subsequent
   * callers can re-open a fresh connection.
   */
  close() {
    closeDatabase();
  }
}

/**
 * Get database instance.
 * Opens synchronously on first call; returns the same singleton thereafter.
 * Returns a DatabaseProxy so that db.close() correctly updates module state.
 */
function getDatabase() {
  if (!dbInstance) {
    dbInstance = loadDatabase();
  }
  return new DatabaseProxy(dbInstance);
}

/**
 * Close database.
 * better-sqlite3 writes to disk on every statement.run() so no flush needed.
 */
function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  dbPath = null;
  releaseDbFileLock();
  // Reset odds context registry on close
  oddsContextReferenceRegistry = new WeakMap();
}

/**
 * Close database without releasing write lock (read-only consumers).
 * Preserved for caller back-compat — better-sqlite3 readers open their own
 * connection so this is now a no-op for the singleton.
 */
function closeDatabaseReadOnly() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  dbPath = null;
  releaseDbFileLock();
  oddsContextReferenceRegistry = new WeakMap();
}

/**
 * Open the database for reading WITHOUT acquiring the write lock.
 * Safe for read-only consumers (web server) that must coexist with the worker.
 *
 * Returns a fresh native better-sqlite3 read-only instance per call.
 * WAL mode ensures concurrent readers and the single writer coexist safely.
 *
 * MUST be paired with closeReadOnlyInstance(db) — never closeDatabase().
 */
function getDatabaseReadOnly() {
  const resolved = resolveDatabasePath();
  const filePath = dbPath || resolved.dbPath;

  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(
      `[DB] getDatabaseReadOnly: database file not found at ${filePath}. ` +
      'Ensure CHEDDAR_DB_PATH is set and the worker has initialized the database.'
    );
  }

  let instance;
  try {
    instance = new Database(filePath, { readonly: true });
    instance.pragma('foreign_keys = ON');
  } catch (e) {
    throw new Error(
      `[DB] getDatabaseReadOnly: database file at ${filePath} is malformed and cannot be opened: ${e.message}. ` +
      'Do not serve stale or empty data — fail the request and investigate the DB file.'
    );
  }

  // Wrap in a ReadOnlyProxy that:
  // - Returns null (not undefined) from .get() for consistency with former sql.js behaviour
  // - Throws on any write attempt
  return new ReadOnlyDatabaseProxy(instance);
}

/**
 * Proxy around a native better-sqlite3 read-only instance.
 * - .prepare().get() returns null (not undefined) for no-row results
 * - .prepare().run() throws a descriptive error (write rejected)
 */
class ReadOnlyDatabaseProxy {
  constructor(db) {
    this._db = db;
  }

  prepare(query) {
    const stmt = this._db.prepare(query);
    return new ReadOnlyStatement(stmt, query);
  }

  exec() {
    throw new Error(
      '[DB] exec() rejected on read-only instance. ' +
      'Only the worker process may write to the database.'
    );
  }

  pragma(pragma, options) { return this._db.pragma(pragma, options); }

  close() {
    try { this._db.close(); } catch { /* ignore */ }
  }
}

/**
 * Statement wrapper for read-only database instances.
 * .get() returns null (not undefined) for no-row results.
 * .run() throws immediately.
 */
class ReadOnlyStatement {
  constructor(stmt, query) {
    this._stmt = stmt;
    this._query = query;
  }

  run() {
    throw new Error(
      '[DB] Write rejected on read-only instance. ' +
      'Only the worker process may write to the database. ' +
      `Query: ${this._query}`
    );
  }

  get(...params) {
    const result = this._stmt.get(...params);
    return result === undefined ? null : result;
  }

  all(...params) { return this._stmt.all(...params); }
  iterate(...params) { return this._stmt.iterate(...params); }
  columns() { return this._stmt.columns(); }
  pluck(val) { return this._stmt.pluck(val); }
  raw(val) { return this._stmt.raw(val); }
  expand(val) { return this._stmt.expand(val); }
  safeIntegers(val) { return this._stmt.safeIntegers(val); }
}

/**
 * Close a per-request read-only database instance returned by getDatabaseReadOnly().
 * Works with both ReadOnlyDatabaseProxy and native better-sqlite3 instances.
 */
function closeReadOnlyInstance(db) {
  if (db) {
    try { db.close(); } catch { /* ignore */ }
  }
}

function ensureRunStateSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_state (
      id TEXT PRIMARY KEY,
      current_run_id TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT OR IGNORE INTO run_state (id, current_run_id, updated_at)
    VALUES ('singleton', NULL, CURRENT_TIMESTAMP);
  `);
}

function ensureCardPayloadRunIdColumn(db) {
  const columns = db.prepare(`PRAGMA table_info(card_payloads)`).all();
  const hasRunId = columns.some(
    (column) => String(column.name || '').toLowerCase() === 'run_id',
  );
  if (!hasRunId) {
    db.exec(`ALTER TABLE card_payloads ADD COLUMN run_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_card_payloads_run_id ON card_payloads(run_id)`,
  );
}

function ensureOddsIngestFailuresSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS odds_ingest_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      failure_key TEXT NOT NULL UNIQUE,
      job_run_id TEXT,
      job_name TEXT,
      sport TEXT,
      provider TEXT,
      game_id TEXT,
      reason_code TEXT NOT NULL,
      reason_detail TEXT,
      home_team TEXT,
      away_team TEXT,
      payload_hash TEXT,
      source_context TEXT,
      first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_last_seen
      ON odds_ingest_failures(last_seen DESC)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_reason
      ON odds_ingest_failures(reason_code, last_seen DESC)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_sport
      ON odds_ingest_failures(sport, last_seen DESC)`,
  );
}

function ensureSoccerTeamXgCacheSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS soccer_team_xg_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sport TEXT NOT NULL,
      league TEXT NOT NULL,
      team_name TEXT NOT NULL,
      home_xg_l6 REAL,
      away_xg_l6 REAL,
      fetched_at TEXT NOT NULL,
      cache_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sport, league, team_name, cache_date)
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_soccer_team_xg_cache_league_date
    ON soccer_team_xg_cache(league, cache_date)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_soccer_team_xg_cache_team
    ON soccer_team_xg_cache(team_name)
  `);
}

function buildOddsIngestFailureKey(event) {
  const sport = normalizeSportValue(event.sport, 'buildOddsIngestFailureKey');
  return [
    event.jobName || 'pull_odds_hourly',
    sport || 'unknown',
    event.provider || 'unknown',
    event.gameId || 'no-game',
    event.reasonCode || 'UNKNOWN',
    event.homeTeam || '',
    event.awayTeam || '',
  ].join('|');
}

function recordOddsIngestFailure(event) {
  if (!event || !event.reasonCode) return;
  const db = getDatabase();
  ensureOddsIngestFailuresSchema(db);

  const nowIso = new Date().toISOString();
  const failureKey = event.failureKey || buildOddsIngestFailureKey(event);
  const sport = normalizeSportValue(event.sport, 'recordOddsIngestFailure');
  const sourceContext =
    event.sourceContext && typeof event.sourceContext === 'object'
      ? JSON.stringify(event.sourceContext)
      : null;

  const stmt = db.prepare(`
    INSERT INTO odds_ingest_failures (
      failure_key,
      job_run_id,
      job_name,
      sport,
      provider,
      game_id,
      reason_code,
      reason_detail,
      home_team,
      away_team,
      payload_hash,
      source_context,
      first_seen,
      last_seen,
      occurrence_count,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(failure_key) DO UPDATE SET
      job_run_id = excluded.job_run_id,
      job_name = excluded.job_name,
      reason_detail = excluded.reason_detail,
      payload_hash = COALESCE(excluded.payload_hash, odds_ingest_failures.payload_hash),
      source_context = COALESCE(excluded.source_context, odds_ingest_failures.source_context),
      last_seen = excluded.last_seen,
      occurrence_count = odds_ingest_failures.occurrence_count + 1,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    failureKey,
    event.jobRunId || null,
    event.jobName || null,
    sport,
    event.provider || null,
    event.gameId || null,
    event.reasonCode,
    event.reasonDetail || null,
    event.homeTeam || null,
    event.awayTeam || null,
    event.payloadHash || null,
    sourceContext,
    nowIso,
    nowIso,
    nowIso,
  );
}

function getOddsIngestFailureSummary({
  sinceHours = 24,
  limit = 50,
  reasonLimit = 20,
  readOnly = false,
} = {}) {
  const db = readOnly ? getDatabaseReadOnly() : getDatabase();
  if (!readOnly) {
    ensureOddsIngestFailuresSchema(db);
  }

  const safeSinceHours =
    Number.isFinite(Number(sinceHours)) && Number(sinceHours) > 0
      ? Math.min(Number(sinceHours), 24 * 30)
      : 24;
  const safeLimit =
    Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(Number(limit), 500)
      : 50;
  const safeReasonLimit =
    Number.isFinite(Number(reasonLimit)) && Number(reasonLimit) > 0
      ? Math.min(Number(reasonLimit), 100)
      : 20;
  const sinceExpr = `-${safeSinceHours} hours`;

  try {
    const totalsStmt = db.prepare(`
      SELECT
        COUNT(*) AS row_count,
        COALESCE(SUM(occurrence_count), 0) AS occurrence_count
      FROM odds_ingest_failures
      WHERE datetime(last_seen) >= datetime('now', ?)
    `);
    const totals = totalsStmt.get(sinceExpr) || {
      row_count: 0,
      occurrence_count: 0,
    };

    const topReasonsStmt = db.prepare(`
      SELECT
        reason_code,
        sport,
        COUNT(*) AS row_count,
        COALESCE(SUM(occurrence_count), 0) AS occurrence_count,
        MAX(last_seen) AS last_seen
      FROM odds_ingest_failures
      WHERE datetime(last_seen) >= datetime('now', ?)
      GROUP BY reason_code, sport
      ORDER BY occurrence_count DESC, row_count DESC, last_seen DESC
      LIMIT ?
    `);
    const topReasons = topReasonsStmt.all(sinceExpr, safeReasonLimit);

    const recentStmt = db.prepare(`
      SELECT
        id,
        job_run_id,
        job_name,
        sport,
        provider,
        game_id,
        reason_code,
        reason_detail,
        home_team,
        away_team,
        payload_hash,
        source_context,
        first_seen,
        last_seen,
        occurrence_count
      FROM odds_ingest_failures
      WHERE datetime(last_seen) >= datetime('now', ?)
      ORDER BY datetime(last_seen) DESC
      LIMIT ?
    `);
    const recentRows = recentStmt.all(sinceExpr, safeLimit);

    return {
      window_hours: safeSinceHours,
      totals,
      top_reasons: topReasons,
      recent_failures: recentRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such table: odds_ingest_failures')) {
      return {
        window_hours: safeSinceHours,
        totals: { row_count: 0, occurrence_count: 0 },
        top_reasons: [],
        recent_failures: [],
      };
    }
    throw error;
  } finally {
    if (readOnly) {
      closeReadOnlyInstance(db);
    }
  }
}

function getCurrentRunId(sport = null) {
  const db = getDatabase();
  ensureRunStateSchema(db);
  const rowId = sport ? sport.toLowerCase() : 'singleton';
  const stmt = db.prepare(
    `SELECT current_run_id FROM run_state WHERE id = ? LIMIT 1`,
  );
  const row = stmt.get(rowId);
  return row?.current_run_id ?? null;
}

function setCurrentRunId(runId, sport = null) {
  const db = getDatabase();
  ensureRunStateSchema(db);
  const rowId = sport ? sport.toLowerCase() : 'singleton';
  const stmt = db.prepare(`
    INSERT INTO run_state (id, current_run_id, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      current_run_id = excluded.current_run_id,
      updated_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(rowId, runId ?? null);
}

/**
 * Insert a new job run
 * @param {string} jobName - Name of the job (e.g., 'pull_odds_hourly')
 * @param {string} id - Unique job run ID (UUID or similar)
 * @param {string|null} jobKey - Optional deterministic window key for idempotency
 * @returns {void}
 */
function insertJobRun(jobName, id, jobKey = null) {
  const db = getDatabase();
  const started_at = new Date().toISOString();

  if (jobKey) {
    const stmt = db.prepare(`
      INSERT INTO job_runs (id, job_name, job_key, status, started_at)
      SELECT ?, ?, ?, 'running', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM job_runs WHERE job_key = ? AND status IN ('running', 'success')
      )
    `);
    const result = stmt.run(id, jobName, jobKey, started_at, jobKey);
    if (!result.changes) {
      const confirmStmt = db.prepare(
        `SELECT 1 FROM job_runs WHERE id = ? LIMIT 1`,
      );
      const exists = Boolean(confirmStmt.get(id));
      if (!exists) {
        const error = new Error(`Job key already claimed: ${jobKey}`);
        error.code = 'JOB_RUN_ALREADY_CLAIMED';
        throw error;
      }
    }
    return;
  }

  const stmt = db.prepare(`
    INSERT INTO job_runs (id, job_name, job_key, status, started_at)
    VALUES (?, ?, ?, 'running', ?)
  `);

  stmt.run(id, jobName, jobKey, started_at);
}

/**
 * Mark a job run as complete
 * @param {string} jobRunId - The job run ID
 */
function markJobRunSuccess(jobRunId) {
  const db = getDatabase();
  const ended_at = new Date().toISOString();
  
  const stmt = db.prepare(`
    UPDATE job_runs
    SET status = 'success', ended_at = ?
    WHERE id = ?
  `);
  
  stmt.run(ended_at, jobRunId);
}

/**
 * Mark a job run as failed
 * @param {string} jobRunId - The job run ID
 * @param {string} errorMessage - Error message
 */
function markJobRunFailure(jobRunId, errorMessage) {
  const db = getDatabase();
  const ended_at = new Date().toISOString();
  
  const stmt = db.prepare(`
    UPDATE job_runs
    SET status = 'failed', ended_at = ?, error_message = ?
    WHERE id = ?
  `);
  
  stmt.run(ended_at, errorMessage, jobRunId);
}

/**
 * Insert an odds snapshot
 * @param {object} snapshot - Odds data
 * @param {string} snapshot.id - Unique ID
 * @param {string} snapshot.gameId - Game ID
 * @param {string} snapshot.sport - Sport name
 * @param {string} snapshot.capturedAt - ISO 8601 timestamp
 * @param {number} snapshot.h2hHome - Home moneyline
 * @param {number} snapshot.h2hAway - Away moneyline
 * @param {number} snapshot.total - Total line
 * @param {string} snapshot.jobRunId - Associated job run ID
 * @param {object} snapshot.rawData - Full odds object (stringified)
 */
function insertOddsSnapshot(snapshot) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(snapshot.sport, 'insertOddsSnapshot');
  const toNullableNumber = (value) =>
    Number.isFinite(value) ? value : null;
  
  const stmt = db.prepare(`
    INSERT INTO odds_snapshots (
      id, game_id, sport, captured_at, h2h_home, h2h_away, total,
      spread_home, spread_away, spread_home_book, spread_away_book,
      moneyline_home, moneyline_away,
      spread_price_home, spread_price_away, total_price_over, total_price_under,
      spread_consensus_line, spread_consensus_confidence,
      spread_dispersion_stddev, spread_source_book_count,
      total_consensus_line, total_consensus_confidence,
      total_dispersion_stddev, total_source_book_count,
      h2h_consensus_home, h2h_consensus_away, h2h_consensus_confidence,
      h2h_book, total_book,
      ml_f5_home, ml_f5_away,
      raw_data, job_run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    snapshot.id,
    snapshot.gameId,
    normalizedSport,
    snapshot.capturedAt,
    toNullableNumber(snapshot.h2hHome),
    toNullableNumber(snapshot.h2hAway),
    toNullableNumber(snapshot.total),
    toNullableNumber(snapshot.spreadHome),
    toNullableNumber(snapshot.spreadAway),
    snapshot.spreadHomeBook || null,
    snapshot.spreadAwayBook || null,
    toNullableNumber(snapshot.monelineHome),
    toNullableNumber(snapshot.monelineAway),
    toNullableNumber(snapshot.spreadPriceHome),
    toNullableNumber(snapshot.spreadPriceAway),
    toNullableNumber(snapshot.totalPriceOver),
    toNullableNumber(snapshot.totalPriceUnder),
    toNullableNumber(snapshot.spreadConsensusLine),
    snapshot.spreadConsensusConfidence || null,
    toNullableNumber(snapshot.spreadDispersionStddev),
    Number.isInteger(snapshot.spreadSourceBookCount)
      ? snapshot.spreadSourceBookCount
      : null,
    toNullableNumber(snapshot.totalConsensusLine),
    snapshot.totalConsensusConfidence || null,
    toNullableNumber(snapshot.totalDispersionStddev),
    Number.isInteger(snapshot.totalSourceBookCount)
      ? snapshot.totalSourceBookCount
      : null,
    toNullableNumber(snapshot.h2hConsensusHome),
    toNullableNumber(snapshot.h2hConsensusAway),
    snapshot.h2hConsensusConfidence || null,
    snapshot.h2hBook || null,
    snapshot.totalBook || null,
    toNullableNumber(snapshot.mlF5Home),
    toNullableNumber(snapshot.mlF5Away),
    snapshot.rawData ? JSON.stringify(snapshot.rawData) : null,
    snapshot.jobRunId
  );
}

/**
 * Delete odds snapshots for a game + captured_at timestamp
 * @param {string} gameId - Game ID
 * @param {string} capturedAt - ISO 8601 timestamp
 * @returns {number} Count of deleted rows
 */
function deleteOddsSnapshotsByGameAndCapturedAt(gameId, capturedAt) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM odds_snapshots
    WHERE game_id = ? AND captured_at = ?
  `);
  
  const result = stmt.run(gameId, capturedAt);
  return result.changes;
}

/**
 * Update the raw_data field of the latest odds snapshot for a game.
 * Used to persist ESPN enrichment after the fact.
 * Optimized to avoid expensive verification on large JSON strings.
 * @param {string} snapshotId - The odds_snapshots.id to update
 * @param {object|string} enrichedRawData - The enriched raw_data (object or JSON string)
 * @returns {boolean} True if update was attempted (row exists), false if not found
 */
function updateOddsSnapshotRawData(snapshotId, enrichedRawData) {
  try {
    const db = getDatabase();
    
    // Handle both object and string inputs (enrichment functions may return either)
    let rawDataJson = null;
    if (enrichedRawData) {
      rawDataJson = typeof enrichedRawData === 'string'
        ? enrichedRawData
        : JSON.stringify(enrichedRawData);
    }
    
    // First verify the row exists (lightweight check, just id)
    const existing = db.prepare('SELECT 1 FROM odds_snapshots WHERE id = ?').get(snapshotId);
    if (!existing) {
      console.warn(`[updateOddsSnapshotRawData] Snapshot ${snapshotId} not found`);
      return false;
    }
    
    // Warn if raw_data is getting very large (suggests bloat from repeated enrichments)
    if (rawDataJson && rawDataJson.length > 1024 * 1024) {
      console.warn(`[updateOddsSnapshotRawData] Large raw_data for ${snapshotId}: ${Math.round(rawDataJson.length / 1024)}KB`);
    }
    
    // Perform the update (trust SQLite to execute correctly)
    // Skip expensive verification step that loads entire JSON back into memory
    db.prepare('UPDATE odds_snapshots SET raw_data = ? WHERE id = ?').run(rawDataJson, snapshotId);
    
    return true;
  } catch (err) {
    console.error(`[updateOddsSnapshotRawData] Error for snapshot ${snapshotId}: ${err.message}`);
    return false;
  }
}

/**
 * Prepare idempotent odds snapshot writes
 * @param {string} gameId - Game ID
 * @param {string} capturedAt - ISO 8601 timestamp
 * @returns {number} Count of deleted rows
 */
function prepareOddsSnapshotWrite(gameId, capturedAt) {
  return deleteOddsSnapshotsByGameAndCapturedAt(gameId, capturedAt);
}

/**
 * Get latest odds snapshot for a game
 * @param {string} gameId - Game ID
 * @returns {object|null} Latest odds snapshot or null
 */
function getLatestOdds(gameId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE game_id = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `);
  
  return stmt.get(gameId) || null;
}

/**
 * Get all odds snapshots for a sport since a given time
 * @param {string} sport - Sport name
 * @param {string} sinceUtc - ISO 8601 timestamp
 * @returns {array} Odds snapshots
 */
function getOddsSnapshots(sport, sinceUtc) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getOddsSnapshots');
  
  const stmt = db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE sport = ? AND captured_at >= ?
    ORDER BY game_id, captured_at DESC
  `);
  
  return stmt.all(normalizedSport, sinceUtc);
}

function normalizeLineDeltaMarketType(marketType) {
  const raw = String(marketType || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'FIRSTPERIOD') return 'FIRST_PERIOD';
  if (raw === 'PUCK_LINE') return 'PUCKLINE';
  if (raw === 'TEAMTOTAL') return 'TEAM_TOTAL';
  return raw;
}

function normalizeLineDeltaSelectionSide(selectionSide) {
  const raw = String(selectionSide || '').trim().toUpperCase();
  if (raw === 'HOME' || raw === 'AWAY' || raw === 'OVER' || raw === 'UNDER') {
    return raw;
  }
  return null;
}

function getSnapshotLineForMarket(snapshot, marketType, selectionSide) {
  const normalizedMarketType = normalizeLineDeltaMarketType(marketType);
  const normalizedSelectionSide =
    normalizeLineDeltaSelectionSide(selectionSide);

  if (
    normalizedMarketType === 'TOTAL' ||
    normalizedMarketType === 'TEAM_TOTAL' ||
    normalizedMarketType === 'FIRST_PERIOD'
  ) {
    return Number.isFinite(snapshot?.total) ? snapshot.total : null;
  }

  if (
    normalizedMarketType === 'SPREAD' ||
    normalizedMarketType === 'PUCKLINE'
  ) {
    if (normalizedSelectionSide === 'AWAY') {
      return Number.isFinite(snapshot?.spread_away) ? snapshot.spread_away : null;
    }
    return Number.isFinite(snapshot?.spread_home) ? snapshot.spread_home : null;
  }

  if (normalizedMarketType === 'MONEYLINE') {
    if (normalizedSelectionSide === 'AWAY') {
      return Number.isFinite(snapshot?.h2h_away)
        ? snapshot.h2h_away
        : Number.isFinite(snapshot?.moneyline_away)
          ? snapshot.moneyline_away
          : null;
    }
    return Number.isFinite(snapshot?.h2h_home)
      ? snapshot.h2h_home
      : Number.isFinite(snapshot?.moneyline_home)
        ? snapshot.moneyline_home
        : null;
  }

  return null;
}

/**
 * Compute opener vs current line movement for a game/market from odds_snapshots.
 *
 * The returned line values are selection-side aware for spread/puckline when
 * selectionSide is provided (HOME uses spread_home, AWAY uses spread_away).
 *
 * @param {object} params
 * @param {string} params.sport
 * @param {string} params.gameId
 * @param {string} params.marketType
 * @param {string} [params.selectionSide]
 * @param {object} [params.db]
 * @returns {{opener_line:number|null,current_line:number|null,delta:number|null,delta_pct:number|null,snapshot_count:number}}
 */
function computeLineDelta({
  sport,
  gameId,
  marketType,
  selectionSide = null,
  db = null,
}) {
  const database = db || getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'computeLineDelta');
  const normalizedMarketType = normalizeLineDeltaMarketType(marketType);
  const normalizedSelectionSide =
    normalizeLineDeltaSelectionSide(selectionSide);

  if (!normalizedSport || !gameId || !normalizedMarketType) {
    return {
      opener_line: null,
      current_line: null,
      delta: null,
      delta_pct: null,
      snapshot_count: 0,
    };
  }

  const rows = database
    .prepare(`
      SELECT
        captured_at,
        total,
        spread_home,
        spread_away,
        h2h_home,
        h2h_away,
        moneyline_home,
        moneyline_away
      FROM odds_snapshots
      WHERE game_id = ?
        AND LOWER(sport) = ?
      ORDER BY captured_at ASC
    `)
    .all(gameId, normalizedSport);

  const snapshotsWithLine = rows
    .map((row) => ({
      captured_at: row.captured_at,
      line: getSnapshotLineForMarket(
        row,
        normalizedMarketType,
        normalizedSelectionSide,
      ),
    }))
    .filter((row) => Number.isFinite(row.line));

  if (snapshotsWithLine.length === 0) {
    return {
      opener_line: null,
      current_line: null,
      delta: null,
      delta_pct: null,
      snapshot_count: 0,
    };
  }

  const openerLine = snapshotsWithLine[0].line;
  const currentLine = snapshotsWithLine[snapshotsWithLine.length - 1].line;
  const delta = currentLine - openerLine;
  const deltaPct =
    openerLine === 0 ? null : Number((delta / Math.abs(openerLine)).toFixed(4));

  return {
    opener_line: openerLine,
    current_line: currentLine,
    delta: Number(delta.toFixed(4)),
    delta_pct,
    snapshot_count: snapshotsWithLine.length,
  };
}

/**
 * Get latest odds snapshots for upcoming games only (prevents stale data processing)
 * Joins with games table to filter by game_time_utc
 * Deduplicates to one snapshot per game (most recent) to prevent OOM on large datasets
 * @param {string} sport - Sport code (e.g., 'NHL')
 * @param {string} nowUtc - Current time in ISO UTC
 * @param {string} horizonUtc - End of time window in ISO UTC (e.g., now + 36 hours)
 * @returns {array} Latest odds snapshot per game with game_time_utc attached
 */
function getOddsWithUpcomingGames(sport, nowUtc, horizonUtc) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getOddsWithUpcomingGames');
  
  // Deduplicate to latest snapshot per game at SQL level to prevent OOM
  const stmt = db.prepare(`
    SELECT 
      o.*,
      g.game_time_utc,
      g.home_team,
      g.away_team
    FROM odds_snapshots o
    INNER JOIN (
      SELECT game_id, MAX(captured_at) as max_captured_at
      FROM odds_snapshots
      WHERE LOWER(sport) = ?
      GROUP BY game_id
    ) latest ON o.game_id = latest.game_id AND o.captured_at = latest.max_captured_at
    INNER JOIN games g ON o.game_id = g.game_id
    WHERE LOWER(o.sport) = ?
      AND g.game_time_utc IS NOT NULL
      AND g.game_time_utc > ?
      AND g.game_time_utc <= ?
    ORDER BY g.game_time_utc ASC
  `);
  
  return stmt.all(normalizedSport, normalizedSport, nowUtc, horizonUtc);
}

/**
 * Upsert a player shot log row
 * @param {object} log
 * @param {string} log.id - Unique ID
 * @param {string} log.sport - Sport code
 * @param {number} log.playerId - Player ID
 * @param {string} [log.playerName]
 * @param {string} log.gameId - Game ID
 * @param {string} [log.gameDate] - ISO date
 * @param {string} [log.opponent]
 * @param {boolean} [log.isHome]
 * @param {number} [log.shots]
 * @param {number} [log.toiMinutes]
 * @param {object} [log.rawData]
 * @param {string} log.fetchedAt - ISO timestamp
 */
function upsertPlayerShotLog(log) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(log.sport, 'upsertPlayerShotLog');

  const stmt = db.prepare(`
    INSERT INTO player_shot_logs (
      id, sport, player_id, player_name, game_id, game_date,
      opponent, is_home, shots, toi_minutes, raw_data, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, player_id, game_id) DO UPDATE SET
      player_name = excluded.player_name,
      game_date = excluded.game_date,
      opponent = excluded.opponent,
      is_home = excluded.is_home,
      shots = excluded.shots,
      toi_minutes = excluded.toi_minutes,
      raw_data = excluded.raw_data,
      fetched_at = excluded.fetched_at
  `);

  stmt.run(
    log.id,
    normalizedSport,
    log.playerId,
    log.playerName || null,
    log.gameId,
    log.gameDate || null,
    log.opponent || null,
    log.isHome ? 1 : 0,
    Number.isFinite(log.shots) ? log.shots : null,
    Number.isFinite(log.toiMinutes) ? log.toiMinutes : null,
    log.rawData ? JSON.stringify(log.rawData) : null,
    log.fetchedAt
  );
}

/**
 * Get latest shot logs for a player
 * @param {number} playerId
 * @param {number} limit
 * @returns {array}
 */
function getPlayerShotLogs(playerId, limit = 5) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM player_shot_logs
    WHERE player_id = ?
    ORDER BY game_date DESC, fetched_at DESC
    LIMIT ?
  `);

  return stmt.all(playerId, limit);
}

/**
 * Upsert a tracked player row for a sport+market.
 * Used by automated ID sync jobs (e.g., NHL SOG top-shooter sync).
 *
 * @param {object} row
 * @param {number} row.playerId
 * @param {string} row.sport
 * @param {string} row.market
 * @param {string} [row.playerName]
 * @param {string} [row.teamAbbrev]
 * @param {number} [row.shots]
 * @param {number} [row.gamesPlayed]
 * @param {number} [row.shotsPerGame]
 * @param {number} [row.seasonId]
 * @param {string} [row.source]
 * @param {boolean|number} [row.isActive]
 * @param {string} [row.lastSyncedAt]
 */
function upsertTrackedPlayer(row) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(row.sport, 'upsertTrackedPlayer');
  const normalizedMarket = String(row.market || '').trim().toLowerCase();
  const playerId = Number(row.playerId);
  if (!Number.isFinite(playerId)) {
    throw new Error('upsertTrackedPlayer requires numeric playerId');
  }

  const stmt = db.prepare(`
    INSERT INTO tracked_players (
      player_id, sport, market, player_name, team_abbrev, shots,
      games_played, shots_per_game, season_id, source, is_active, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, sport, market) DO UPDATE SET
      player_name = excluded.player_name,
      team_abbrev = excluded.team_abbrev,
      shots = excluded.shots,
      games_played = excluded.games_played,
      shots_per_game = excluded.shots_per_game,
      season_id = excluded.season_id,
      source = excluded.source,
      is_active = excluded.is_active,
      last_synced_at = excluded.last_synced_at,
      updated_at = CURRENT_TIMESTAMP
  `);

  const shots = Number(row.shots);
  const gamesPlayed = Number(row.gamesPlayed);
  const shotsPerGame = Number(row.shotsPerGame);
  const seasonId = Number(row.seasonId);

  stmt.run(
    playerId,
    normalizedSport,
    normalizedMarket,
    row.playerName || null,
    row.teamAbbrev || null,
    Number.isFinite(shots) ? shots : null,
    Number.isFinite(gamesPlayed) ? gamesPlayed : null,
    Number.isFinite(shotsPerGame) ? shotsPerGame : null,
    Number.isFinite(seasonId) ? seasonId : null,
    row.source || 'unknown',
    row.isActive === undefined ? 1 : row.isActive ? 1 : 0,
    row.lastSyncedAt || new Date().toISOString(),
  );
}

/**
 * List tracked players for a sport+market.
 *
 * @param {object} params
 * @param {string} [params.sport='NHL']
 * @param {string} [params.market='shots_on_goal']
 * @param {boolean} [params.activeOnly=true]
 * @param {number|null} [params.limit=null]
 * @returns {array}
 */
function listTrackedPlayers({
  sport = 'NHL',
  market = 'shots_on_goal',
  activeOnly = true,
  limit = null,
} = {}) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'listTrackedPlayers');
  const normalizedMarket = String(market || '').trim().toLowerCase();
  const params = [normalizedSport, normalizedMarket];

  let sql = `
    SELECT
      player_id,
      sport,
      market,
      player_name,
      team_abbrev,
      shots,
      games_played,
      shots_per_game,
      season_id,
      source,
      is_active,
      last_synced_at
    FROM tracked_players
    WHERE sport = ?
      AND market = ?
  `;

  if (activeOnly) {
    sql += ' AND is_active = 1';
  }

  sql += `
    ORDER BY
      shots_per_game DESC,
      shots DESC,
      games_played DESC,
      player_id ASC
  `;

  if (Number.isFinite(limit) && Number(limit) > 0) {
    sql += ' LIMIT ?';
    params.push(Math.floor(Number(limit)));
  }

  return db.prepare(sql).all(...params);
}

/**
 * Deactivate tracked players for sport+market that are not in the active set.
 *
 * @param {object} params
 * @param {string} [params.sport='NHL']
 * @param {string} [params.market='shots_on_goal']
 * @param {number[]} [params.activePlayerIds=[]]
 * @param {string} [params.lastSyncedAt]
 * @returns {number} count of rows changed
 */
function deactivateTrackedPlayersNotInSet({
  sport = 'NHL',
  market = 'shots_on_goal',
  activePlayerIds = [],
  lastSyncedAt = null,
} = {}) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(
    sport,
    'deactivateTrackedPlayersNotInSet',
  );
  const normalizedMarket = String(market || '').trim().toLowerCase();
  const safeIds = Array.isArray(activePlayerIds)
    ? activePlayerIds.map((id) => Number(id)).filter(Number.isFinite)
    : [];
  const syncedAt = lastSyncedAt || new Date().toISOString();

  if (safeIds.length === 0) {
    const stmt = db.prepare(`
      UPDATE tracked_players
      SET
        is_active = 0,
        last_synced_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE sport = ?
        AND market = ?
        AND is_active = 1
    `);
    const info = stmt.run(syncedAt, normalizedSport, normalizedMarket);
    return info.changes || 0;
  }

  const placeholders = safeIds.map(() => '?').join(', ');
  const stmt = db.prepare(`
    UPDATE tracked_players
    SET
      is_active = 0,
      last_synced_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE sport = ?
      AND market = ?
      AND is_active = 1
      AND player_id NOT IN (${placeholders})
  `);
  const info = stmt.run(syncedAt, normalizedSport, normalizedMarket, ...safeIds);
  return info.changes || 0;
}

/**
 * Upsert a game record (insert or update if exists)
 * @param {object} game - Game data
 * @param {string} game.id - UUID for the game record
 * @param {string} game.gameId - Canonical game ID (e.g., nhl-2026-02-27-tor-mtl)
 * @param {string} game.sport - Sport code
 * @param {string} game.homeTeam - Home team name
 * @param {string} game.awayTeam - Away team name
 * @param {string} game.gameTimeUtc - Game start time in ISO 8601 UTC
 * @param {string} game.status - Game status (default: 'scheduled')
 */
function upsertGame({ id, gameId, sport, homeTeam, awayTeam, gameTimeUtc, status = 'scheduled' }) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'upsertGame');
  const normalizedHomeTeam = normalizeTeamName(homeTeam, 'upsertGame:homeTeam');
  const normalizedAwayTeam = normalizeTeamName(awayTeam, 'upsertGame:awayTeam');
  
  const stmt = db.prepare(`
    INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(game_id) DO UPDATE SET
      home_team = excluded.home_team,
      away_team = excluded.away_team,
      game_time_utc = excluded.game_time_utc,
      status = excluded.status,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(id, normalizedSport, gameId, normalizedHomeTeam, normalizedAwayTeam, gameTimeUtc, status);
}

/**
 * Upsert a game ID mapping (external provider -> canonical game_id)
 * @param {object} row - Mapping data
 * @param {string} row.sport - Sport code (canonical lowercase)
 * @param {string} row.provider - Provider name (e.g., 'espn')
 * @param {string} row.externalGameId - Provider game ID
 * @param {string} row.gameId - Canonical game ID
 * @param {string} row.matchMethod - 'exact' | 'teams_time_fuzzy'
 * @param {number} row.matchConfidence - 0..1
 * @param {string} row.matchedAt - ISO 8601 timestamp
 * @param {string|null} row.extGameTimeUtc
 * @param {string|null} row.extHomeTeam
 * @param {string|null} row.extAwayTeam
 * @param {string|null} row.oddsGameTimeUtc
 * @param {string|null} row.oddsHomeTeam
 * @param {string|null} row.oddsAwayTeam
 */
function upsertGameIdMap(row) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(row.sport, 'upsertGameIdMap');
  const provider = row.provider ? String(row.provider).trim().toLowerCase() : null;

  const stmt = db.prepare(`
    INSERT INTO game_id_map (
      sport, provider, external_game_id, game_id,
      match_method, match_confidence, matched_at,
      ext_game_time_utc, ext_home_team, ext_away_team,
      odds_game_time_utc, odds_home_team, odds_away_team
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, provider, external_game_id) DO UPDATE SET
      game_id = excluded.game_id,
      match_method = excluded.match_method,
      match_confidence = excluded.match_confidence,
      matched_at = excluded.matched_at,
      ext_game_time_utc = excluded.ext_game_time_utc,
      ext_home_team = excluded.ext_home_team,
      ext_away_team = excluded.ext_away_team,
      odds_game_time_utc = excluded.odds_game_time_utc,
      odds_home_team = excluded.odds_home_team,
      odds_away_team = excluded.odds_away_team
  `);

  stmt.run(
    normalizedSport,
    provider,
    row.externalGameId,
    row.gameId,
    row.matchMethod,
    row.matchConfidence,
    row.matchedAt,
    row.extGameTimeUtc || null,
    row.extHomeTeam || null,
    row.extAwayTeam || null,
    row.oddsGameTimeUtc || null,
    row.oddsHomeTeam || null,
    row.oddsAwayTeam || null
  );
}

/**
 * Resolve canonical game_id from external provider ID
 * @param {string} sport - Sport code
 * @param {string} provider - Provider name (e.g., 'espn')
 * @param {string} externalGameId - Provider game ID
 * @returns {object|null} Mapping row or null
 */
function getCanonicalGameIdByExternal(sport, provider, externalGameId) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getCanonicalGameIdByExternal');
  const normalizedProvider = provider ? String(provider).trim().toLowerCase() : null;

  const stmt = db.prepare(`
    SELECT *
    FROM game_id_map
    WHERE sport = ? AND provider = ? AND external_game_id = ?
    LIMIT 1
  `);

  return stmt.get(normalizedSport, normalizedProvider, externalGameId) || null;
}

/**
 * Delete model outputs for a game + model combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @returns {number} Count of deleted rows
 */
function deleteModelOutputsByGame(gameId, modelName) {
  return deleteModelOutputsForGame(gameId, modelName);
}

/**
 * Get job run history for a job
 * @param {string} jobName - Job name
 * @param {number} limit - Max results
 * @returns {array} Job runs
 */
function getJobRunHistory(jobName, limit = 10) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM job_runs
    WHERE job_name = ?
    ORDER BY started_at DESC
    LIMIT ?
  `);
  
  return stmt.all(jobName, limit);
}

/**
 * Check if a given job was successful in the last N minutes
 * @param {string} jobName - Job name
 * @param {number} minutesAgo - Window
 * @returns {boolean}
 */
function wasJobRecentlySuccessful(jobName, minutesAgo = 60) {
  const db = getDatabase();
  const threshold = new Date(Date.now() - minutesAgo * 60000).toISOString();
  
  const stmt = db.prepare(`
    SELECT id FROM job_runs
    WHERE job_name = ? AND status = 'success' AND started_at > ?
    LIMIT 1
  `);

  return Boolean(stmt.get(jobName, threshold));
}

/**
 * Check if a job_key has a successful run (deterministic idempotency)
 * @param {string} jobKey - Deterministic window key (e.g., "nhl|fixed|2026-02-27|0900")
 * @returns {boolean}
 */
function hasSuccessfulJobRun(jobKey) {
  if (!jobKey) return false;

  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT 1
    FROM job_runs
    WHERE job_key = ?
      AND status = 'success'
    LIMIT 1
  `);

  const row = stmt.get(jobKey);
  return Boolean(row);
}

/**
 * Check if a job_key has a currently running job (prevents overlap)
 * @param {string} jobKey - Deterministic window key
 * @returns {boolean}
 */
function hasRunningJobRun(jobKey) {
  if (!jobKey) return false;

  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT 1
    FROM job_runs
    WHERE job_key = ?
      AND status = 'running'
    LIMIT 1
  `);

  const row = stmt.get(jobKey);
  return Boolean(row);
}

/**
 * Check if any run for a job_name is currently running.
 * Used when overlap protection must span multiple window-scoped job keys.
 * @param {string} jobName - Job name
 * @returns {boolean}
 */
function hasRunningJobName(jobName) {
  if (!jobName) return false;

  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT 1
    FROM job_runs
    WHERE job_name = ?
      AND status = 'running'
    LIMIT 1
  `);

  const row = stmt.get(jobName);
  return Boolean(row);
}

/**
 * Determine if a job_key should run (abstracts success/running/failed logic)
 * @param {string} jobKey - Deterministic window key
 * @returns {boolean} - true if should run, false if should skip
 */
function shouldRunJobKey(jobKey) {
  if (!jobKey) return true; // manual runs without idempotency

  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT status
    FROM job_runs
    WHERE job_key = ?
    ORDER BY started_at DESC
    LIMIT 1
  `);

  const row = stmt.get(jobKey);

  // If never run -> run
  if (!row) return true;

  // If success -> skip
  if (row.status === 'success') return false;

  // If running -> skip (avoid overlap)
  if (row.status === 'running') return false;

  // If failed -> allow retry
  return true;
}

/**
 * Get latest job run for a given job_key (debugging/monitoring)
 * @param {string} jobKey - Deterministic window key
 * @returns {object|null} - Latest job run record or null
 */
function getLatestJobRunByKey(jobKey) {
  if (!jobKey) return null;

  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT id, job_name, job_key, status, started_at, ended_at, error_message
    FROM job_runs
    WHERE job_key = ?
    ORDER BY started_at DESC
    LIMIT 1
  `);

  return stmt.get(jobKey) || null;
}

/**
 * Check if a job_key was successful in the last N minutes (time-bounded variant)
 * @param {string} jobKey - Deterministic window key
 * @param {number} minutesAgo - Window
 * @returns {boolean}
 */
function wasJobKeyRecentlySuccessful(jobKey, minutesAgo = 60) {
  if (!jobKey) return false;

  const db = getDatabase();
  const threshold = new Date(Date.now() - minutesAgo * 60000).toISOString();

  const stmt = db.prepare(`
    SELECT 1
    FROM job_runs
    WHERE job_key = ?
      AND status = 'success'
      AND started_at > ?
    LIMIT 1
  `);

  return Boolean(stmt.get(jobKey, threshold));
}

/**
 * Insert a model output (inference result)
 * @param {object} output - Model output data
 * @param {string} output.id - Unique ID
 * @param {string} output.gameId - Game ID
 * @param {string} output.sport - Sport name
 * @param {string} output.modelName - Model name (e.g., 'nhl-model-v1')
 * @param {string} output.modelVersion - Version string
 * @param {string} output.predictionType - Type of prediction (e.g., 'moneyline', 'spread', 'total')
 * @param {string} output.predictedAt - ISO 8601 timestamp
 * @param {number} output.confidence - Confidence score (0-1)
 * @param {object} output.outputData - Full inference output (will be stringified)
 * @param {string} output.oddsSnapshotId - Optional reference to odds_snapshot
 * @param {string} output.jobRunId - Optional reference to job_run
 */
function insertModelOutput(output) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO model_outputs (
      id, game_id, sport, model_name, model_version, prediction_type,
      predicted_at, confidence, output_data, odds_snapshot_id, job_run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    output.id,
    output.gameId,
    output.sport,
    output.modelName,
    output.modelVersion,
    output.predictionType,
    output.predictedAt,
    output.confidence || null,
    output.outputData ? JSON.stringify(output.outputData) : '{}',
    output.oddsSnapshotId || null,
    output.jobRunId || null
  );
}

/**
 * Get latest model output for a game + model combo
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @returns {object|null} Model output or null
 */
function getLatestModelOutput(gameId, modelName) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM model_outputs
    WHERE game_id = ? AND model_name = ?
    ORDER BY predicted_at DESC
    LIMIT 1
  `);
  
  return stmt.get(gameId, modelName) || null;
}

/**
 * Get all model outputs for a game
 * @param {string} gameId - Game ID
 * @returns {array} Model outputs
 */
function getModelOutputs(gameId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM model_outputs
    WHERE game_id = ?
    ORDER BY model_name, predicted_at DESC
  `);
  
  return stmt.all(gameId);
}

/**
 * Get model outputs for a sport since a given time
 * @param {string} sport - Sport name
 * @param {string} sinceUtc - ISO 8601 timestamp
 * @returns {array} Model outputs
 */
function getModelOutputsBySport(sport, sinceUtc) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM model_outputs
    WHERE sport = ? AND predicted_at >= ?
    ORDER BY game_id, model_name, predicted_at DESC
  `);
  
  return stmt.all(sport, sinceUtc);
}

/**
 * Delete model outputs for a game + model combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @returns {number} Count of deleted rows
 */
function deleteModelOutputsForGame(gameId, modelName) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM model_outputs
    WHERE game_id = ? AND model_name = ?
  `);
  
  const result = stmt.run(gameId, modelName);
  return result.changes;
}

/**
 * Delete card payloads for a game + card type combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} cardType - Card type
 * @returns {number} Count of deleted rows
 */
function deleteCardPayloadsByGameAndType(gameId, cardType, options = {}) {
  return deleteCardPayloadsForGame(gameId, cardType, options);
}

/**
 * Prepare idempotent writes for model outputs and card payloads
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @param {string} cardType - Card type
 * @param {{runId?: string}} options - Run scope for payload cleanup (required)
 * @returns {{deletedOutputs: number, deletedCards: number}}
 */
function normalizeRunScopeId(options = {}) {
  if (typeof options.runId !== 'string') return null;
  const normalized = options.runId.trim();
  return normalized.length > 0 ? normalized : null;
}

function prepareModelAndCardWrite(gameId, modelName, cardType, options = {}) {
  const runId = normalizeRunScopeId(options);
  if (!runId) {
    const error = new Error(
      '[DB] prepareModelAndCardWrite requires a non-empty options.runId for run-scoped writes.',
    );
    error.code = 'RUN_ID_REQUIRED';
    throw error;
  }

  const deletedOutputs = deleteModelOutputsByGame(gameId, modelName);
  const deletedCards = deleteCardPayloadsByGameAndType(
    gameId,
    cardType,
    { ...options, runId },
  );
  return { deletedOutputs, deletedCards };
}

/**
 * Delete card payloads for a game + card type combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} cardType - Card type
 * @param {{runId?: string}} options - Optional run scope for payload cleanup
 * @returns {number} Count of deleted rows
 */
function deleteCardPayloadsForGame(gameId, cardType, options = {}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const runId = normalizeRunScopeId(options);

  // Run-scoped cleanup allows workers to stage new run rows without removing
  // currently published run rows, preventing transient empty API reads.
  const runScopeClause = runId ? ' AND run_id = ?' : '';
  const runScopeParams = runId ? [runId] : [];

  // Rewrites are only allowed for unsettled rows. Remove pending result links first,
  // then delete unreferenced payloads. Settled payloads are retained for audit integrity.
  const deletePendingResultsStmt = db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (
        SELECT id
        FROM card_payloads
        WHERE game_id = ? AND card_type = ?${runScopeClause}
      )
  `);
  deletePendingResultsStmt.run(gameId, cardType, ...runScopeParams);

  const deleteUnreferencedPayloadsStmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE game_id = ? AND card_type = ?
      ${runScopeClause}
      AND id NOT IN (
        SELECT card_id
        FROM card_results
      )
  `);
  const deleted = deleteUnreferencedPayloadsStmt.run(
    gameId,
    cardType,
    ...runScopeParams,
  ).changes;

  // Keep referenced payloads immutable but stale so current-card reads ignore them.
  const expireReferencedPayloadsStmt = db.prepare(`
    UPDATE card_payloads
    SET expires_at = COALESCE(expires_at, ?), updated_at = ?
    WHERE game_id = ? AND card_type = ?
      ${runScopeClause}
      AND id IN (
        SELECT card_id
        FROM card_results
      )
      AND expires_at IS NULL
  `);
  expireReferencedPayloadsStmt.run(now, now, gameId, cardType, ...runScopeParams);

  return deleted;
}

/**
 * Insert a card result row (settlement tracking)
 * @param {object} result - Card result data
 * @param {string} result.id - Unique ID
 * @param {string} result.cardId - Card ID
 * @param {string} result.gameId - Game ID
 * @param {string} result.sport - Sport name
 * @param {string} result.cardType - Card type
 * @param {string} result.recommendedBetType - Recommended bet type (moneyline/spread/etc)
 * @param {string} result.status - Status (pending/settled/void/error)
 * @param {string|null} result.result - Result (win/loss/push/void)
 * @param {string|null} result.settledAt - ISO 8601 timestamp
 * @param {number|null} result.pnlUnits - P&L in units
 * @param {object|null} result.metadata - Optional metadata
 */
function insertCardResult(result) {
  const db = getDatabase();
  const canonicalSport = normalizeSportCode(result.sport, 'insertCardResult');
  const normalizedSport = canonicalSport
    ? canonicalSport.toLowerCase()
    : (result.sport ? String(result.sport).toLowerCase() : result.sport);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO card_results (
      id, card_id, game_id, sport, card_type, recommended_bet_type,
      market_key, market_type, selection, line, locked_price,
      status, result, settled_at, pnl_units, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    result.id,
    result.cardId,
    result.gameId,
    normalizedSport,
    result.cardType,
    result.recommendedBetType,
    result.marketKey || null,
    result.marketType || null,
    result.selection || null,
    result.line !== undefined ? result.line : null,
    result.lockedPrice !== undefined ? result.lockedPrice : null,
    result.status,
    result.result || null,
    result.settledAt || null,
    result.pnlUnits !== undefined ? result.pnlUnits : null,
    result.metadata ? JSON.stringify(result.metadata) : null
  );
}

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function toFiniteNumberOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function resolveOfficialPlayStatus(payloadData) {
  const officialStatus = toUpperToken(payloadData?.decision_v2?.official_status);
  if (officialStatus === 'PLAY' || officialStatus === 'LEAN' || officialStatus === 'PASS') {
    return officialStatus;
  }

  // Legacy fallback for payloads that predate decision_v2.
  const legacyStatus = toUpperToken(payloadData?.status);
  if (legacyStatus === 'FIRE') return 'PLAY';
  if (legacyStatus === 'WATCH') return 'LEAN';
  if (legacyStatus === 'PASS') return 'PASS';

  return '';
}

function normalizeMarketTypeForTracking(rawValue) {
  const token = toUpperToken(rawValue).replace(/[\s-]+/g, '_');
  if (!token) return '';

  if (token === 'MONEYLINE' || token === 'ML' || token === 'H2H') return 'MONEYLINE';
  if (token === 'SPREAD' || token === 'PUCKLINE' || token === 'PUCK_LINE') return 'SPREAD';
  if (
    token === 'TOTAL' ||
    token === 'TOTALS' ||
    token === 'OVER_UNDER' ||
    token === 'OU' ||
    token === 'FIRST_PERIOD' ||
    token === '1P' ||
    token === 'P1'
  ) {
    return 'TOTAL';
  }

  return token;
}

function resolveTrackingPeriod(payloadData, context = {}) {
  const explicitPeriod = normalizeMarketPeriod(
    context.period ??
      payloadData?.period ??
      payloadData?.time_period ??
      payloadData?.market?.period ??
      payloadData?.market_context?.period ??
      payloadData?.market_context?.wager?.period ??
      payloadData?.pricing_trace?.period ??
      null
  );
  if (explicitPeriod) return explicitPeriod;

  const marketToken = toUpperToken(
    context.marketType ??
      payloadData?.market_type ??
      payloadData?.market_context?.market_type ??
      payloadData?.recommended_bet_type
  ).replace(/[\s-]+/g, '_');

  if (marketToken === 'FIRST_PERIOD' || marketToken === '1P' || marketToken === 'P1') {
    return '1P';
  }

  return 'FULL_GAME';
}

function shouldTrackDisplayedPlay(payloadData, context = {}) {
  const kind = toUpperToken(payloadData?.kind || 'PLAY');
  if (kind !== 'PLAY') return false;

  const sport = toUpperToken(context.sport ?? payloadData?.sport);
  const marketType = normalizeMarketTypeForTracking(
    context.marketType ??
      payloadData?.market_type ??
      payloadData?.market_context?.market_type ??
      payloadData?.recommended_bet_type
  );
  const selection = toUpperToken(
    context.selection ??
      payloadData?.selection?.side ??
      payloadData?.selection
  );
  const line =
    context.line !== undefined
      ? toFiniteNumberOrNull(context.line)
      : toFiniteNumberOrNull(payloadData?.line);
  const price =
    context.price !== undefined
      ? toFiniteNumberOrNull(context.price)
      : toFiniteNumberOrNull(payloadData?.price);
  const officialStatus = resolveOfficialPlayStatus(payloadData);
  const isActionable = officialStatus === 'PLAY' || officialStatus === 'LEAN';
  if (!isActionable) return false;

  if (!sport || !marketType) return false;

  if (marketType === 'MONEYLINE') {
    return (selection === 'HOME' || selection === 'AWAY') && price !== null;
  }
  if (marketType === 'SPREAD') {
    return (
      (selection === 'HOME' || selection === 'AWAY') &&
      line !== null &&
      price !== null
    );
  }
  if (marketType === 'TOTAL') {
    const period = resolveTrackingPeriod(payloadData, context);
    return (
      (selection === 'OVER' || selection === 'UNDER') &&
      line !== null &&
      (price !== null || period === '1P')
    );
  }

  return false;
}

function hasCardDisplayLogTable(db) {
  const row = db
    .prepare(
      `
      SELECT 1 AS exists_flag
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'card_display_log'
      LIMIT 1
    `,
    )
    .get();
  return Boolean(row);
}

function rankOfficialStatus(statusToken) {
  if (statusToken === 'PLAY') return 2;
  if (statusToken === 'LEAN') return 1;
  return 0;
}

function safeTimestampMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function toSortableNumber(value, fallback = -Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function toConfidencePct(payloadData, fallbackValue = null) {
  const confidencePct = toFiniteNumberOrNull(payloadData?.confidence_pct);
  if (confidencePct !== null) return confidencePct;
  const confidence = toFiniteNumberOrNull(payloadData?.confidence);
  if (confidence !== null) return confidence * 100;
  return toFiniteNumberOrNull(fallbackValue) ?? 0;
}

function get30DayPerformanceFactor(db, params, cache) {
  const sport = toUpperToken(params?.sport);
  const marketType = toUpperToken(params?.marketType);
  const anchorIso = params?.anchorIso || new Date().toISOString();
  const cacheKey = `${sport}|${marketType}|${String(anchorIso).slice(0, 10)}`;

  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!sport || !marketType) {
    const fallback = { factor: 1, sampleSize: 0 };
    if (cache) cache.set(cacheKey, fallback);
    return fallback;
  }

  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
      FROM card_results
      WHERE status = 'settled'
        AND UPPER(COALESCE(sport, '')) = ?
        AND UPPER(COALESCE(market_type, '')) = ?
        AND datetime(COALESCE(settled_at, CURRENT_TIMESTAMP)) >= datetime(?, '-30 days')
    `,
    )
    .get(sport, marketType, anchorIso);

  const wins = Number(row?.wins || 0);
  const losses = Number(row?.losses || 0);
  const sampleSize = wins + losses;
  const factor = sampleSize >= 25 && sampleSize > 0 ? wins / sampleSize : 1;
  const result = { factor, sampleSize };
  if (cache) cache.set(cacheKey, result);
  return result;
}

function buildDisplayedPlayRankContext(db, candidate, cache) {
  const payloadData =
    candidate?.payloadData && typeof candidate.payloadData === 'object'
      ? candidate.payloadData
      : {};
  const officialStatus = resolveOfficialPlayStatus(payloadData);
  const statusRank = rankOfficialStatus(officialStatus);
  const confidencePct = toConfidencePct(payloadData, candidate?.confidencePct);
  const perf = get30DayPerformanceFactor(
    db,
    {
      sport: candidate?.sport,
      marketType: candidate?.marketType,
      anchorIso: candidate?.displayedAt || new Date().toISOString(),
    },
    cache,
  );
  const weightedConfidence = confidencePct * perf.factor;
  const edgePct = toSortableNumber(
    payloadData?.decision_v2?.edge_delta_pct ?? payloadData?.decision_v2?.edge_pct,
  );
  const supportScore = toSortableNumber(payloadData?.decision_v2?.support_score);
  const displayedAtMs = safeTimestampMs(candidate?.displayedAt);
  const pickId = String(candidate?.pickId || '');

  return {
    statusRank,
    weightedConfidence,
    edgePct,
    supportScore,
    displayedAtMs,
    pickId,
  };
}

function compareDisplayedPlayRank(a, b) {
  if (a.statusRank !== b.statusRank) return a.statusRank - b.statusRank;
  if (a.weightedConfidence !== b.weightedConfidence) {
    return a.weightedConfidence - b.weightedConfidence;
  }
  if (a.edgePct !== b.edgePct) return a.edgePct - b.edgePct;
  if (a.supportScore !== b.supportScore) return a.supportScore - b.supportScore;
  if (a.displayedAtMs !== b.displayedAtMs) return a.displayedAtMs - b.displayedAtMs;
  if (a.pickId === b.pickId) return 0;
  return a.pickId > b.pickId ? 1 : -1;
}

function upsertBestDisplayedPlayLog(db, entry) {
  if (!hasCardDisplayLogTable(db)) return false;

  const existing = db
    .prepare(
      `
      SELECT
        id,
        pick_id,
        sport,
        market_type,
        line,
        odds,
        confidence_pct,
        displayed_at
      FROM card_display_log
      WHERE game_id = ?
        AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)
      ORDER BY datetime(displayed_at) DESC, id DESC
      LIMIT 1
    `,
    )
    .get(
      entry.gameId,
      entry.runId,
      entry.runId,
    );

  if (!existing) {
    db.prepare(
      `
      INSERT OR IGNORE INTO card_display_log (
        pick_id, run_id, game_id, sport, market_type, selection, line,
        odds, odds_book, confidence_pct, displayed_at, api_endpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      entry.pickId,
      entry.runId || null,
      entry.gameId || null,
      entry.sport || null,
      entry.marketType || null,
      entry.selection || null,
      entry.line !== undefined ? entry.line : null,
      entry.odds !== undefined ? entry.odds : null,
      entry.oddsBook || null,
      entry.confidencePct !== undefined ? entry.confidencePct : null,
      entry.displayedAt || new Date().toISOString(),
      entry.apiEndpoint || '/api/games',
    );
    return true;
  }

  if (existing.pick_id !== entry.pickId) {
    const cache = new Map();
    const existingPayloadRow = db
      .prepare(
        `
        SELECT payload_data
        FROM card_payloads
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(existing.pick_id);

    let existingPayloadData = {};
    if (existingPayloadRow?.payload_data) {
      try {
        existingPayloadData = JSON.parse(existingPayloadRow.payload_data);
      } catch {
        existingPayloadData = {};
      }
    }

    const candidateRank = buildDisplayedPlayRankContext(
      db,
      {
        pickId: entry.pickId,
        sport: entry.sport,
        marketType: entry.marketType,
        confidencePct: entry.confidencePct,
        displayedAt: entry.displayedAt,
        payloadData: entry.payloadData,
      },
      cache,
    );
    const existingRank = buildDisplayedPlayRankContext(
      db,
      {
        pickId: existing.pick_id,
        sport: existing.sport,
        marketType: existing.market_type,
        confidencePct: existing.confidence_pct,
        displayedAt: existing.displayed_at,
        payloadData: existingPayloadData,
      },
      cache,
    );

    if (compareDisplayedPlayRank(candidateRank, existingRank) <= 0) {
      return false;
    }
  }

  db.prepare(
    `DELETE FROM card_display_log WHERE pick_id = ? AND id != ?`,
  ).run(entry.pickId, existing.id);

  db.prepare(
    `
      UPDATE card_display_log
      SET
        pick_id = ?,
        run_id = ?,
        game_id = ?,
        sport = ?,
        market_type = ?,
        selection = ?,
        line = ?,
        odds = ?,
        odds_book = ?,
        confidence_pct = ?,
        displayed_at = ?,
        api_endpoint = ?
      WHERE id = ?
    `,
  ).run(
    entry.pickId,
    entry.runId || null,
    entry.gameId || null,
    entry.sport || null,
    entry.marketType || null,
    entry.selection || null,
    entry.line !== undefined ? entry.line : null,
    entry.odds !== undefined ? entry.odds : null,
    entry.oddsBook || null,
    entry.confidencePct !== undefined ? entry.confidencePct : null,
    entry.displayedAt || new Date().toISOString(),
    entry.apiEndpoint || '/api/games',
    existing.id,
  );
  return true;
}

/**
 * Insert a card payload (web-ready data)
 * @param {object} card - Card payload data
 * @param {string} card.id - Unique ID
 * @param {string} card.gameId - Game ID
 * @param {string} card.sport - Sport name
 * @param {string} card.cardType - Card type (e.g., 'clv-analysis', 'pick', 'line-movement')
 * @param {string} card.cardTitle - Display title
 * @param {string} card.createdAt - ISO 8601 timestamp
 * @param {string} card.expiresAt - Optional ISO 8601 timestamp (when card becomes stale)
 * @param {object} card.payloadData - The actual card data (will be stringified)
 * @param {string} card.modelOutputIds - Optional comma-separated IDs of related model outputs
 * @param {object} card.metadata - Optional metadata object
 * @param {string} card.runId - Optional snapshot run ID
 */
function insertCardPayload(card) {
  const db = getDatabase();
  const normalizedCardTitle = normalizeCardTitle(card.cardTitle, 'insertCardPayload');
  const payloadData = card.payloadData && typeof card.payloadData === 'object'
    ? card.payloadData
    : {};
  const runId = card.runId ?? payloadData.run_id ?? null;
  const normalizedRunId = runId ? String(runId) : null;
  if (normalizedRunId && !payloadData.run_id) {
    payloadData.run_id = normalizedRunId;
  }

  // 1P driver projections (nhl-pace-1p) have no priced odds — PASS calls (selection.side=NONE)
  // are not actionable and skip market locking entirely; OVER/UNDER calls lock without a price.
  const is1pDriver = String(card.cardType || '').includes('-pace-1p');
  const is1pPassCall = is1pDriver && toUpperToken(payloadData?.selection?.side) === 'NONE';
  // Without Odds Mode: LEAN cards have no market price — skip price requirement at lock time.
  const isNoOddsModeLean = Array.isArray(payloadData?.tags) && payloadData.tags.includes('no_odds_mode');

  let lockedMarket = null;
  if (!is1pPassCall) {
    try {
      lockedMarket = deriveLockedMarketContext(payloadData, {
        gameId: card.gameId,
        homeTeam: payloadData.home_team ?? null,
        awayTeam: payloadData.away_team ?? null,
        requirePrice: !is1pDriver && !isNoOddsModeLean,
        requireLineForMarket: !isNoOddsModeLean,
      });
    } catch (error) {
      const code = error?.code || 'INVALID_MARKET_CONTRACT';
      throw createMarketError(
        code,
        `[DB] Refusing to lock invalid market payload for card ${card.id}: ${error.message}`,
        { cardId: card.id, gameId: card.gameId, cause: error?.details || null }
      );
    }
  }

  if (lockedMarket) {
    payloadData.market_type = lockedMarket.marketType;
    payloadData.recommended_bet_type = toRecommendedBetType(lockedMarket.marketType);
    payloadData.selection = {
      ...(payloadData.selection && typeof payloadData.selection === 'object' ? payloadData.selection : {}),
      side: lockedMarket.selection,
    };
    if (lockedMarket.line !== null) payloadData.line = lockedMarket.line;
    if (lockedMarket.lockedPrice !== null) payloadData.price = lockedMarket.lockedPrice;
    if (lockedMarket.period) {
      payloadData.period = lockedMarket.period;
      payloadData.market = {
        ...(payloadData.market && typeof payloadData.market === 'object'
          ? payloadData.market
          : {}),
        period: lockedMarket.period,
      };
    }
    payloadData.market_key = lockedMarket.marketKey;
  }

  const oddsContext = payloadData?.odds_context;
  if (lockedMarket && oddsContext && typeof oddsContext === 'object') {
    // Ensure registry exists (defensive check)
    if (!oddsContextReferenceRegistry) {
      oddsContextReferenceRegistry = new WeakMap();
    }
    
    const existing = oddsContextReferenceRegistry.get(oddsContext);
    if (
      existing &&
      existing.gameId === card.gameId &&
      existing.marketKey !== lockedMarket.marketKey
    ) {
      throw createMarketError(
        'SHARED_ODDS_CONTEXT_REFERENCE',
        `[DB] Two market rows share the same odds_context object reference for game ${card.gameId}`,
        {
          gameId: card.gameId,
          firstCardId: existing.cardId,
          firstMarketKey: existing.marketKey,
          secondCardId: card.id,
          secondMarketKey: lockedMarket.marketKey,
        }
      );
    }

    oddsContextReferenceRegistry.set(oddsContext, {
      cardId: card.id,
      gameId: card.gameId,
      marketKey: lockedMarket.marketKey,
    });
  }
  
  ensureCardPayloadRunIdColumn(db);

    // Normalize sport to lowercase for consistency with odds_snapshots and games table
    const normalizedSport = card.sport ? card.sport.toLowerCase() : card.sport;

  const stmt = db.prepare(`
    INSERT INTO card_payloads (
      id, game_id, sport, card_type, card_title, created_at,
      expires_at, payload_data, model_output_ids, metadata, run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    card.id,
    card.gameId,
    normalizedSport,
    card.cardType,
    normalizedCardTitle,
    card.createdAt,
    card.expiresAt || null,
    JSON.stringify(payloadData),
    card.modelOutputIds || null,
    card.metadata ? JSON.stringify(card.metadata) : null,
    normalizedRunId
  );

  const recommendedBetType = lockedMarket
    ? toRecommendedBetType(lockedMarket.marketType)
    : (payloadData?.recommended_bet_type || 'unknown');

  insertCardResult({
    id: `card-result-${card.id}`,
    cardId: card.id,
    gameId: card.gameId,
    sport: card.sport,
    cardType: card.cardType,
    recommendedBetType,
    marketKey: lockedMarket?.marketKey || null,
    marketType: lockedMarket?.marketType || null,
    selection: lockedMarket?.selection || null,
    line: lockedMarket?.line ?? null,
    lockedPrice: lockedMarket?.lockedPrice ?? null,
    status: 'pending',
    result: null,
    settledAt: null,
    pnlUnits: null,
    metadata: lockedMarket
      ? {
          lockedAt: card.createdAt || new Date().toISOString(),
          marketKey: lockedMarket.marketKey,
          lockedMarket: {
            marketType: lockedMarket.marketType,
            selection: lockedMarket.selection,
            line: lockedMarket.line,
            lockedPrice: lockedMarket.lockedPrice,
            period: lockedMarket.period || 'FULL_GAME',
          },
        }
      : null
  });

  if (
    lockedMarket &&
    shouldTrackDisplayedPlay(payloadData, {
      sport: card.sport,
      marketType: lockedMarket.marketType,
      period: lockedMarket.period,
      selection: lockedMarket.selection,
      line: lockedMarket.line,
      price: lockedMarket.lockedPrice,
    })
  ) {
    const confidencePct = toFiniteNumberOrNull(payloadData?.confidence_pct);
    const fallbackConfidence = toFiniteNumberOrNull(payloadData?.confidence);
    const normalizedConfidence =
      confidencePct !== null
        ? confidencePct
        : fallbackConfidence !== null
          ? fallbackConfidence * 100
          : null;

    upsertBestDisplayedPlayLog(db, {
      pickId: card.id,
      runId: normalizedRunId,
      gameId: card.gameId,
      sport: card.sport ? String(card.sport).toUpperCase() : null,
      marketType: lockedMarket.marketType,
      selection: lockedMarket.selection,
      line: lockedMarket.line,
      odds: lockedMarket.lockedPrice,
      oddsBook: payloadData?.odds_context?.bookmaker || null,
      confidencePct: normalizedConfidence,
      displayedAt: card.createdAt || new Date().toISOString(),
      apiEndpoint: '/api/games',
      payloadData,
    });
  }
}

/**
 * Get card payload by ID
 * @param {string} cardId - Card ID
 * @returns {object|null} Card payload or null
 */
function getCardPayload(cardId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE id = ?
  `);
  
  return stmt.get(cardId) || null;
}

/**
 * Get all cards for a game
 * @param {string} gameId - Game ID
 * @returns {array} Card payloads
 */
function getCardPayloads(gameId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE game_id = ?
    ORDER BY created_at DESC
  `);
  
  return stmt.all(gameId);
}

/**
 * Get cards by type (e.g., all 'clv-analysis' cards)
 * @param {string} cardType - Card type
 * @param {number} limitDays - Return cards from last N days (default 7)
 * @returns {array} Card payloads
 */
function getCardPayloadsByType(cardType, limitDays = 7) {
  const db = getDatabase();
  const threshold = new Date(Date.now() - limitDays * 86400000).toISOString();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE card_type = ? AND created_at >= ?
    ORDER BY created_at DESC
  `);
  
  return stmt.all(cardType, threshold);
}

/**
 * Get cards for a sport
 * @param {string} sport - Sport name
 * @param {number} limitCards - Max cards per game (default 10)
 * @returns {array} Card payloads
 */
function getCardPayloadsBySport(sport, limitCards = 10) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE sport = ?
    ORDER BY game_id, created_at DESC
    LIMIT ?
  `);
  
  return stmt.all(sport, limitCards);
}

/**
 * Mark a card as expired
 * @param {string} cardId - Card ID
 */
function expireCardPayload(cardId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE card_payloads
    SET expires_at = datetime('now'), updated_at = ?
    WHERE id = ?
  `);
  
  stmt.run(new Date().toISOString(), cardId);
}

/**
 * Delete old expired cards (cleanup)
 * @param {number} daysOld - Delete cards older than N days (default 30)
 * @returns {number} Count of deleted cards
 */
function deleteExpiredCards(daysOld = 30) {
  const db = getDatabase();
  const threshold = new Date(Date.now() - daysOld * 86400000).toISOString();

  // Drop pending settlement rows for payloads that are already expired and being pruned.
  const deletePendingResultsStmt = db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (
        SELECT id
        FROM card_payloads
        WHERE expires_at IS NOT NULL AND expires_at < ?
      )
  `);
  deletePendingResultsStmt.run(threshold);

  // Never delete payloads still referenced by card_results; preserve audit integrity.
  const stmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE expires_at IS NOT NULL
      AND expires_at < ?
      AND id NOT IN (
        SELECT card_id
        FROM card_results
      )
  `);

  const result = stmt.run(threshold);
  return result.changes;
}

/**
 * Get the current published decision record
 * @param {string} decisionKey
 * @returns {object|null}
 */
function getDecisionRecord(decisionKey) {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM decision_records
    WHERE decision_key = ?
  `);

  return stmt.get(decisionKey) || null;
}

/**
 * Upsert a decision record (published decision)
 * @param {object} record
 */
function upsertDecisionRecord(record) {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO decision_records (
      decision_key, sport, game_id, market, period, side_family,
      recommended_side, recommended_line, recommended_price, book,
      edge, confidence, locked_status, locked_at, last_seen_at,
      result_version, inputs_hash, odds_snapshot_id,
      flip_count, last_flip_at, last_reason_code, last_reason_detail,
      last_candidate_hash, candidate_seen_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(decision_key) DO UPDATE SET
      sport = excluded.sport,
      game_id = excluded.game_id,
      market = excluded.market,
      period = excluded.period,
      side_family = excluded.side_family,
      recommended_side = excluded.recommended_side,
      recommended_line = excluded.recommended_line,
      recommended_price = excluded.recommended_price,
      book = excluded.book,
      edge = excluded.edge,
      confidence = excluded.confidence,
      locked_status = CASE
        WHEN decision_records.locked_status = 'HARD' THEN 'HARD'
        ELSE excluded.locked_status
      END,
      locked_at = CASE
        WHEN decision_records.locked_status = 'HARD' THEN decision_records.locked_at
        WHEN excluded.locked_status = 'HARD' THEN excluded.locked_at
        ELSE decision_records.locked_at
      END,
      last_seen_at = excluded.last_seen_at,
      result_version = excluded.result_version,
      inputs_hash = excluded.inputs_hash,
      odds_snapshot_id = excluded.odds_snapshot_id,
      flip_count = CASE
        WHEN excluded.recommended_side != decision_records.recommended_side THEN decision_records.flip_count + 1
        ELSE decision_records.flip_count
      END,
      last_flip_at = CASE
        WHEN excluded.recommended_side != decision_records.recommended_side THEN excluded.last_seen_at
        ELSE decision_records.last_flip_at
      END,
      last_reason_code = excluded.last_reason_code,
      last_reason_detail = excluded.last_reason_detail,
      last_candidate_hash = excluded.last_candidate_hash,
      candidate_seen_count = excluded.candidate_seen_count
  `);

  stmt.run(
    record.decisionKey,
    record.sport,
    record.gameId,
    record.market,
    record.period,
    record.sideFamily,
    record.recommendedSide,
    record.recommendedLine,
    record.recommendedPrice,
    record.book || null,
    record.edge,
    record.confidence ?? null,
    record.lockedStatus,
    record.lockedAt || null,
    record.lastSeenAt,
    record.resultVersion || null,
    record.inputsHash || null,
    record.oddsSnapshotId || null,
    record.flipCount ?? 0,
    record.lastFlipAt || null,
    record.lastReasonCode || null,
    record.lastReasonDetail || null,
    record.lastCandidateHash || null,
    record.candidateSeenCount ?? 0
  );
}

/**
 * Update candidate tracking without changing published decision
 * @param {object} update
 */
function updateDecisionCandidateTracking(update) {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE decision_records
    SET last_seen_at = ?,
        last_candidate_hash = ?,
        candidate_seen_count = ?,
        last_reason_code = ?,
        last_reason_detail = ?,
        locked_status = CASE
          WHEN ? IS NULL THEN locked_status
          WHEN locked_status = 'HARD' THEN locked_status
          ELSE ?
        END,
        locked_at = CASE
          WHEN ? IS NULL THEN locked_at
          WHEN locked_status = 'HARD' THEN locked_at
          WHEN ? = 'HARD' THEN ?
          ELSE locked_at
        END
    WHERE decision_key = ?
  `);

  stmt.run(
    update.lastSeenAt,
    update.lastCandidateHash || null,
    update.candidateSeenCount ?? 0,
    update.lastReasonCode || null,
    update.lastReasonDetail || null,
    update.lockedStatus || null,
    update.lockedStatus || null,
    update.lockedStatus || null,
    update.lockedStatus || null,
    update.lockedAt || null,
    update.decisionKey
  );
}

/**
 * Insert a decision event audit record
 * @param {object} event
 */
function insertDecisionEvent(event) {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO decision_events (
      ts, decision_key, action, reason_code, reason_detail,
      prev_side, prev_line, prev_price, prev_edge,
      cand_side, cand_line, cand_price, cand_edge,
      edge_delta, line_delta, price_delta,
      inputs_hash, result_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    event.ts,
    event.decisionKey,
    event.action,
    event.reasonCode,
    event.reasonDetail || null,
    event.prevSide || null,
    event.prevLine ?? null,
    event.prevPrice ?? null,
    event.prevEdge ?? null,
    event.candSide,
    event.candLine ?? null,
    event.candPrice ?? null,
    event.candEdge,
    event.edgeDelta ?? null,
    event.lineDelta ?? null,
    event.priceDelta ?? null,
    event.inputsHash || null,
    event.resultVersion || null
  );
}

/**
 * Get upcoming games for scheduler window detection
 * @param {object} params
 * @param {string} params.startUtcIso - Start time (ISO 8601 UTC)
 * @param {string} params.endUtcIso - End time (ISO 8601 UTC)
 * @param {string[]} params.sports - Optional array of sports to filter (e.g., ['nhl', 'nba'])
 * @returns {array} Games [{game_id, sport, game_time_utc}, ...]
 */
function getUpcomingGames({ startUtcIso, endUtcIso, sports = [] }) {
  const db = getDatabase();

  const baseSql = `
    SELECT game_id, sport, game_time_utc
    FROM games
    WHERE game_time_utc IS NOT NULL
      AND game_time_utc >= ?
      AND game_time_utc <= ?
  `;

  if (sports && sports.length > 0) {
    const placeholders = sports.map(() => '?').join(', ');
    const stmt = db.prepare(`${baseSql} AND LOWER(sport) IN (${placeholders}) ORDER BY game_time_utc ASC`);
    return stmt.all(startUtcIso, endUtcIso, ...sports.map(s => s.toLowerCase()));
  }

  const stmt = db.prepare(`${baseSql} ORDER BY game_time_utc ASC`);
  return stmt.all(startUtcIso, endUtcIso);
}

/**
 * Upsert a game result (settlement data)
 * @param {object} result - Game result data
 * @param {string} result.id - Unique ID for result record
 * @param {string} result.gameId - Game ID (FK to games)
 * @param {string} result.sport - Sport code
 * @param {number} result.finalScoreHome - Home team final score
 * @param {number} result.finalScoreAway - Away team final score
 * @param {string} result.status - 'in_progress' | 'final' | 'cancelled' | 'postponed'
 * @param {string} result.resultSource - 'primary_api' | 'backup_scraper' | 'manual'
 * @param {string|null} result.settledAt - ISO 8601 timestamp (when status became final)
 * @param {object|null} result.metadata - Optional metadata
 */
function upsertGameResult(result) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(result.sport, 'upsertGameResult');
  
  const stmt = db.prepare(`
    INSERT INTO game_results (
      id, game_id, sport, final_score_home, final_score_away,
      status, result_source, settled_at, metadata, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(game_id) DO UPDATE SET
      final_score_home = excluded.final_score_home,
      final_score_away = excluded.final_score_away,
      status = excluded.status,
      result_source = excluded.result_source,
      settled_at = excluded.settled_at,
      metadata = excluded.metadata,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(
    result.id,
    result.gameId,
    normalizedSport,
    result.finalScoreHome,
    result.finalScoreAway,
    result.status,
    result.resultSource,
    result.settledAt || null,
    result.metadata ? JSON.stringify(result.metadata) : null
  );
}

/**
 * Get game result by game_id
 * @param {string} gameId - Game ID
 * @returns {object|null} Game result or null
 */
function getGameResult(gameId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM game_results
    WHERE game_id = ?
  `);
  
  return stmt.get(gameId) || null;
}

/**
 * Get game results by status and time window
 * @param {string} status - Status filter ('final', 'in_progress', etc)
 * @param {string} sinceUtc - ISO 8601 timestamp (only results settled after this time)
 * @returns {array} Game results
 */
function getGameResults(status, sinceUtc) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM game_results
    WHERE status = ? AND settled_at > ?
    ORDER BY settled_at DESC
  `);
  
  return stmt.all(status, sinceUtc);
}

/**
 * Upsert tracking stat
 * @param {object} stat - Tracking stat data
 * @param {string} stat.id - Unique ID
 * @param {string} stat.statKey - Composite key (sport|market|direction|confidence|driver|period)
 * @param {string} stat.sport - Sport filter
 * @param {string} stat.marketType - Market type filter
 * @param {string} stat.direction - Direction filter
 * @param {string} stat.confidenceTier - Confidence tier filter
 * @param {string} stat.driverKey - Driver filter
 * @param {string} stat.timePeriod - Time period filter
 * @param {number} stat.totalCards - Total cards count
 * @param {number} stat.settledCards - Settled cards count
 * @param {number} stat.wins - Win count
 * @param {number} stat.losses - Loss count
 * @param {number} stat.pushes - Push count
 * @param {number} stat.totalPnlUnits - Total P&L in units
 * @param {number} stat.winRate - Win rate (computed)
 * @param {number} stat.avgPnlPerCard - Avg P&L per card (computed)
 * @param {number} stat.confidenceCalibration - Confidence calibration score
 * @param {object|null} stat.metadata - Optional metadata
 */
function upsertTrackingStat(stat) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO tracking_stats (
      id, stat_key, sport, market_type, direction, confidence_tier, driver_key, time_period,
      total_cards, settled_cards, wins, losses, pushes, total_pnl_units,
      win_rate, avg_pnl_per_card, confidence_calibration, metadata, computed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(stat_key) DO UPDATE SET
      total_cards = excluded.total_cards,
      settled_cards = excluded.settled_cards,
      wins = excluded.wins,
      losses = excluded.losses,
      pushes = excluded.pushes,
      total_pnl_units = excluded.total_pnl_units,
      win_rate = excluded.win_rate,
      avg_pnl_per_card = excluded.avg_pnl_per_card,
      confidence_calibration = excluded.confidence_calibration,
      metadata = excluded.metadata,
      computed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(
    stat.id,
    stat.statKey,
    stat.sport || null,
    stat.marketType || null,
    stat.direction || null,
    stat.confidenceTier || null,
    stat.driverKey || null,
    stat.timePeriod || null,
    stat.totalCards,
    stat.settledCards,
    stat.wins,
    stat.losses,
    stat.pushes,
    stat.totalPnlUnits,
    stat.winRate,
    stat.avgPnlPerCard,
    stat.confidenceCalibration || null,
    stat.metadata ? JSON.stringify(stat.metadata) : null
  );
}

/**
 * Atomically increment tracking stat counters by delta values.
 * Race-safe for concurrent settlement processes.
 * 
 * @param {object} params - Increment parameters
 * @param {string} params.statKey - Unique stat key (e.g., "NHL|moneyline|all|all|all|alltime")
 * @param {string} params.id - Stat ID (used only on first insert)
 * @param {string} params.sport - Sport name
 * @param {string} params.marketType - Market type
 * @param {string} params.direction - Direction (HOME/AWAY/OVER/UNDER/all)
 * @param {string} params.confidenceTier - Confidence tier
 * @param {string} params.driverKey - Driver key
 * @param {string} params.timePeriod - Time period
 * @param {number} params.deltaWins - Wins to add (default 0)
 * @param {number} params.deltaLosses - Losses to add (default 0)
 * @param {number} params.deltaPushes - Pushes to add (default 0)
 * @param {number} params.deltaPnl - PnL units to add (default 0)
 * @param {object|null} params.metadata - Optional metadata
 */
function incrementTrackingStat(params) {
  const db = getDatabase();
  
  const {
    statKey,
    id,
    sport,
    marketType,
    direction,
    confidenceTier,
    driverKey,
    timePeriod,
    deltaWins = 0,
    deltaLosses = 0,
    deltaPushes = 0,
    deltaPnl = 0,
    metadata = null
  } = params;
  
  const deltaTotal = deltaWins + deltaLosses + deltaPushes;
  const deltaDecided = deltaWins + deltaLosses;
  const winRate = deltaDecided > 0 ? deltaWins / deltaDecided : 0;
  const avgPnlPerCard = deltaTotal > 0 ? deltaPnl / deltaTotal : 0;
  
  // Insert new row or increment existing counters atomically
  const stmt = db.prepare(`
    INSERT INTO tracking_stats (
      id, stat_key, sport, market_type, direction, confidence_tier, driver_key, time_period,
      total_cards, settled_cards, wins, losses, pushes, total_pnl_units,
      win_rate, avg_pnl_per_card, confidence_calibration, metadata, computed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(stat_key) DO UPDATE SET
      total_cards = total_cards + ?,
      settled_cards = settled_cards + ?,
      wins = wins + ?,
      losses = losses + ?,
      pushes = pushes + ?,
      total_pnl_units = total_pnl_units + ?,
      win_rate = CASE 
        WHEN (wins + ? + losses + ?) > 0 
        THEN CAST(wins + ? AS REAL) / (wins + ? + losses + ?)
        ELSE 0 
      END,
      avg_pnl_per_card = CASE
        WHEN (settled_cards + ?) > 0
        THEN (total_pnl_units + ?) / (settled_cards + ?)
        ELSE 0
      END,
      metadata = CASE WHEN ? IS NOT NULL THEN ? ELSE metadata END,
      computed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  
  stmt.run(
    // INSERT values (used only on first creation)
    id,
    statKey,
    sport || null,
    marketType || null,
    direction || null,
    confidenceTier || null,
    driverKey || null,
    timePeriod || null,
    deltaTotal,
    deltaTotal,
    deltaWins,
    deltaLosses,
    deltaPushes,
    deltaPnl,
    winRate,
    avgPnlPerCard,
    metadataJson,
    // UPDATE deltas
    deltaTotal,
    deltaTotal,
    deltaWins,
    deltaLosses,
    deltaPushes,
    deltaPnl,
    // win_rate calculation
    deltaWins, deltaLosses, deltaWins, deltaWins, deltaLosses,
    // avg_pnl_per_card calculation
    deltaTotal, deltaPnl, deltaTotal,
    // metadata
    metadataJson, metadataJson
  );
}

/**
 * Get tracking stats by filters
 * @param {object} filters - Filter object
 * @param {string} filters.sport - Sport filter (optional)
 * @param {string} filters.marketType - Market type filter (optional)
 * @param {string} filters.timePeriod - Time period filter (optional)
 * @returns {array} Tracking stats
 */
function getTrackingStats(filters = {}) {
  const db = getDatabase();
  
  const where = [];
  const params = [];
  
  if (filters.sport) {
    where.push('sport = ?');
    params.push(filters.sport);
  }
  
  if (filters.marketType) {
    where.push('market_type = ?');
    params.push(filters.marketType);
  }
  
  if (filters.timePeriod) {
    where.push('time_period = ?');
    params.push(filters.timePeriod);
  }
  
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  
  const stmt = db.prepare(`
    SELECT * FROM tracking_stats
    ${whereSql}
    ORDER BY computed_at DESC
  `);
  
  return stmt.all(...params);
}

/**
 * Get cached team metrics for a specific sport/team/date
 * @param {string} sport - Sport (e.g., 'NBA', 'NHL')
 * @param {string} teamName - Team name (as normalized by team-metrics.js)
 * @param {string} cacheDate - Cache date in ET (YYYY-MM-DD format)
 * @returns {object|null} Cached metrics object or null if not found/expired
 */
function getTeamMetricsCache(sport, teamName, cacheDate) {
  const db = getDatabase();
  // Keep sport uppercase for CHECK constraint
  const normalizedSport = String(sport || '').trim().toUpperCase();
  
  const stmt = db.prepare(`
    SELECT 
      id, sport, team_name, cache_date, status,
      metrics, team_info, recent_games, resolution,
      fetched_at, created_at
    FROM team_metrics_cache
    WHERE sport = ? AND team_name = ? AND cache_date = ?
  `);
  
  const row = stmt.get(normalizedSport, teamName, cacheDate);
  
  if (!row) return null;
  
  // Parse JSON columns
  return {
    id: row.id,
    sport: row.sport,
    teamName: row.team_name,
    cacheDate: row.cache_date,
    status: row.status,
    metrics: row.metrics ? JSON.parse(row.metrics) : null,
    teamInfo: row.team_info ? JSON.parse(row.team_info) : null,
    recentGames: row.recent_games ? JSON.parse(row.recent_games) : null,
    resolution: row.resolution ? JSON.parse(row.resolution) : null,
    fetchedAt: row.fetched_at,
    createdAt: row.created_at
  };
}

/**
 * Upsert team metrics cache entry
 * @param {object} cacheEntry - Cache entry object
 * @param {string} cacheEntry.sport - Sport
 * @param {string} cacheEntry.teamName - Team name
 * @param {string} cacheEntry.cacheDate - Cache date (ET, YYYY-MM-DD)
 * @param {string} cacheEntry.status - Status ('ok', 'missing', 'failed', 'partial')
 * @param {object} cacheEntry.metrics - Metrics object (optional)
 * @param {object} cacheEntry.teamInfo - Team info object (optional)
 * @param {array} cacheEntry.recentGames - Recent games array (optional)
 * @param {object} cacheEntry.resolution - Resolution metadata (optional)
 * @returns {number} Row ID
 */
function upsertTeamMetricsCache(cacheEntry) {
  const db = getDatabase();
  // Keep sport uppercase for CHECK constraint
  const normalizedSport = String(cacheEntry.sport || '').trim().toUpperCase();
  
  const metricsJson = cacheEntry.metrics ? JSON.stringify(cacheEntry.metrics) : null;
  const teamInfoJson = cacheEntry.teamInfo ? JSON.stringify(cacheEntry.teamInfo) : null;
  const recentGamesJson = cacheEntry.recentGames ? JSON.stringify(cacheEntry.recentGames) : null;
  const resolutionJson = cacheEntry.resolution ? JSON.stringify(cacheEntry.resolution) : null;
  
  const stmt = db.prepare(`
    INSERT INTO team_metrics_cache (
      sport, team_name, cache_date, status,
      metrics, team_info, recent_games, resolution,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(sport, team_name, cache_date) DO UPDATE SET
      status = excluded.status,
      metrics = excluded.metrics,
      team_info = excluded.team_info,
      recent_games = excluded.recent_games,
      resolution = excluded.resolution,
      fetched_at = CURRENT_TIMESTAMP
  `);
  
  const info = stmt.run(
    normalizedSport,
    cacheEntry.teamName,
    cacheEntry.cacheDate,
    cacheEntry.status,
    metricsJson,
    teamInfoJson,
    recentGamesJson,
    resolutionJson
  );
  
  return info.lastInsertRowid;
}

/**
 * Delete team metrics cache entries older than a given date
 * @param {string} beforeDate - Delete entries before this date (YYYY-MM-DD)
 * @returns {number} Number of rows deleted
 */
function deleteStaleTeamMetricsCache(beforeDate) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM team_metrics_cache
    WHERE cache_date < ?
  `);
  
  const info = stmt.run(beforeDate);
  return info.changes;
}

/**
 * Get cached soccer team xG row for a specific sport/league/team/cache_date.
 *
 * @param {object} params
 * @param {string} params.sport
 * @param {string} params.league
 * @param {string} params.teamName
 * @param {string} params.cacheDate
 * @returns {object|null}
 */
function getSoccerTeamXgCache({
  sport = 'SOCCER',
  league,
  teamName,
  cacheDate,
} = {}) {
  const db = getDatabase();
  ensureSoccerTeamXgCacheSchema(db);

  const stmt = db.prepare(`
    SELECT
      id,
      sport,
      league,
      team_name,
      home_xg_l6,
      away_xg_l6,
      fetched_at,
      cache_date,
      created_at,
      updated_at
    FROM soccer_team_xg_cache
    WHERE sport = ?
      AND league = ?
      AND team_name = ?
      AND cache_date = ?
    LIMIT 1
  `);

  return (
    stmt.get(
      String(sport || 'SOCCER').trim().toUpperCase(),
      String(league || '').trim().toUpperCase(),
      String(teamName || '').trim(),
      String(cacheDate || '').trim(),
    ) || null
  );
}

/**
 * Upsert soccer team xG cache row.
 * Update only when xG values change, preserving idempotent repeat writes.
 *
 * @param {object} row
 * @returns {number}
 */
function upsertSoccerTeamXgCache(row) {
  const db = getDatabase();
  ensureSoccerTeamXgCacheSchema(db);

  const normalizedSport = String(row?.sport || 'SOCCER').trim().toUpperCase();
  const normalizedLeague = String(row?.league || '').trim().toUpperCase();
  const normalizedTeamName = String(row?.teamName || row?.team_name || '').trim();
  const normalizedCacheDate = String(row?.cacheDate || row?.cache_date || '').trim();

  const stmt = db.prepare(`
    INSERT INTO soccer_team_xg_cache (
      sport,
      league,
      team_name,
      home_xg_l6,
      away_xg_l6,
      fetched_at,
      cache_date,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(sport, league, team_name, cache_date) DO UPDATE SET
      home_xg_l6 = excluded.home_xg_l6,
      away_xg_l6 = excluded.away_xg_l6,
      fetched_at = excluded.fetched_at,
      updated_at = CURRENT_TIMESTAMP
    WHERE excluded.home_xg_l6 IS NOT soccer_team_xg_cache.home_xg_l6
       OR excluded.away_xg_l6 IS NOT soccer_team_xg_cache.away_xg_l6
  `);

  const info = stmt.run(
    normalizedSport,
    normalizedLeague,
    normalizedTeamName,
    Number.isFinite(row?.homeXgL6) ? row.homeXgL6 : null,
    Number.isFinite(row?.awayXgL6) ? row.awayXgL6 : null,
    row?.fetchedAt || new Date().toISOString(),
    normalizedCacheDate,
  );

  return Number(info.lastInsertRowid || 0);
}

/**
 * List cached soccer team xG rows by league + cache date.
 *
 * @param {object} params
 * @returns {array}
 */
function listSoccerTeamXgCache({
  sport = 'SOCCER',
  league,
  cacheDate,
} = {}) {
  const db = getDatabase();
  ensureSoccerTeamXgCacheSchema(db);

  const where = ['sport = ?'];
  const params = [String(sport || 'SOCCER').trim().toUpperCase()];

  if (league) {
    where.push('league = ?');
    params.push(String(league).trim().toUpperCase());
  }
  if (cacheDate) {
    where.push('cache_date = ?');
    params.push(String(cacheDate).trim());
  }

  const stmt = db.prepare(`
    SELECT
      id,
      sport,
      league,
      team_name,
      home_xg_l6,
      away_xg_l6,
      fetched_at,
      cache_date,
      created_at,
      updated_at
    FROM soccer_team_xg_cache
    WHERE ${where.join(' AND ')}
    ORDER BY league ASC, team_name ASC
  `);

  return stmt.all(...params);
}

/**
 * Delete soccer xG cache rows older than date.
 *
 * @param {string} beforeDate
 * @returns {number}
 */
function deleteStaleSoccerTeamXgCache(beforeDate) {
  const db = getDatabase();
  ensureSoccerTeamXgCacheSchema(db);

  const stmt = db.prepare(`
    DELETE FROM soccer_team_xg_cache
    WHERE cache_date < ?
  `);
  const info = stmt.run(beforeDate);
  return info.changes;
}

/**
 * Backfill: Normalize historical card_results.sport values to lowercase
 * Ensures all sport codes in card_results table are lowercase for consistency
 * @returns {object} {affected: number of rows updated, errors: any errors encountered}
 */
function backfillCardResultsSportCasing() {
  try {
    const db = getDatabase();

    // Count rows that need normalization (mixed-case sport values)
    const countBeforeStmt = db.prepare(`
      SELECT COUNT(*) as count FROM card_results
      WHERE sport IS NOT NULL AND sport != LOWER(sport)
    `);
    const countBefore = countBeforeStmt.get();
    const affectedCount = countBefore?.count || 0;

    // Update any mixed-case sport values to lowercase
    const stmt = db.prepare(`
      UPDATE card_results
      SET sport = LOWER(sport)
      WHERE sport IS NOT NULL AND sport != LOWER(sport)
    `);

    stmt.run();

    return {
      affected: affectedCount,
      errors: null,
    };
  } catch (e) {
    return {
      affected: 0,
      errors: e.message,
    };
  }
}

/**
 * Upsert a player prop line (fetched from odds provider).
 */
function upsertPlayerPropLine(row) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO player_prop_lines (
      id, sport, game_id, odds_event_id, player_name, prop_type, period,
      line, over_price, under_price, bookmaker, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, game_id, player_name, prop_type, period, bookmaker, line) DO UPDATE SET
      odds_event_id = excluded.odds_event_id,
      over_price = excluded.over_price,
      under_price = excluded.under_price,
      fetched_at = excluded.fetched_at
  `);
  stmt.run(
    row.id,
    row.sport,
    row.gameId,
    row.oddsEventId || null,
    row.playerName,
    row.propType,
    row.period || 'full_game',
    row.line,
    row.overPrice || null,
    row.underPrice || null,
    row.bookmaker || null,
    row.fetchedAt,
  );
}

/**
 * Upsert a player's availability/injury status.
 * Called by pull jobs after checking injury signals from the source API.
 *
 * @param {{ playerId: number, sport: string, status: string, statusReason?: string, checkedAt: string }} row
 */
function upsertPlayerAvailability(row) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO player_availability (player_id, sport, status, status_reason, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id, sport) DO UPDATE SET
      status = excluded.status,
      status_reason = excluded.status_reason,
      checked_at = excluded.checked_at
  `);
  stmt.run(
    row.playerId,
    row.sport || 'NHL',
    row.status,
    row.statusReason || null,
    row.checkedAt,
  );
}

/**
 * Get the latest availability record for a player.
 * Returns null if no record exists (fail-open: caller should proceed normally).
 *
 * @param {number} playerId
 * @param {string} sport
 * @returns {{ player_id: number, sport: string, status: string, status_reason: string|null, checked_at: string }|null}
 */
function getPlayerAvailability(playerId, sport) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT player_id, sport, status, status_reason, checked_at
    FROM player_availability
    WHERE player_id = ? AND sport = ?
    LIMIT 1
  `);
  return stmt.get(playerId, sport || 'NHL') || null;
}

/**
 * Get consensus prop line for a player+game+propType combo.
 * Prefers draftkings, then fanduel, then betmgm, then any available.
 * Returns null if no line found.
 */
function getPlayerPropLine(sport, gameId, playerName, propType, period) {
  const db = getDatabase();
  const resolvedPeriod = period || 'full_game';
  const stmt = db.prepare(`
    SELECT line, over_price, under_price, bookmaker
    FROM player_prop_lines
    WHERE sport = ?
      AND game_id = ?
      AND LOWER(player_name) = LOWER(?)
      AND prop_type = ?
      AND period = ?
    ORDER BY
      CASE bookmaker
        WHEN 'draftkings' THEN 1
        WHEN 'fanduel' THEN 2
        WHEN 'betmgm' THEN 3
        ELSE 4
      END ASC
    LIMIT 1
  `);
  return stmt.get(sport, gameId, playerName, propType, resolvedPeriod) || null;
}

/**
 * Get de-duplicated player prop lines for a game.
 * For each player+prop_type+period, bookmaker priority is applied:
 * draftkings -> fanduel -> betmgm -> any.
 */
function getPlayerPropLinesForGame(sport, gameId, propTypes = null) {
  const db = getDatabase();
  const hasPropTypes = Array.isArray(propTypes) && propTypes.length > 0;
  const placeholders = hasPropTypes ? propTypes.map(() => '?').join(', ') : '';
  const stmt = db.prepare(`
    SELECT player_name, prop_type, period, line, over_price, under_price, bookmaker, fetched_at
    FROM player_prop_lines
    WHERE sport = ?
      AND game_id = ?
      ${hasPropTypes ? `AND prop_type IN (${placeholders})` : ''}
    ORDER BY
      LOWER(player_name) ASC,
      prop_type ASC,
      period ASC,
      CASE bookmaker
        WHEN 'draftkings' THEN 1
        WHEN 'fanduel' THEN 2
        WHEN 'betmgm' THEN 3
        ELSE 4
      END ASC
  `);

  const rows = hasPropTypes
    ? stmt.all(sport, gameId, ...propTypes)
    : stmt.all(sport, gameId);

  const uniqueRows = [];
  const seenKeys = new Set();
  for (const row of rows) {
    const dedupeKey = `${String(row.player_name || '').toLowerCase()}|${row.prop_type}|${row.period}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token Quota Ledger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get or create the quota ledger row for a provider+period.
 * Returns the current row (or a default if not yet written).
 */
function getQuotaLedger(provider, period) {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM token_quota_ledger WHERE provider = ? AND period = ? LIMIT 1`,
    )
    .get(provider, period);
  if (row) return row;
  // Return safe defaults — row will be created on first upsert
  return {
    provider,
    period,
    tokens_remaining: null,
    tokens_spent_session: 0,
    monthly_limit: Number(process.env.ODDS_MONTHLY_LIMIT) || 20000,
    circuit_open_until: null,
    circuit_reason: null,
  };
}

/**
 * Upsert quota ledger for a provider+period.
 * Pass only the fields you want to update; others retain their existing values.
 */
function upsertQuotaLedger({
  provider,
  period,
  tokens_remaining,
  tokens_spent_session,
  monthly_limit,
  circuit_open_until,
  circuit_reason,
  updated_by,
}) {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO token_quota_ledger
       (provider, period, tokens_remaining, tokens_spent_session, monthly_limit,
        circuit_open_until, circuit_reason, last_updated, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(provider, period) DO UPDATE SET
       tokens_remaining     = COALESCE(excluded.tokens_remaining, tokens_remaining),
       tokens_spent_session = COALESCE(excluded.tokens_spent_session, tokens_spent_session),
       monthly_limit        = COALESCE(excluded.monthly_limit, monthly_limit),
       circuit_open_until   = excluded.circuit_open_until,
       circuit_reason       = excluded.circuit_reason,
       last_updated         = datetime('now'),
       updated_by           = excluded.updated_by`,
  ).run(
    provider,
    period,
    tokens_remaining ?? null,
    tokens_spent_session ?? null,
    monthly_limit ?? null,
    circuit_open_until ?? null,
    circuit_reason ?? null,
    updated_by ?? null,
  );
}

/**
 * Check if the DB-persisted circuit breaker is open for a provider.
 * Returns { open: boolean, until: string|null, reason: string|null }.
 */
function isQuotaCircuitOpen(provider, period) {
  const row = getQuotaLedger(provider, period);
  if (!row.circuit_open_until) return { open: false, until: null, reason: null };
  const until = new Date(row.circuit_open_until).getTime();
  if (Date.now() < until) {
    return { open: true, until: row.circuit_open_until, reason: row.circuit_reason };
  }
  return { open: false, until: null, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// T-minus Pull Dedup Log
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempt to claim a T-minus odds pull slot for the given window key.
 * Uses INSERT OR IGNORE so concurrent/restarted processes can't double-claim.
 *
 * @param {string} sport - e.g. 'nba'
 * @param {string} windowKey - e.g. 'nba|T-30|2026-03-25T19'
 * @returns {boolean} true if this call claimed the slot (should queue the pull),
 *                    false if already claimed by a prior run/restart
 */
function claimTminusPullSlot(sport, windowKey) {
  const db = getDatabase();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO tminus_pull_log (sport, window_key) VALUES (?, ?)`,
    )
    .run(sport, windowKey);
  return result.changes > 0;
}

/**
 * Purge tminus_pull_log rows older than 48 hours.
 * Call once at scheduler startup to keep the table small.
 */
function purgeStaleTminusPullLog() {
  const db = getDatabase();
  db.prepare(
    `DELETE FROM tminus_pull_log WHERE queued_at < datetime('now', '-48 hours')`,
  ).run();
}

module.exports = {
  initDb,
  getDatabase,
  getDatabaseReadOnly,
  closeDatabase,
  closeDatabaseReadOnly,
  closeReadOnlyInstance,
  checkSqliteIntegrity,
  getCurrentRunId,
  setCurrentRunId,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  hasSuccessfulJobRun,
  hasRunningJobRun,
  hasRunningJobName,
  shouldRunJobKey,
  getLatestJobRunByKey,
  wasJobKeyRecentlySuccessful,
  insertOddsSnapshot,
  updateOddsSnapshotRawData,
  deleteOddsSnapshotsByGameAndCapturedAt,
  prepareOddsSnapshotWrite,
  getLatestOdds,
  getOddsSnapshots,
  computeLineDelta,
  getOddsWithUpcomingGames,
  recordOddsIngestFailure,
  getOddsIngestFailureSummary,
  upsertPlayerShotLog,
  getPlayerShotLogs,
  upsertTrackedPlayer,
  listTrackedPlayers,
  deactivateTrackedPlayersNotInSet,
  upsertPlayerAvailability,
  getPlayerAvailability,
  upsertPlayerPropLine,
  getPlayerPropLine,
  getPlayerPropLinesForGame,
  getJobRunHistory,
  wasJobRecentlySuccessful,
  insertModelOutput,
  deleteModelOutputsByGame,
  deleteModelOutputsForGame,
  getLatestModelOutput,
  getModelOutputs,
  getModelOutputsBySport,
  insertCardPayload,
  insertCardResult,
  deleteCardPayloadsByGameAndType,
  deleteCardPayloadsForGame,
  prepareModelAndCardWrite,
  getCardPayload,
  getCardPayloads,
  getCardPayloadsByType,
  getCardPayloadsBySport,
  expireCardPayload,
  deleteExpiredCards,
  getDecisionRecord,
  upsertDecisionRecord,
  updateDecisionCandidateTracking,
  insertDecisionEvent,
  getUpcomingGames,
  upsertGame,
  upsertGameIdMap,
  getCanonicalGameIdByExternal,
  upsertGameResult,
  getGameResult,
  getGameResults,
  upsertTrackingStat,
  incrementTrackingStat,
  getTrackingStats,
  getTeamMetricsCache,
  upsertTeamMetricsCache,
  deleteStaleTeamMetricsCache,
  getSoccerTeamXgCache,
  upsertSoccerTeamXgCache,
  listSoccerTeamXgCache,
  deleteStaleSoccerTeamXgCache,
  backfillCardResultsSportCasing,
  getQuotaLedger,
  upsertQuotaLedger,
  isQuotaCircuitOpen,
  claimTminusPullSlot,
  purgeStaleTminusPullLog,
};
