/**
 * Centralized Feature Flags Service
 *
 * Consolidates scattered ENABLE_* environment variable checks across schedulers
 * into a single, consistent interface to reduce configuration complexity and
 * prevent accidental feature drift.
 *
 * Usage:
 *   const { isFeatureEnabled } = require('./feature-flags');
 *   if (isFeatureEnabled('nhl', 'model')) { ... }
 *   if (isFeatureEnabled('nba', 'player-availability-sync')) { ... }
 *
 * Feature categories:
 *   - 'model': Sport inference model execution (default: enabled)
 *   - 'player-availability-sync': Hourly player injury/status polling (default: enabled)
 *   - 'sog-sync': NHL SOG player roster refresh (default: disabled — explicit opt-in)
 *   - 'goalie-starters': NHL goalie starter pre-fetch (default: enabled)
 *   - 'blk-ingest': NHL BLK (blocked shots) ingest (default: enabled)
 */

/**
 * Check if a feature is enabled for a specific sport
 * @param {string} sport - Sport identifier ('nhl', 'nba', 'mlb', 'fpl', 'nfl')
 * @param {string} featureName - Feature identifier ('model', 'player-availability-sync', etc.)
 * @returns {boolean} - True if feature is enabled
 */
function isFeatureEnabled(sport, featureName) {
  if (!sport || !featureName) return false;

  const normalizedSport = String(sport).toLowerCase().trim();
  const normalizedFeature = String(featureName).toLowerCase().trim();

  // Known sports that have models
  const knownSports = ['nhl', 'nba', 'mlb', 'fpl', 'nfl'];

  // Model execution (default: enabled unless explicitly disabled for known sports)
  if (normalizedFeature === 'model') {
    if (!knownSports.includes(normalizedSport)) return false;
    const key = `ENABLE_${normalizedSport.toUpperCase()}_MODEL`;
    return process.env[key] !== 'false';
  }

  // Player availability sync (default: enabled for known sports unless explicitly disabled)
  if (normalizedFeature === 'player-availability-sync') {
    const syncableSports = ['nhl', 'nba'];
    if (!syncableSports.includes(normalizedSport)) return false;
    const key = `ENABLE_${normalizedSport.toUpperCase()}_PLAYER_AVAILABILITY_SYNC`;
    return process.env[key] !== 'false';
  }

  // NHL goalie starters pre-fetch (default: enabled)
  if (normalizedFeature === 'goalie-starters' && normalizedSport === 'nhl') {
    const key = 'ENABLE_NHL_GOALIE_STARTERS';
    return process.env[key] !== 'false';
  }

  // NHL SOG player ID sync (default: DISABLED — requires explicit opt-in)
  if (normalizedFeature === 'sog-sync' && normalizedSport === 'nhl') {
    const key = 'ENABLE_NHL_SOG_PLAYER_SYNC';
    return process.env[key] === 'true';
  }

  // NHL BLK (blocked shots) ingest (default: enabled)
  if (normalizedFeature === 'blk-ingest' && normalizedSport === 'nhl') {
    const key = 'ENABLE_NHL_BLK_INGEST';
    return process.env[key] !== 'false';
  }

  // NHL MoneyPuck BLK rates (default: enabled)
  if (normalizedFeature === 'moneypuck-blk' && normalizedSport === 'nhl') {
    const key = 'NHL_MONEYPUCK_BLK_ENABLED';
    return process.env[key] !== 'false';
  }

  // Player props scheduler (default: enabled)
  if (normalizedFeature === 'player-props-scheduler') {
    const key = 'ENABLE_PLAYER_PROPS_SCHEDULER';
    return process.env[key] !== 'false';
  }

  // Unknown feature or sport
  return false;
}

module.exports = { isFeatureEnabled };
