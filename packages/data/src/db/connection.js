const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { resolveDatabasePath } = require('../db-path');

let dbInstance = null;
let dbPath = null;
let warnedDbPathContract = false;
let dbLockHandle = null;
let dbLockPath = null;
let dbLockRegistered = false;
const warnedSportValues = new Set();
let oddsContextReferenceRegistry = new WeakMap();
let readOnlyOpenFailureStreak = 0;
let lastReadOnlyFailureAtMs = 0;
const EXPECTED_TABLE_NAMES = ['games', 'card_payloads', 'card_results', 'game_results'];
const REQUIRED_CARD_RESULTS_MARKET_COLUMNS = ['market_key', 'market_type', 'selection', 'line', 'locked_price'];
const DEFAULT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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

function getReadOnlyRetryConfig() {
  const retryMs = Number(process.env.CHEDDAR_DB_READ_RETRY_MS || 300);
  const retryIntervalMs = Number(process.env.CHEDDAR_DB_READ_RETRY_INTERVAL_MS || 25);

  return {
    retryMs: Number.isFinite(retryMs) ? Math.max(0, retryMs) : 300,
    retryIntervalMs: Number.isFinite(retryIntervalMs)
      ? Math.max(1, retryIntervalMs)
      : 25,
  };
}

function markReadOnlyOpenSuccess(filePath, attempts, waitedMs) {
  if (readOnlyOpenFailureStreak > 0) {
    console.info(
      `[DB] getDatabaseReadOnly recovered after transient access failure (path=${filePath}, attempts=${attempts}, waited_ms=${waitedMs}, prior_failures=${readOnlyOpenFailureStreak}).`,
    );
  }
  readOnlyOpenFailureStreak = 0;
  lastReadOnlyFailureAtMs = 0;
}

function markReadOnlyOpenFailure(filePath, reason, attempts, waitedMs) {
  const nowMs = Date.now();
  if (nowMs - lastReadOnlyFailureAtMs > 60_000) {
    readOnlyOpenFailureStreak = 0;
  }
  readOnlyOpenFailureStreak += 1;
  lastReadOnlyFailureAtMs = nowMs;

  const level = readOnlyOpenFailureStreak >= 3 ? 'error' : 'warn';
  console[level](
    `[DB] getDatabaseReadOnly failed (path=${filePath}, attempts=${attempts}, waited_ms=${waitedMs}, streak=${readOnlyOpenFailureStreak}, reason=${reason}).`,
  );
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

  const { retryMs, retryIntervalMs } = getReadOnlyRetryConfig();
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + retryMs;
  let attempts = 0;
  let lastOpenError = null;

  while (true) {
    attempts += 1;

    const hasDbFile = Boolean(filePath) && fs.existsSync(filePath);
    if (hasDbFile) {
      try {
        const instance = new Database(filePath, { readonly: true });
        instance.pragma('foreign_keys = ON');
        const waitedMs = Date.now() - startedAtMs;
        markReadOnlyOpenSuccess(filePath, attempts, waitedMs);
        return new ReadOnlyDatabaseProxy(instance);
      } catch (error) {
        lastOpenError = error;
        const transientOpenError =
          error &&
          (error.code === 'ENOENT' ||
            error.code === 'SQLITE_CANTOPEN' ||
            /no such file|unable to open database file/i.test(String(error.message || '')));
        if (!transientOpenError) {
          throw new Error(
            `[DB] getDatabaseReadOnly: database file at ${filePath} is malformed and cannot be opened: ${error.message}. ` +
            'Do not serve stale or empty data — fail the request and investigate the DB file.'
          );
        }
      }
    }

    const nowMs = Date.now();
    if (nowMs >= deadlineMs) {
      const waitedMs = nowMs - startedAtMs;
      const lastReason = lastOpenError
        ? `${lastOpenError.code || 'unknown'}: ${lastOpenError.message}`
        : 'file_missing';
      markReadOnlyOpenFailure(filePath, lastReason, attempts, waitedMs);
      throw new Error(
        `[DB] getDatabaseReadOnly: database file not accessible at ${filePath} after ${attempts} attempts over ${waitedMs}ms. ` +
        'Ensure CHEDDAR_DB_PATH is set and the worker has initialized the database.'
      );
    }

    spinSleepMs(retryIntervalMs);
  }

  // Wrap in a ReadOnlyProxy that:
  // - Returns null (not undefined) from .get() for consistency with former sql.js behaviour
  // - Throws on any write attempt
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

function getOddsContextReferenceRegistry() {
  return oddsContextReferenceRegistry;
}

module.exports = {
  DEFAULT_REFRESH_TOKEN_TTL_MS,
  getDatabase,
  getDatabaseReadOnly,
  closeDatabase,
  closeDatabaseReadOnly,
  closeReadOnlyInstance,
  checkSqliteIntegrity,
  normalizeSportValue,
  getOddsContextReferenceRegistry,
};
