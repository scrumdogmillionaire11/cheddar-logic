/**
 * Normalize Odds Data
 * Handles multiple provider schema variations transparently
 */

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null) return obj[k];
  }
  return null;
}

/**
 * Normalize a game object from odds provider to canonical shape
 * @param {object} raw - Raw game object from provider
 * @param {string} sport - Sport code (NHL, NBA, etc.)
 * @returns {object} Normalized game+odds object, or null if required fields missing
 */
function normalizeGame(raw, sport) {
  // Game identifiers
  const gameId =
    pick(raw, ['gameId', 'game_id', 'id', 'key']) ||
    null;

  // Teams
  const homeTeam =
    pick(raw, ['home_team', 'homeTeam', 'home_team_name', 'homeName']) ||
    pick(raw?.teams, ['home', 'homeTeam', 'home_team']) ||
    null;

  const awayTeam =
    pick(raw, ['away_team', 'awayTeam', 'away_team_name', 'awayName']) ||
    pick(raw?.teams, ['away', 'awayTeam', 'away_team']) ||
    null;

  // Game start time
  const startTimeStr =
    pick(raw, ['game_time_utc', 'start_time_utc', 'commence_time', 'start_time', 'gameTime', 'startTime']) ||
    null;

  let gameTimeUtc = null;
  if (startTimeStr) {
    const d = new Date(startTimeStr);
    gameTimeUtc = isNaN(d.getTime()) ? null : d.toISOString();
  }

  // Odds data
  const h2hHome = pick(raw, ['h2h_home', 'h2hHome', 'home_moneyline']) || null;
  const h2hAway = pick(raw, ['h2h_away', 'h2hAway', 'away_moneyline']) || null;
  const spreadHome = pick(raw, ['spread_home', 'spreadHome', 'home_spread']) || null;
  const spreadAway = pick(raw, ['spread_away', 'spreadAway', 'away_spread']) || null;
  const monelineHome = pick(raw, ['moneyline_home', 'monelineHome', 'home_moneyline_odds']) || null;
  const monelineAway = pick(raw, ['moneyline_away', 'monelineAway', 'away_moneyline_odds']) || null;
  const total = pick(raw, ['total', 'over_under', 'ou_total']) || null;

  // Gate on required fields
  if (!gameId || !homeTeam || !awayTeam || !gameTimeUtc) {
    return null;
  }

  return {
    gameId,
    sport,
    homeTeam,
    awayTeam,
    gameTimeUtc,
    odds: {
      h2hHome,
      h2hAway,
      spreadHome,
      spreadAway,
      monelineHome,
      monelineAway,
      total
    },
    raw
  };
}

module.exports = { normalizeGame, pick };
