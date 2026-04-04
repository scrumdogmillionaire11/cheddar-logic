'use strict';

/**
 * market-structure.js
 *
 * Implements the Market Structure analysis layer for both worlds:
 *
 * WORLD 1 — ODDS-BACKED MARKETS
 * "You are not predicting outcomes. You are pricing mistakes."
 *
 *   Step 3: Sharp anchor check   → analyzeSharpAnchor()
 *   Step 4: Market structure (FTP) pressure, behavior, timing
 *   Step 5: Context filter        → contextIsExplained()
 *   Step 6: Correction check      → correctionDetected()
 *   Full:   analyzeMarketStructure(snapshot)
 *
 * WORLD 2 — PROJECTION-ONLY
 * "No price → no trade. A projection is a trigger candidate, not a bet."
 *
 *   Step 6: Output classification → classifyProjectionOutput(result)
 *   Outputs: SUPPRESS / WATCHLIST / READY_FOR_PRICE
 *
 * HOW FTP FITS
 * Public data is NOT a signal — it is a PRESSURE SOURCE.
 * "Fade the public" is a subset of mispricing where public pressure caused
 * the pricing error.  This module detects that specific cause.
 */

// ─── Enumerations ────────────────────────────────────────────────────────────

/** Public pressure classification */
const MARKET_PRESSURE = Object.freeze({
  HEAVY_HOME: 'HEAVY_HOME',   // >60% of bets / money on home
  HEAVY_AWAY: 'HEAVY_AWAY',   // >60% of bets / money on away
  BALANCED: 'BALANCED',       // 40–60% split
  UNKNOWN: 'UNKNOWN',         // splits not available
});

/**
 * Line behavior relative to public pressure.
 *
 * INFLATION          – line moved WITH public (retail drove the price)
 * SHARP_DISAGREEMENT – line moved AGAINST public (sharps on the other side)
 * RESISTANCE         – line held despite heavy public pressure (sharp defense)
 * NEUTRAL            – balanced public, no anomalous behavior
 * UNKNOWN            – insufficient data
 */
const LINE_BEHAVIOR = Object.freeze({
  INFLATION: 'INFLATION',
  SHARP_DISAGREEMENT: 'SHARP_DISAGREEMENT',
  RESISTANCE: 'RESISTANCE',
  NEUTRAL: 'NEUTRAL',
  UNKNOWN: 'UNKNOWN',
});

/**
 * What CAUSED the potential mispricing.
 * PUBLIC_PRESSURE = inefficiency traceable to retail one-sidedness
 * SHARP_FADE      = market moved against public → sharp consensus exists
 * ORGANIC         = explained by context (injuries, weather, lineup, etc.)
 * UNKNOWN         = not enough data to classify
 */
const INEFFICIENCY_CAUSE = Object.freeze({
  PUBLIC_PRESSURE: 'PUBLIC_PRESSURE',
  SHARP_FADE: 'SHARP_FADE',
  ORGANIC: 'ORGANIC',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Projection-only output classification.
 *
 * SUPPRESS        = bad inputs, weak projection, or high fragility → do not surface
 * WATCHLIST       = interesting but missing confirmation
 * READY_FOR_PRICE = strong projection + stable inputs + environment aligned →
 *                   trigger candidate (runs full odds-backed pipeline when price appears)
 */
const PROJECTION_OUTPUT = Object.freeze({
  SUPPRESS: 'SUPPRESS',
  WATCHLIST: 'WATCHLIST',
  READY_FOR_PRICE: 'READY_FOR_PRICE',
});

// ─── Thresholds ───────────────────────────────────────────────────────────────

const PRESSURE_HEAVY_THRESHOLD = 0.60;    // >60% bets/money = "heavy"
const PRESSURE_LIGHT_THRESHOLD = 0.40;    // <40% = heavy other side
const LINE_DRIFT_EPSILON = 0.25;          // pts change to count as "moved"
const PROJECTION_CONFIDENCE_FIRE = 0.60;  // minimum confidence for READY_FOR_PRICE
const PROJECTION_CONFIDENCE_WATCH = 0.40; // minimum confidence for WATCHLIST
const PROJECTION_MAX_MISSING_INPUTS = 2;  // missing inputs capped at this for READY_FOR_PRICE

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Returns a number or null (never NaN). */
function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Classify public pressure from a snapshot's splits columns.
 *
 * Decision: weight money (handle) equally with bets.
 * If either is HEAVY on the same side, that side is dominant.
 */
function classifyPressure(snapshot) {
  const betsPctHome   = asNum(snapshot.public_bets_pct_home);
  const handlePctHome = asNum(snapshot.public_handle_pct_home);

  if (betsPctHome === null && handlePctHome === null) return MARKET_PRESSURE.UNKNOWN;

  // Average bets + handle when both present; fall back to whichever is available
  const values = [betsPctHome, handlePctHome].filter((v) => v !== null);
  const avgHome = values.reduce((s, v) => s + v, 0) / values.length;

  if (avgHome > PRESSURE_HEAVY_THRESHOLD) return MARKET_PRESSURE.HEAVY_HOME;
  if (avgHome < PRESSURE_LIGHT_THRESHOLD) return MARKET_PRESSURE.HEAVY_AWAY;
  return MARKET_PRESSURE.BALANCED;
}

/**
 * Classify line behavior: did the line move with or against public pressure?
 *
 * Uses spread_home vs spread_consensus_line.
 * consensus_line is the Pinnacle-proxy "fair" line; spread_home is the current
 * tracked line.  If the current line has drifted further in the direction the
 * public is loading → that's inflation.  If it drifted the other way → sharps
 * pushed back.
 *
 * Convention: negative spread_home means home is favored.
 * HEAVY_HOME public → "correct" healthy direction would keep or narrow the favourite.
 * If spread_home is MORE negative than consensus (e.g. -4 vs consensus -3),
 * the line has inflated in the public's favour → INFLATION.
 */
function classifyLineBehavior(snapshot, pressure) {
  if (pressure === MARKET_PRESSURE.UNKNOWN || pressure === MARKET_PRESSURE.BALANCED) {
    return LINE_BEHAVIOR.NEUTRAL;
  }

  const spreadHome     = asNum(snapshot.spread_home);
  const consensusLine  = asNum(snapshot.spread_consensus_line);

  if (spreadHome === null || consensusLine === null) return LINE_BEHAVIOR.UNKNOWN;

  // drift = how far current line moved vs consensus in home-favour direction
  // drift > 0 → home became a bigger favourite (line moved home)
  // drift < 0 → home became a smaller favourite (line moved away)
  const drift = consensusLine - spreadHome; // e.g. -3 - (-4) = +1 (home favoured more now)

  const hasDrifted = Math.abs(drift) >= LINE_DRIFT_EPSILON;

  if (pressure === MARKET_PRESSURE.HEAVY_HOME) {
    if (!hasDrifted) return LINE_BEHAVIOR.RESISTANCE;      // public heavy, line held
    if (drift > 0)   return LINE_BEHAVIOR.INFLATION;       // line moved further home (with public)
    return LINE_BEHAVIOR.SHARP_DISAGREEMENT;                // line moved away (sharps on away)
  }

  // HEAVY_AWAY
  if (!hasDrifted) return LINE_BEHAVIOR.RESISTANCE;
  if (drift < 0)   return LINE_BEHAVIOR.INFLATION;         // line moved further away (with public)
  return LINE_BEHAVIOR.SHARP_DISAGREEMENT;                  // line moved back toward home (sharps on home)
}

/**
 * Derive inefficiency cause from line behavior.
 * FTP is NOT a strategy — it is one cause of mispricing.
 */
function deriveInefficiencyCause(lineBehavior, contextExplained) {
  if (contextExplained) return INEFFICIENCY_CAUSE.ORGANIC;

  switch (lineBehavior) {
    case LINE_BEHAVIOR.SHARP_DISAGREEMENT:
      return INEFFICIENCY_CAUSE.SHARP_FADE;
    case LINE_BEHAVIOR.RESISTANCE:
    case LINE_BEHAVIOR.INFLATION:
      return INEFFICIENCY_CAUSE.PUBLIC_PRESSURE;
    default:
      return INEFFICIENCY_CAUSE.UNKNOWN;
  }
}

// ─── Step 3: Sharp anchor check ───────────────────────────────────────────────

/**
 * Evaluate whether the current snapshot aligns with, diverges from, or lacks
 * a sharp book anchor.
 *
 * Returns one of:
 *   { aligned: true,  signal: 'CHEDDAR' }    — sharp composite confirms our read
 *   { aligned: false, signal: 'COTTAGE' }     — consensus exists but diverges
 *   { aligned: null,  signal: 'UNPRICED' }    — no sharp data available
 *   { aligned: null,  signal: 'PENDING' }     — consensus exists but not enough
 *                                               books to be reliable
 *
 * @param {object} snapshot - odds_snapshot row (or similar with consensus fields)
 */
function analyzeSharpAnchor(snapshot) {
  const confidence = snapshot?.spread_consensus_confidence;
  const bookCount  = asNum(snapshot?.spread_source_book_count);

  if (!confidence || confidence === 'LOW' || (bookCount !== null && bookCount < 3)) {
    return { aligned: null, signal: 'UNPRICED', reason: 'INSUFFICIENT_BOOKS' };
  }

  if (confidence === 'MEDIUM') {
    return { aligned: null, signal: 'PENDING', reason: 'MEDIUM_CONFIDENCE_ONLY' };
  }

  // HIGH confidence — compare our spread to consensus
  const spreadHome    = asNum(snapshot.spread_home);
  const consensusLine = asNum(snapshot.spread_consensus_line);

  if (spreadHome === null || consensusLine === null) {
    return { aligned: null, signal: 'UNPRICED', reason: 'MISSING_LINES' };
  }

  const delta = Math.abs(spreadHome - consensusLine);
  const aligned = delta <= 0.5; // within half a point = aligned

  return {
    aligned,
    signal: aligned ? 'CHEDDAR' : 'COTTAGE',
    delta,
    spread_home: spreadHome,
    consensus_line: consensusLine,
  };
}

// ─── Step 5: Context filter ────────────────────────────────────────────────────

/**
 * Returns true if the line movement is explained by known context factors,
 * meaning NO pricing inefficiency exists.
 *
 * Context flags come from the model/card raw_data or injury status fields.
 *
 * @param {object} contextFlags - Object with boolean properties:
 *   injuryImpact, paceShift, weatherImpact, lineupConfirmed, matchupShift
 */
function contextIsExplained({
  injuryImpact = false,
  paceShift = false,
  weatherImpact = false,
  lineupConfirmed = false,
  matchupShift = false,
} = {}) {
  return injuryImpact || paceShift || weatherImpact || lineupConfirmed || matchupShift;
}

// ─── Step 6: Correction check ─────────────────────────────────────────────────

/**
 * Returns true if the market appears to have already corrected the mispricing.
 *
 * Signals that indicate correction:
 * - spread_review_flag = 1 → snapshot flagged for review (already under scrutiny)
 * - sharp_price_status signals from the pipeline already confirmed a bet edge
 *   → if CHEDDAR price was already acted on by the pipeline, the window may be closed
 * - External: line has moved substantially in the direction of our thesis
 *
 * @param {object} snapshot - odds_snapshot row
 * @param {object} [opts]
 * @param {boolean} [opts.edgeAlreadyActedOn] - pipeline already fired a card on this game
 */
function correctionDetected(snapshot, { edgeAlreadyActedOn = false } = {}) {
  if (!snapshot) return false;

  const reviewFlag = snapshot.spread_review_flag === 1 || snapshot.spread_review_flag === true;
  if (reviewFlag) return true;

  // If a card was already emitted with FIRE/CHEDDAR, the window may be closed
  if (edgeAlreadyActedOn) return true;

  return false;
}

// ─── Step 4 + full odds-backed analysis ───────────────────────────────────────

/**
 * Full Market Structure analysis for an odds-backed market.
 *
 * Encapsulates Steps 3-6 of the odds-backed system:
 * 3. Sharp anchor
 * 4. FTP pressure + line behavior
 * 5. Context filter (caller provides contextFlags)
 * 6. Correction check
 *
 * @param {object} snapshot     - odds_snapshot row with splits columns populated
 * @param {object} [contextFlags] - context explanation flags (see contextIsExplained)
 * @param {object} [opts]
 * @param {boolean} [opts.edgeAlreadyActedOn]
 * @returns {MarketStructureResult}
 */
function analyzeMarketStructure(snapshot, contextFlags = {}, opts = {}) {
  const pressure      = classifyPressure(snapshot);
  const lineBehavior  = classifyLineBehavior(snapshot, pressure);
  const sharpAnchor   = analyzeSharpAnchor(snapshot);
  const explained     = contextIsExplained(contextFlags);
  const corrected     = correctionDetected(snapshot, opts);
  const inefficiency  = deriveInefficiencyCause(lineBehavior, explained);

  const splitsPresent = snapshot?.splits_source != null;

  /**
   * public_pressure_actionable:
   *   true  → FTP signal exists (SHARP_DISAGREEMENT or RESISTANCE) AND not explained AND not corrected
   *   false → inflated, explained, corrected, or no data
   */
  const public_pressure_actionable =
    !explained &&
    !corrected &&
    splitsPresent &&
    (lineBehavior === LINE_BEHAVIOR.SHARP_DISAGREEMENT || lineBehavior === LINE_BEHAVIOR.RESISTANCE);

  return {
    // Step 3
    sharp_anchor: sharpAnchor,

    // Step 4
    public_pressure: pressure,
    line_behavior: lineBehavior,
    splits_present: splitsPresent,
    splits_source: snapshot?.splits_source ?? null,
    bets_pct_home: asNum(snapshot?.public_bets_pct_home),
    bets_pct_away: asNum(snapshot?.public_bets_pct_away),
    handle_pct_home: asNum(snapshot?.public_handle_pct_home),
    handle_pct_away: asNum(snapshot?.public_handle_pct_away),

    // Step 5
    context_explained: explained,

    // Step 6
    correction_detected: corrected,

    // Synthesis
    inefficiency_cause: inefficiency,
    public_pressure_actionable,
  };
}

// ─── Projection-only output classifier ────────────────────────────────────────

/**
 * Classify a projection-only result into SUPPRESS / WATCHLIST / READY_FOR_PRICE.
 *
 * READY_FOR_PRICE is the key output — it marks the projection as a trigger
 * candidate that should run the full odds-backed pipeline once a price appears.
 *
 * It does NOT mean "bet this."  It means: "when the market opens on this,
 * immediately compare."
 *
 * @param {object} result - Projection result object with:
 *   {number|null}  result.projection       - Numeric forecast value
 *   {number}       result.confidence       - 0–1 confidence score
 *   {string[]}     result.missing_inputs   - Array of unavailable input keys
 *   {string[]}     result.environment_flags - Suppression flags (WIND_, UMP_, etc.)
 *   {string[]}     result.risk_flags       - Risk flags from model
 *   {number}       [result.dependency_score] - Fraction of how many things need to go right (0=few, 1=many)
 *
 * @returns {{ output: PROJECTION_OUTPUT, reason: string, trigger_candidate: boolean }}
 */
function classifyProjectionOutput(result = {}) {
  const {
    projection = null,
    confidence = 0,
    missing_inputs = [],
    environment_flags = [],
    risk_flags = [],
    dependency_score = 0,
  } = result;

  // SUPPRESS conditions
  if (projection === null) {
    return { output: PROJECTION_OUTPUT.SUPPRESS, reason: 'NO_PROJECTION', trigger_candidate: false };
  }
  if (confidence < PROJECTION_CONFIDENCE_WATCH) {
    return { output: PROJECTION_OUTPUT.SUPPRESS, reason: 'LOW_CONFIDENCE', trigger_candidate: false };
  }
  if (missing_inputs.length > PROJECTION_MAX_MISSING_INPUTS) {
    return {
      output: PROJECTION_OUTPUT.SUPPRESS,
      reason: `MISSING_INPUTS:${missing_inputs.length}`,
      trigger_candidate: false,
    };
  }
  // High-fragility check: >2 environment suppression flags OR dependency_score > 0.7
  if (environment_flags.length > 2 || dependency_score > 0.7) {
    return {
      output: PROJECTION_OUTPUT.SUPPRESS,
      reason: environment_flags.length > 2 ? 'HIGH_ENVIRONMENT_SUPPRESSION' : 'HIGH_DEPENDENCY',
      trigger_candidate: false,
    };
  }

  // READY_FOR_PRICE conditions — all must be true
  const isReady =
    confidence >= PROJECTION_CONFIDENCE_FIRE &&
    missing_inputs.length <= 1 &&
    environment_flags.length === 0 &&
    risk_flags.length <= 1 &&
    dependency_score <= 0.4;

  if (isReady) {
    return {
      output: PROJECTION_OUTPUT.READY_FOR_PRICE,
      reason: 'STRONG_PROJECTION',
      trigger_candidate: true,
    };
  }

  // WATCHLIST — interesting but not yet confirmed
  return {
    output: PROJECTION_OUTPUT.WATCHLIST,
    reason: [
      missing_inputs.length > 0 && `MISSING_INPUTS:${missing_inputs.length}`,
      environment_flags.length > 0 && `ENV_FLAGS:${environment_flags.length}`,
      confidence < PROJECTION_CONFIDENCE_FIRE && 'CONFIDENCE_BELOW_FIRE',
    ]
      .filter(Boolean)
      .join('|') || 'PARTIAL_CONFIRMATION',
    trigger_candidate: false,
  };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // Enums
  MARKET_PRESSURE,
  LINE_BEHAVIOR,
  INEFFICIENCY_CAUSE,
  PROJECTION_OUTPUT,

  // Analysis functions
  analyzeMarketStructure,
  analyzeSharpAnchor,
  contextIsExplained,
  correctionDetected,
  classifyProjectionOutput,

  // Exposed internals for testing
  _classifyPressure: classifyPressure,
  _classifyLineBehavior: classifyLineBehavior,
  _deriveInefficiencyCause: deriveInefficiencyCause,
};
