/**
 * Sports Configuration
 * Defines active sports, their seasons, markets, and API details
 * 
 * Token costs (The Odds API pricing):
 * - 1 token = 1 market pulled (region fixed to 'us')
 * - NHL: h2h + totals = 2 tokens
 * - NBA: h2h + totals + spreads = 3 tokens
 * - MLB: h2h + totals = 2 tokens
 * - NFL: h2h + totals + spreads = 3 tokens
 * - Multiple bookmakers doesn't increase token cost
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
    markets: ['h2h', 'totals'],
    tokensPerFetch: 2,
    defaultTTL: 240,             // 4 hours standard
    pregameTTL: 30,              // 30 min inside 2 hours
    sharpWindowTTL: 0,           // Don't cache inside 1 hour — fetch on demand
    apiKey: 'icehockey_nhl',
    bookmakers: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
  },

  NBA: {
    active: true,
    season: { start: '10-01', end: '06-30' },
    markets: ['h2h', 'totals', 'spreads'],
    tokensPerFetch: 3,
    defaultTTL: 240,
    pregameTTL: 30,
    sharpWindowTTL: 0,
    apiKey: 'basketball_nba',
    bookmakers: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
  },

  MLB: {
    active: false,               // Flip this when season starts (~March 20)
    season: { start: '03-20', end: '11-01' },
    markets: ['h2h', 'totals'],
    tokensPerFetch: 2,
    defaultTTL: 180,             // Shorter — SP confirmations move lines faster
    pregameTTL: 20,              // Tighter pregame window for weather/lineup
    sharpWindowTTL: 0,
    apiKey: 'baseball_mlb',
    bookmakers: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff'],
    notes: 'No external model yet — dashboard only'
  },

  NFL: {
    active: false,               // Flip during season (~September-February)
    season: { start: '09-01', end: '02-15' },
    markets: ['h2h', 'totals', 'spreads'],
    tokensPerFetch: 3,
    defaultTTL: 1440,            // 24 hours — weekly sport
    pregameTTL: 60,              // 1 hour pregame window
    sharpWindowTTL: 15,          // 15 min before kickoff
    apiKey: 'americanfootball_nfl',
    bookmakers: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
  },

  NCAAM: {
    active: true,
    season: { start: '11-01', end: '04-15' },
    markets: ['h2h', 'totals', 'spreads'],
    tokensPerFetch: 3,
    defaultTTL: 240,
    pregameTTL: 30,
    sharpWindowTTL: 0,
    apiKey: 'basketball_ncaab',
    bookmakers: ['betmgm', 'draftkings', 'fanduel', 'williamhill_us', 'espnbet', 'fliff']
  }
};

/**
 * Get list of currently active sports based on their active flag and season dates
 */
function getActiveSports() {
  const today = new Date();
  const mmdd = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  
  return Object.entries(SPORTS_CONFIG)
    .filter(([_, cfg]) => {
      if (!cfg.active) return false;
      
      // Simple date range check (doesn't handle year boundaries perfectly, but works for season logic)
      const inSeason = mmdd >= cfg.season.start || mmdd <= cfg.season.end;
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
  const mmdd = `${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  
  return mmdd >= cfg.season.start || mmdd <= cfg.season.end;
}

module.exports = { 
  SPORTS_CONFIG, 
  getActiveSports, 
  getTokensForFetch,
  getSportConfig,
  isInSeason
};
