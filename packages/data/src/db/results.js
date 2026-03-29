const {
  getDatabase,
  normalizeSportValue,
} = require('./connection');
const { normalizeSportCode } = require('../normalize');

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

module.exports = {
  insertCardResult,
  upsertGameResult,
  getGameResult,
  getGameResults,
  backfillCardResultsSportCasing,
};
