/**
 * Seasonal gate helpers for sport-specific UI visibility.
 *
 * This is the single source of truth for NFL seasonal gating.
 * Consumers: filter-panel.tsx (sportOptions), filters.ts (DEFAULT_*_FILTERS),
 * cards-page-client.tsx (TRACKED_SPORTS).
 *
 * Note: No NFL preset entries exist in presets.ts at this time.
 * If NFL-specific presets are added in the future, they should also
 * consult isNflSeason() to avoid surfacing stale NFL presets off-season.
 */

/**
 * Returns true when the current date falls within the NFL regular
 * season + playoffs window: September 1 – February 28/29.
 * Month 0 = January, Month 8 = September.
 */
export function isNflSeason(now: Date = new Date()): boolean {
  const month = now.getMonth(); // 0-based
  // Sep (8) through Dec (11) OR Jan (0) through Feb (1)
  return month >= 8 || month <= 1;
}
