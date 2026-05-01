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
  'PASS_MISSING_EDGE',
  'NO_EDGE_AT_PRICE',              // model threshold outcome, NOT a market condition
  'PASS_DRIVER_SUPPORT_WEAK',
  'PASS_CONFLICT_HIGH',
  'PASS_DIRECTION_MISMATCH',
  // NHL raw delta authority codes (WI-1183)
  'PASS_NO_DIRECTIONAL_EDGE',
  'PASS_SIGNAL_DIVERGENCE',
  'PASS_LOW_CONSENSUS',
  'SIGNAL_DIVERGENCE',
  'BASE_PLAY_DELTA_GTE_1_0',
  'BASE_SLIGHT_EDGE_DELTA_GTE_0_5',
  'BASE_PASS_DELTA_LT_0_5',
  'FRAGILITY_UNDER_5_5',
  'FRAGILITY_OVER_6_5_ACCELERANT_BELOW_0_20',
  'OVER_6_5_ACCELERANT_OK',
  'FLOOR_GUARD_FORCE_PASS_DELTA_LT_0_5',
  'ANTI_FLATTENING_RESTORE_PLAY',
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
  // MLB model signals
  'PASS_NO_DISTRIBUTION',
  'PASS_UNKNOWN',
  'SOFT_WEAK_DRIVER_SUPPORT',
  'HIGH_END_SLIGHT_EDGE_PROMOTION',
]));

// DATA: inputs are missing, stale at the snapshot level, or unparseable.
const DATA_REASON_CODES = Object.freeze(new Set([
  'MISSING_DATA_PROJECTION_INPUTS',
  'MISSING_DATA_DRIVERS',
  'MISSING_DATA_TEAM_MAPPING',
  'MISSING_DATA_NO_ODDS',
  'MISSING_DATA_FEATURE_FRESHNESS',
  'MISSING_DATA_MARKET_TYPES',
  'PASS_MISSING_DRIVER_INPUTS',
  'PASS_MISSING_SELECTION',
  'PASS_MISSING_LINE',
  'PASS_MISSING_PRICE',
  'PASS_NO_MARKET_PRICE',
  'PASS_MISSING_REQUIRED_INPUTS',
  'PASS_INTEGRITY_BLOCK',
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
  // MLB model data-quality signals
  'MARKET_SANITY_FAIL',
  'MODEL_DEGRADED_INPUTS',
  'PASS_DEGRADED_TOTAL_MODEL',
  'PASS_INPUTS_INCOMPLETE',
  'PASS_MODEL_DEGRADED',
  'PASS_PROJECTION_ONLY_NO_MARKET',
  'PASS_SYNTHETIC_FALLBACK',
  'SOFT_DEGRADED_TOTAL_MODEL',
  'SOFT_MARKET_SANITY_FAIL',  // Feature timestamp guard (all sports)
  'PASS_FEATURE_TIMESTAMP_LEAK',]));

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
  'PRICE_STALE',
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
  'CAP_GOALIES_UNCONFIRMED',
  'CAP_MAJOR_INJURY_UNCERTAINTY',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_INJURY_UNCERTAINTY',
  'DOWNGRADE_SLIGHT_EDGE_TO_PASS_INJURY_UNCERTAINTY_THIN_EDGE',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5',
  'DOWNGRADE_SLIGHT_EDGE_TO_PASS_UNDER_5_5',
  'DOWNGRADE_PLAY_TO_SLIGHT_EDGE_OVER_6_5',
  'DOWNGRADE_SLIGHT_EDGE_TO_PASS_OVER_6_5',
  'STARTER_UNCONFIRMED',
  'STARTER_MISMATCH',
  'BEST_LINE_UNCONFIRMED',
  'WEATHER_STATUS_PENDING',
  'MARKET_SOURCE_UNCONFIRMED',
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
  // Execution-gate drop-reason codes
  'PASS_CONFIDENCE_GATE',
  'PROJECTION_ONLY_EXCLUSION',
]));

// Master list for validation, tests, documentation, and fingerprinting.
// Increment REASON_CODE_SCHEMA_VERSION whenever codes are added, removed, or moved.
const ALL_REASON_CODES = Object.freeze([
  ...MODEL_REASON_CODES,
  ...DATA_REASON_CODES,
  ...MARKET_REASON_CODES,
  ...GATE_REASON_CODES,
]);

const REASON_CODE_SCHEMA_VERSION = 7;

// ─── Human-readable labels ───────────────────────────────────────────────────
// Every code in ALL_REASON_CODES must appear here.
// assertAllCodesLabeled() enforces this in dev and tests.
const REASON_CODE_LABELS = Object.freeze({
  // MODEL
  PASS_NO_EDGE: 'No edge',
  PASS_MISSING_EDGE: 'Edge unavailable',
  PASS_DIRECTION_MISMATCH: 'Direction mismatches market side',
  PASS_NO_DIRECTIONAL_EDGE: 'No directional edge — delta below epsilon',
  PASS_SIGNAL_DIVERGENCE: 'Signal divergence — strong driver conflict',
  PASS_LOW_CONSENSUS: 'Low consensus — driver and delta conflict',
  SIGNAL_DIVERGENCE: 'Signal divergence applied — delta penalized',
  BASE_PLAY_DELTA_GTE_1_0: 'Base play threshold met',
  BASE_SLIGHT_EDGE_DELTA_GTE_0_5: 'Base slight-edge threshold met',
  BASE_PASS_DELTA_LT_0_5: 'Base delta below slight-edge threshold',
  FRAGILITY_UNDER_5_5: 'Under 5.5 fragility cap applied',
  FRAGILITY_OVER_6_5_ACCELERANT_BELOW_0_20: 'Over 6.5 lacks scoring accelerant',
  OVER_6_5_ACCELERANT_OK: 'Over 6.5 scoring accelerant confirmed',
  FLOOR_GUARD_FORCE_PASS_DELTA_LT_0_5: 'Floor guard forced pass below threshold',
  ANTI_FLATTENING_RESTORE_PLAY: 'Play restored after anti-flattening check',
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
  MISSING_DATA_FEATURE_FRESHNESS: 'Feature freshness stale',
  MISSING_DATA_MARKET_TYPES: 'Market missing required types',
  PASS_MISSING_DRIVER_INPUTS: 'Missing driver inputs',
  PASS_MISSING_SELECTION: 'Selection unavailable',
  PASS_MISSING_LINE: 'Line unavailable',
  PASS_MISSING_PRICE: 'Price unavailable',
  PASS_NO_MARKET_PRICE: 'Market price unavailable',
  PASS_MISSING_REQUIRED_INPUTS: 'Missing required inputs',
  PASS_INTEGRITY_BLOCK: 'Integrity block',
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
  PRICE_STALE: 'Price stale versus signal',
  PLAY_REQUIRES_FRESH_MARKET: 'Play requires fresh market data',
  STARTER_UNCONFIRMED: 'Starter not confirmed',
  STARTER_MISMATCH: 'Starter mismatch versus priced assumption',
  BEST_LINE_UNCONFIRMED: 'Best line not confirmed',
  WEATHER_STATUS_PENDING: 'Weather status pending',
  MARKET_SOURCE_UNCONFIRMED: 'Market source unconfirmed',
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
  CAP_GOALIES_UNCONFIRMED: 'Goalies unconfirmed — cap applied',
  CAP_MAJOR_INJURY_UNCERTAINTY: 'Major injury uncertainty — cap applied',
  DOWNGRADE_PLAY_TO_SLIGHT_EDGE_GOALIE_UNCERTAINTY: 'Goalie uncertainty downgraded play to slight edge',
  DOWNGRADE_PLAY_TO_SLIGHT_EDGE_INJURY_UNCERTAINTY: 'Injury uncertainty downgraded play to slight edge',
  DOWNGRADE_SLIGHT_EDGE_TO_PASS_INJURY_UNCERTAINTY_THIN_EDGE: 'Thin edge downgraded to pass by injury uncertainty',
  DOWNGRADE_PLAY_TO_SLIGHT_EDGE_UNDER_5_5: 'Under 5.5 fragility downgraded play to slight edge',
  DOWNGRADE_SLIGHT_EDGE_TO_PASS_UNDER_5_5: 'Under 5.5 fragility downgraded slight edge to pass',
  DOWNGRADE_PLAY_TO_SLIGHT_EDGE_OVER_6_5: 'Over 6.5 fragility downgraded play to slight edge',
  DOWNGRADE_SLIGHT_EDGE_TO_PASS_OVER_6_5: 'Over 6.5 fragility downgraded slight edge to pass',
  PASS_EXECUTION_GATE_CONFIDENCE_BELOW_THRESHOLD: 'Model edge present, blocked by confidence gate',
  PASS_EXECUTION_GATE_NET_EDGE_INSUFFICIENT: 'No edge at current price',
  PASS_EXECUTION_GATE_NO_EDGE_COMPUTED: 'Model incomplete',
  PASS_EXECUTION_GATE_BLOCKED: 'Blocked by execution gate',
  PASS_EXECUTION_GATE_LOW_EDGE: 'Edge below execution threshold',
  PASS_EXECUTION_GATE_NO_EDGE: 'No edge at execution',
  PASS_EXECUTION_GATE_STALE_SNAPSHOT: 'Stale snapshot at execution',
  PASS_EXECUTION_GATE_MIXED_BOOK_SOURCE_MISMATCH: 'Book source mismatch',
  // Execution-gate drop-reason codes
  PASS_CONFIDENCE_GATE: 'Edge present — blocked by confidence gate',
  PROJECTION_ONLY_EXCLUSION: 'Excluded — projection-only path',
  // MLB model signals (MODEL bucket)
  PASS_NO_DISTRIBUTION: 'No probability distribution computed',
  PASS_UNKNOWN: 'Pass — reason unknown',
  SOFT_WEAK_DRIVER_SUPPORT: 'Soft advisory — weak driver support',
  HIGH_END_SLIGHT_EDGE_PROMOTION: 'High-end slight edge promoted to play',
  // MLB model data-quality signals (DATA bucket)
  MARKET_SANITY_FAIL: 'Market sanity check failed',
  MODEL_DEGRADED_INPUTS: 'Model received degraded inputs',
  PASS_DEGRADED_TOTAL_MODEL: 'Pass — total model degraded',
  PASS_INPUTS_INCOMPLETE: 'Pass — required inputs incomplete',
  PASS_MODEL_DEGRADED: 'Pass — model degraded',
  PASS_PROJECTION_ONLY_NO_MARKET: 'Pass — projection only, no market line',
  PASS_SYNTHETIC_FALLBACK: 'Pass — synthetic fallback data used',
  SOFT_DEGRADED_TOTAL_MODEL: 'Soft advisory — total model degraded',
  SOFT_MARKET_SANITY_FAIL: 'Soft advisory — market sanity check failed',
  // Feature timestamp guard (all sports)
  PASS_FEATURE_TIMESTAMP_LEAK: 'Pass — feature data leaked future timestamp',
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
  'PRICE_STALE',
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
  'MISSING_DATA_MARKET_TYPES',
  'MARKET_PRICE_MISSING',
  'GOALIE_UNCONFIRMED',
  'GOALIE_CONFLICTING',
  'INJURY_UNCERTAIN',
  'STARTER_UNCONFIRMED',
  'STARTER_MISMATCH',
  'BEST_LINE_UNCONFIRMED',
  'WEATHER_STATUS_PENDING',
  'MARKET_SOURCE_UNCONFIRMED',
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
