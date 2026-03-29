const { getDatabase } = require('./connection');

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
  claimTminusPullSlot,
  purgeStaleTminusPullLog,
};
