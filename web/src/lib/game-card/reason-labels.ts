// Canonical source: packages/data/src/reason-codes.js
// Inlined here to avoid pulling the server-only @cheddar-logic/data package
// (which depends on better-sqlite3) into the client bundle.

export const REASON_CODE_LABELS: Record<string, string> = Object.freeze({
  LINE_NOT_CONFIRMED: 'Line not confirmed',
  EDGE_RECHECK_PENDING: 'Edge needs recheck before action',
  EDGE_NO_LONGER_CONFIRMED: 'Edge no longer clears threshold',
  MARKET_DATA_STALE: 'Market data stale',
  PRICE_SYNC_PENDING: 'Book price still syncing',
  BLOCKED_BET_VERIFICATION_REQUIRED: 'Waiting on line verification',
  EDGE_CLEAR: 'Edge clear',
  EDGE_FOUND_SIDE: 'Edge found',
  EDGE_FOUND: 'Edge found',
  NO_EDGE_AT_PRICE: 'Price too sharp',
  PASS_NO_EDGE: 'No edge',
  PASS_EXECUTION_GATE_CONFIDENCE_BELOW_THRESHOLD: 'Model edge present, blocked by confidence gate',
  PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT: 'No edge at current price',
  PASS_EXECUTION_GATE_NO_EDGE_COMPUTED: 'Model incomplete',
  PASS_LOW_CONFIDENCE: 'Low confidence',
  PASS_SHARP_MONEY_OPPOSITE: 'Sharp money against',
  GATE_GOALIE_UNCONFIRMED: 'Waiting on goalie confirmation',
  GATE_LINE_MOVEMENT: 'Line moved - re-evaluating',
  BLOCK_INJURY_RISK: 'Injury risk flag',
  MARKET_EDGE_UNAVAILABLE: 'Edge unavailable at current market',
  NO_PRIMARY_SUPPORT: 'Insufficient model support',
  MODEL_PROB_MISSING: 'Model incomplete',
  MARKET_PRICE_MISSING: 'Market price unavailable',
  MISSING_DATA_NO_ODDS: 'Odds unavailable',
  MISSING_DATA_PROJECTION_INPUTS: 'Missing projection inputs',
  MISSING_DATA_DRIVERS: 'Driver output unavailable',
  MISSING_DATA_TEAM_MAPPING: 'Team mapping unresolved',
  PASS_MISSING_DRIVER_INPUTS: 'Missing driver inputs',
  PASS_DATA_ERROR: 'Data error - no play',
  EXACT_WAGER_MISMATCH: 'Line mismatch',
  HEAVY_FAVORITE_PRICE_CAP: 'High price cap',
  PROXY_EDGE_CAPPED: 'Edge capped by proxy',
  PARSE_FAILURE: 'Model data unavailable',
  SUPPORT_BELOW_LEAN_THRESHOLD: 'Insufficient support',
  SUPPORT_BELOW_PLAY_THRESHOLD: 'Insufficient support',
  FIRST_PERIOD_NO_PROJECTION: 'No 1P projection available',
});

export function getReasonCodeLabel(code?: string | null): string | null {
  if (!code) return null;
  const token = String(code).trim().toUpperCase();
  if (!token) return null;
  if (REASON_CODE_LABELS[token]) return REASON_CODE_LABELS[token];
  if (token.includes('GOALIE')) return 'Waiting on goalie confirmation';
  return null;
}
