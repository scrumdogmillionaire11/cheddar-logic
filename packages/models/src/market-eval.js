'use strict';

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
    // Allow projection-floor cards to pass even with market odds missing (WI-0919)
    // Projection-only scenarios intentionally have no market line; this is correct
    const isProjectionFloor = card.projection_floor === true || card.without_odds_mode === true;
    const hasOnlyMarketOddsMissing = card.missing_inputs.every((name) => {
      const n = String(name).toLowerCase();
      return n.includes('odds') || n.includes('price') || n.includes('market');
    });
    
    if (isProjectionFloor && hasOnlyMarketOddsMissing) {
      // Projection-floor cards are allowed with missing market odds — select as lean
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
  evaluateSingleMarket,
  finalizeGameMarketEvaluation,
  assertNoSilentMarketDrop,
  logRejectedMarkets,
};
