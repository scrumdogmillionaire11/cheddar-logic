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
// VALID_STATUSES — all nine terminal state values for consumer validation
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
      { inputs_ok: false },
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
      { inputs_ok: false },
    );
  }

  // --- Missing inputs gate ---
  if (Array.isArray(card.missing_inputs) && card.missing_inputs.length > 0) {
    // Allow projection-only cards to pass even with missing inputs (WI-0919)
    // Projection-only scenarios intentionally use degraded inputs when full model unavailable
    const isProjectionOnly = card.projection_floor === true || card.without_odds_mode === true;
    
    if (isProjectionOnly) {
      // Projection-only cards allowed through — they'll use SYNTHETIC_FALLBACK or degraded inputs
      return buildResult(card, safeCtx, 'QUALIFIED_LEAN', [], { official_tier: 'LEAN' });
    }
    
    const codes = card.missing_inputs.map((name) => {
      const n = String(name).toLowerCase();
      if (n.includes('pitcher') || n.includes('sp_')) return REASON_CODES.MISSING_STARTING_PITCHER;
      if (n.includes('goalie') || n.includes('goaltender')) return REASON_CODES.MISSING_GOALIE_CONFIRMATION;
      if (n.includes('consistency')) return REASON_CODES.MISSING_CONSISTENCY_FIELDS;
      if (n.includes('odds') || n.includes('price') || n.includes('market')) return REASON_CODES.MISSING_MARKET_ODDS;
      return REASON_CODES.MISSING_MARKET_ODDS;
    });
    return buildResult(card, safeCtx, 'REJECTED_INPUTS', codes, { inputs_ok: false });
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
      { watchdog_ok: false, official_tier: 'PASS', notes },
    );
  }

  // --- EV threshold explicitly false ---
  if (card.ev_threshold_passed === false) {
    const codes = [REASON_CODES.EDGE_BELOW_THRESHOLD];
    if (Array.isArray(card.reason_codes)) {
      codes.push(...card.reason_codes);
    }
    return buildResult(card, safeCtx, 'REJECTED_THRESHOLD', codes, { official_tier: 'PASS' });
  }

  // --- Card status === 'PASS' (model said pass explicitly) ---
  if (card.status === 'PASS') {
    const codes = [REASON_CODES.EV_BELOW_THRESHOLD];
    if (card.pass_reason_code) {
      codes.push(card.pass_reason_code);
    }
    return buildResult(card, safeCtx, 'REJECTED_THRESHOLD', codes, { official_tier: 'PASS' });
  }

  // --- LEAN / WATCH → QUALIFIED_LEAN ---
  if (card.classification === 'LEAN' || card.status === 'WATCH') {
    return buildResult(card, safeCtx, 'QUALIFIED_LEAN', [], { official_tier: 'LEAN' });
  }

  // --- FIRE / BASE → QUALIFIED_OFFICIAL ---
  if (card.ev_threshold_passed === true && (card.status === 'FIRE' || card.classification === 'BASE')) {
    return buildResult(card, safeCtx, 'QUALIFIED_OFFICIAL', [], { official_tier: 'PLAY' });
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
// assertNoSilentMarketDrop(gameEval) — throws on unbalanced partition
// ---------------------------------------------------------------------------
function assertNoSilentMarketDrop(gameEval) {
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
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
  assertNoSilentMarketDrop,
  logRejectedMarkets,
};
