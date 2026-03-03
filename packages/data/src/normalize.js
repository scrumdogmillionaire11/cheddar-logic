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
};

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
  const lowerClean = cleaned.toLowerCase();
  
  // Build reverse lookup from TEAM_VARIANTS
  for (const [canonical, variants] of Object.entries(TEAM_VARIANTS)) {
    if (variants.includes(lowerClean)) {
      return canonical;
    }
  }
  
  // Unknown variant: track it for discovery, then return cleaned
  trackUnknownTeamVariant(cleaned);
  console.warn(
    `[NORMALIZE] Unknown team "${cleaned}" in ${context}. ` +
    `Add to TEAM_VARIANTS map if this becomes a recurring variant.`
  );
  
  // Return cleaned original (preserves case for human review in logs/UI)
  return cleaned;
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
