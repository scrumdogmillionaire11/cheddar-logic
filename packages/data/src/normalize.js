/**
 * Text Normalization Module
 * 
 * Centralized normalization utilities to ensure consistent data quality
 * across all domains: team names, markets, cards, players, etc.
 * 
 * Philosophy: Normalize at ingestion (API → DB) once, downstream code
 * can trust the data is clean.
 */

// ============================================================================
// DIACRITICS REMOVAL
// ============================================================================

/**
 * Remove diacritics (accents, umlauts, etc.) from text
 * @param {string} text - Input text
 * @returns {string} Text with diacritics removed
 */
function removeDiacritics(text) {
  if (!text || typeof text !== 'string') return '';
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ============================================================================
// GENERIC TEXT NORMALIZATION
// ============================================================================

/**
 * Basic text cleanup: trim, collapse whitespace
 * @param {string} text - Input text
 * @returns {string} Trimmed, cleaned text
 */
function cleanText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .trim()
    .replace(/\s+/g, ' '); // Collapse multiple spaces
}

/**
 * Generic enum normalization with allowed values
 * @param {unknown} value - Input value
 * @param {string[]} allowedValues - Array of allowed uppercase values
 * @param {string} context - Optional context for logging
 * @returns {string|null} Normalized uppercase value or null
 */
function normalizeEnum(value, allowedValues, context = '') {
  if (!value || typeof value !== 'string') return null;
  
  const upper = value.trim().toUpperCase();
  if (allowedValues.includes(upper)) {
    return upper;
  }
  
  if (context) {
    console.warn(`[NORMALIZE] Invalid enum "${value}" for ${context}. Allowed: ${allowedValues.join(', ')}`);
  }
  return null;
}

// ============================================================================
// MARKET TYPE NORMALIZATION
// ============================================================================

const MARKET_ALIASES = {
  'H2H': 'MONEYLINE',
  'ML': 'MONEYLINE',
  'MONEY LINE': 'MONEYLINE',
  'MONEYLINE': 'MONEYLINE',
  
  'SPREAD': 'SPREAD',
  'LINE': 'SPREAD',
  'ATS': 'SPREAD',
  'POINT SPREAD': 'SPREAD',
  
  'TOTAL': 'TOTAL',
  'OVER/UNDER': 'TOTAL',
  'O/U': 'TOTAL',
  'OVER UNDER': 'TOTAL',
  
  'PUCKLINE': 'PUCKLINE',
  'PUCK_LINE': 'PUCKLINE',
  'PUCK LINE': 'PUCKLINE',
  
  'TEAM_TOTAL': 'TEAM_TOTAL',
  'TEAMTOTAL': 'TEAM_TOTAL',
  'TEAM TOTAL': 'TEAM_TOTAL',
  
  'PROP': 'PROP',
  
  'INFO': 'INFO',
};

const VALID_MARKETS = [
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
  'PROP',
  'INFO'
];

/**
 * Normalize market type to canonical uppercase with alias resolution
 * @param {unknown} market - Input market (any case, with aliases)
 * @param {string} context - Optional context for logging
 * @returns {string|null} Canonical market or null if invalid
 */
function normalizeMarketType(market, context = 'normalizeMarketType') {
  if (!market || typeof market !== 'string') return null;
  
  const cleaned = cleanText(market).toUpperCase();
  
  // Direct match
  if (VALID_MARKETS.includes(cleaned)) {
    return cleaned;
  }
  
  // Alias lookup
  if (MARKET_ALIASES[cleaned]) {
    return MARKET_ALIASES[cleaned];
  }
  
  console.warn(`[NORMALIZE] Unknown market type "${market}" in ${context}`);
  return null;
}

/**
 * Normalize direction/side (HOME, AWAY, OVER, UNDER, NEUTRAL, FAV, DOG)
 * @param {unknown} direction - Input direction
 * @returns {string|null} Normalized direction or null
 */
function normalizeDirection(direction, context = 'normalizeDirection') {
  if (!direction || typeof direction !== 'string') return null;
  
  const upper = cleanText(direction).toUpperCase();
  
  const validDirections = ['HOME', 'AWAY', 'OVER', 'UNDER', 'NEUTRAL', 'FAV', 'DOG'];
  if (validDirections.includes(upper)) {
    return upper;
  }
  
  console.warn(`[NORMALIZE] Invalid direction "${direction}" in ${context}`);
  return null;
}

// ============================================================================
// SPORT CODE NORMALIZATION
// ============================================================================

const VALID_SPORTS = ['NHL', 'NBA', 'NCAAM', 'SOCCER', 'MLB', 'NFL'];

const SPORT_ALIASES = {
  'COLLEGE BASKETBALL': 'NCAAM',
  'MENS COLLEGE BASKETBALL': 'NCAAM',
  'COLLEGE HOOPS': 'NCAAM',
  'HOCKEY': 'NHL',
  'BASKETBALL': 'NBA',
  'FOOTBALL': 'NFL',
  'BASEBALL': 'MLB',
  'SOCCER': 'SOCCER',
};

/**
 * Normalize sport code
 * @param {unknown} sport - Input sport name/code
 * @returns {string|null} Normalized sport (NHL, NBA, NCAAM, SOCCER, MLB, NFL) or null
 */
function normalizeSportCode(sport, context = 'normalizeSportCode') {
  if (!sport || typeof sport !== 'string') return null;
  
  const cleaned = cleanText(sport).toUpperCase();
  
  // Direct match
  if (VALID_SPORTS.includes(cleaned)) {
    return cleaned;
  }
  
  // Alias lookup
  if (SPORT_ALIASES[cleaned]) {
    return SPORT_ALIASES[cleaned];
  }
  
  console.warn(`[NORMALIZE] Unknown sport "${sport}" in ${context}`);
  return null;
}

// ============================================================================
// TEAM NAME NORMALIZATION
// ============================================================================

// Discovery tracking: collects unknown team names for periodic manual review
const discoveredTeamVariants = new Map();

/**
 * Track an unknown team name variant for discovery/review
 * @param {string} variant - Unknown team name that was encountered
 */
function trackUnknownTeamVariant(variant) {
  if (!variant) return;
  
  const key = variant.toLowerCase();
  if (discoveredTeamVariants.has(key)) {
    const entry = discoveredTeamVariants.get(key);
    entry.count += 1;
    entry.lastSeen = new Date().toISOString();
  } else {
    discoveredTeamVariants.set(key, {
      variant,
      count: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
  }
}

function normalizeTeamVariantKey(teamName) {
  if (!teamName || typeof teamName !== 'string') return '';
  return removeDiacritics(cleanText(teamName))
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Common team name variants for case-insensitive lookup fallback
const TEAM_VARIANTS = {
  'TORONTO MAPLE LEAFS': ['toronto maple leafs', 'tor maple leafs', 'maple leafs'],
  'BOSTON CELTICS': ['boston celtics', 'bos celtics', 'celtics'],
  'GOLDEN STATE WARRIORS': ['golden state warriors', 'gs warriors', 'warriors'],
  'LOS ANGELES LAKERS': ['los angeles lakers', 'la lakers', 'lakers'],
  'MIAMI HEAT': ['miami heat', 'heat'],
  'NEW YORK KNICKS': ['new york knicks', 'ny knicks', 'knicks'],
  'DENVER NUGGETS': ['denver nuggets', 'nuggets'],
  'PHOENIX SUNS': ['phoenix suns', 'suns'],
  'DALLAS MAVERICKS': ['dallas mavericks', 'mavs', 'mavericks'],
  'CHICAGO BULLS': ['chicago bulls', 'bulls'],
  'CLEVELAND CAVALIERS': ['cleveland cavaliers', 'cavs', 'cavaliers'],
  'SPORTING CP': ['sporting cp', 'sporting lisbon', 'sporting clube de portugal'],
  'BODO/GLIMT': ['bodo/glimt', 'bodo glimt', 'bodø/glimt', 'fk bodo/glimt'],
  'PARIS SAINT-GERMAIN': ['paris saint-germain', 'paris saint germain', 'psg'],
};

const LOGGED_TEAM_VARIANTS = [
  // NHL (all 32 teams)
  'Anaheim Ducks',
  'Boston Bruins',
  'Buffalo Sabres',
  'Calgary Flames',
  'Carolina Hurricanes',
  'Chicago Blackhawks',
  'Colorado Avalanche',
  'Columbus Blue Jackets',
  'Dallas Stars',
  'Detroit Red Wings',
  'Edmonton Oilers',
  'Florida Panthers',
  'Los Angeles Kings',
  'Minnesota Wild',
  'Montreal Canadiens',
  'Nashville Predators',
  'New Jersey Devils',
  'New York Islanders',
  'New York Rangers',
  'Ottawa Senators',
  'Philadelphia Flyers',
  'Pittsburgh Penguins',
  'San Jose Sharks',
  'Seattle Kraken',
  'St Louis Blues',
  'Tampa Bay Lightning',
  'Toronto Maple Leafs',
  'Utah Mammoth',
  'Vancouver Canucks',
  'Vegas Golden Knights',
  'Washington Capitals',
  'Winnipeg Jets',
  // NBA (all 30 teams)
  'Atlanta Hawks',
  'Brooklyn Nets',
  'Charlotte Hornets',
  'Chicago Bulls',
  'Cleveland Cavaliers',
  'Dallas Mavericks',
  'Denver Nuggets',
  'Detroit Pistons',
  'Golden State Warriors',
  'Houston Rockets',
  'Indiana Pacers',
  'Los Angeles Clippers',
  'Los Angeles Lakers',
  'Memphis Grizzlies',
  'Miami Heat',
  'Milwaukee Bucks',
  'Minnesota Timberwolves',
  'New Orleans Pelicans',
  'New York Knicks',
  'Oklahoma City Thunder',
  'Orlando Magic',
  'Philadelphia 76ers',
  'Phoenix Suns',
  'Portland Trail Blazers',
  'Sacramento Kings',
  'San Antonio Spurs',
  'Toronto Raptors',
  'Utah Jazz',
  'Washington Wizards',
  // NCAAM
  'Alabama A&M Bulldogs',
  'Alabama St Hornets',
  'Air Force Falcons',
  'Alcorn St Braves',
  'Arizona St Sun Devils',
  'Arkansas Razorbacks',
  'Arkansas-Little Rock Trojans',
  'Arkansas-Pine Bluff Golden Lions',
  'Auburn Tigers',
  'Baylor Bears',
  'Bellarmine Knights',
  'Boise State Broncos',
  'Boston College Eagles',
  'Butler Bulldogs',
  'BYU Cougars',
  'California Golden Bears',
  'Charlotte 49ers',
  'Cincinnati Bearcats',
  'Cleveland St Vikings',
  'Colorado Buffaloes',
  'Colorado St Rams',
  'Creighton Bluejays',
  'Davidson Wildcats',
  'DePaul Blue Demons',
  'Detroit Mercy Titans',
  'Duquesne Dukes',
  'Eastern Illinois Panthers',
  'Eastern Kentucky Colonels',
  'Florida Gators',
  'Florida Gulf Coast Eagles',
  'Florida St Seminoles',
  'Fordham Rams',
  'Fort Wayne Mastodons',
  'Fresno St Bulldogs',
  'Georgia Tech Yellow Jackets',
  'Grambling St Tigers',
  'Grand Canyon Antelopes',
  'Green Bay Phoenix',
  'GW Revolutionaries',
  'Houston Cougars',
  'Illinois Fighting Illini',
  'Indiana Hoosiers',
  'Jackson St Tigers',
  'Jacksonville Dolphins',
  'Kansas Jayhawks',
  'Kansas St Wildcats',
  'Kent State Golden Flashes',
  'La Salle Explorers',
  'Lindenwood Lions',
  'Loyola (Chi) Ramblers',
  'Louisville Cardinals',
  'LSU Tigers',
  'Marquette Golden Eagles',
  'Maryland Terrapins',
  'Miami Hurricanes',
  'Milwaukee Panthers',
  'Minnesota Golden Gophers',
  'Miss Valley St Delta Devils',
  'Mississippi St Bulldogs',
  'Nebraska Cornhuskers',
  'Nevada Wolf Pack',
  'New Mexico Lobos',
  'North Alabama Lions',
  'Northern Illinois Huskies',
  'Northern Kentucky Norse',
  'North Texas Mean Green',
  'Northwestern Wildcats',
  'Notre Dame Fighting Irish',
  'Oakland Golden Grizzlies',
  'Ohio State Buckeyes',
  'Old Dominion Monarchs',
  'Ole Miss Rebels',
  'Oregon Ducks',
  'Oral Roberts Golden Eagles',
  'Penn State Nittany Lions',
  'Pittsburgh Panthers',
  'Providence Friars',
  'Purdue Boilermakers',
  'Rhode Island Rams',
  'Rice Owls',
  'Robert Morris Colonials',
  'Saint Joseph\'s Hawks',
  'Saint Louis Billikens',
  'San Diego St Aztecs',
  'San Jose St Spartans',
  'SIU-Edwardsville Cougars',
  'SMU Mustangs',
  'Southern Jaguars',
  'St. Bonaventure Bonnies',
  'Stanford Cardinal',
  'Stetson Hatters',
  'Syracuse Orange',
  'Texas Longhorns',
  'UAB Blazers',
  'UCLA Bruins',
  'UL Monroe Warhawks',
  'UMKC Kangaroos',
  'UNLV Rebels',
  'USC Trojans',
  'Utah State Aggies',
  'Utah Utes',
  'Vanderbilt Commodores',
  'Villanova Wildcats',
  'Virginia Tech Hokies',
  'Washington Huskies',
  'West Virginia Mountaineers',
  'Wisconsin Badgers',
  'Wright St Raiders',
  'Wyoming Cowboys',
  'Youngstown St Penguins',
  // Additional mid-major/smaller NCAAM programs discovered from live odds API
  'Campbell Fighting Camels',
  'East Tennessee St Buccaneers',
  'Eastern Washington Eagles',
  'Florida Int\'l Golden Panthers',
  'Gonzaga Bulldogs',
  'Hofstra Pride',
  'Jacksonville St Gamecocks',
  'LIU Sharks',
  'Merrimack Warriors',
  'Monmouth Hawks',
  'Montana Grizzlies',
  'N Colorado Bears',
  'New Mexico St Aggies',
  'New Orleans Privateers',
  'NJIT Highlanders',
  'Oklahoma St Cowboys',
  'Oregon St Beavers',
  'Santa Clara Broncos',
  'Siena Saints',
  'Saint Mary\'s Gaels',
  'Texas A&M-CC Islanders',
  'Troy Trojans',
  'UMBC Retrievers',
  'UMass Lowell River Hawks',
  'UT Rio Grande Valley Vaqueros',
  'Wake Forest Demon Deacons',
  // Additional variants discovered from live odds pull
  'Furman Paladins',
  'Georgia Southern Eagles',
  'Mercyhurst Lakers',
  'Michigan Wolverines',
  'Missouri St Bears',
  'Nicholls St Colonels',
  'South Florida Bulls',
  'Towson Tigers',
  'Vermont Catamounts',
  'Weber State Wildcats',
  'Wichita St Shockers',
  // Additional NCAAM variants discovered from pull-odds TEAM_MAPPING_UNMAPPED logs
  'George Mason Patriots',
  'Liberty Flames',
  'Howard Bison',
  'Yale Bulldogs',
  'UNC Wilmington Seahawks',
  'Tulsa Golden Hurricane',
  'Stephen F. Austin Lumberjacks',
  'NC State Wolfpack',
  'South Alabama Jaguars',
  'Seattle Redhawks',
  'St. Thomas (MN) Tommies',
  'UC Irvine Anteaters',
  // SOCCER (EPL) — discovered from live odds pull
  'Brentford',
  'Wolverhampton Wanderers',
  'Arsenal',
  'Bayer Leverkusen',
  'Chelsea',
  'Manchester City',
  'Real Madrid',
  'Sporting CP',
  'Bodo/Glimt',
  'Paris Saint-Germain',
];

for (const teamName of LOGGED_TEAM_VARIANTS) {
  const canonical = teamName.toUpperCase();
  if (!TEAM_VARIANTS[canonical]) {
    TEAM_VARIANTS[canonical] = [];
  }
  const variant = teamName.toLowerCase();
  if (!TEAM_VARIANTS[canonical].includes(variant)) {
    TEAM_VARIANTS[canonical].push(variant);
  }
}

const TEAM_VARIANT_LOOKUP = new Map();
for (const [canonical, variants] of Object.entries(TEAM_VARIANTS)) {
  const canonicalKey = normalizeTeamVariantKey(canonical);
  if (canonicalKey && !TEAM_VARIANT_LOOKUP.has(canonicalKey)) {
    TEAM_VARIANT_LOOKUP.set(canonicalKey, canonical);
  }
  for (const variant of variants) {
    const key = normalizeTeamVariantKey(variant);
    if (key && !TEAM_VARIANT_LOOKUP.has(key)) {
      TEAM_VARIANT_LOOKUP.set(key, canonical);
    }
  }
}

/**
 * Normalize team name: trim, preserve case, build reverse variant map
 * Returns the canonical form if found in variants
 * Unknown variants are logged for discovery/manual review
 * @param {unknown} teamName - Input team name
 * @param {string} context - Optional context for logging
 * @returns {string} Normalized team name (title case)
 */
function normalizeTeamName(teamName, context = 'normalizeTeamName') {
  if (!teamName || typeof teamName !== 'string') return '';
  
  const cleaned = cleanText(teamName);
  const lookupKey = normalizeTeamVariantKey(cleaned);
  
  if (lookupKey && TEAM_VARIANT_LOOKUP.has(lookupKey)) {
    return TEAM_VARIANT_LOOKUP.get(lookupKey);
  }
  
  // Unknown variant: track it for discovery, then return cleaned
  // (tracked in-memory via trackUnknownTeamVariant; no log to avoid noise for NCAAM)
  trackUnknownTeamVariant(cleaned);
  
  // Return cleaned original (preserves case for human review in logs/UI)
  return cleaned;
}

/**
 * Resolve team name against TEAM_VARIANTS and return match metadata.
 * Unknown variants are tracked via discovery map and returned as unmatched.
 *
 * @param {unknown} teamName - Input team name
 * @param {string} context - Optional context for logging/discovery
 * @returns {{normalized: string, canonical: string, matched: boolean, key: string}}
 */
function resolveTeamVariant(teamName, context = 'resolveTeamVariant') {
  if (!teamName || typeof teamName !== 'string') {
    return { normalized: '', canonical: '', matched: false, key: '' };
  }

  const normalized = cleanText(teamName);
  const key = normalizeTeamVariantKey(normalized);

  if (key && TEAM_VARIANT_LOOKUP.has(key)) {
    const canonical = TEAM_VARIANT_LOOKUP.get(key);
    return { normalized, canonical, matched: true, key };
  }

  trackUnknownTeamVariant(normalized);
  return { normalized, canonical: normalized, matched: false, key };
}

/**
 * Check whether the provided team name is covered by TEAM_VARIANTS.
 *
 * @param {unknown} teamName - Input team name
 * @returns {boolean}
 */
function isKnownTeamVariant(teamName) {
  const result = resolveTeamVariant(teamName, 'isKnownTeamVariant');
  return result.matched;
}

/**
 * Create a team lookup key for fuzzy matching (case-insensitive)
 * @param {string} teamName - Team name
 * @returns {string} Lowercase key for comparisons
 */
function teamLookupKey(teamName) {
  if (!teamName) return '';
  return cleanText(teamName).toLowerCase();
}

/**
 * Get discovered team variants for manual review
 * Returns all unknown team names encountered, sorted by frequency
 * @returns {array} Array of discovered variants with count and dates
 */
function getDiscoveredTeamVariants() {
  return Array.from(discoveredTeamVariants.values())
    .sort((a, b) => b.count - a.count);
}

/**
 * Clear discovered team variants (call after manual review and update TEAM_VARIANTS)
 */
function clearDiscoveredTeamVariants() {
  discoveredTeamVariants.clear();
}

// ============================================================================
// CARD TITLE NORMALIZATION
// ============================================================================

/**
 * Normalize card title: trim, collapse whitespace, preserve case
 * Used for storage; can be lowercased separately for matching
 * @param {unknown} title - Input title
 * @returns {string} Normalized title
 */
function normalizeCardTitle(title, context = 'normalizeCardTitle') {
  if (!title || typeof title !== 'string') return '';
  
  const cleaned = cleanText(title);
  
  // Remove redundant "Card" suffix if present
  if (cleaned.toLowerCase().endsWith(' card')) {
    return cleaned.slice(0, -5).trim();
  }
  
  return cleaned;
}

// ============================================================================
// PLAYER NAME NORMALIZATION
// ============================================================================

const SUFFIX_PATTERNS = ['JR.', 'JR', 'SR.', 'SR', 'II', 'III', 'IV', 'V'];

/**
 * Normalize player name: trim, remove diacritics, preserve case
 * @param {unknown} name - Player name
 * @returns {string} Normalized name
 */
function normalizePlayerName(name, context = 'normalizePlayerName') {
  if (!name || typeof name !== 'string') return '';
  
  let cleaned = cleanText(name);
  
  // Remove common suffixes
  for (const suffix of SUFFIX_PATTERNS) {
    const regex = new RegExp(`\\s${suffix}$`, 'i');
    cleaned = cleaned.replace(regex, '');
  }
  
  // Remove diacritics for consistent matching
  cleaned = removeDiacritics(cleaned);
  
  return cleaned;
}

/**
 * Create a player name lookup key (lowercase, no diacritics)
 * @param {string} playerName - Player name
 * @returns {string} Lowercase lookup key
 */
function playerLookupKey(playerName) {
  if (!playerName) return '';
  return normalizePlayerName(playerName).toLowerCase();
}

// ============================================================================
// REASONING / FREE TEXT NORMALIZATION
// ============================================================================

/**
 * Normalize reasoning text: trim, collapse whitespace, preserve case
 * Used for storing model reasoning, forecasts, etc.
 * @param {unknown} text - Input text
 * @returns {string} Normalized text
 */
function normalizeReasoningText(text, context = 'normalizeReasoningText') {
  if (!text || typeof text !== 'string') return '';
  
  return cleanText(text);
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
  // Generic
  cleanText,
  removeDiacritics,
  normalizeEnum,
  
  // Market & Direction
  normalizeMarketType,
  normalizeDirection,
  
  // Sport
  normalizeSportCode,
  
  // Team
  normalizeTeamName,
  resolveTeamVariant,
  isKnownTeamVariant,
  teamLookupKey,
  getDiscoveredTeamVariants,
  clearDiscoveredTeamVariants,
  
  // Card
  normalizeCardTitle,
  
  // Player
  normalizePlayerName,
  playerLookupKey,
  
  // Text
  normalizeReasoningText,
  
  // Metadata (for tests, logging)
  VALID_MARKETS,
  VALID_SPORTS,
  MARKET_ALIASES,
  SPORT_ALIASES,
  TEAM_VARIANTS,
};
