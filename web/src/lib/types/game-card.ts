/**
 * Normalized game card types for filtering
 * Based on FILTER-FEATURE.md design
 *
 * CANONICAL MARKET TYPES (used throughout system, never guessed)
 * MONEYLINE, SPREAD, TOTAL, PUCKLINE, TEAM_TOTAL, FIRST_PERIOD, PROP, INFO
 */

export type Sport =
  | 'NHL'
  | 'NBA'
  | 'NCAAM'
  | 'SOCCER'
  | 'MLB'
  | 'NFL'
  | 'UNKNOWN';

// CANONICAL market types — authoritative, not inferred
export type CanonicalMarketType =
  | 'MONEYLINE'
  | 'SPREAD'
  | 'TOTAL'
  | 'PUCKLINE'
  | 'TEAM_TOTAL'
  | 'FIRST_PERIOD'
  | 'FIRST_5_INNINGS'
  | 'PROP'
  | 'INFO';

// Legacy market types for UI compatibility
export type Market = 'TOTAL' | 'SPREAD' | 'ML' | 'RISK' | 'UNKNOWN';

export type DriverTier = 'BEST' | 'SUPER' | 'WATCH' | 'GOOD' | 'OK' | 'BAD';
export type Direction = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';

/** Role classification for driver gating logic */
export type DriverRole = 'PRIMARY' | 'CONTEXT' | 'RISK';

/** Consensus grade derived from weighted support vs contra scores */
export type SupportGrade = 'STRONG' | 'MIXED' | 'WEAK';
export type SelectionSide =
  | 'OVER'
  | 'UNDER'
  | 'HOME'
  | 'AWAY'
  | 'FAV'
  | 'DOG'
  | 'NONE';

export type ExpressionStatus = 'FIRE' | 'WATCH' | 'PASS';
export type ActionStatus = 'BASE' | 'LEAN' | 'PASS' | 'FIRE_NOW' | 'HOLD'; // NHL totals: FIRE_NOW | HOLD

export type TruthStatus = 'STRONG' | 'MEDIUM' | 'WEAK';
export type ValueStatus = 'GOOD' | 'OK' | 'BAD';
export type BetAction = 'BET' | 'NO_PLAY';
export type PriceFlag =
  | 'PRICE_TOO_STEEP'
  | 'COINFLIP'
  | 'CHASED_LINE'
  | 'VIG_HEAVY';
export type DecisionLabel = 'FIRE' | 'WATCH' | 'PASS';
export type DecisionClassification = 'PLAY' | 'LEAN' | 'NONE';

// Reason codes for PASS status: deterministic blockers
export type PassReasonCode =
  | 'PASS_MISSING_KIND'
  | 'PASS_MISSING_MARKET_TYPE'
  | 'PASS_MISSING_EDGE'
  | 'PASS_MISSING_LINE'
  | 'PASS_MISSING_SELECTION'
  | 'PASS_MISSING_PRICE'
  | 'PASS_NO_MARKET_PRICE'
  | 'PASS_TOTAL_INSUFFICIENT_DATA'
  | 'PASS_NO_QUALIFIED_PLAYS'
  | 'PASS_DRIVER_LOAD_FAILED'
  | 'PASS_MISSING_DRIVER_INPUTS'
  | 'PASS_NO_PRIMARY_SUPPORT'
  | 'PASS_MARKET_PRICE_MISSING'
  | 'PASS_DATA_ERROR'
  | 'PASS_DRIVER_SUPPORT_WEAK'
  | 'PASS_DRIVER_CONFLICT'
  | 'PASS_LONGSHOT_GUARD'
  | 'INSUFFICIENT_DATA'
  | 'MARKET_STALE_EDGE'
  | 'PRICE_TOO_STEEP'
  | 'MISSING_PRICE_EDGE'
  | 'NO_VALUE_AT_PRICE'
  | 'NO_DECISION'
  | 'KEY_NUMBER_FRAGILITY_TOTAL'
  | 'EDGE_FOUND_TOTAL'
  | 'REST_EDGE_SIDE'
  | 'WELCOME_HOME_FADE'
  | 'MATCHUP_EDGE_SIDE'
  | 'EDGE_FOUND_SIDE'
  | 'EDGE_FOUND'
  // Consensus-gated pass reasons (from driver-scoring framework)
  | 'PASS_NO_EDGE'
  | 'PASS_MISSING_PRIMARY_DRIVER'
  | 'PASS_CONFLICT_HIGH'
  | 'PASS_BLOCKED_STALE'
  // Missing-data taxonomy (distinct from no-edge outcomes)
  | 'MISSING_DATA_NO_PLAYS'
  | 'MISSING_DATA_DRIVERS'
  | 'MISSING_DATA_NO_ODDS'
  | 'MISSING_DATA_TEAM_MAPPING'
  | 'MISSING_DATA_PROJECTION_INPUTS';

/**
 * Spread line comparison — projected vs market line for spread cards
 */
export interface SpreadCompare {
  direction: Direction;           // HOME or AWAY — which side's perspective
  marketLine: number | null;      // Market spread for the chosen side (e.g., -9.5)
  projectedSpread: number | null; // Model projection if parseable from driver note; null otherwise
}

export type RiskTag =
  | 'RISK_BLOWOUT'
  | 'RISK_FRAGILITY'
  | 'RISK_KEY_NUMBER'
  | 'RISK_STALE';

/**
 * Canonical selection (bet side/direction)
 */
export interface Selection {
  side: SelectionSide;
  team?: string; // optional team name or identifier
}

/**
 * Canonical model metadata
 */
export interface ModelMetadata {
  projection?: number; // e.g., model total
  edge?: number; // model - market
  confidence?: number; // 0..1
  sigma?: number; // optional
}

export interface CanonicalGate {
  code: string;
  severity: 'INFO' | 'WARN' | 'BLOCK';
  blocks_bet: boolean;
}

export type BetMarketType =
  | 'moneyline'
  | 'spread'
  | 'total'
  | 'team_total'
  | 'player_prop';
export type BetSide = 'home' | 'away' | 'over' | 'under';

export interface CanonicalBet {
  market_type: BetMarketType;
  side: BetSide;
  team?: 'home' | 'away';
  line?: number;
  odds_american: number;
  book?: string;
  as_of_iso: string;
}

export interface DecisionData {
  status: DecisionLabel;
  truth: TruthStatus;
  value_tier: ValueStatus;
  edge_pct: number | null;
  edge_tier: 'BEST' | 'GOOD' | 'OK' | 'BAD';
  coinflip: boolean;
  reason_code: string;
}

export interface DecisionV2MissingData {
  missing_fields: string[];
  source_attempts: Array<{
    field: string;
    source: string;
    result: 'FOUND' | 'MISSING' | 'ERROR';
    note?: string;
  }>;
  severity: 'INFO' | 'WARNING' | 'BLOCKING';
}

export interface DecisionV2 {
  direction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NONE';
  support_score: number;
  conflict_score: number;
  drivers_used: string[];
  driver_reasons: string[];

  watchdog_status: 'OK' | 'CAUTION' | 'BLOCKED';
  watchdog_reason_codes: string[];
  missing_data: DecisionV2MissingData;

  consistency: {
    pace_tier: string;
    event_env: string;
    event_direction_tag: string;
    vol_env: string;
    total_bias: string;
  };

  market_type?: CanonicalMarketType | null;
  market_line?: number | null;
  market_price?: number | null;

  fair_prob: number | null;
  implied_prob: number | null;
  edge_pct: number | null;
  edge_delta_pct?: number | null;
  edge_method?: 'ML_PROB' | 'MARGIN_DELTA' | 'TOTAL_DELTA' | 'TEAM_TOTAL_DELTA' | 'ONE_PERIOD_DELTA' | null;
  edge_line_delta?: number | null;
  edge_lean?: 'OVER' | 'UNDER' | null;
  proxy_used?: boolean;
  proxy_capped?: boolean;
  exact_wager_valid?: boolean;
  pricing_trace?: {
    market_type?: CanonicalMarketType | string | null;
    market_side?: SelectionSide | string | null;
    market_line?: number | null;
    market_price?: number | null;
    line_source?: string | null;
    price_source?: string | null;
  };

  sharp_price_status: 'CHEDDAR' | 'COTTAGE' | 'UNPRICED' | 'PENDING_VERIFICATION';
  price_reason_codes: string[];

  official_status: 'PLAY' | 'LEAN' | 'PASS';
  play_tier: 'BEST' | 'GOOD' | 'OK' | 'BAD';
  primary_reason_code: string;

  pipeline_version: 'v2';
  decided_at: string;

  canonical_envelope_v2?: {
    official_status?: 'PLAY' | 'LEAN' | 'PASS';
    terminal_reason_family?: string;
    primary_reason_code?: string;
    reason_codes?: string[];
    is_actionable?: boolean;
    execution_status?: 'EXECUTABLE' | 'PROJECTION_ONLY' | 'BLOCKED';
    publish_ready?: boolean;
  };
}

export interface FinalMarketDecision {
  surfaced_status: 'PLAY' | 'SLIGHT EDGE' | 'PASS';
  surfaced_reason: string;
  model_strength: 'BEST' | 'GOOD' | 'WATCH' | null;
  model_edge_pct: number | null;
  fair_price: string | null;
  verification_state: 'VERIFIED' | 'PENDING';
  certainty_state: 'CONFIRMED' | 'PARTIAL' | 'UNCONFIRMED';
  market_verification_status: 'VERIFIED' | 'UNVERIFIED';
  projection_input_status: 'COMPLETE' | 'INCOMPLETE' | 'STALE_FALLBACK';
  market_stable: boolean;
  line_verified: boolean;
  show_model_context: boolean;
}

export type CardQuality = 'OK' | 'DEGRADED' | 'BROKEN';

export type ProjectionSource =
  | 'FULL_MODEL'
  | 'DEGRADED_MODEL'
  | 'SYNTHETIC_FALLBACK';
export type StatusCap = 'PLAY' | 'LEAN' | 'PASS';

export interface PlayabilityBand {
  over_playable_at_or_below?: number | null;
  under_playable_at_or_above?: number | null;
}

export interface PitcherKProbabilityLadder {
  p_5_plus?: number | null;
  p_6_plus?: number | null;
  p_7_plus?: number | null;
}

export interface PitcherKFairPricePair {
  over?: number | null;
  under?: number | null;
}

export interface PitcherKFairPrices {
  k_5_plus?: PitcherKFairPricePair | null;
  k_6_plus?: PitcherKFairPricePair | null;
  k_7_plus?: PitcherKFairPricePair | null;
}

export interface TransformMeta {
  quality: CardQuality;
  missing_inputs: string[];
  placeholders_found: string[];
  drop_reason?: { drop_reason_code: string; drop_reason_layer: string } | null;
}

/**
 * Canonical API Play — all fields required at emission, validates present during transform
 */
export interface CanonicalApiPlay {
  // Authoritative market classification
  market_type: CanonicalMarketType; // MONEYLINE, SPREAD, TOTAL, INFO, PUCKLINE, etc.

  // Selection (what we're betting on)
  selection: Selection;

  // Market data
  line?: number; // spread/total/team total line
  price?: number; // American odds
  book?: string; // sportsbook identifier

  // Model data
  model: ModelMetadata;

  // Deterministic messaging
  tags?: string[]; // e.g. ["RISK_BLOWOUT", "ACCELERANT_SCORE"]
  reason_codes?: (PassReasonCode | string)[]; // e.g. ["PASS_MISSING_EDGE", "PASS_DATA_ERROR"]

  // Repair metadata (if API applied inference)
  repair_applied?: boolean;
  repair_rule_id?: string;

  // Legacy fields (for backward compat, but not authoritative)
  cardTitle?: string;
  prediction?: Direction;
  confidence?: number;
  tier?: DriverTier | null;
  reasoning?: string;
  evPassed?: boolean;
  driverKey?: string;
  cardType?: string;
}

/**
 * FT trend context as it appears in API play payloads (snake_case)
 * Single canonical definition — imported by route.ts, transform.ts, cards-page-client.tsx
 */
export interface FtTrendContext {
  home_ft_pct: number | null;
  away_ft_pct: number | null;
  total_line: number | null;
  advantaged_side: 'HOME' | 'AWAY' | null;
}

/**
 * FT trend context as used in DriverRow (camelCase display form)
 */
export interface FtTrendContextDisplay {
  homeFtPct: number | null;
  awayFtPct: number | null;
  totalLine: number | null;
  advantagedSide: 'HOME' | 'AWAY' | null;
}

/**
 * Normalized driver row with stable key and deduped data
 */
export interface DriverRow {
  key: string; // stable: e.g. "nhl_total_fragility"
  market: Market;
  tier: DriverTier;
  direction: Direction;
  confidence?: number;
  signal?: number;
  note: string;
  cardType: string;
  cardTitle: string;
  ftTrendContext?: FtTrendContextDisplay;
  /** Driver role assigned at transform time from DRIVER_ROLES registry */
  role?: DriverRole;
}

/**
 * Market odds structure
 */
export interface GameMarkets {
  ml?: { home: number; away: number };
  spread?: { home: number; away: number };
  total?: { line: number; over?: number; under?: number };
}

export interface EvidenceItem {
  id: string;
  cardType: string;
  cardTitle: string;
  reasoning: string;
  driverKey: string;
  selection?: Selection;
  aggregation_key?: string;
  evidence_for_play_id?: string;
}

/**
 * Expression choice (orchestration result)
 */
export interface ExpressionChoice {
  chosenMarket: Market;
  status: ExpressionStatus;
  score: number;
  edge?: number;
  pick: string;
}

/**
 * Canonical play decision — merges legacy and canonical fields
 *
 * CANONICAL FIELDS (preferred if present):
 *  - market_type (MONEYLINE, SPREAD, TOTAL, etc.)
 *  - selection (explicit side + optional team)
 *  - reason_codes (deterministic blockers)
 *  - tags (risk tags, inference markers, etc.)
 *
 * LEGACY COMPAT FIELDS (historical rows only; non-authoritative):
 *  - market (legacy: ML, SPREAD, TOTAL, RISK, UNKNOWN)
 *  - side (legacy direction)
 *
 * Migration note:
 *  - New code must derive filtering/visibility from canonical fields
 *    (`market_type`, `selection`, `action`, `classification`, `decision_v2`).
 *  - Legacy fields remain for historical row rendering only.
 */
export interface Play {
  // Canonical contract fields for display/reducer invariants
  market_key?: string;
  decision?: DecisionLabel;
  classificationLabel?: DecisionClassification;
  bet?: CanonicalBet | null;
  gates?: CanonicalGate[];
  decision_data?: DecisionData;
  transform_meta?: TransformMeta;
  /** Source card type (e.g. 'nhl-pace-1p', 'mlb-f5'). Present on all transformed plays. */
  cardType?: string;
  /** Pipeline execution status token. 'PROJECTION_ONLY' means no odds backing. */
  execution_status?: 'EXECUTABLE' | 'PROJECTION_ONLY' | 'BLOCKED';

  // Canonical fields (preferred)
  market_type?: CanonicalMarketType;
  selection?: Selection;
  reason_codes?: (PassReasonCode | string)[];
  tags?: (RiskTag | string)[];
  reason_source?: 'canonical' | 'NON_CANONICAL_RENDER_FALLBACK' | string;
  kind?: 'PLAY' | 'EVIDENCE';
  evidence_count?: number;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };

  // Canonical decision fields (new)
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
  decision_v2?: DecisionV2;
  final_market_decision?: FinalMarketDecision;

  // Legacy compatibility fields (historical rows only)
  status: ExpressionStatus;
  market: Market | 'NONE';
  pick: string;
  lean: string;
  side: Direction | null;
  truthStatus: TruthStatus;
  truthStrength: number;
  conflict: number;
  modelProb?: number;
  impliedProb?: number;
  edge?: number;
  edgePoints?: number;
  edgeVsConsensusPts?: number;
  edgeVsBestAvailablePts?: number;
  executionAlphaPts?: number;
  playableEdge?: boolean;
  projectedMargin?: number;
  projectedTotal?: number;
  projectedTotalLow?: number;
  projectedTotalHigh?: number;
  projectedHomeF5Runs?: number;
  projectedAwayF5Runs?: number;
  projectionSource?: ProjectionSource;
  statusCap?: StatusCap | null;
  playability?: PlayabilityBand | null;
  projectedTeamTotal?: number;
  projectedGoalDiff?: number;
  projectedScoreHome?: number;
  projectedScoreAway?: number;
  lineSource?: string;
  priceSource?: string;
  valueStatus: ValueStatus;
  betAction: BetAction;
  priceFlags: PriceFlag[];
  line?: number;
  price?: number;
  updatedAt: string;
  whyCode: string;
  whyText: string;
}

/**
 * Market condition signals derived from public splits + consensus data.
 * Populated during transform from odds snapshot; null fields gracefully render no pills.
 */
export interface MarketSignalData {
  publicBetsPctHome: number | null;
  publicBetsPctAway: number | null;
  publicHandlePctHome: number | null;
  publicHandlePctAway: number | null;
  splitsSource: string | null;
  /** Included here so deriveMarketSignals stays a pure card→pills function. */
  spreadConsensusConfidence: string | null;
}

/**
 * Normalized game card with derived tags for filtering
 */
export interface GameCard {
  id: string;
  gameId: string;
  sport: Sport;
  league?: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO
  updatedAt: string; // ISO (odds captured_at or created_at)
  status: string; // 'scheduled', 'in_progress', etc.
  markets: GameMarkets;
  play?: Play;
  expressionChoice?: ExpressionChoice;
  drivers: DriverRow[];
  evidence?: EvidenceItem[];
  tags: string[]; // derived for fast filtering
  /** Market signal pills source data. Absent when splits are not yet populated (WI-0666/0667). */
  marketSignals?: MarketSignalData;
}

/**
 * Player Props specific types - separate from game lines
 */
export interface PropPlayRow {
  // core IDs
  runId?: string;
  createdAt?: string;
  playerId: string; // player identifier from API/model
  playerName: string; // display name (not raw ID)
  teamAbbr?: string;
  gameId?: string;
  propType: string; // SOG, Points, Assists, etc.
  line: number | null;
  projection: number | null;
  mu?: number | null;
  kMean?: number | null;
  probabilityLadder?: PitcherKProbabilityLadder | null;
  fairPrices?: PitcherKFairPrices | null;
  suggestedLine?: number | null;
  threshold?: number | null;
  confidence: number | null; // 0-1 (convert to 0-100 for display)
  price: number | null;
  status: 'FIRE' | 'WATCH' | 'HOLD' | 'NO_PLAY';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  edge: number | null;
  isTrending?: boolean;
  roleGatePass?: boolean;
  dataQuality?: string | null;
  reasonCodes?: string[];
  missingInputs?: string[];
  projectionSource?: ProjectionSource | null;
  statusCap?: StatusCap | null;
  playability?: PlayabilityBand | null;
  passReasonCode?: string | null;
  passReason?: string | null;
  basis?: 'PROJECTION_ONLY' | 'ODDS_BACKED';
  l5Sog?: number[];
  l5Mean?: number | null;

  // metadata
  sourceCardType: string;
  sourceCardTitle: string;
  updatedAtUtc: string;
  reasoning?: string;
  /** Canonical props verdict for NHL SOG cards. */
  propVerdict?: 'PLAY' | 'WATCH' | 'NO_PLAY' | 'PROJECTION';
  /** Canonical lean side selected from the better-priced prop side. */
  leanSide?: 'OVER' | 'UNDER' | null;
  /** Price associated with the displayed lean side. */
  displayPrice?: number | null;
  /** Projection delta expressed in the lean direction. */
  lineDelta?: number | null;
  /** Fair probability for the displayed lean side. */
  fairProb?: number | null;
  /** Implied probability for the displayed lean side. */
  impliedProb?: number | null;
  /** Probability edge for the displayed lean side (fair - implied). */
  probEdgePp?: number | null;
  /** EV for the displayed lean side. */
  ev?: number | null;
  /** Recency signal label for the displayed projection. */
  l5Trend?: 'uptrend' | 'downtrend' | 'stable' | null;
  /** Deterministic reason string for the displayed props verdict. */
  propWhy?: string;
  /** Canonical prop-decision flags for UI display/debug. */
  propFlags?: string[];
  /** WI-0529: Three-state display decision from model job. Absent on legacy rows. */
  propDisplayState?: 'PLAY' | 'WATCH' | 'PROJECTION_ONLY';
  /** The sportsbook O/U line being priced (e.g. 2.5). Null if projection-only. */
  marketLine?: number | null;
  /** American odds for the OVER side from sportsbook. Null if no real line. */
  priceOver?: number | null;
  /** American odds for the UNDER side from sportsbook. Null if no real line. */
  priceUnder?: number | null;
  /** Sportsbook the line/price was sourced from. Null if synthetic/unknown. */
  bookmaker?: string | null;
}

export interface PropGameCard {
  gameId: string;
  sport: Sport;
  gameTimeUtc: string;
  homeTeam: string;
  awayTeam: string;
  status: string;

  // optional game context
  oddsUpdatedUtc?: string;
  moneyline?: { home: number; away: number };
  total?: { line: number };

  // ALL prop plays for this game
  propPlays: PropPlayRow[];

  // for filtering/sorting
  maxConfidence: number;
  tags: string[];
}

/**
 * Tags that can be derived from a GameCard for fast filtering
 */
export const GAME_TAGS = {
  // Actionability
  HAS_FIRE: 'has_fire',
  HAS_WATCH: 'has_watch',
  HAS_PASS: 'has_pass',

  // Market picks
  HAS_SIDE_PICK: 'has_side_pick',
  HAS_TOTAL_PICK: 'has_total_pick',
  HAS_ML_PICK: 'has_ml_pick',

  // Driver strength
  HAS_BEST_DRIVER: 'has_best_driver',
  HAS_SUPER_DRIVER: 'has_super_driver',
  HAS_WATCH_DRIVER: 'has_watch_driver',

  // Risk flags
  HAS_RISK_FRAGILITY: 'has_risk_fragility',
  HAS_RISK_BLOWOUT: 'has_risk_blowout',
  HAS_RISK_KEY_NUMBER: 'has_risk_key_number',
  HAS_LOW_COVERAGE: 'has_low_coverage',

  // Odds freshness
  UPDATED_WITHIN_60S: 'updated_within_60s',
  UPDATED_WITHIN_5M: 'updated_within_5m',
  STALE_5M: 'stale_5m',
  STALE_30M: 'stale_30m',

  // ML odds patterns
  COINFLIP_ML: 'coinflip_ml',

  // Time windows
  STARTS_WITHIN_2H: 'starts_within_2h',
  STARTS_TODAY: 'starts_today',

  // Data quality
  HAS_DRIVER_CONTRADICTION: 'has_driver_contradiction',
  NO_ODDS: 'no_odds',
  UNKNOWN_SPORT: 'unknown_sport',

  // Driver consensus / support grade
  SUPPORT_STRONG: 'support_strong',
  SUPPORT_MIXED:  'support_mixed',
  SUPPORT_WEAK:   'support_weak',

  // Situational signals
  WELCOME_HOME_FADE: 'welcome_home_fade',
} as const;

export type GameTag = (typeof GAME_TAGS)[keyof typeof GAME_TAGS];
