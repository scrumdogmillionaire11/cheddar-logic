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

let SQL = null;
let dbInstance = null;
let dbPath = null;

/**
 * Initialize SQL.js (must be called once at startup)
 */
async function initDb() {
  if (SQL) return;
  SQL = await initSqlJs();
}

/**
 * Load database from disk or create new
 */
function loadDatabase() {
  const dbFile = dbPath || (process.env.DATABASE_PATH || 
    path.join(process.env.CHEDDAR_DATA_DIR || '/tmp/cheddar-logic', 'cheddar.db'));
  
  dbPath = dbFile;
  const dir = path.dirname(dbFile);
  
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
      throw new Error(`Statement all error: ${e.message}`);
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
  
  const stmt = db.prepare(`
    INSERT INTO odds_snapshots (
      id, game_id, sport, captured_at, h2h_home, h2h_away, total,
      spread_home, spread_away, moneyline_home, moneyline_away,
      raw_data, job_run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    snapshot.id,
    snapshot.gameId,
    snapshot.sport,
    snapshot.capturedAt,
    snapshot.h2hHome,
    snapshot.h2hAway,
    snapshot.total,
    snapshot.spreadHome || null,
    snapshot.spreadAway || null,
    snapshot.monelineHome || null,
    snapshot.monelineAway || null,
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
  
  const stmt = db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE sport = ? AND captured_at >= ?
    ORDER BY game_id, captured_at DESC
  `);
  
  return stmt.all(sport, sinceUtc);
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
  
  const stmt = db.prepare(`
    SELECT 
      o.*,
      g.game_time_utc,
      g.home_team,
      g.away_team
    FROM odds_snapshots o
    INNER JOIN games g ON o.game_id = g.game_id
    WHERE o.sport = ?
      AND g.game_time_utc IS NOT NULL
      AND g.game_time_utc > ?
      AND g.game_time_utc <= ?
    ORDER BY o.game_id, o.captured_at DESC
  `);
  
  return stmt.all(sport, nowUtc, horizonUtc);
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
  
  stmt.run(id, sport, gameId, homeTeam, awayTeam, gameTimeUtc, status);
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
  
  return stmt.get(jobName, threshold) !== undefined;
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
  
  const stmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE game_id = ? AND card_type = ?
  `);
  
  const result = stmt.run(gameId, cardType);
  return result.changes;
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
      status, result, settled_at, pnl_units, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    result.id,
    result.cardId,
    result.gameId,
    result.sport,
    result.cardType,
    result.recommendedBetType,
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
 */
function insertCardPayload(card) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO card_payloads (
      id, game_id, sport, card_type, card_title, created_at,
      expires_at, payload_data, model_output_ids, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    card.id,
    card.gameId,
    card.sport,
    card.cardType,
    card.cardTitle,
    card.createdAt,
    card.expiresAt || null,
    card.payloadData ? JSON.stringify(card.payloadData) : '{}',
    card.modelOutputIds || null,
    card.metadata ? JSON.stringify(card.metadata) : null
  );

  const recommendedBetType = card.payloadData?.recommended_bet_type || 'unknown';

  insertCardResult({
    id: `card-result-${card.id}`,
    cardId: card.id,
    gameId: card.gameId,
    sport: card.sport,
    cardType: card.cardType,
    recommendedBetType,
    status: 'pending',
    result: null,
    settledAt: null,
    pnlUnits: null,
    metadata: null
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
  
  const stmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE expires_at IS NOT NULL AND expires_at < ?
  `);
  
  const result = stmt.run(threshold);
  return result.changes;
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
    result.sport,
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
  closeDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  hasSuccessfulJobRun,
  hasRunningJobRun,
  shouldRunJobKey,
  getLatestJobRunByKey,
  wasJobKeyRecentlySuccessful,
  insertOddsSnapshot,
  deleteOddsSnapshotsByGameAndCapturedAt,
  prepareOddsSnapshotWrite,
  getLatestOdds,
  getOddsSnapshots,
  getOddsWithUpcomingGames,
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
  getUpcomingGames,
  upsertGame,
  upsertGameResult,
  getGameResult,
  getGameResults,
  upsertTrackingStat,
  getTrackingStats
};

