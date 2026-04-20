// ─── Aliases ────────────────────────────────────────────────────────────────
// Legacy export retained for callers that import the symbol. New producers and
// validators must use canonical reason codes directly.
const REASON_CODE_ALIASES = Object.freeze({});

// ─── Exclusive bucket sets ───────────────────────────────────────────────────
// Every reason code belongs to exactly ONE bucket.
// assertExclusiveBuckets() enforces this at module-load time.

// MODEL: the model assessed no edge, or the model's own confidence is the blocker.
// Includes positive signals (EDGE_CLEAR, EDGE_FOUND) since they originate from model assessment.
const MODEL_REASON_CODES = Object.freeze(new Set([
  'EDGE_CLEAR',
  'EDGE_FOUND',
  'EDGE_FOUND_SIDE',
  'PASS_NO_EDGE',
  'NO_EDGE_AT_PRICE',              // model threshold outcome, NOT a market condition
  'PASS_DRIVER_SUPPORT_WEAK',
  'PASS_CONFLICT_HIGH',
  'SUPPORT_BELOW_LEAN_THRESHOLD',
  'SUPPORT_BELOW_PLAY_THRESHOLD',
  'NO_PRIMARY_SUPPORT',
  'PASS_LOW_CONFIDENCE',
  'PASS_SHARP_MONEY_OPPOSITE',
  'SIGMA_FALLBACK_DEGRADED',
  'PLAY_CONTRADICTION_CAPPED',
  // NHL model signals
  'NHL_1P_OVER_LEAN',
  'NHL_1P_UNDER_LEAN',
  'NHL_ML_LEAN',
  'NHL_1P_OVER_PLAY',
  'NHL_1P_UNDER_PLAY',
  'NHL_ML_PLAY',
  // First-period projection signals
  'FIRST_PERIOD_PROJECTION_LEAN',
  'FIRST_PERIOD_PROJECTION_PLAY',
]));

// DATA: inputs are missing, stale at the snapshot level, or unparseable.
const DATA_REASON_CODES = Object.freeze(new Set([
  'MISSING_DATA_PROJECTION_INPUTS',
  'MISSING_DATA_DRIVERS',
  'MISSING_DATA_TEAM_MAPPING',
  'MISSING_DATA_NO_ODDS',
  'PASS_MISSING_DRIVER_INPUTS',
  'PASS_DATA_ERROR',
  'WATCHDOG_CONSISTENCY_MISSING',
  'WATCHDOG_PARSE_FAILURE',
  'MODEL_PROB_MISSING',
  'MARKET_PRICE_MISSING',
  'MARKET_EDGE_UNAVAILABLE',
  'PARSE_FAILURE',
  'STALE_SNAPSHOT',                // data freshness — NOT a market condition
  // WI-0907 all-sports input validation codes
  'ESPN_NULL_OBSERVATION',
  'ESPN_NULL_ALERT_FAILED',
  'TIMESTAMP_MISSING',
  'TIMESTAMP_PARSE_ERROR',
  'TIMESTAMP_AGE_INVALID',
  'GAME_ID_INVALID',
  'AVAILABILITY_GATE_DEGRADED',
  'LINE_DELTA_COMPUTATION_FAILED',
  'LINE_CONTEXT_MISSING',
  'CAPTURED_AT_MISSING',
  'CAPTURED_AT_MS_INVALID',
  'NEUTRAL_VALUE_COERCE_SILENT',
  'PRICE_VALIDATION_FAILED',
  'STALE_RECOVERY_REFRESH_FAILED',
  'STALE_RECOVERY_RELOAD_FAILED',
]));

// Subset of DATA codes that are hard blockers warranting WATCH state when edge exists.
// Not every DATA code triggers WATCH — only critical input failures do.
const DATA_BLOCKER_CODES = Object.freeze(new Set([
  'MISSING_DATA_PROJECTION_INPUTS',
  'MISSING_DATA_DRIVERS',
  'MODEL_PROB_MISSING',
  'WATCHDOG_PARSE_FAILURE',
  'WATCHDOG_CONSISTENCY_MISSING',
]));

// MARKET: the market itself is unverified, stale, or awaiting external confirmation.
// Includes goalie/injury status codes — they are waiting on external confirmation,
// not hard policy gates, so WATCH (not BLOCKED) is the correct routing.
const MARKET_REASON_CODES = Object.freeze(new Set([
  'LINE_NOT_CONFIRMED',
  'EDGE_RECHECK_PENDING',
  'EDGE_NO_LONGER_CONFIRMED',
  'STALE_MARKET',
  'PRICE_SYNC_PENDING',
  'BLOCKED_BET_VERIFICATION_REQUIRED',
  'GATE_LINE_MOVEMENT',
  'WATCHDOG_MARKET_UNAVAILABLE',
  'EDGE_SANITY_NON_TOTAL',
  'LINE_MOVE_ADVERSE',
  'PLAY_REQUIRES_FRESH_MARKET',
  'GOALIE_UNCONFIRMED',
  'GOALIE_CONFLICTING',
  'INJURY_UNCERTAIN',
]));

// GATE: a hard policy rule blocked the play regardless of model edge → BLOCKED.
// Note: GOALIE_UNCONFIRMED/GOALIE_CONFLICTING/INJURY_UNCERTAIN are MARKET codes
// (awaiting external confirmation → WATCH). GATE_GOALIE_UNCONFIRMED is a hard block.
const GATE_REASON_CODES = Object.freeze(new Set([
  'HEAVY_FAVORITE_PRICE_CAP',
  'FIRST_PERIOD_NO_PROJECTION',
  'EXACT_WAGER_MISMATCH',
  'PROXY_EDGE_BLOCKED',
  'PROXY_EDGE_CAPPED',
  'GATE_GOALIE_UNCONFIRMED',
  'BLOCK_INJURY_RISK',
  // Execution gate family (full canonical names — prefix NOT stripped)
  'PASS_EXECUTION_GATE_CONFIDENCE_BELOW_THRESHOLD',
  'PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT',
  'PASS_EXECUTION_GATE_NO_EDGE_COMPUTED',
  'PASS_EXECUTION_GATE_BLOCKED',
  'PASS_EXECUTION_GATE_LOW_EDGE',
  'PASS_EXECUTION_GATE_NO_EDGE',
  'PASS_EXECUTION_GATE_STALE_SNAPSHOT',
  'PASS_EXECUTION_GATE_MIXED_BOOK_SOURCE_MISMATCH',
]));

// Master list for validation, tests, documentation, and fingerprinting.
// Increment REASON_CODE_SCHEMA_VERSION whenever codes are added, removed, or moved.
const ALL_REASON_CODES = Object.freeze([
  ...MODEL_REASON_CODES,
  ...DATA_REASON_CODES,
  ...MARKET_REASON_CODES,
  ...GATE_REASON_CODES,
]);

const REASON_CODE_SCHEMA_VERSION = 1;

// ─── Human-readable labels ───────────────────────────────────────────────────
// Every code in ALL_REASON_CODES must appear here.
// assertAllCodesLabeled() enforces this in dev and tests.
const REASON_CODE_LABELS = Object.freeze({
  // MODEL
  PASS_NO_EDGE: 'No edge',
  NO_EDGE_AT_PRICE: 'Price too sharp',
  PASS_DRIVER_SUPPORT_WEAK: 'Driver support weak',
  PASS_CONFLICT_HIGH: 'Conflicting signals',
  SUPPORT_BELOW_LEAN_THRESHOLD: 'Insufficient support',
  SUPPORT_BELOW_PLAY_THRESHOLD: 'Insufficient support',
  NO_PRIMARY_SUPPORT: 'Insufficient model support',
  PASS_LOW_CONFIDENCE: 'Low confidence',
  PASS_SHARP_MONEY_OPPOSITE: 'Sharp money against',
  SIGMA_FALLBACK_DEGRADED: 'Sigma fallback — degraded confidence',
  PLAY_CONTRADICTION_CAPPED: 'Contradicting signals — capped to lean',
  NHL_1P_OVER_LEAN: 'Lean only — 1P over',
  NHL_1P_UNDER_LEAN: 'Lean only — 1P under',
  NHL_ML_LEAN: 'Lean only — ML',
  NHL_1P_OVER_PLAY: 'Play — 1P over',
  NHL_1P_UNDER_PLAY: 'Play — 1P under',
  NHL_ML_PLAY: 'Play — ML',
  FIRST_PERIOD_PROJECTION_LEAN: 'Lean — 1P projection',
  FIRST_PERIOD_PROJECTION_PLAY: 'Play — 1P projection',
  // DATA
  MISSING_DATA_PROJECTION_INPUTS: 'Missing projection inputs',
  MISSING_DATA_DRIVERS: 'Driver output unavailable',
  MISSING_DATA_TEAM_MAPPING: 'Team mapping unresolved',
  MISSING_DATA_NO_ODDS: 'Odds unavailable',
  PASS_MISSING_DRIVER_INPUTS: 'Missing driver inputs',
  PASS_DATA_ERROR: 'Data error — no play',
  WATCHDOG_CONSISTENCY_MISSING: 'Projection inputs missing',
  WATCHDOG_PARSE_FAILURE: 'Model data unavailable',
  MODEL_PROB_MISSING: 'Model incomplete',
  MARKET_PRICE_MISSING: 'Market price unavailable',
  MARKET_EDGE_UNAVAILABLE: 'Edge unavailable at current market',
  PARSE_FAILURE: 'Model data unavailable',
  STALE_SNAPSHOT: 'Snapshot stale',
  ESPN_NULL_OBSERVATION: 'ESPN feed null',
  ESPN_NULL_ALERT_FAILED: 'ESPN null alert failed',
  TIMESTAMP_MISSING: 'Timestamp missing',
  TIMESTAMP_PARSE_ERROR: 'Timestamp invalid',
  TIMESTAMP_AGE_INVALID: 'Timestamp too old',
  GAME_ID_INVALID: 'Game ID invalid',
  AVAILABILITY_GATE_DEGRADED: 'Availability gate degraded',
  LINE_DELTA_COMPUTATION_FAILED: 'Line delta unavailable',
  LINE_CONTEXT_MISSING: 'Line context missing',
  CAPTURED_AT_MISSING: 'Capture time missing',
  CAPTURED_AT_MS_INVALID: 'Capture time invalid',
  NEUTRAL_VALUE_COERCE_SILENT: 'Neutral value coerced',
  PRICE_VALIDATION_FAILED: 'Price validation failed',
  STALE_RECOVERY_REFRESH_FAILED: 'Stale recovery failed',
  STALE_RECOVERY_RELOAD_FAILED: 'Stale reload failed',
  // MARKET
  LINE_NOT_CONFIRMED: 'Line not confirmed',
  EDGE_RECHECK_PENDING: 'Edge needs recheck before action',
  EDGE_NO_LONGER_CONFIRMED: 'Edge no longer clears threshold',
  STALE_MARKET: 'Market data stale',
  PRICE_SYNC_PENDING: 'Book price still syncing',
  BLOCKED_BET_VERIFICATION_REQUIRED: 'Waiting on line verification',
  GATE_LINE_MOVEMENT: 'Line moved — re-evaluating',
  WATCHDOG_MARKET_UNAVAILABLE: 'Market unavailable',
  EDGE_SANITY_NON_TOTAL: 'Edge sanity check failed',
  LINE_MOVE_ADVERSE: 'Line moved adversely',
  PLAY_REQUIRES_FRESH_MARKET: 'Play requires fresh market data',
  // GATE
  HEAVY_FAVORITE_PRICE_CAP: 'High price cap',
  FIRST_PERIOD_NO_PROJECTION: 'No 1P projection available',
  EXACT_WAGER_MISMATCH: 'Line mismatch',
  PROXY_EDGE_BLOCKED: 'Edge blocked by proxy cap',
  PROXY_EDGE_CAPPED: 'Edge capped by proxy',
  GATE_GOALIE_UNCONFIRMED: 'Waiting on goalie confirmation',
  BLOCK_INJURY_RISK: 'Injury risk flag',
  GOALIE_UNCONFIRMED: 'Waiting on goalie confirmation',
  GOALIE_CONFLICTING: 'Conflicting goalie reports',
  INJURY_UNCERTAIN: 'Injury status uncertain',
  PASS_EXECUTION_GATE_CONFIDENCE_BELOW_THRESHOLD: 'Model edge present, blocked by confidence gate',
  PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT: 'No edge at current price',
  PASS_EXECUTION_GATE_NO_EDGE_COMPUTED: 'Model incomplete',
  PASS_EXECUTION_GATE_BLOCKED: 'Blocked by execution gate',
  PASS_EXECUTION_GATE_LOW_EDGE: 'Edge below execution threshold',
  PASS_EXECUTION_GATE_NO_EDGE: 'No edge at execution',
  PASS_EXECUTION_GATE_STALE_SNAPSHOT: 'Stale snapshot at execution',
  PASS_EXECUTION_GATE_MIXED_BOOK_SOURCE_MISMATCH: 'Book source mismatch',
  // Legacy aliases also need labels so inlined clients don't fall through
  EDGE_CLEAR: 'Edge clear',
  EDGE_FOUND_SIDE: 'Edge found',
  EDGE_FOUND: 'Edge found',
});

// ─── Existing blocker set (preserved for callers) ────────────────────────────
const BLOCKER_REASON_CODES = Object.freeze([
  'LINE_NOT_CONFIRMED',
  'EDGE_RECHECK_PENDING',
  'EDGE_NO_LONGER_CONFIRMED',
  'STALE_MARKET',
  'PRICE_SYNC_PENDING',
  'BLOCKED_BET_VERIFICATION_REQUIRED',
  'SUPPORT_BELOW_LEAN_THRESHOLD',
  'SUPPORT_BELOW_PLAY_THRESHOLD',
  'EXACT_WAGER_MISMATCH',
  'MARKET_PRICE_MISSING',
  'MODEL_PROB_MISSING',
  'MARKET_EDGE_UNAVAILABLE',
  'NO_EDGE_AT_PRICE',
  'NO_PRIMARY_SUPPORT',
  'HEAVY_FAVORITE_PRICE_CAP',
  'FIRST_PERIOD_NO_PROJECTION',
]);

// Codes that indicate market is unverified / awaiting confirmation.
const MARKET_UNVERIFIED_CODES = Object.freeze(new Set([
  'LINE_NOT_CONFIRMED',
  'EDGE_RECHECK_PENDING',
  'PRICE_SYNC_PENDING',
  'STALE_MARKET',
  'BLOCKED_BET_VERIFICATION_REQUIRED',
  'GATE_LINE_MOVEMENT',
  'MISSING_DATA_NO_ODDS',
  'MARKET_PRICE_MISSING',
  'GOALIE_UNCONFIRMED',
  'GOALIE_CONFLICTING',
  'INJURY_UNCERTAIN',
]));

// ─── Utilities ───────────────────────────────────────────────────────────────

function getReasonCodeLabel(code) {
  if (!code) return null;
  const token = String(code).trim().toUpperCase();
  if (!token) return null;
  if (REASON_CODE_LABELS[token]) return REASON_CODE_LABELS[token];
  if (token.includes('GOALIE')) return 'Waiting on goalie confirmation';
  return null;
}

function classifyReasonCode(code) {
  if (!code) {
    if (process.env.NODE_ENV !== 'production') {
      throw new Error('classifyReasonCode: received empty or null code');
    }
    return 'DATA'; // safe prod fallback
  }
  const token = String(code).trim().toUpperCase();
  if (MODEL_REASON_CODES.has(token)) return 'MODEL';
  if (DATA_REASON_CODES.has(token)) return 'DATA';
  if (MARKET_REASON_CODES.has(token)) return 'MARKET';
  if (GATE_REASON_CODES.has(token)) return 'GATE';
  // Genuinely unknown — log it, preserve it in unknown_flags, never silently discard
  if (typeof console !== 'undefined') {
    console.error(`[reason-codes] UNKNOWN_REASON_CODE: ${token}`);
  }
  return 'UNKNOWN';
}

// ─── Startup invariants ──────────────────────────────────────────────────────

function assertExclusiveBuckets() {
  const buckets = [MODEL_REASON_CODES, DATA_REASON_CODES, MARKET_REASON_CODES, GATE_REASON_CODES];
  const seen = new Map();
  for (const set of buckets) {
    for (const code of set) {
      if (seen.has(code)) {
        throw new Error(`[reason-codes] Reason code "${code}" exists in multiple buckets`);
      }
      seen.set(code, true);
    }
  }
}

function assertAllCodesLabeled() {
  for (const code of ALL_REASON_CODES) {
    if (!REASON_CODE_LABELS[code]) {
      throw new Error(`[reason-codes] Missing label for reason code: ${code}`);
    }
  }
}

assertExclusiveBuckets();
if (process.env.NODE_ENV !== 'production') {
  assertAllCodesLabeled();
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Taxonomy
  REASON_CODE_ALIASES,
  MODEL_REASON_CODES,
  DATA_REASON_CODES,
  DATA_BLOCKER_CODES,
  MARKET_REASON_CODES,
  GATE_REASON_CODES,
  ALL_REASON_CODES,
  REASON_CODE_SCHEMA_VERSION,
  // Labels and legacy sets
  REASON_CODE_LABELS,
  BLOCKER_REASON_CODES,
  MARKET_UNVERIFIED_CODES,
  // Functions
  getReasonCodeLabel,
  classifyReasonCode,
  assertExclusiveBuckets,
  assertAllCodesLabeled,
};
