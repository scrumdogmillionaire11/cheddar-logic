const {
  getDatabase,
  normalizeSportValue,
} = require('./connection');
const { normalizeTeamName } = require('../normalize');

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

module.exports = {
  getUpcomingGames,
  upsertGame,
  upsertGameIdMap,
  getCanonicalGameIdByExternal,
};
