/**
 * Normalized game card types for filtering
 * Based on FILTER-FEATURE.md design
 */

export type Sport = 'NHL' | 'NBA' | 'NCAAM' | 'SOCCER' | 'UNKNOWN';
export type Market = 'TOTAL' | 'SPREAD' | 'ML' | 'RISK' | 'UNKNOWN';
export type DriverTier = 'BEST' | 'SUPER' | 'WATCH';
export type Direction = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
export type ExpressionStatus = 'FIRE' | 'WATCH' | 'PASS';
export type TruthStatus = 'STRONG' | 'MEDIUM' | 'WEAK';
export type ValueStatus = 'GOOD' | 'OK' | 'BAD';
export type BetAction = 'BET' | 'NO_PLAY';
export type PriceFlag = 'PRICE_TOO_STEEP' | 'COINFLIP' | 'CHASED_LINE' | 'VIG_HEAVY';

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
}

/**
 * Market odds structure
 */
export interface GameMarkets {
  ml?: { home: number; away: number };
  spread?: { home: number; away: number };
  total?: { line: number; over?: number; under?: number };
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
 * Canonical play decision
 */
export interface Play {
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
  tags: string[]; // derived for fast filtering
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
} as const;

export type GameTag = typeof GAME_TAGS[keyof typeof GAME_TAGS];
