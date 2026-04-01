/**
 * Sports Configuration
 * Defines active sports, their seasons, markets, and API details
 *
 * Token costs (The Odds API pricing):
 * - 1 token = 1 market pulled (region fixed to 'us')
 * - Multiple bookmakers doesn't increase token cost
 *
 * Canonical market budget — MUST stay at 7 tokens total per composite run:
 *   NBA  (main job):  totals + spreads                       = 2 tokens
 *   NHL  (main job):  totals + totals_1st_period              = 2 tokens
 *   NHL  (prop job):  player_shots_on_goal                   = 1 token
 *   MLB  (main job):  totals_1st_5_innings                   = 1 token
 *   MLB  (prop job):  pitcher_strikeouts                     = 1 token
 *   ──────────────────────────────────────────────────────── = 7 tokens
 *
 * To add a market: increment tokensPerFetch / propTokensPerRun here,
 * verify the total above stays acceptable, update the pipeline (index.js,
 * normalize.js, odds.js migration) if it is a new game-market type.
 *
 * US Bookmakers:
 * - betmgm, draftkings, fanduel (main books)
 * - williamhill_us (Caesars), espnbet (theScore Bet)
 * - fliff, hardrockbet, fanatics
 */

const SPORTS_CONFIG = {
  NHL: {
    active: true,
    season: { start: '10-01', end: '04-30' },
    markets: ['totals', 'totals_1st_period'],
    tokensPerFetch: 2,
    propMarkets: ['player_shots_on_goal'],
    propTokensPerRun: 1,
    defaultTTL: 240, // 4 hours standard
    pregameTTL: 30, // 30 min inside 2 hours
    sharpWindowTTL: 0, // Don't cache inside 1 hour — fetch on demand
    apiKey: 'icehockey_nhl',
    bookmakers: [
      'betmgm',
      'draftkings',
      'fanduel',
      'williamhill_us',
      'espnbet',
      'fliff',
    ],
  },

  NBA: {
    active: true,
    season: { start: '10-01', end: '06-30' },
    markets: ['totals', 'spreads'],
    tokensPerFetch: 2,
    defaultTTL: 240,
    pregameTTL: 30,
    sharpWindowTTL: 0,
    apiKey: 'basketball_nba',
    bookmakers: [
      'betmgm',
      'draftkings',
      'fanduel',
      'williamhill_us',
      'espnbet',
      'fliff',
    ],
  },

  MLB: {
    active: true, // season starts 2026-03-25
    season: { start: '03-20', end: '11-01' },
    markets: ['totals_1st_5_innings'],
    tokensPerFetch: 1,
    propMarkets: ['pitcher_strikeouts'],
    propTokensPerRun: 1,
    defaultTTL: 180, // Shorter — SP confirmations move lines faster
    pregameTTL: 20, // Tighter pregame window for weather/lineup
    sharpWindowTTL: 0,
    apiKey: 'baseball_mlb',
    bookmakers: [
      'betmgm',
      'draftkings',
      'fanduel',
      'williamhill_us',
      'espnbet',
      'fliff',
    ],
    notes: 'No external model yet — dashboard only',
  },

  NFL: {
    active: false, // Flip during season (~September-February)
    season: { start: '09-01', end: '02-15' },
    markets: ['h2h', 'totals', 'spreads'],
    tokensPerFetch: 3,
    defaultTTL: 1440, // 24 hours — weekly sport
    pregameTTL: 60, // 1 hour pregame window
    sharpWindowTTL: 15, // 15 min before kickoff
    apiKey: 'americanfootball_nfl',
    bookmakers: [
      'betmgm',
      'draftkings',
      'fanduel',
      'williamhill_us',
      'espnbet',
      'fliff',
    ],
  },
};

/**
 * Get list of currently active sports based on their active flag and season dates
 */
function getActiveSports() {
  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  return Object.entries(SPORTS_CONFIG)
    .filter(([_, cfg]) => {
      if (!cfg.active) return false;

      // Use OR for wrap-around seasons (e.g. NFL: Sep–Feb, start > end)
      // Use AND for within-year seasons (e.g. MLB: Mar–Nov, start < end)
      const wrapsYear = cfg.season.start > cfg.season.end;
      const inSeason = wrapsYear
        ? (mmdd >= cfg.season.start || mmdd <= cfg.season.end)
        : (mmdd >= cfg.season.start && mmdd <= cfg.season.end);
      return inSeason;
    })
    .map(([sport]) => sport);
}

/**
 * Calculate total token cost for fetching multiple sports
 */
function getTokensForFetch(sports) {
  return sports.reduce((sum, sport) => {
    const cfg = SPORTS_CONFIG[sport.toUpperCase()];
    return sum + (cfg?.tokensPerFetch || 0);
  }, 0);
}

/**
 * Get sport configuration by name
 */
function getSportConfig(sport) {
  return SPORTS_CONFIG[sport.toUpperCase()];
}

/**
 * Check if a sport is currently in season
 */
function isInSeason(sport) {
  const cfg = SPORTS_CONFIG[sport.toUpperCase()];
  if (!cfg || !cfg.active) return false;

  const today = new Date();
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Use OR for wrap-around seasons (e.g. NFL: Sep–Feb, start > end)
  // Use AND for within-year seasons (e.g. MLB: Mar–Nov, start < end)
  const wrapsYear = cfg.season.start > cfg.season.end;
  return wrapsYear
    ? (mmdd >= cfg.season.start || mmdd <= cfg.season.end)
    : (mmdd >= cfg.season.start && mmdd <= cfg.season.end);
}

module.exports = {
  SPORTS_CONFIG,
  getActiveSports,
  getTokensForFetch,
  getSportConfig,
  isInSeason,
};
