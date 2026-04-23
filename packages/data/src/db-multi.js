/* DISABLED (WI-1138): Dead code — no callers. Dual-DB mode is not supported.
 * See ADR-0002. Do not re-enable without a new ADR.
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

function logCardDisplay(db, payload) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function getDisplayedPickIds(db, runId) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function getSettlementLedger(db, sport, minDate, maxDate) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function getCurrentRunId(db) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function setCurrentRunId(db, runId) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function insertRun(db, runId, status, itemsCount) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function getRun(db, runId) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function markRunSuccess(db, runId) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function markRunFailure(db, runId, errorMessage) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

function initDualMode(recordDatabasePath, localDatabasePath) {
  throw new Error(
    '[WI-1138] Dual-DB mode is disabled. Use packages/data/src/db.js (single-writer worker) ' +
    'or closeDatabaseReadOnly() (read-only web). See ADR-0002.'
  );
}

module.exports = {
  initDualMode,
  AutoRoutingDb: undefined,
  DatabaseWrapper: undefined,
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
