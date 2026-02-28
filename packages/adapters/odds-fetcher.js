/**
 * Odds Adapter (deprecated)
 *
 * DB writes have moved to apps/worker job orchestration.
 * This module now only fetches normalized odds data.
 */

const { fetchOdds } = require('@cheddar-logic/odds');

/**
 * Fetch normalized odds for a sport (no DB writes)
 *
 * @param {string} sport - Sport to fetch (NHL, NBA, etc.)
 * @returns {object} { fetched: number, failed: number, errors: array, games: array }
 */
async function fetchOddsAndPersist(oddsFetcher, sport, jobRunId) {
  try {
    const { games, errors } = await fetchOdds({ sport, hoursAhead: 36 });
    const fetched = Array.isArray(games) ? games.length : 0;
    const failed = Array.isArray(errors) ? errors.length : 0;

    return {
      fetched,
      failed,
      errors: errors || [],
      games: games || []
    };
  } catch (error) {
    console.error(`[OddsAdapter] Error fetching ${sport}:`, error.message);
    return {
      fetched: 0,
      failed: 1,
      errors: [error.message]
    };
  }
}

/**
 * Batch fetch normalized odds for multiple sports (no DB writes)
 *
 * @param {array} sports - List of sports to fetch
 * @returns {object} Aggregated results
 */
async function fetchMultipleSportsAndPersist(oddsFetcher, sports, jobRunId) {
  const allResults = {
    sports: [],
    totalFetched: 0,
    totalFailed: 0,
    errors: []
  };

  for (const sport of sports) {
    const result = await fetchOddsAndPersist(null, sport, null);
    allResults.sports.push({
      sport,
      ...result
    });
    allResults.totalFetched += result.fetched;
    allResults.totalFailed += result.failed;
    if (result.errors.length > 0) {
      allResults.errors.push(...result.errors);
    }
  }

  return allResults;
}

module.exports = {
  fetchOddsAndPersist,
  fetchMultipleSportsAndPersist
};
