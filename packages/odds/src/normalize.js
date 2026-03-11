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
 *
 * Source Contract:
 * - Each sport defines required markets in packages/odds/src/config.js
 * - All required markets must be present and prices non-null (strict mode)
 * - Missing markets logged as SOURCE_CONTRACT_FAILURE diagnostics
 */

const SPORTS_CONFIG = require('./config');

/**
 * Get required markets for a sport from config
 * @param {string} sport - Sport code (NHL, NBA, NCAAM, etc.)
 * @returns {array} Required market names for the sport
 */
function getRequiredMarkets(sport) {
  const config = SPORTS_CONFIG[sport.toUpperCase()];
  return config?.markets || [];
}

/**
 * Validate that a game has all required market data for its sport
 * Always returns valid result; missing markets tracked in contract metadata
 *
 * @param {object} game - Normalized game object
 * @param {string} sport - Sport code
 * @returns {{marketOk: boolean, missing: array, details: object}}
 */
function validateMarketContract(game, sport) {
  if (!game || !game.market) {
    return {
      marketOk: false,
      missing: getRequiredMarkets(sport),
      details: { reason: 'no_market_data' },
    };
  }

  const required = getRequiredMarkets(sport);
  const missing = [];
  const prices = {};

  for (const market of required) {
    const marketData = Array.isArray(game.market[market])
      ? game.market[market][0]
      : game.market[market];

    if (!marketData) {
      missing.push(market);
      continue;
    }

    // Check that required price fields are present
    const hasValidPrices =
      market === 'h2h'
        ? marketData.home !== null && marketData.away !== null
        : market === 'totals'
          ? marketData.over !== null && marketData.under !== null
          : market === 'spreads'
            ? marketData.home_price !== null && marketData.away_price !== null
            : true;

    if (!hasValidPrices) {
      missing.push(`${market}_incomplete_prices`);
    }

    prices[market] = !!hasValidPrices;
  }

  return {
    marketOk: missing.length === 0,
    missing,
    prices,
    details: {
      required,
      sport: sport.toUpperCase(),
    },
  };
}

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
    console.warn(
      `[Normalize] Skipped game ${gameId}: gameTimeUtc not valid ISO "${gameTimeUtc}"`,
    );
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
      totalPriceOver: totals?.over ?? null,
      totalPriceUnder: totals?.under ?? null,
      spreadHome: spreads?.home_line ?? null,
      spreadAway: spreads?.away_line ?? null,
      spreadPriceHome: spreads?.home_price ?? null,
      spreadPriceAway: spreads?.away_price ?? null,
      monelineHome: h2h?.home ?? null,
      monelineAway: h2h?.away ?? null,
    },
    raw: rawGame, // Keep raw for debugging
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
  normalizeGames,
  validateMarketContract,
  getRequiredMarkets,
};
