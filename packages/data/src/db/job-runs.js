const { getDatabase } = require('./connection');

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

module.exports = {
  getCurrentRunId,
  setCurrentRunId,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  getJobRunHistory,
  wasJobRecentlySuccessful,
  hasSuccessfulJobRun,
  hasRunningJobRun,
  hasRunningJobName,
  shouldRunJobKey,
  getLatestJobRunByKey,
  wasJobKeyRecentlySuccessful,
};
