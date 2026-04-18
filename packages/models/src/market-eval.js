'use strict';

const {
  WATCHDOG_REASONS,
  buildDecisionV2,
} = require('./decision-pipeline-v2');

/**
 * market-eval.js — Shared independent market evaluation contract.
 *
 * Every generated market candidate must end in exactly one terminal status
 * with explicit reasons. No market may disappear without accounting.
 *
 * Exports:
 *   evaluateSingleMarket(card, ctx) → MarketEvalResult
 *   finalizeGameMarketEvaluation({ game_id, sport, market_results }) → GameMarketEvaluation
 *   assertNoSilentMarketDrop(gameEval) → void (throws on mismatch)
 *   logRejectedMarkets(rejected, logger) → void
 *   REASON_CODES — frozen object; sole source of rejection reason strings
 */

// ---------------------------------------------------------------------------
// REASON_CODES — the only source of rejection reason strings in this module.
// ---------------------------------------------------------------------------
const REASON_CODES = Object.freeze({
  MISSING_MARKET_ODDS: 'MISSING_MARKET_ODDS',
  MISSING_STARTING_PITCHER: 'MISSING_STARTING_PITCHER',
  MISSING_GOALIE_CONFIRMATION: 'MISSING_GOALIE_CONFIRMATION',
  MISSING_CONSISTENCY_FIELDS: 'MISSING_CONSISTENCY_FIELDS',
  WATCHDOG_UNSAFE_FOR_BASE: 'WATCHDOG_UNSAFE_FOR_BASE',
  EDGE_BELOW_THRESHOLD: 'EDGE_BELOW_THRESHOLD',
  EV_BELOW_THRESHOLD: 'EV_BELOW_THRESHOLD',
  DUPLICATE_MARKET_SUPPRESSED: 'DUPLICATE_MARKET_SUPPRESSED',
  DISPLAY_RANKED_BELOW_PRIMARY: 'DISPLAY_RANKED_BELOW_PRIMARY',
  UNCLASSIFIED_MARKET_STATE: 'UNCLASSIFIED_MARKET_STATE',
});

// ---------------------------------------------------------------------------
// VALID_STATUSES — all ten terminal state values for consumer validation
// ---------------------------------------------------------------------------
const VALID_STATUSES = Object.freeze([
  'QUALIFIED_OFFICIAL',
  'QUALIFIED_LEAN',
  'REJECTED_INPUTS',
  'REJECTED_CONSISTENCY',
  'REJECTED_WATCHDOG',
  'REJECTED_THRESHOLD',
  'REJECTED_SELECTOR',
  'REJECTED_DUPLICATE',
  'REJECTED_MARKET_POLICY',
  'SKIP_GAME_MIXED_FAILURES',
]);

// ---------------------------------------------------------------------------
// VALID_MARKET_TYPES — all supported normalised market type tokens
// ---------------------------------------------------------------------------
const VALID_MARKET_TYPES = Object.freeze([
  'F5_ML',
  'F5_TOTAL',
  'FULL_GAME_ML',
  'FULL_GAME_TOTAL',
  'PUCKLINE',
  'SPREAD',
  'TOTAL',
  'MONEYLINE',
  'FIRST_PERIOD',
  'UNKNOWN',
]);

const KNOWN_WATCHDOG_REASON_CODES = new Set(
  Object.values(WATCHDOG_REASONS || {}),
);
const DECISION_PIPELINE_LINKED = typeof buildDecisionV2 === 'function';

const CANONICAL_MONEYLINE_SUPPRESSION_REASONS = Object.freeze({
  MODEL_NO_EDGE: 'MODEL_NO_EDGE',
  MODEL_LOW_CONFIDENCE: 'MODEL_LOW_CONFIDENCE',
  MODEL_INTEGRITY_FAIL: 'MODEL_INTEGRITY_FAIL',
  MODEL_NO_RECENT_DATA: 'MODEL_NO_RECENT_DATA',
  GATE_STALE_EXPIRED: 'GATE_STALE_EXPIRED',
  GATE_STALE_VALID: 'GATE_STALE_VALID',
  GATE_INTEGRITY_FAIL: 'GATE_INTEGRITY_FAIL',
  GATE_NO_CONTRACT: 'GATE_NO_CONTRACT',
  TRANSFORM_STATUS_REMAP: 'TRANSFORM_STATUS_REMAP',
  TRANSFORM_INSUFFICIENT_DATA: 'TRANSFORM_INSUFFICIENT_DATA',
  FILTER_USER_CHOICE: 'FILTER_USER_CHOICE',
  FILTER_DEFAULT_HIDDEN: 'FILTER_DEFAULT_HIDDEN',
});

const MONEYLINE_REASON_ALIAS_MAP = Object.freeze({
  NO_EDGE: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_NO_EDGE,
  PASS_NO_EDGE: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_NO_EDGE,
  PASS_EXECUTION_GATE_NO_EDGE: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_NO_EDGE,
  CONFIDENCE_LOW: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_LOW_CONFIDENCE,
  PASS_CONFIDENCE_GATE: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_LOW_CONFIDENCE,
  INSUFFICIENT_DATA: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_NO_RECENT_DATA,
  PROJECTION_ONLY_EXCLUSION: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_NO_RECENT_DATA,
  INTEGRITY_CHECK_FAILED: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_INTEGRITY_FAIL,
  STATUS_OVERRIDE: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.TRANSFORM_STATUS_REMAP,
  STALE_SNAPSHOT_EXPIRED: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_STALE_EXPIRED,
  STALE_SNAPSHOT_STALE_VALID: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_STALE_VALID,
  STALE_SNAPSHOT: CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_STALE_EXPIRED,
});

function canonicalizeMoneylineSuppressionReason(reason, layer = 'MODEL') {
  const normalized = String(reason || '')
    .trim()
    .toUpperCase()
    .split(':')[0]
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (MONEYLINE_REASON_ALIAS_MAP[normalized]) {
    return MONEYLINE_REASON_ALIAS_MAP[normalized];
  }

  if (normalized.startsWith('STALE_SNAPSHOT_')) {
    return normalized.includes('VALID')
      ? CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_STALE_VALID
      : CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_STALE_EXPIRED;
  }

  if (Object.prototype.hasOwnProperty.call(CANONICAL_MONEYLINE_SUPPRESSION_REASONS, normalized)) {
    return CANONICAL_MONEYLINE_SUPPRESSION_REASONS[normalized];
  }

  if (layer === 'GATE') return CANONICAL_MONEYLINE_SUPPRESSION_REASONS.GATE_INTEGRITY_FAIL;
  if (layer === 'TRANSFORM') return CANONICAL_MONEYLINE_SUPPRESSION_REASONS.TRANSFORM_STATUS_REMAP;
  if (layer === 'FILTER') return CANONICAL_MONEYLINE_SUPPRESSION_REASONS.FILTER_DEFAULT_HIDDEN;
  return CANONICAL_MONEYLINE_SUPPRESSION_REASONS.MODEL_INTEGRITY_FAIL;
}

// ---------------------------------------------------------------------------
// Market type normalisation
// ---------------------------------------------------------------------------
const MARKET_TYPE_MAP = {
  f5_ml: 'F5_ML',
  f5_total: 'F5_TOTAL',
  full_game_ml: 'FULL_GAME_ML',
  full_game_total: 'FULL_GAME_TOTAL',
  spread: 'SPREAD',
  puckline: 'PUCKLINE',
  total: 'TOTAL',
};

function normaliseMarketType(market) {
  if (market == null) return 'UNKNOWN';
  const lower = String(market).toLowerCase();
  return MARKET_TYPE_MAP[lower] || String(market).toUpperCase();
}

// ---------------------------------------------------------------------------
// buildResult — construct a canonical MarketEvalResult from a driver card
// ---------------------------------------------------------------------------
function buildResult(card, ctx, status, reasonCodes, extra = {}) {
  const gameId = (ctx && ctx.game_id) || '';
  const sport = (ctx && ctx.sport) || (card && card.sport) || null;
  const market = (card && card.market) || null;

  // Provenance fields — defaults
  const inputs_status = extra.inputs_status !== undefined ? extra.inputs_status : 'COMPLETE';
  const evaluation_status = extra.evaluation_status !== undefined ? extra.evaluation_status : 'NO_EVALUATION';
  const raw_edge_value = extra.raw_edge_value !== undefined ? extra.raw_edge_value : null;
  const threshold_required = extra.threshold_required !== undefined ? extra.threshold_required : null;
  const threshold_passed = extra.threshold_passed !== undefined ? extra.threshold_passed : null;
  const block_reasons = Array.isArray(extra.block_reasons) ? extra.block_reasons : [];

  return {
    game_id: gameId,
    sport: sport,
    market_type: normaliseMarketType(market),
    candidate_id: `${gameId}::${market ?? 'unknown'}`,
    inputs_ok: extra.inputs_ok !== undefined ? extra.inputs_ok : true,
    consistency_ok: extra.consistency_ok !== undefined ? extra.consistency_ok : true,
    watchdog_ok: extra.watchdog_ok !== undefined ? extra.watchdog_ok : true,
    model_edge: card != null && card.edge !== undefined ? card.edge : null,
    fair_price: card != null && card.fair_price !== undefined ? card.fair_price : null,
    win_probability: card != null && card.win_probability !== undefined ? card.win_probability : null,
    official_tier: extra.official_tier || 'PASS',
    status: status,
    reason_codes: Array.isArray(reasonCodes) ? reasonCodes : [],
    notes: Array.isArray(extra.notes) ? extra.notes : [],
    // Provenance fields
    inputs_status,
    evaluation_status,
    raw_edge_value,
    threshold_required,
    threshold_passed,
    block_reasons,
  };
}

// ---------------------------------------------------------------------------
// evaluateSingleMarket(card, ctx) → MarketEvalResult
// ---------------------------------------------------------------------------
function evaluateSingleMarket(card, ctx) {
  const safeCtx = ctx || {};

  // --- Null / missing card ---
  if (card == null) {
    return buildResult(
      null,
      safeCtx,
      'REJECTED_INPUTS',
      [REASON_CODES.MISSING_MARKET_ODDS],
      { inputs_ok: false, inputs_status: 'MISSING', evaluation_status: 'NO_EVALUATION', threshold_passed: null },
    );
  }

  // --- Malformed driver card (missing terminal inputs entirely) ---
  if (
    card.ev_threshold_passed == null &&
    typeof card.status === 'undefined' &&
    typeof card.classification === 'undefined'
  ) {
    return buildResult(
      card,
      safeCtx,
      'REJECTED_INPUTS',
      [REASON_CODES.UNCLASSIFIED_MARKET_STATE],
      { inputs_ok: false, inputs_status: 'MISSING', evaluation_status: 'NO_EVALUATION', threshold_passed: null },
    );
  }

  // --- Missing inputs gate ---
  if (Array.isArray(card.missing_inputs) && card.missing_inputs.length > 0) {
    // Allow projection-only cards to pass even with missing inputs (WI-0919)
    // Projection-only scenarios intentionally use degraded inputs when full model unavailable
    const isProjectionOnly = card.projection_floor === true || card.without_odds_mode === true;
    
    if (isProjectionOnly) {
      // Projection-only cards allowed through — they'll use SYNTHETIC_FALLBACK or degraded inputs
      return buildResult(card, safeCtx, 'QUALIFIED_LEAN', [], {
        official_tier: 'LEAN',
        inputs_status: 'COMPLETE',
        evaluation_status: 'EDGE_COMPUTED',
        threshold_passed: true,
      });
    }
    
    const codes = card.missing_inputs.map((name) => {
      const n = String(name).toLowerCase();
      if (n.includes('pitcher') || n.includes('sp_')) return REASON_CODES.MISSING_STARTING_PITCHER;
      if (n.includes('goalie') || n.includes('goaltender')) return REASON_CODES.MISSING_GOALIE_CONFIRMATION;
      if (n.includes('consistency')) return REASON_CODES.MISSING_CONSISTENCY_FIELDS;
      if (n.includes('odds') || n.includes('price') || n.includes('market')) return REASON_CODES.MISSING_MARKET_ODDS;
      return REASON_CODES.MISSING_MARKET_ODDS;
    });
    return buildResult(card, safeCtx, 'REJECTED_INPUTS', codes, { inputs_ok: false, inputs_status: 'MISSING', evaluation_status: 'NO_EVALUATION', threshold_passed: null });
  }

  // --- Watchdog gate ---
  if (
    Array.isArray(card.watchdog_reason_codes) &&
    card.watchdog_reason_codes.length > 0
  ) {
    const watchdogCodes = card.watchdog_reason_codes
      .map((value) => String(value))
      .filter(Boolean);

    const notes = [];
    if (DECISION_PIPELINE_LINKED) {
      notes.push('decision_pipeline_linked');
    }
    if (watchdogCodes.some((code) => KNOWN_WATCHDOG_REASON_CODES.has(code))) {
      notes.push('watchdog_reason_recognized');
    }

    return buildResult(
      card,
      safeCtx,
      'REJECTED_WATCHDOG',
      [REASON_CODES.WATCHDOG_UNSAFE_FOR_BASE, ...watchdogCodes],
      { watchdog_ok: false, official_tier: 'PASS', notes, inputs_status: 'PARTIAL', evaluation_status: 'NO_EVALUATION', threshold_passed: null },
    );
  }

  // --- EV threshold explicitly false ---
  if (card.ev_threshold_passed === false) {
    const codes = [REASON_CODES.EDGE_BELOW_THRESHOLD];
    if (Array.isArray(card.reason_codes)) {
      codes.push(...card.reason_codes);
    }
    return buildResult(card, safeCtx, 'REJECTED_THRESHOLD', codes, {
      official_tier: 'PASS',
      inputs_status: 'COMPLETE',
      evaluation_status: 'EDGE_COMPUTED',
      raw_edge_value: card.edge != null ? card.edge : null,
      threshold_passed: false,
    });
  }

  // --- Card status === 'PASS' (model said pass explicitly) ---
  if (card.status === 'PASS') {
    const codes = [REASON_CODES.EV_BELOW_THRESHOLD];
    if (card.pass_reason_code) {
      codes.push(card.pass_reason_code);
    }
    // Derive provenance based on pass_reason_code
    let passExtra;
    if (card.pass_reason_code === 'PASS_NO_EDGE') {
      passExtra = {
        official_tier: 'PASS',
        inputs_status: 'COMPLETE',
        evaluation_status: 'EDGE_COMPUTED',
        raw_edge_value: card.edge != null ? card.edge : null,
        threshold_passed: false,
      };
    } else {
      passExtra = {
        official_tier: 'PASS',
        inputs_status: 'COMPLETE',
        evaluation_status: 'NO_EVALUATION',
        threshold_passed: null,
        block_reasons: card.pass_reason_code ? [card.pass_reason_code] : [],
      };
    }
    return buildResult(card, safeCtx, 'REJECTED_THRESHOLD', codes, passExtra);
  }

  // --- LEAN / WATCH → QUALIFIED_LEAN ---
  if (card.classification === 'LEAN' || card.status === 'WATCH') {
    return buildResult(card, safeCtx, 'QUALIFIED_LEAN', [], {
      official_tier: 'LEAN',
      inputs_status: 'COMPLETE',
      evaluation_status: 'EDGE_COMPUTED',
      threshold_passed: true,
    });
  }

  // --- FIRE / BASE → QUALIFIED_OFFICIAL ---
  if (card.ev_threshold_passed === true && (card.status === 'FIRE' || card.classification === 'BASE')) {
    return buildResult(card, safeCtx, 'QUALIFIED_OFFICIAL', [], {
      official_tier: 'PLAY',
      inputs_status: 'COMPLETE',
      evaluation_status: 'EDGE_COMPUTED',
      threshold_passed: true,
    });
  }

  // --- Default fallback ---
  return buildResult(
    card,
    safeCtx,
    'REJECTED_THRESHOLD',
    [REASON_CODES.UNCLASSIFIED_MARKET_STATE],
    { official_tier: 'PASS' },
  );
}

// ---------------------------------------------------------------------------
// assertLegalPassNoEdge(result) — throws when PASS_NO_EDGE is used illegally
// ---------------------------------------------------------------------------
function assertLegalPassNoEdge(result) {
  const hasNoEdgeCode =
    Array.isArray(result.reason_codes) && result.reason_codes.includes('PASS_NO_EDGE');
  if (!hasNoEdgeCode) return;

  const positiveEdge = typeof result.raw_edge_value === 'number' && result.raw_edge_value > 0;
  const noEvaluation = result.evaluation_status === 'NO_EVALUATION';
  const missingInputs = result.inputs_status === 'MISSING';

  if (positiveEdge || noEvaluation || missingInputs) {
    throw new Error(
      `ILLEGAL_PASS_NO_EDGE: candidate=${result.candidate_id} raw_edge=${result.raw_edge_value} ` +
      `evaluation_status=${result.evaluation_status} inputs_status=${result.inputs_status}. ` +
      `PASS_NO_EDGE requires: EDGE_COMPUTED + COMPLETE inputs + non-positive edge.`,
    );
  }
}

// ---------------------------------------------------------------------------
// assertNoSilentMarketDrop(gameEval) — throws on unbalanced partition
// ---------------------------------------------------------------------------
function assertNoSilentMarketDrop(gameEval) {
  // Enforce PASS_NO_EDGE integrity on every result
  gameEval.market_results.forEach((r) => assertLegalPassNoEdge(r));
  // Terminal-state + shape invariants (checked first so error is actionable)
  for (const r of gameEval.market_results) {
    if (!r.status || !VALID_STATUSES.includes(r.status)) {
      throw new Error(
        `MISSING_MARKET_TERMINAL_STATUS for ${r.candidate_id ?? 'unknown'}: got ${r.status}`,
      );
    }
    if (!Array.isArray(r.reason_codes)) {
      throw new Error(`MISSING_REASON_CODES_ARRAY for ${r.candidate_id ?? 'unknown'}`);
    }
  }

  // Count invariant
  const total = gameEval.market_results.length;
  const partitioned =
    gameEval.official_plays.length + gameEval.leans.length + gameEval.rejected.length;

  if (total !== partitioned) {
    throw new Error(
      `UNACCOUNTED_MARKET_RESULTS for ${gameEval.game_id}: ` +
        `market_results.length=${total} !== official_plays(${gameEval.official_plays.length}) ` +
        `+ leans(${gameEval.leans.length}) + rejected(${gameEval.rejected.length})=${partitioned}`,
    );
  }
}

// ---------------------------------------------------------------------------
// finalizeGameMarketEvaluation({ game_id, sport, market_results })
//   → GameMarketEvaluation
// ---------------------------------------------------------------------------
function finalizeGameMarketEvaluation({ game_id, sport, market_results }) {
  const official_plays = [];
  const leans = [];
  const rejected = [];

  for (const result of market_results) {
    if (result.status === 'QUALIFIED_OFFICIAL') {
      official_plays.push(result);
    } else if (result.status === 'QUALIFIED_LEAN') {
      leans.push(result);
    } else {
      rejected.push(result);
    }
  }

  const gameEval = {
    game_id,
    sport,
    market_results,
    official_plays,
    leans,
    rejected,
    status: null, // set below
  };

  // Invariant check before deciding status
  assertNoSilentMarketDrop(gameEval);

  // Determine game-level status
  let status;
  const allInputsRejected =
    market_results.length > 0 &&
    market_results.every((r) => r.status === 'REJECTED_INPUTS');

  if (allInputsRejected) {
    status = 'SKIP_GAME_INPUT_FAILURE';
  } else if (official_plays.length > 0) {
    status = 'HAS_OFFICIAL_PLAYS';
  } else if (leans.length > 0) {
    status = 'LEANS_ONLY';
  } else {
    status = 'SKIP_MARKET_NO_EDGE';
  }

  // Upgrade SKIP_MARKET_NO_EDGE to SKIP_GAME_MIXED_FAILURES if any rejected
  // result never ran evaluation (some candidates were never evaluated)
  if (status === 'SKIP_MARKET_NO_EDGE') {
    const anyNoEvaluation = rejected.some((r) => r.evaluation_status === 'NO_EVALUATION');
    if (anyNoEvaluation) status = 'SKIP_GAME_MIXED_FAILURES';
  }

  gameEval.status = status;
  return gameEval;
}

// ---------------------------------------------------------------------------
// logRejectedMarkets(rejected, logger = console)
// ---------------------------------------------------------------------------
function logRejectedMarkets(rejected, logger) {
  const log = logger || console;
  for (const item of rejected) {
    log.info(
      `[MARKET_REJECTED] game=${item.game_id} market=${item.market_type} ` +
        `status=${item.status} reasons=${(item.reason_codes || []).join(',')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  REASON_CODES,
  VALID_STATUSES,
  VALID_MARKET_TYPES,
  CANONICAL_MONEYLINE_SUPPRESSION_REASONS,
  canonicalizeMoneylineSuppressionReason,
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
  assertLegalPassNoEdge,
  assertNoSilentMarketDrop,
  logRejectedMarkets,
};
