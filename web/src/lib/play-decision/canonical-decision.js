/**
 * Canonical Play Decision Logic (JavaScript Implementation)
 * For use in Next.js and Node.js environments
 * 
 * Two layers:
 * 1. deriveClassification() - model truth (ignores market/time/availability)
 * 2. deriveAction() - execution decision (considers market/time/wrappers)
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const THRESHOLDS = {
  TOTAL: {
    base_edge_threshold: 0.02,  // 2.0% edge minimum for BASE
    confidence_floor: 0.55,     // 55% confidence minimum
    weak_signal_adjustment: 0.015,    // +1.5% if weak signal
    conflict_adjustment: 0.01,        // +1.0% if high conflict
    steep_favorite_adjustment: 0.02,  // +2.0% for very steep favorites
    veto_on_total_bias: true,  // TOTAL_BIAS_CONFLICT → PASS
  },
  
  SPREAD: {
    base_edge_threshold: 0.025,    // 2.5% edge minimum for BASE
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.015,
    conflict_adjustment: 0.01,
  },
  
  MONEYLINE: {
    base_edge_threshold: 0.025,    // 2.5% edge minimum for BASE
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.015,
    conflict_adjustment: 0.01,
  },
  
  DOUBLE_CHANCE: {
    base_edge_threshold: 0.03,     // 3.0% (wider markets)
    confidence_floor: 0.55,
  },
  
  TSOA: {
    base_edge_threshold: 0.035,    // 3.5%
    confidence_floor: 0.55,
  },
  
  PROP: {
    base_edge_threshold: 0.035,
    confidence_floor: 0.55,
  },
};

// ============================================================================
// LAYER 1: CLASSIFICATION (Model Truth)
// ============================================================================

/**
 * Derive classification: Does the model endorse this as positive expected value?
 * 
 * Returns: { classification: 'BASE' | 'LEAN' | 'PASS', pass_reason?: string }
 */
export function deriveClassification(play) {
  // ========== HARD VETO CHECKS ==========
  
  if (!play.market_type) {
    return { classification: 'PASS', pass_reason: 'MISSING_MARKET_TYPE' };
  }
  
  if (!play.selection_key) {
    return { classification: 'PASS', pass_reason: 'MISSING_SELECTION' };
  }
  
  // TOTAL_BIAS hard veto
  if (
    play.market_type === 'TOTAL' &&
    play.warning_tags?.includes('TOTAL_BIAS_CONFLICT')
  ) {
    return {
      classification: 'PASS',
      pass_reason: 'TOTAL_BIAS_CONFLICT',
    };
  }
  
  // Consistency/data quality veto
  if (play.warning_tags?.includes('CONSISTENCY_FAIL')) {
    return {
      classification: 'PASS',
      pass_reason: 'CONSISTENCY_FAIL',
    };
  }
  
  // OUT_OF_SCOPE hard veto
  if (play.warning_tags?.includes('OUT_OF_SCOPE_MARKET')) {
    return {
      classification: 'PASS',
      pass_reason: 'OUT_OF_SCOPE_MARKET',
    };
  }
  
  // Unsupported market type for sport
  if (!isMarketTypeSupportedForSport(play.market_type, play.sport)) {
    return {
      classification: 'PASS',
      pass_reason: 'UNSUPPORTED_MARKET',
    };
  }
  
  // Missing edge
  if (play.model.edge === undefined || play.model.edge === null) {
    return {
      classification: 'PASS',
      pass_reason: 'NO_EDGE',
    };
  }
  
  // Non-positive edge
  if (play.model.edge <= 0) {
    return {
      classification: 'PASS',
      pass_reason: 'NO_EDGE',
    };
  }
  
  // ========== THRESHOLD EVALUATION ==========
  const thresholds = getThresholdsForMarket(play.market_type);
  if (!thresholds) {
    return {
      classification: 'PASS',
      pass_reason: 'UNSUPPORTED_MARKET',
    };
  }
  
  const confidence = play.model.confidence ?? 0.5;
  const edge = play.model.edge;
  
  // Apply weak signal adjustment
  let adjustedThreshold = thresholds.base_edge_threshold;
  
  if (confidence < 0.6) {
    adjustedThreshold +=
      thresholds.weak_signal_adjustment ?? 0.015;
  }
  
  // Determine BASE vs LEAN
  const meetsBaseThreshold = edge >= adjustedThreshold;
  const meetsConfidenceFloor = confidence >= (thresholds.confidence_floor ?? 0.55);
  
  if (meetsBaseThreshold && meetsConfidenceFloor) {
    return { classification: 'BASE' };
  }
  
  if (edge > 0 && !play.warning_tags?.includes('HARD_VETO')) {
    return { classification: 'LEAN' };
  }
  
  if (edge > 0) {
    return { classification: 'LEAN' };
  }
  
  return {
    classification: 'PASS',
    pass_reason: 'INSUFFICIENT_DATA',
  };
}

// ============================================================================
// LAYER 2: ACTION (Execution Decision)
// ============================================================================

/**
 * Derive action: What should user do RIGHT NOW?
 * 
 * Rules:
 * 1. classification=PASS → action=PASS (never upgraded)
 * 2. market_available=false → action=HOLD
 * 3. wrapper_blocks=true → action=HOLD
 * 4. Otherwise:
 *    - classification=BASE → FIRE
 *    - classification=LEAN → HOLD
 * 
 * Returns: { action: 'FIRE' | 'HOLD' | 'PASS', why_code: string, why_text: string }
 */
export function deriveAction(classification, marketContext, wrapperContext) {
  const mc = marketContext || {};
  const wc = wrapperContext || {};
  
  // Rule 1: PASS always stays PASS
  if (classification === 'PASS') {
    return {
      action: 'PASS',
      why_code: 'CLASSIFICATION_PASS',
      why_text:
        'Model does not endorse (no edge, hard veto, or insufficient data)',
    };
  }
  
  // Check sport-specific wrappers
  if (wc.enforced_blockers?.length) {
    return {
      action: 'HOLD',
      why_code: 'WRAPPER_BLOCKS',
      why_text: `Execution blocked by: ${wc.enforced_blockers.join(', ')}`,
    };
  }
  
  // Rule 2: Market availability
  const marketAvailable = mc.market_available ?? true;
  if (marketAvailable === false) {
    return {
      action: 'HOLD',
      why_code: 'MARKET_UNAVAILABLE',
      why_text:
        'This market is not currently available at the book',
    };
  }
  
  // Rule 3: Time window
  const timeWindowOk = mc.time_window_ok ?? true;
  if (timeWindowOk === false) {
    return {
      action: 'HOLD',
      why_code: 'TIME_WINDOW_CLOSED',
      why_text:
        'Bet window has closed for this game',
    };
  }
  
  // Rule 4: Classification to action
  if (classification === 'BASE') {
    return {
      action: 'FIRE',
      why_code: 'CLASSIFICATION_BASE',
      why_text:
        'Model strongly endorses (BASE classification)',
    };
  }
  
  if (classification === 'LEAN') {
    return {
      action: 'HOLD',
      why_code: 'CLASSIFICATION_LEAN',
      why_text:
        'Model suggests mild edge (LEAN classification) - watch for confirmation',
    };
  }
  
  return {
    action: 'PASS',
    why_code: 'UNKNOWN',
    why_text:
      'Unknown classification state',
  };
}

// ============================================================================
// UNIFIED DECISION
// ============================================================================

/**
 * Derive full decision: both classification and action
 */
export function derivePlayDecision(play, marketContext, wrapperContext) {
  const classResult = deriveClassification(play);
  const actionResult = deriveAction(
    classResult.classification,
    marketContext,
    wrapperContext
  );
  
  return {
    play: {
      ...play,
      classification: classResult.classification,
      action: actionResult.action,
      pass_reason_code: classResult.pass_reason,
    },
    classification: classResult.classification,
    action: actionResult.action,
    why_code: actionResult.why_code,
    why_text: actionResult.why_text,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check if a market type is supported for a given sport
 */
export function isMarketTypeSupportedForSport(market, sport) {
  const supportedByAll = ['MONEYLINE', 'SPREAD', 'TOTAL', 'PROP'];
  
  if (supportedByAll.includes(market)) {
    return true;
  }
  
  switch (sport) {
    case 'NHL':
      return ['PUCKLINE', 'SOG'].includes(market);
    case 'SOCCER':
      return [
        'DOUBLE_CHANCE',
        'DRAW_NO_BET',
        'TSOA',
        'SHOTS_ON_TARGET',
      ].includes(market);
    default:
      return false;
  }
}

/**
 * Get threshold configuration for a market type
 */
export function getThresholdsForMarket(market) {
  const threshMap = {
    TOTAL: THRESHOLDS.TOTAL,
    SPREAD: THRESHOLDS.SPREAD,
    MONEYLINE: THRESHOLDS.MONEYLINE,
    TEAM_TOTAL: THRESHOLDS.TOTAL,
    PUCKLINE: THRESHOLDS.SPREAD,
    DOUBLE_CHANCE: THRESHOLDS.DOUBLE_CHANCE,
    DRAW_NO_BET: THRESHOLDS.DOUBLE_CHANCE,
    TSOA: THRESHOLDS.TSOA,
    PROP: THRESHOLDS.PROP,
    SOG: THRESHOLDS.PROP,
    SHOTS_ON_TARGET: THRESHOLDS.PROP,
    INFO: undefined,
  };
  
  return threshMap[market];
}

/**
 * Convert classification + action to legacy status for UI migration
 * Deprecated: Only for backward compatibility
 */
export function classificationToLegacyStatus(classification, action) {
  if (classification === 'PASS') {
    return 'PASS';
  }
  
  if (action === 'FIRE') {
    return 'FIRE';
  }
  if (action === 'HOLD') {
    return 'WATCH';
  }
  
  return 'PASS';
}
