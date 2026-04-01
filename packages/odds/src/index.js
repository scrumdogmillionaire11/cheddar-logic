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
 * @returns {object} { games: [...], errors: [...], rawCount: number, windowRawCount: number }
 */
async function fetchOdds({ sport, hoursAhead = 36 } = {}) {
  const apiKey = process.env.ODDS_API_KEY;
  const backupApiKey = process.env.BACKUP_ODDS_API_KEY;

  if (!apiKey && !backupApiKey) {
    return {
      games: [],
      errors: ['ODDS_API_KEY not found in environment variables'],
      rawCount: 0,
      windowRawCount: 0,
    };
  }

  const config = getSportConfig(sport);
  if (!config) {
    return {
      games: [],
      errors: [`Unknown sport: ${sport}`],
      rawCount: 0,
      windowRawCount: 0,
    };
  }

  try {
    console.log(`[Odds] Fetching ${sport} (${hoursAhead}h horizon)...`);

    // Try primary key; fall back to backup on auth/quota errors
    let fetchResult;
    try {
      fetchResult = await fetchFromOddsAPI(sport, config, apiKey);
    } catch (primaryErr) {
      const status = primaryErr?.response?.status;
      if (backupApiKey && (status === 401 || status === 402 || status === 429)) {
        console.warn(
          `[Odds] Primary key failed (HTTP ${status}) — retrying with BACKUP_ODDS_API_KEY`,
        );
        fetchResult = await fetchFromOddsAPI(sport, config, backupApiKey);
      } else {
        throw primaryErr;
      }
    }

const { games: rawGames, remainingTokens } = fetchResult;

    console.log(`[Odds] Got ${rawGames.length} raw games for ${sport}`);

    // Filter to games within time window
    const now = Date.now();
    const cutoff = now + hoursAhead * 60 * 60 * 1000;
    const filteredGames = rawGames.filter((game) => {
      const gameTime = new Date(game.commence_time).getTime();
      return gameTime > now && gameTime <= cutoff;
    });

    console.log(
      `[Odds] ${filteredGames.length} games within ${hoursAhead}h window`,
    );

    // Normalize the games
    const { games, skippedMissingFields, errors } = normalizeGames(
      filteredGames,
      sport,
    );

    if (skippedMissingFields > 0) {
      console.warn(
        `[Odds] skippedMissingFields=${skippedMissingFields} for ${sport}`,
      );
    }

    if (games.length === 0) {
      console.log(`[Odds] No valid games for ${sport} after normalization`);
    }

    return {
      games,
      errors,
      rawCount: rawGames.length,
      windowRawCount: filteredGames.length,
      remainingTokens,
    };
  } catch (err) {
    console.error(`[Odds] Error fetching ${sport}:`, err.message);
    return {
      games: [],
      errors: [`${sport}: ${err.message}`],
      rawCount: 0,
      windowRawCount: 0,
      remainingTokens: null,
    };
  }
}

/**
 * Fetch from The Odds API and transform to internal format
 * @private
 */
async function fetchFromOddsAPI(sport, config, apiKey) {
  // All active sports use config.apiKey (singular).
  const url = `https://api.the-odds-api.com/v4/sports/${config.apiKey}/odds`;
  const params = {
    apiKey,
    regions: 'us',
    markets: config.markets.join(','),
    bookmakers: config.bookmakers.join(','),
    oddsFormat: 'american',
  };

  console.log(`[Odds] API call: ${url}?markets=${config.markets.join(',')}`);

  const response = await axios.get(url, {
    params,
    timeout: 10000,
  });

  const remaining = response.headers['x-requests-remaining'];
  let remainingTokens = null;
  if (remaining) {
    remainingTokens = parseInt(remaining);
    console.log(`[Odds] API quota remaining: ${remainingTokens}`);
    if (remainingTokens < 200) {
      console.warn(`[Odds] ⚠️  LOW API QUOTA: ${remaining} requests remaining`);
    }
  }

  // If sport has period markets, fetch them separately (Odds API returns 422
  // when period/alternate markets are mixed with featured markets in one call).
  let mergedApiData = response.data;
  if (config.periodMarkets && config.periodMarkets.length > 0) {
    const periodParams = {
      apiKey,
      regions: 'us',
      markets: config.periodMarkets.join(','),
      bookmakers: config.bookmakers.join(','),
      oddsFormat: 'american',
    };
    console.log(
      `[Odds] API call: ${url}?markets=${config.periodMarkets.join(',')} (period)`,
    );
    const periodResponse = await axios.get(url, {
      params: periodParams,
      timeout: 10000,
    });

    // Overwrite remainingTokens with the most recent API header value
    const periodRemaining = periodResponse.headers['x-requests-remaining'];
    if (periodRemaining) {
      remainingTokens = parseInt(periodRemaining);
      console.log(`[Odds] API quota remaining after period fetch: ${remainingTokens}`);
      if (remainingTokens < 200) {
        console.warn(`[Odds] ⚠️  LOW API QUOTA: ${remainingTokens} requests remaining`);
      }
    }

    // Merge period-market bookmaker data into featured game objects by game.id
    if (Array.isArray(periodResponse.data)) {
      const periodByGameId = new Map(
        periodResponse.data
          .filter((g) => g && g.id)
          .map((g) => [g.id, g]),
      );

      mergedApiData = (response.data || []).map((game) => {
        const periodGame = periodByGameId.get(game?.id);
        if (!periodGame) return game;
        return {
          ...game,
          bookmakers: [
            ...(game.bookmakers || []),
            ...(periodGame.bookmakers || []),
          ],
        };
      });
    }
  }

  // Transform API response to internal format (matches shared-data structure)
  return { games: transformAPIResponse(mergedApiData, sport), remainingTokens };
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

  return apiData.map((game) => {
    const transformed = {
      gameId: game.id,
      sport: sport.toUpperCase(),
      matchup: `${game.away_team} @ ${game.home_team}`,
      home_team: game.home_team,
      away_team: game.away_team,
      commence_time: game.commence_time,
      markets: {},
    };

    // Extract market data from all bookmakers
    if (game.bookmakers && game.bookmakers.length > 0) {
      game.bookmakers.forEach((bookmaker) => {
        bookmaker.markets?.forEach((market) => {
          if (market.key === 'h2h') {
            const homeOutcome = market.outcomes.find(
              (o) => o.name === game.home_team,
            );
            const awayOutcome = market.outcomes.find(
              (o) => o.name === game.away_team,
            );

            if (!transformed.markets.h2h) transformed.markets.h2h = [];
            transformed.markets.h2h.push({
              book: bookmaker.key,
              home: homeOutcome?.price,
              away: awayOutcome?.price,
            });
          }

          if (market.key === 'totals') {
            const overOutcome = market.outcomes.find((o) => o.name === 'Over');
            const underOutcome = market.outcomes.find(
              (o) => o.name === 'Under',
            );

            if (!transformed.markets.totals) transformed.markets.totals = [];
            transformed.markets.totals.push({
              book: bookmaker.key,
              line: overOutcome?.point,
              over: overOutcome?.price,
              under: underOutcome?.price,
            });
          }

          if (market.key === 'spreads') {
            const homeOutcome = market.outcomes.find(
              (o) => o.name === game.home_team,
            );
            const awayOutcome = market.outcomes.find(
              (o) => o.name === game.away_team,
            );

            if (!transformed.markets.spreads) transformed.markets.spreads = [];
            transformed.markets.spreads.push({
              book: bookmaker.key,
              home_line: homeOutcome?.point,
              home_price: homeOutcome?.price,
              away_line: awayOutcome?.point,
              away_price: awayOutcome?.price,
            });
          }

          if (market.key === 'totals_1st_5_innings') {
            const overOutcome = market.outcomes.find((o) => o.name === 'Over');
            const underOutcome = market.outcomes.find((o) => o.name === 'Under');

            if (!transformed.markets.totals_1st_5_innings)
              transformed.markets.totals_1st_5_innings = [];
            transformed.markets.totals_1st_5_innings.push({
              book: bookmaker.key,
              line: overOutcome?.point,
              over: overOutcome?.price,
              under: underOutcome?.price,
            });
          }

          if (market.key === 'totals_1st_period' || market.key === 'totals_p1') {
            const overOutcome = market.outcomes.find((o) => o.name === 'Over');
            const underOutcome = market.outcomes.find((o) => o.name === 'Under');

            if (!transformed.markets.totals_1st_period)
              transformed.markets.totals_1st_period = [];
            transformed.markets.totals_1st_period.push({
              book: bookmaker.key,
              line: overOutcome?.point,
              over: overOutcome?.price,
              under: underOutcome?.price,
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
  isInSeason: require('./config').isInSeason,
};
