/**
 * Odds Normalization Layer
 * 
 * Converts game data from shared-data odds-fetcher to standardized format
 * Required fields (hard gates):
 * - gameId
 * - sport
 * - homeTeam
 * - awayTeam
 * - gameTimeUtc (ISO string, parseable)
 * - capturedAtUtc (ISO string)
 * - market (raw odds data, if available)
 */

/**
 * Normalize a single game from shared-data format to cheddar-logic format
 * @param {object} rawGame - Game object from shared-data odds-fetcher
 * @param {string} sport - Sport code (NHL, NBA, MLB, NFL)
 * @returns {object|null} Normalized game or null if missing required fields
 */
function normalizeGame(rawGame, sport) {
  if (!rawGame) return null;

  // Validate required fields
  const gameId = rawGame.gameId || rawGame.id;
  const homeTeam = rawGame.home_team;
  const awayTeam = rawGame.away_team;
  const gameTimeUtc = rawGame.commence_time;

  // Hard gates: drop if missing any required field
  if (!gameId) {
    console.warn('[Normalize] Skipped game: missing gameId');
    return null;
  }
  if (!homeTeam) {
    console.warn(`[Normalize] Skipped game ${gameId}: missing homeTeam`);
    return null;
  }
  if (!awayTeam) {
    console.warn(`[Normalize] Skipped game ${gameId}: missing awayTeam`);
    return null;
  }
  if (!gameTimeUtc) {
    console.warn(`[Normalize] Skipped game ${gameId}: missing gameTimeUtc`);
    return null;
  }

  // Validate gameTimeUtc is parseable ISO string
  const gameDate = new Date(gameTimeUtc);
  if (isNaN(gameDate.getTime())) {
    console.warn(`[Normalize] Skipped game ${gameId}: gameTimeUtc not valid ISO "${gameTimeUtc}"`);
    return null;
  }

  // Build normalized object
  const market = rawGame.markets || {};
  const h2h = Array.isArray(market.h2h) ? market.h2h[0] : null;
  const totals = Array.isArray(market.totals) ? market.totals[0] : null;
  const spreads = Array.isArray(market.spreads) ? market.spreads[0] : null;

  return {
    gameId,
    sport: sport.toUpperCase(),
    homeTeam: homeTeam.trim(),
    awayTeam: awayTeam.trim(),
    gameTimeUtc, // Use exactly as provided (ISO UTC)
    capturedAtUtc: new Date().toISOString(),
    market, // Raw market data (h2h, totals, spreads, etc.)
    odds: {
      h2hHome: h2h?.home ?? null,
      h2hAway: h2h?.away ?? null,
      total: totals?.line ?? null,
      spreadHome: spreads?.home_line ?? null,
      spreadAway: spreads?.away_line ?? null,
      monelineHome: h2h?.home ?? null,
      monelineAway: h2h?.away ?? null
    },
    raw: rawGame // Keep raw for debugging
  };
}

/**
 * Normalize an array of games from shared-data format
 * @param {array} rawGames - Games from shared-data odds-fetcher
 * @param {string} sport - Sport code
 * @returns {object} { games: [...], skipped: number, errors: [...] }
 */
function normalizeGames(rawGames, sport) {
  const games = [];
  let skippedMissingFields = 0;
  const errors = [];

  if (!Array.isArray(rawGames)) {
    errors.push(`Expected array, got ${typeof rawGames}`);
    return { games: [], skipped: 0, errors };
  }

  for (const rawGame of rawGames) {
    try {
      const normalized = normalizeGame(rawGame, sport);
      if (normalized) {
        games.push(normalized);
      } else {
        skippedMissingFields++;
      }
    } catch (err) {
      skippedMissingFields++;
      errors.push(`Game ${rawGame?.gameId || 'unknown'}: ${err.message}`);
    }
  }

  return { games, skippedMissingFields, errors };
}

module.exports = {
  normalizeGame,
  normalizeGames
};
