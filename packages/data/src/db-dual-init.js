/* DISABLED (WI-1138): Dual-DB mode is no longer supported.
 * All exported functions throw. See ADR-0002.
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
 * Initialize dual-database mode.
 * Preserved as async for caller back-compat; opens both DBs synchronously internally.
 *
 * @param {object} options
 * @param {string} options.recordDbPath - Path to shared record database (read-only)
 * @param {string} options.localDbPath - Path to local state database (writable)
 * @returns {Promise<void>}
 */
function initDualDb(options) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

/**
 * Check if dual-mode is active.
 */
function isDualModeActive() {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

/**
 * Get a database instance.
 *
 * @param {string} mode - 'record' | 'local' | 'auto' (default: 'auto')
 * @returns {DatabaseWrapper|AutoRoutingDb}
 */
function getDb(mode) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

/**
 * Graceful shutdown.
 */
function closeDualDb() {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
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
  DatabaseWrapper: undefined,
  AutoRoutingDb: undefined
};
