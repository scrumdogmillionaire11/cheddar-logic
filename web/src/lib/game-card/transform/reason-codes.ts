/**
 * Reason code normalization and classification helpers
 * Extracted from game-card/transform.ts (WI-0622)
 */

export const PASS_REASON_ALIAS_MAP: Record<string, string> = {
  MISSING_LINE: 'PASS_MISSING_LINE',
  MISSING_EDGE: 'PASS_MISSING_EDGE',
  MISSING_SELECTION: 'PASS_MISSING_SELECTION',
  MISSING_PRICE: 'PASS_MISSING_PRICE',
  NO_MARKET_PRICE: 'PASS_NO_MARKET_PRICE',
  NO_STARTER_SIGNAL: 'PASS_MISSING_DRIVER_INPUTS',
};

export function normalizePassReasonCode(reason?: string | null): string | null {
  if (typeof reason !== 'string') return null;
  const code = reason.trim().toUpperCase();
  if (!code) return null;
  if (code.startsWith('PASS_')) return code;

  return PASS_REASON_ALIAS_MAP[code] ?? code;
}

export const NO_ACTIONABLE_IGNORE_REASON_CODES = new Set([
  'PASS_MISSING_MARKET_TYPE',
]);

export const NO_ACTIONABLE_EXPLICIT_NO_EDGE_REASON_CODES = new Set([
  'NO_EDGE_AT_PRICE',
  'PASS_NO_EDGE',
  'PASS_DRIVER_SUPPORT_WEAK',
  'PASS_CONFLICT_HIGH',
  // Decision pipeline: below-threshold healthy no-play
  'SUPPORT_BELOW_LEAN_THRESHOLD',
  'SUPPORT_BELOW_PLAY_THRESHOLD',
  // Decision pipeline: proxy cap signals
  'PROXY_EDGE_BLOCKED',
  'PROXY_EDGE_CAPPED',
  // Decision pipeline: heavy favorite gate
  'HEAVY_FAVORITE_PRICE_CAP',
  // NHL model signals: no conviction/lean (healthy no-play)
  'NHL_1P_OVER_LEAN',
  'NHL_1P_UNDER_LEAN',
  'NHL_ML_LEAN',
  // NHL model signals: play likelihood (healthy no-play)
  'NHL_1P_OVER_PLAY',
  'NHL_1P_UNDER_PLAY',
  'NHL_ML_PLAY',
  // FIRST_PERIOD canonical policy reason codes (WI-0537 / WI-0511)
  'FIRST_PERIOD_PROJECTION_PLAY',
  'FIRST_PERIOD_PROJECTION_LEAN',
  'FIRST_PERIOD_NO_PROJECTION',
]);

export const NO_ACTIONABLE_FETCH_REASON_FRAGMENTS = [
  'TEAM_MAPPING',
  'PROJECTION_INPUT',
  'NO_ODDS',
  'DRIVER',
  'INGEST',
  'SOURCE',
  'MISSING_',
  // Decision pipeline watchdog and goalie uncertainty codes (WI-0511)
  'WATCHDOG',
  'GOALIE',
  'STALE',
];

export function isFetchFailureReasonCode(code: string): boolean {
  return NO_ACTIONABLE_FETCH_REASON_FRAGMENTS.some((fragment) =>
    code.includes(fragment),
  );
}

export function isExplicitNoEdgeReasonCode(code: string): boolean {
  return NO_ACTIONABLE_EXPLICIT_NO_EDGE_REASON_CODES.has(code);
}
