/**
 * @cheddar-logic/odds
 * 
 * Odds fetching and normalization layer
 * 
 * Does NOT write to DB. Only fetches, normalizes, and returns data.
 * Consumer (pull_odds_hourly) is responsible for DB persistence.
 */

const { normalizeGames } = require('./normalize');

// Import shared-data odds-fetcher (path relative to cheddar-logic root)
// Using require.resolve to safely import from external project
let sharedDataOddsFetcher;
try {
  sharedDataOddsFetcher = require('/Users/ajcolubiale/projects/shared-data/lib/odds-fetcher.js');
} catch (err) {
  console.error('[Odds] Failed to load shared-data odds-fetcher:', err.message);
  sharedDataOddsFetcher = null;
}

/**
 * Fetch odds for a sport and normalize the output
 * 
 * Does NOT write to DB — returns normalized games only.
 * 
 * @param {object} params
 * @param {string} params.sport - Sport code (NHL, NBA, MLB, NFL)
 * @param {number} params.hoursAhead - Fetch games within this many hours (default 36)
 * @returns {object} { games: [...], errors: [...] }
 */
async function fetchOdds({ sport, hoursAhead = 36 } = {}) {
  if (!sharedDataOddsFetcher) {
    return {
      games: [],
      errors: ['shared-data odds-fetcher not available'],
      rawCount: 0
    };
  }

  try {
    console.log(`[Odds] Fetching ${sport} (${hoursAhead}h horizon)...`);

    // Call shared-data odds-fetcher
    const rawGames = await sharedDataOddsFetcher.getUpcomingGames(sport, hoursAhead);

    if (!Array.isArray(rawGames)) {
      return {
        games: [],
        errors: [`Expected array from getUpcomingGames, got ${typeof rawGames}`],
        rawCount: 0
      };
    }

    console.log(`[Odds] Got ${rawGames.length} raw games for ${sport}`);

    // Normalize the games
    const { games, skippedMissingFields, errors } = normalizeGames(rawGames, sport);

    if (skippedMissingFields > 0) {
      console.warn(`[Odds] skippedMissingFields=${skippedMissingFields} for ${sport}`);
    }

    if (games.length === 0) {
      console.log(`[Odds] No valid games for ${sport} after normalization`);
    }

    return { games, errors, rawCount: rawGames.length };
  } catch (err) {
    console.error(`[Odds] Error fetching ${sport}:`, err.message);
    return {
      games: [],
      errors: [`${sport}: ${err.message}`],
      rawCount: 0
    };
  }
}

module.exports = {
  fetchOdds
};
