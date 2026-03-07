/**
 * Database Client
 * Singleton connection to the SQLite database (via sql.js)
 * 
 * Usage:
 *   await require('./db.js').init()
 *   const db = require('./db.js').getDatabase()
 *   
 * All timestamps stored in ISO 8601 UTC format
 */

const initSqlJs = require('sql.js/dist/sql-asm.js');
const fs = require('fs');
const path = require('path');
const {
  createMarketError,
  deriveLockedMarketContext,
  toRecommendedBetType,
} = require('./market-contract');
const { resolveDatabasePath } = require('./db-path');
const {
  normalizeTeamName,
  normalizeCardTitle,
  normalizeSportCode,
} = require('./normalize');

let SQL = null;
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
    const buffer = fs.readFileSync(dbFile);
    const db = new SQL.Database(buffer);
    const tablePlaceholders = EXPECTED_TABLE_NAMES.map(() => '?').join(', ');
    const tableStmt = db.prepare(
      `SELECT COUNT(*) AS c
       FROM sqlite_master
       WHERE type='table' AND name IN (${tablePlaceholders})`
    );
    tableStmt.bind(EXPECTED_TABLE_NAMES);
    let tableCount = 0;
    if (tableStmt.step()) {
      const row = tableStmt.getAsObject();
      tableCount = Number(row.c || 0);
    }
    tableStmt.free();

    let rowCount = 0;
    let cardPayloadCount = 0;
    let hasMarketContractColumns = false;
    if (tableCount > 0) {
      for (const tableName of EXPECTED_TABLE_NAMES) {
        try {
          const countStmt = db.prepare(`SELECT COUNT(*) AS c FROM ${tableName}`);
          if (countStmt.step()) {
            const row = countStmt.getAsObject();
            const count = Number(row.c || 0);
            rowCount += count;
            if (tableName === 'card_payloads') {
              cardPayloadCount = count;
            }
          }
          countStmt.free();
        } catch {
          // Ignore missing/incompatible tables.
        }
      }

      try {
        const columnStmt = db.prepare(`PRAGMA table_info(card_results)`);
        const columnNames = new Set();
        while (columnStmt.step()) {
          const row = columnStmt.getAsObject();
          if (typeof row.name === 'string') {
            columnNames.add(row.name);
          }
        }
        columnStmt.free();
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
      `[DB] CHEDDAR_DB_ALLOW_MULTI_PROCESS=true — skipping DB lock for ${dbFile} (unsafe for sql.js file writes).`,
    );
    return;
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
    'Set CHEDDAR_DB_ALLOW_MULTI_PROCESS=true to bypass (unsafe for sql.js file writes).';
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
 * Initialize SQL.js (must be called once at startup)
 */
async function initDb() {
  if (SQL) return;
  SQL = await initSqlJs();
  // Ensure registry is fresh on init
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

  try {
    if (fs.existsSync(dbFile)) {
      const buffer = fs.readFileSync(dbFile);
      const db = new SQL.Database(buffer);
      return db;
    }
  } catch (e) {
    console.warn(`Failed to load existing database: ${e.message}`);
  }

  return new SQL.Database();
}

/**
 * Save database to disk
 */
function saveDatabase() {
  if (!dbInstance || !dbPath) return;
  
  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (e) {
    console.error(`Failed to save database: ${e.message}`);
    throw e;
  }
}

/**
 * Statement wrapper that mimics better-sqlite3
 */
class Statement {
  constructor(db, query) {
    this.db = db;
    this.query = query;
    this.stmt = db.prepare(query);
  }

  run(...params) {
    try {
      this.stmt.bind(params);
      this.stmt.step();
      this.stmt.reset();
      saveDatabase();
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
      const errorMsg = e?.message || e?.toString() || JSON.stringify(e) || 'unknown error';
      throw new Error(`Statement all error: ${errorMsg} | Query: ${this.query} | Params: ${JSON.stringify(params)}`);
    }
  }
}

/**
 * Database wrapper object
 */
class DatabaseWrapper {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  prepare(query) {
    return new Statement(this._db, query);
  }

  exec(sql) {
    try {
      this._db.run(sql);
      saveDatabase();
    } catch (e) {
      throw new Error(`Exec error: ${e.message}`);
    }
  }

  pragma(pragma) {
    /* Most pragmas ignored in sql.js */
    if (pragma === 'foreign_keys = ON') {
      try {
        this._db.run('PRAGMA foreign_keys = ON');
      } catch (e) {
        // sql.js doesn't support all pragmas
      }
    }
  }

  close() {
    if (dbInstance) {
      saveDatabase();
      dbInstance.close();
      dbInstance = null;
    }
    releaseDbFileLock();
  }

  getRowsModified() {
    return this._db.getRowsModified();
  }
}

/**
 * Get database instance
 * Ensures SQL.js is initialized first
 */
function getDatabase() {
  if (!SQL) {
    throw new Error('Database not initialized. Call initDb() first from require("./db.js").initDb()');
  }

  if (!dbInstance) {
    dbInstance = loadDatabase();
    try {
      dbInstance.run('PRAGMA foreign_keys = ON');
    } catch (e) {
      /* Pragma may not be supported */
    }
  }

  return new DatabaseWrapper(dbInstance);
}

/**
 * Close database and save to disk
 */
function closeDatabase() {
  if (dbInstance) {
    saveDatabase();
    dbInstance.close();
    dbInstance = null;
  }
  releaseDbFileLock();
  // Reset odds context registry on close
  oddsContextReferenceRegistry = new WeakMap();
}

/**
 * Close database without saving to disk (read-only consumers).
 * Use this in the web server — it must never write or acquire write locks.
 */
function closeDatabaseReadOnly() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  releaseDbFileLock();
  oddsContextReferenceRegistry = new WeakMap();
}

/**
 * Open the database for reading WITHOUT acquiring the write lock.
 * Safe for read-only consumers (web server) that must coexist with the worker.
 *
 * Returns a fresh DatabaseWrapper per call — no module-level singleton.
 * Always reads the latest bytes from disk, so it sees worker writes immediately.
 *
 * MUST be paired with closeReadOnlyInstance(db) — never closeDatabase().
 */
function getDatabaseReadOnly() {
  if (!SQL) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  const resolved = resolveDatabasePath();
  const filePath = dbPath || resolved.dbPath;
  let instance;
  try {
    if (filePath && fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      instance = new SQL.Database(buffer);
    } else {
      instance = new SQL.Database();
    }
  } catch (e) {
    console.warn(`[DB] getDatabaseReadOnly: failed to load ${filePath}: ${e.message}`);
    instance = new SQL.Database();
  }
  try {
    instance.run('PRAGMA foreign_keys = ON');
  } catch { /* ignore */ }
  return new DatabaseWrapper(instance);
}

/**
 * Close a per-request read-only database instance returned by getDatabaseReadOnly().
 * Closes the sql.js in-memory database without touching the lock or saving to disk.
 */
function closeReadOnlyInstance(db) {
  if (db && db._db) {
    try { db._db.close(); } catch { /* ignore */ }
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
  
  const stmt = db.prepare(`
    INSERT INTO odds_snapshots (
      id, game_id, sport, captured_at, h2h_home, h2h_away, total,
      spread_home, spread_away, moneyline_home, moneyline_away,
      spread_price_home, spread_price_away, total_price_over, total_price_under,
      raw_data, job_run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    snapshot.id,
    snapshot.gameId,
    normalizedSport,
    snapshot.capturedAt,
    snapshot.h2hHome,
    snapshot.h2hAway,
    snapshot.total,
    snapshot.spreadHome || null,
    snapshot.spreadAway || null,
    snapshot.monelineHome || null,
    snapshot.monelineAway || null,
    snapshot.spreadPriceHome || null,
    snapshot.spreadPriceAway || null,
    snapshot.totalPriceOver || null,
    snapshot.totalPriceUnder || null,
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
 * @param {string} gameId - Game ID
 * @param {string} sport - Sport code (NBA, NCAAM, NHL)
 * @param {string} capturedAt - The captured_at timestamp (used for logging only)
 * @param {object} enrichedRawData - The enriched raw_data object to persist
 * @returns {boolean} True if update succeeded, false if no matching row found
 */
function updateOddsSnapshotRawData(gameId, sport, capturedAt, enrichedRawData) {
  try {
    const db = getDatabase();
    
    // First, find the ID of the latest snapshot for this game
    const findStmt = db.prepare(`
      SELECT id FROM odds_snapshots
      WHERE game_id = ?
      ORDER BY captured_at DESC
      LIMIT 1
    `);
    const latestSnap = findStmt.get(gameId);
    
    if (!latestSnap) {
      console.warn(`[updateOddsSnapshotRawData] No odds snapshot found for game ${gameId}`);
      return false;
    }
    
    // Prepare the raw_data JSON
    const rawDataJson = enrichedRawData ? JSON.stringify(enrichedRawData) : null;
    
    // Update using the snapshot ID
    const updateStmt = db.prepare(`
      UPDATE odds_snapshots
      SET raw_data = ?
      WHERE id = ?
    `);
    
    const result = updateStmt.run(rawDataJson, latestSnap.id);
    if (result.changes === 0) {
      console.warn(`[updateOddsSnapshotRawData] Failed to update snapshot ${latestSnap.id} for game ${gameId} at ${capturedAt}`);
      return false;
    }
    
    console.log(`[updateOddsSnapshotRawData] Updated raw_data for game ${gameId} (snapshot ${latestSnap.id}) captured at ${capturedAt}`);
    return true;
  } catch (err) {
    console.error(`[updateOddsSnapshotRawData] Error updating game ${gameId}: ${err.message}`);
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

/**
 * Get latest odds snapshots for upcoming games only (prevents stale data processing)
 * Joins with games table to filter by game_time_utc
 * @param {string} sport - Sport code (e.g., 'NHL')
 * @param {string} nowUtc - Current time in ISO UTC
 * @param {string} horizonUtc - End of time window in ISO UTC (e.g., now + 36 hours)
 * @returns {array} Odds snapshots with game_time_utc attached
 */
function getOddsWithUpcomingGames(sport, nowUtc, horizonUtc) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getOddsWithUpcomingGames');
  
  const stmt = db.prepare(`
    SELECT 
      o.*,
      g.game_time_utc,
      g.home_team,
      g.away_team
    FROM odds_snapshots o
    INNER JOIN games g ON o.game_id = g.game_id
    WHERE LOWER(o.sport) = ?
      AND g.game_time_utc IS NOT NULL
      AND g.game_time_utc > ?
      AND g.game_time_utc <= ?
    ORDER BY o.game_id, o.captured_at DESC
  `);
  
  return stmt.all(normalizedSport, nowUtc, horizonUtc);
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
function deleteCardPayloadsByGameAndType(gameId, cardType) {
  return deleteCardPayloadsForGame(gameId, cardType);
}

/**
 * Prepare idempotent writes for model outputs and card payloads
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @param {string} cardType - Card type
 * @returns {{deletedOutputs: number, deletedCards: number}}
 */
function prepareModelAndCardWrite(gameId, modelName, cardType) {
  const deletedOutputs = deleteModelOutputsByGame(gameId, modelName);
  const deletedCards = deleteCardPayloadsByGameAndType(gameId, cardType);
  return { deletedOutputs, deletedCards };
}

/**
 * Delete card payloads for a game + card type combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} cardType - Card type
 * @returns {number} Count of deleted rows
 */
function deleteCardPayloadsForGame(gameId, cardType) {
  const db = getDatabase();
  const now = new Date().toISOString();

  // Rewrites are only allowed for unsettled rows. Remove pending result links first,
  // then delete unreferenced payloads. Settled payloads are retained for audit integrity.
  const deletePendingResultsStmt = db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (
        SELECT id
        FROM card_payloads
        WHERE game_id = ? AND card_type = ?
      )
  `);
  deletePendingResultsStmt.run(gameId, cardType);

  const deleteUnreferencedPayloadsStmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE game_id = ? AND card_type = ?
      AND id NOT IN (
        SELECT card_id
        FROM card_results
      )
  `);
  const deleted = deleteUnreferencedPayloadsStmt.run(gameId, cardType).changes;

  // Keep referenced payloads immutable but stale so current-card reads ignore them.
  const expireReferencedPayloadsStmt = db.prepare(`
    UPDATE card_payloads
    SET expires_at = COALESCE(expires_at, ?), updated_at = ?
    WHERE game_id = ? AND card_type = ?
      AND id IN (
        SELECT card_id
        FROM card_results
      )
      AND expires_at IS NULL
  `);
  expireReferencedPayloadsStmt.run(now, now, gameId, cardType);

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
    result.sport,
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

  let lockedMarket = null;
  try {
    lockedMarket = deriveLockedMarketContext(payloadData, {
      gameId: card.gameId,
      homeTeam: payloadData.home_team ?? null,
      awayTeam: payloadData.away_team ?? null,
      requirePrice: true,
      requireLineForMarket: true,
    });
  } catch (error) {
    const code = error?.code || 'INVALID_MARKET_CONTRACT';
    throw createMarketError(
      code,
      `[DB] Refusing to lock invalid market payload for card ${card.id}: ${error.message}`,
      { cardId: card.id, gameId: card.gameId, cause: error?.details || null }
    );
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

  // Normalize sport to uppercase for consistency with odds_snapshots and API queries
  const normalizedSport = card.sport ? card.sport.toUpperCase() : card.sport;

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
      ? { lockedAt: card.createdAt || new Date().toISOString(), marketKey: lockedMarket.marketKey }
      : null
  });
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
    WHERE game_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
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
    WHERE card_type = ? AND created_at >= ? AND (expires_at IS NULL OR expires_at > datetime('now'))
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
    WHERE sport = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
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

module.exports = {
  initDb,
  getDatabase,
  getDatabaseReadOnly,
  closeDatabase,
  closeDatabaseReadOnly,
  closeReadOnlyInstance,
  getCurrentRunId,
  setCurrentRunId,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  hasSuccessfulJobRun,
  hasRunningJobRun,
  shouldRunJobKey,
  getLatestJobRunByKey,
  wasJobKeyRecentlySuccessful,
  insertOddsSnapshot,
  updateOddsSnapshotRawData,
  deleteOddsSnapshotsByGameAndCapturedAt,
  prepareOddsSnapshotWrite,
  getLatestOdds,
  getOddsSnapshots,
  getOddsWithUpcomingGames,
  upsertPlayerShotLog,
  getPlayerShotLogs,
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
  getTrackingStats
};
