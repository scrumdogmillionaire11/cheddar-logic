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
const {
  buildConsensus,
  detectMisprice,
  selectBestExecution,
} = require('./market_evaluator');

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
  const spreadConsensus = buildConsensus(market.spreads || [], 'spread');
  const totalConsensus = buildConsensus(market.totals || [], 'total');
  const h2hConsensus = buildConsensus(market.h2h || [], 'h2h');
  const spreadExecution = selectBestExecution(market.spreads || [], 'spread');
  const totalExecution = selectBestExecution(market.totals || [], 'total');
  const h2hExecution = selectBestExecution(market.h2h || [], 'h2h');
  const spreadMisprice = detectMisprice(
    spreadConsensus,
    spreadExecution,
    market.spreads || [],
    'spread',
  );
  const totalMisprice = detectMisprice(
    totalConsensus,
    totalExecution,
    market.totals || [],
    'total',
  );

  const sharedH2HBook =
    h2hExecution.best_price_home_book &&
    h2hExecution.best_price_home_book === h2hExecution.best_price_away_book
      ? h2hExecution.best_price_home_book
      : null;

  return {
    gameId,
    sport: sport.toUpperCase(),
    homeTeam: homeTeam.trim(),
    awayTeam: awayTeam.trim(),
    gameTimeUtc, // Use exactly as provided (ISO UTC)
    capturedAtUtc: new Date().toISOString(),
    market, // Raw market data (h2h, totals, spreads, etc.)
    odds: {
      h2hHome: h2hExecution.best_price_home,
      h2hAway: h2hExecution.best_price_away,
      h2hBook: sharedH2HBook,
      h2hHomeBook: h2hExecution.best_price_home_book,
      h2hAwayBook: h2hExecution.best_price_away_book,
      total: totalConsensus.consensus_line,
      totalBook: null,
      totalLineOver: totalExecution.best_line_over,
      totalLineOverBook: totalExecution.best_line_over_book,
      totalLineUnder: totalExecution.best_line_under,
      totalLineUnderBook: totalExecution.best_line_under_book,
      totalPriceOver: totalExecution.best_price_over,
      totalPriceOverBook: totalExecution.best_price_over_book,
      totalPriceUnder: totalExecution.best_price_under,
      totalPriceUnderBook: totalExecution.best_price_under_book,
      spreadHome: spreadExecution.best_line_home,
      spreadHomeBook: spreadExecution.best_line_home_book,
      spreadAway: spreadExecution.best_line_away,
      spreadAwayBook: spreadExecution.best_line_away_book,
      spreadPriceHome: spreadExecution.best_price_home,
      spreadPriceHomeBook: spreadExecution.best_price_home_book,
      spreadPriceAway: spreadExecution.best_price_away,
      spreadPriceAwayBook: spreadExecution.best_price_away_book,
      spreadConsensusLine: spreadConsensus.consensus_line,
      spreadConsensusConfidence: spreadConsensus.consensus_confidence,
      spreadDispersionStddev: spreadConsensus.dispersion_stddev,
      spreadSourceBookCount: spreadConsensus.source_book_count,
      spreadIsMispriced: spreadMisprice.is_mispriced,
      spreadMispriceType: spreadMisprice.misprice_type,
      spreadMispriceStrength: spreadMisprice.misprice_strength,
      spreadOutlierBook: spreadMisprice.outlier_book,
      spreadOutlierDelta: spreadMisprice.outlier_delta_vs_consensus,
      spreadReviewFlag: spreadMisprice.review_flag,
      monelineHome: h2hExecution.best_price_home,
      monelineAway: h2hExecution.best_price_away,
      totalConsensusLine: totalConsensus.consensus_line,
      totalConsensusConfidence: totalConsensus.consensus_confidence,
      totalDispersionStddev: totalConsensus.dispersion_stddev,
      totalSourceBookCount: totalConsensus.source_book_count,
      totalIsMispriced: totalMisprice.is_mispriced,
      totalMispriceType: totalMisprice.misprice_type,
      totalMispriceStrength: totalMisprice.misprice_strength,
      totalOutlierBook: totalMisprice.outlier_book,
      totalOutlierDelta: totalMisprice.outlier_delta_vs_consensus,
      totalReviewFlag: totalMisprice.review_flag,
      h2hConsensusHome: h2hConsensus.consensus_price_home,
      h2hConsensusAway: h2hConsensus.consensus_price_away,
      h2hConsensusConfidence: h2hConsensus.consensus_confidence,
      // Deprecated fields kept null for compatibility with existing snapshot schema.
      totalF5Line: null,
      totalF5Over: null,
      totalF5OverBook: null,
      totalF5Under: null,
      totalF5UnderBook: null,
      total1pLine: null,
      total1pOver: null,
      total1pUnder: null,
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
