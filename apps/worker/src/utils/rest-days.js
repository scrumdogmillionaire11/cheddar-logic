'use strict';

const { getDatabase } = require('@cheddar-logic/data');

/**
 * Find the UTC timestamp of a team's most recent completed game before the
 * given time. Uses game_time_utc column (NOT game_date — that column does not
 * exist in this schema). Mirrors the getDatabase() pattern from
 * getHomeTeamRecentRoadTrip in run_nba_model.js.
 *
 * @param {string} teamName
 * @param {string} sport  lowercase ('nba', 'nhl')
 * @param {string} beforeUtc ISO8601 UTC string
 * @returns {string|null}
 */
function getTeamLastGameTimeUtc(teamName, sport, beforeUtc) {
  if (!teamName || !sport || !beforeUtc) return null;
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT game_time_utc
    FROM games
    WHERE LOWER(sport) = ?
      AND (UPPER(home_team) = UPPER(?) OR UPPER(away_team) = UPPER(?))
      AND game_time_utc < ?
      AND status IN ('final', 'STATUS_FINAL')
    ORDER BY game_time_utc DESC
    LIMIT 1
  `);
  const row = stmt.get(sport.toLowerCase(), teamName, teamName, beforeUtc);
  return row ? row.game_time_utc : null;
}

/**
 * Calculate whole days between two UTC ISO strings.
 * Capped at 3 (well-rested plateau) and floored at 0 (back-to-back).
 *
 * @param {string} earlierUtcIso
 * @param {string} laterUtcIso
 * @returns {number}
 */
function daysBetween(earlierUtcIso, laterUtcIso) {
  return Math.min(
    3,
    Math.max(
      0,
      Math.floor(
        (new Date(laterUtcIso) - new Date(earlierUtcIso)) / 86400000,
      ),
    ),
  );
}

/**
 * Compute rest days for a team before an upcoming game.
 *
 * @param {string} teamName
 * @param {string} sport  lowercase ('nba', 'nhl')
 * @param {string} gameTimeUtc  ISO8601 UTC string of the upcoming game
 * @returns {{ restDays: number, restSource: 'computed'|'default' }}
 */
function computeRestDays(teamName, sport, gameTimeUtc) {
  const lastGameTime = getTeamLastGameTimeUtc(teamName, sport, gameTimeUtc);
  if (!lastGameTime) {
    return { restDays: 1, restSource: 'default' };
  }
  const restDays = daysBetween(lastGameTime, gameTimeUtc);
  return { restDays, restSource: 'computed' };
}

module.exports = { getTeamLastGameTimeUtc, daysBetween, computeRestDays };
