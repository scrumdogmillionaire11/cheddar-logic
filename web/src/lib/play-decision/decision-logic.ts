/**
 * CANONICAL DECISION LOGIC
 * 
 * Two layers:
 * 1. deriveClassification() - model truth (ignores market/time/availability)
 * 2. deriveAction() - execution decision (considers market/time/wrappers)
 */

import type {
  CanonicalPlay,
  Classification,
  Action,
  PassReasonCode,
  WrapperContext,
  Sport,
  MarketType,
  PlayDecision,
} from '../types/canonical-play';
import { THRESHOLDS } from '../types/canonical-play';

// ============================================================================
// LAYER 1: CLASSIFICATION (Model Truth)
// ============================================================================

/**
 * Derive classification: Does the model endorse this as positive expected value?
 * 
 * Ignores:
 * - Whether market is available at a book
 * - Time window
 * - Current odds/pricing
 * 
 * Only considers:
 * - edge (model prob vs implied prob)
 * - confidence in the signal
 * - hard veto flags
 * 
 * Output: BASE | LEAN | PASS
 */
export function deriveClassification(play: CanonicalPlay): {
  classification: Classification;
  pass_reason?: PassReasonCode;
} {
  // ========== HARD VETO CHECKS ==========
  // Hard veto ALWAYS results in PASS, cannot be overridden
  
  // Missing required market definition
  if (!play.market_type) {
    return {
      classification: 'PASS',
      pass_reason: 'MISSING_MARKET_TYPE',
    };
  }
  
  if (!play.selection_key) {
    return {
      classification: 'PASS',
      pass_reason: 'MISSING_SELECTION',
    };
  }
  
  // TOTAL_BIAS hard veto
  if (play.market_type === 'TOTAL' && play.warning_tags?.includes('TOTAL_BIAS_CONFLICT')) {
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
  
  // OUT_OF_SCOPE hard veto (e.g., SOCCER market not in allowed list)
  if (play.warning_tags?.includes('OUT_OF_SCOPE_MARKET')) {
    return {
      classification: 'PASS',
      pass_reason: 'OUT_OF_SCOPE_MARKET',
    };
  }
  
  // Unsupported market type for this sport
  if (!isMarketTypeSupportedForSport(play.market_type, play.sport)) {
    return {
      classification: 'PASS',
      pass_reason: 'UNSUPPORTED_MARKET',
    };
  }
  
  // Missing edge (cannot evaluate)
  if (play.model.edge === undefined || play.model.edge === null) {
    return {
      classification: 'PASS',
      pass_reason: 'NO_EDGE',
    };
  }
  
  // No positive edge → automatic PASS
  if (play.model.edge <= 0) {
    return {
      classification: 'PASS',
      pass_reason: 'NO_EDGE',
    };
  }
  
  // ========== THRESHOLD EVALUATION ==========
  // At this point we have edge > 0
  
  const thresholds = getThresholdsForMarket(play.market_type);
  if (!thresholds) {
    return {
      classification: 'PASS',
      pass_reason: 'UNSUPPORTED_MARKET',
    };
  }
  
  const confidence = play.model.confidence ?? 0.5;  // Default to 50% if missing
  const edge = play.model.edge;
  
  // Apply adjustments to threshold
  let adjustedThreshold: number = thresholds.base_edge_threshold ?? 0.02;
  
  // Weak signal adjustment (+1.5% if confidence < 0.6)
  if (confidence < 0.6) {
    adjustedThreshold += thresholds.weak_signal_adjustment ?? 0.015;
  }
  
  // Determine BASE vs LEAN
  const meetsBaseThreshold = edge >= adjustedThreshold;
  const meetsConfidenceFloor = confidence >= (thresholds.confidence_floor ?? 0.55);
  
  if (meetsBaseThreshold && meetsConfidenceFloor) {
    return {
      classification: 'BASE',
    };
  }
  
  if (edge > 0 && !play.warning_tags?.includes('HARD_VETO')) {
    return {
      classification: 'LEAN',
    };
  }
  
  // Positive edge but below threshold and low confidence → LEAN
  if (edge > 0) {
    return {
      classification: 'LEAN',
    };
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
 * Inputs:
 * - classification (from Layer 1)
 * - market_available (book has this market)
 * - price_acceptable (optional: book's price is acceptable)
 * - time_window_ok (optional: bet window open)
 * - wrapper_blocks (sport-specific gate)
 * 
 * Rules:
 * 1. classification=PASS → action=PASS (never upgraded)
 * 2. market_available=false → action=HOLD
 * 3. wrapper_blocks=true → action=HOLD
 * 4. Otherwise:
 *    - classification=BASE → FIRE
 *    - classification=LEAN → HOLD
 * 
 * Returns: FIRE | HOLD | PASS
 */
export function deriveAction(
  classification: Classification,
  marketContext?: {
    market_available?: boolean;
    price_acceptable?: boolean;
    time_window_ok?: boolean;
  },
  wrapperContext?: WrapperContext,
): {
  action: Action;
  why_code: string;
  why_text: string;
} {
  // Rule 1: PASS always stays PASS
  if (classification === 'PASS') {
    return {
      action: 'PASS',
      why_code: 'CLASSIFICATION_PASS',
      why_text: 'Model does not endorse (no edge, hard veto, or insufficient data)',
    };
  }
  
  // Check sport-specific wrappers
  if (wrapperContext?.enforced_blockers?.length) {
    return {
      action: 'HOLD',
      why_code: 'WRAPPER_BLOCKS',
      why_text: `Execution blocked by: ${wrapperContext.enforced_blockers.join(', ')}`,
    };
  }
  
  // Rule 2: Market availability
  const marketAvailable = marketContext?.market_available ?? true;  // Assume available if not specified
  if (marketAvailable === false) {
    return {
      action: 'HOLD',
      why_code: 'MARKET_UNAVAILABLE',
      why_text: 'This market is not currently available at the book',
    };
  }
  
  // Rule 3: Time window
  const timeWindowOk = marketContext?.time_window_ok ?? true;  // Assume OK if not specified
  if (timeWindowOk === false) {
    return {
      action: 'HOLD',
      why_code: 'TIME_WINDOW_CLOSED',
      why_text: 'Bet window has closed for this game',
    };
  }
  
  // Rule 4: Classification to action
  if (classification === 'BASE') {
    return {
      action: 'FIRE',
      why_code: 'CLASSIFICATION_BASE',
      why_text: 'Model strongly endorses (BASE classification)',
    };
  }
  
  if (classification === 'LEAN') {
    return {
      action: 'HOLD',
      why_code: 'CLASSIFICATION_LEAN',
      why_text: 'Model suggests mild edge (LEAN classification) - watch for confirmation',
    };
  }
  
  // Fallback (should not reach)
  return {
    action: 'PASS',
    why_code: 'UNKNOWN',
    why_text: 'Unknown classification state',
  };
}

// ============================================================================
// UNIFIED DECISION: Classification + Action
// ============================================================================

/**
 * Derive full decision: both classification and action
 */
export function derivePlayDecision(
  play: CanonicalPlay,
  marketContext?: {
    market_available?: boolean;
    price_acceptable?: boolean;
    time_window_ok?: boolean;
  },
  wrapperContext?: WrapperContext,
): PlayDecision {
  // Layer 1: Classification (model truth)
  const { classification, pass_reason } = deriveClassification(play);
  
  // Layer 2: Action (execution)
  const { action, why_code, why_text } = deriveAction(classification, marketContext, wrapperContext);
  
  return {
    play: {
      ...play,
      classification,
      action,
      pass_reason_code: pass_reason,
    },
    classification,
    action,
    why_code,
    why_text,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Check if a market type is supported for a given sport
 */
function isMarketTypeSupportedForSport(market: MarketType, sport: Sport): boolean {
  const supportedByAll = ['MONEYLINE', 'SPREAD', 'TOTAL', 'PROP'];
  
  if (supportedByAll.includes(market)) {
    return true;
  }
  
  switch (sport) {
    case 'NHL':
      return ['PUCKLINE', 'SOG'].includes(market);
    case 'SOCCER':
      return ['DOUBLE_CHANCE', 'DRAW_NO_BET', 'TSOA', 'SHOTS_ON_TARGET'].includes(market);
    default:
      return false;
  }
}

/**
 * Get threshold configuration for a market type
 */
function getThresholdsForMarket(market: MarketType) {
  const threshMap: Record<MarketType, { base_edge_threshold?: number; confidence_floor?: number; weak_signal_adjustment?: number; conflict_adjustment?: number } | undefined> = {
    TOTAL: THRESHOLDS.TOTAL,
    SPREAD: THRESHOLDS.SPREAD,
    MONEYLINE: THRESHOLDS.MONEYLINE,
    TEAM_TOTAL: THRESHOLDS.TOTAL,  // Use TOTAL thresholds
    PUCKLINE: THRESHOLDS.SPREAD,   // Use SPREAD thresholds
    DOUBLE_CHANCE: THRESHOLDS.DOUBLE_CHANCE,
    DRAW_NO_BET: THRESHOLDS.DOUBLE_CHANCE,  // Similar
    TSOA: THRESHOLDS.TSOA,
    PROP: THRESHOLDS.PROP,
    SOG: THRESHOLDS.PROP,
    SHOTS_ON_TARGET: THRESHOLDS.PROP,
    INFO: undefined,  // INFO is not a betting market
  };
  
  return threshMap[market];
}

/**
 * Convert classification + action to legacy status for UI migration
 * Deprecated: Only for backward compatibility
 */
export function classificationToLegacyStatus(
  classification: Classification,
  action: Action,
): 'FIRE' | 'WATCH' | 'PASS' {
  // PASS classification always → PASS status
  if (classification === 'PASS') {
    return 'PASS';
  }
  
  // Otherwise, use action
  if (action === 'FIRE') {
    return 'FIRE';
  }
  if (action === 'HOLD') {
    return 'WATCH';
  }
  
  return 'PASS';
}
