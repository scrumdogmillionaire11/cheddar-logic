/**
 * CANONICAL PLAY LOGIC SYSTEM
 *
 * Unified Play type for all sports (NBA | NHL | SOCCER)
 *
 * Key principle: Separate CLASSIFICATION (model truth) from ACTION (execution)
 * - Classification: Is the model endorsing as value? (ignores market/time/availability)
 * - Action: What should user do NOW? (considers market, time, wrappers, availability)
 * - UI filtering: Pure visibility predicates only
 */

import type { Direction } from './game-card';

// ============================================================================
// SPORT TYPE
// ============================================================================

export type Sport = 'NBA' | 'NHL' | 'SOCCER' | 'NCAAM';

// ============================================================================
// MARKET TYPES (Universal across all sports)
// ============================================================================

export type MarketType =
  // Universal
  | 'MONEYLINE'
  | 'SPREAD'
  | 'TOTAL'
  | 'TEAM_TOTAL'
  | 'PROP'
  | 'INFO'
  // NHL specific
  | 'PUCKLINE'
  | 'SOG'
  // SOCCER specific
  | 'DOUBLE_CHANCE'
  | 'DRAW_NO_BET'
  | 'TSOA'
  | 'SHOTS_ON_TARGET';

// ============================================================================
// SELECTION KEYS (by market_type)
// ============================================================================

// MONEYLINE: HOME_WIN, AWAY_WIN, or DRAW (soccer)
export type MoneylineSelection = 'HOME_WIN' | 'AWAY_WIN' | 'DRAW';

// SPREAD: HOME_SPREAD, AWAY_SPREAD
export type SpreadSelection = 'HOME_SPREAD' | 'AWAY_SPREAD';

// TOTAL: OVER, UNDER
export type TotalSelection = 'OVER' | 'UNDER';

// TEAM_TOTAL: HOME/AWAY + OVER/UNDER
export type TeamTotalSelection =
  | 'HOME_TEAM_OVER'
  | 'HOME_TEAM_UNDER'
  | 'AWAY_TEAM_OVER'
  | 'AWAY_TEAM_UNDER';

// DOUBLE_CHANCE (SOCCER): HOME_OR_DRAW, AWAY_OR_DRAW, HOME_OR_AWAY
export type DoubleChanceSelection =
  | 'HOME_OR_DRAW'
  | 'AWAY_OR_DRAW'
  | 'HOME_OR_AWAY';

// DRAW_NO_BET (SOCCER): HOME_DNB, AWAY_DNB
export type DrawNoBetSelection = 'HOME_DNB' | 'AWAY_DNB';

// TSOA (SOCCER): HOME_TSOA, AWAY_TSOA
export type TsoaSelection = 'HOME_TSOA' | 'AWAY_TSOA';

// PROP: PLAYER_OVER, PLAYER_UNDER (requires meta.player_name)
export type PropSelection = 'PLAYER_OVER' | 'PLAYER_UNDER';

// Union of all possible selection keys
export type SelectionKey =
  | MoneylineSelection
  | SpreadSelection
  | TotalSelection
  | TeamTotalSelection
  | DoubleChanceSelection
  | DrawNoBetSelection
  | TsoaSelection
  | PropSelection;

// ============================================================================
// CLASSIFICATION (Model Truth Layer)
// ============================================================================

/**
 * Classification: Is the model endorsing this as positive expected value?
 *
 * Ignores:
 * - Market availability
 * - Current time/book selection
 * - Execution constraints (goalie, injury, etc.)
 *
 * Only considers:
 * - Edge (model prob vs implied prob)
 * - Confidence in the signal
 * - Hard veto flags
 */
export type Classification = 'BASE' | 'LEAN' | 'PASS';

/**
 * BASE: Model strongly endorses as value
 * - edge >= market-specific threshold
 * - confidence >= minimum floor
 * - no hard veto flags
 *
 * LEAN: Model suggests mild edge or moderate confidence
 * - edge positive but below BASE threshold
 * - OR confidence is moderate
 * - no hard veto flags
 *
 * PASS: Model does not endorse
 * - edge <= 0
 * - OR hard veto triggered (bias, inconsistency, missing data, out-of-scope)
 *
 * HARD VETO ALWAYS → PASS (cannot be overridden to LEAN/BASE)
 */

// ============================================================================
// ACTION (Execution Layer)
// ============================================================================

/**
 * Action: What should user do right now?
 *
 * Inputs:
 * - classification
 * - market_available (book has this market)
 * - price_acceptable (book's price is acceptable, optional)
 * - time_window_ok (bet window open, optional)
 * - wrapper_blocks (sport-specific gate, e.g., goalie unconfirmed, out of scope)
 *
 * Rules:
 * 1. classification=PASS → action=PASS (never upgraded)
 * 2. market_available=false → action=HOLD
 * 3. wrapper_blocks=true → action=HOLD
 * 4. Otherwise:
 *    - BASE → FIRE
 *    - LEAN → HOLD
 */
export type Action = 'FIRE' | 'HOLD' | 'PASS';

/**
 * FIRE: Bet now (classification=BASE, market available, no blocks)
 * HOLD: Watch, not ready to act yet (LEAN, or market unavailable, or wrapper blocks)
 * PASS: Do not endorse (classification=PASS)
 */

// ============================================================================
// PASS REASON CODES (Enumerate all reasons for PASS)
// ============================================================================

export type PassReasonCode =
  // Data missing
  | 'PASS_MISSING_KIND'
  | 'NO_EDGE'
  | 'MISSING_REQUIRED_FIELDS'
  | 'MISSING_MARKET_TYPE'
  | 'MISSING_SELECTION'
  | 'MISSING_LINE'
  | 'MISSING_PRICE'
  | 'PASS_NO_MARKET_PRICE'

  // Hard veto (bias/consistency)
  | 'TOTAL_BIAS_CONFLICT'
  | 'CONSISTENCY_FAIL'
  | 'OUT_OF_SCOPE_MARKET'
  | 'UNSUPPORTED_MARKET'
  | 'PASS_TOTAL_INSUFFICIENT_DATA'

  // Model veto
  | 'MODEL_VETO'
  | 'INSUFFICIENT_DATA'

  // Generic
  | 'UNKNOWN_REASON';

// ============================================================================
// MODEL METADATA BLOCK
// ============================================================================

export interface ModelData {
  projection?: number; // Model projection (e.g., total, team total)
  edge?: number; // edge = model_prob - implied_prob (positive = value)
  confidence?: number; // 0–1 or 0–100? Keep consistent
  ev?: number; // Optional: expected value in units (e.g., % or points)
}

// ============================================================================
// SPORT-SPECIFIC METADATA (Kept isolated, never participates in core logic)
// ============================================================================

export interface SportMeta {
  // NBA-specific
  pace_env?: string;
  injury_cloud?: boolean;
  back_to_back?: boolean;
  rest_advantage?: string;

  // NHL-specific
  goalie_status?: 'CONFIRMED' | 'UNCONFIRMED' | 'UNKNOWN';
  starting_goalie?: string;
  travel?: string;
  shot_rate_env?: string;

  // SOCCER-specific
  derby?: boolean;
  rotation_risk?: boolean;
  xg_band?: string;

  // PROP-specific
  player_id?: string;
  player_name?: string;
  prop_type?: string; // PRA, REB, AST, PTS, SOG, POINTS, SOT, SHOTS, etc.
}

// ============================================================================
// CANONICAL PLAY OBJECT
// ============================================================================

/**
 * Universal Play object for all sports.
 * Single source of truth for decision making.
 */
export interface CanonicalPlay {
  // IDENTIFIERS
  play_id: string; // Deterministic hash: game_id + market_type + selection_key + line + price + book
  sport: Sport;
  league?: string;
  game_id: string;
  book?: string;

  // MARKET DEFINITION
  market_type: MarketType;
  selection_key: SelectionKey;
  side?: Direction; // Optional legacy helper: derived once from selection_key
  line?: number;
  price_american?: number;

  // MODEL LAYER
  model: ModelData;

  // CLASSIFICATION (Truth)
  classification: Classification;

  // ACTION (Execution)
  action: Action;

  // GOVERNANCE
  pass_reason_code?: PassReasonCode;
  warning_tags?: string[]; // e.g., ["PRICE_TOO_STEEP", "MARKET_STALE"]
  context_tags?: string[]; // e.g., ["INJURY_CLOUD", "GOALIE_UNCONFIRMED"]

  // SPORT-SPECIFIC PAYLOAD (Isolated, not used in core logic unless explicitly referenced)
  meta?: SportMeta;

  // LIFECYCLE
  created_at: string; // ISO timestamp
  expires_at?: string; // ISO timestamp (optional)

}

// ============================================================================
// THRESHOLD CONFIGURATION (by sport + market_type)
// ============================================================================

/**
 * Thresholds to determine BASE vs LEAN
 * Keep explicit, never bury in scattered code
 */
export const THRESHOLDS = {
  // TOTAL (NBA + NHL)
  TOTAL: {
    base_edge_threshold: 0.02, // 2.0% edge minimum for BASE
    confidence_floor: 0.55, // 55% confidence minimum

    // Adjustments
    weak_signal_adjustment: 0.015, // +1.5% if weak signal
    conflict_adjustment: 0.01, // +1.0% if high conflict
    steep_favorite_adjustment: 0.02, // +2.0% for very steep favorites

    // Hard veto
    veto_on_total_bias: true, // TOTAL_BIAS_CONFLICT → PASS
  },

  // SPREAD (NBA)
  SPREAD: {
    base_points_threshold: 1.5, // 1.5 points edge minimum for BASE
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.5, // +0.5 points
    conflict_adjustment: 0.3, // +0.3 points
  },

  // MONEYLINE (NBA + NHL + SOCCER)
  MONEYLINE: {
    base_edge_threshold: 0.025, // 2.5% edge minimum for BASE
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.015,
    conflict_adjustment: 0.01,
  },

  // SOCCER MARKETS
  DOUBLE_CHANCE: {
    base_edge_threshold: 0.03, // 3.0% (wider markets)
    confidence_floor: 0.55,
  },
  TSOA: {
    base_edge_threshold: 0.035, // 3.5%
    confidence_floor: 0.55,
  },

  // PROP
  PROP: {
    base_edge_threshold: 0.035,
    confidence_floor: 0.55,
  },
};

// ============================================================================
// WRAPPER CONTEXT (Sport-specific execution gates)
// ============================================================================

/**
 * WrapperContext: Sport-specific gates that can block execution without changing classification
 *
 * Example:
 * - NHL: goalie_status !== CONFIRMED → wrapper_blocks = true → action becomes HOLD
 * - SOCCER: mode === RESTRICTED && market not in allowlist → wrapper_blocks = true → action PASS
 */
export interface WrapperContext {
  sport: Sport;
  // NHL
  require_confirmed_goalie?: boolean;
  goalie_status?: 'CONFIRMED' | 'UNCONFIRMED' | 'UNKNOWN';
  // SOCCER
  soccer_scope_mode?: 'FULL' | 'RESTRICTED';
  // Generic
  enforced_blockers?: string[]; // e.g., ["INJURY_CLOUD", "MARKET_STALE"]
}

// ============================================================================
// DECISION OUTPUT
// ============================================================================

/**
 * Output of the decision system: fully determined action + classification + rationale
 */
export interface PlayDecision {
  play: CanonicalPlay;
  classification: Classification;
  action: Action;
  why_code?: string; // Human-readable reason (e.g., "EDGE_FOUND_BASE")
  why_text?: string; // Long-form explanation
}
