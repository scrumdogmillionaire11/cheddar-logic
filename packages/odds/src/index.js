/**
 * ============================================================
 * ADAPTER API — PUBLIC CONTRACT
 * ============================================================
 * Export: fetchOdds({ sport, hoursAhead })
 *
 * DO NOT WRITE DB HERE.
 * This package fetches and normalizes odds only.
 * DB persistence is the responsibility of pull_odds_hourly.js.
 * ============================================================
 */

/**
 * @cheddar-logic/odds
 *
 * Odds fetching and normalization layer
 * Calls The Odds API directly (self-contained, no external dependencies)
 *
 * Does NOT write to DB. Only fetches, normalizes, and returns data.
 * Consumer (pull_odds_hourly) is responsible for DB persistence.
 */

const axios = require('axios');
const path = require('path');
const { normalizeGames } = require('./normalize');
const { getSportConfig } = require('./config');

// Load .env from project root (3 levels up from packages/odds/src)
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

/**
 * Fetch odds for a sport and normalize the output
 * 
 * Does NOT write to DB — returns normalized games only.
 * 
 * @param {object} params
 * @param {string} params.sport - Sport code (NHL, NBA, MLB, NFL)
 * @param {number} params.hoursAhead - Fetch games within this many hours (default 36)
 * @returns {object} { games: [...], errors: [...], rawCount: number }
 */
async function fetchOdds({ sport, hoursAhead = 36 } = {}) {
  const apiKey = process.env.ODDS_API_KEY;

  if (!apiKey) {
    return {
      games: [],
      errors: ['ODDS_API_KEY not found in environment variables'],
      rawCount: 0
    };
  }

  const config = getSportConfig(sport);
  if (!config) {
    return {
      games: [],
      errors: [`Unknown sport: ${sport}`],
      rawCount: 0
    };
  }

  try {
    console.log(`[Odds] Fetching ${sport} (${hoursAhead}h horizon)...`);

    // Call The Odds API directly
    const rawGames = await fetchFromOddsAPI(sport, config, apiKey);

    console.log(`[Odds] Got ${rawGames.length} raw games for ${sport}`);

    // Filter to games within time window
    const now = Date.now();
    const cutoff = now + (hoursAhead * 60 * 60 * 1000);
    const filteredGames = rawGames.filter(game => {
      const gameTime = new Date(game.commence_time).getTime();
      return gameTime > now && gameTime <= cutoff;
    });

    console.log(`[Odds] ${filteredGames.length} games within ${hoursAhead}h window`);

    // Normalize the games
    const { games, skippedMissingFields, errors } = normalizeGames(filteredGames, sport);

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

/**
 * Fetch from The Odds API and transform to internal format
 * @private
 */
async function fetchFromOddsAPI(sport, config, apiKey) {
  const url = `https://api.the-odds-api.com/v4/sports/${config.apiKey}/odds`;
  const params = {
    apiKey,
    regions: 'us',
    markets: config.markets.join(','),
    bookmakers: config.bookmakers.join(','),
    oddsFormat: 'american'
  };

  console.log(`[Odds] API call: ${url}?markets=${config.markets.join(',')}`);

  const response = await axios.get(url, {
    params,
    timeout: 10000
  });

  const remaining = response.headers['x-requests-remaining'];
  if (remaining) {
    const remainingInt = parseInt(remaining);
    console.log(`[Odds] API quota remaining: ${remainingInt}`);
    if (remainingInt < 200) {
      console.warn(`[Odds] ⚠️  LOW API QUOTA: ${remaining} requests remaining`);
    }
  }

  // Transform API response to internal format (matches shared-data structure)
  return transformAPIResponse(response.data, sport);
}

/**
 * Transform The Odds API response to internal format
 * @private
 */
function transformAPIResponse(apiData, sport) {
  if (!Array.isArray(apiData)) {
    console.warn('[Odds] API returned non-array response');
    return [];
  }

  return apiData.map(game => {
    const transformed = {
      gameId: game.id,
      sport: sport.toUpperCase(),
      matchup: `${game.away_team} @ ${game.home_team}`,
      home_team: game.home_team,
      away_team: game.away_team,
      commence_time: game.commence_time,
      markets: {}
    };

    // Extract market data from all bookmakers
    if (game.bookmakers && game.bookmakers.length > 0) {
      game.bookmakers.forEach(bookmaker => {
        bookmaker.markets?.forEach(market => {
          if (market.key === 'h2h') {
            const homeOutcome = market.outcomes.find(o => o.name === game.home_team);
            const awayOutcome = market.outcomes.find(o => o.name === game.away_team);

            if (!transformed.markets.h2h) transformed.markets.h2h = [];
            transformed.markets.h2h.push({
              book: bookmaker.key,
              home: homeOutcome?.price,
              away: awayOutcome?.price
            });
          }

          if (market.key === 'totals') {
            const overOutcome = market.outcomes.find(o => o.name === 'Over');
            const underOutcome = market.outcomes.find(o => o.name === 'Under');

            if (!transformed.markets.totals) transformed.markets.totals = [];
            transformed.markets.totals.push({
              book: bookmaker.key,
              line: overOutcome?.point,
              over: overOutcome?.price,
              under: underOutcome?.price
            });
          }

          if (market.key === 'spreads') {
            const homeOutcome = market.outcomes.find(o => o.name === game.home_team);
            const awayOutcome = market.outcomes.find(o => o.name === game.away_team);

            if (!transformed.markets.spreads) transformed.markets.spreads = [];
            transformed.markets.spreads.push({
              book: bookmaker.key,
              home_line: homeOutcome?.point,
              home_price: homeOutcome?.price,
              away_line: awayOutcome?.point,
              away_price: awayOutcome?.price
            });
          }
        });
      });
    }

    return transformed;
  });
}

module.exports = {
  fetchOdds,
  // Expose config utilities for external use
  getSportConfig,
  getActiveSports: require('./config').getActiveSports,
  getTokensForFetch: require('./config').getTokensForFetch,
  isInSeason: require('./config').isInSeason
};
