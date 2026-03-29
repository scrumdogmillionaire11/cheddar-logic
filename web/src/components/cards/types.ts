'use client';

import type { GameFilters, ViewMode } from '@/lib/game-card/filters';
import type {
  Direction,
  DriverRow,
  DriverTier,
  ExpressionStatus,
  GameCard,
  Market,
  PropGameCard as PropGameCardType,
  PropPlayRow,
  SpreadCompare,
  Sport,
  SupportGrade,
  PassReasonCode,
} from '@/lib/types/game-card';

export type SportCountMap = Record<string, number>;

export type DropReason =
  | 'DROP_SPORT_NOT_ALLOWED'
  | 'DROP_TIME_WINDOW'
  | 'DROP_STALE_ODDS'
  | 'DROP_MARKET_NOT_ALLOWED'
  | 'DROP_NO_BETTABLE_STATUS'
  | 'DROP_DRIVER_STRENGTH'
  | 'DROP_RISK_FILTER'
  | 'DROP_SEARCH'
  | 'DROP_NO_PLAY'
  | 'DROP_PRESET_RULE'
  | 'DROP_UNKNOWN';

export type DropReasonCounts = Record<DropReason, number>;

export type PlayStatusCounts = {
  FIRE: number;
  WATCH: number;
  PASS: number;
};

export type DroppedMeta = {
  games: number;
  playCount: number;
  hasAnyPlay: number;
  hasBettable: number;
  hasBlockedTotals: number;
  hasDataError: number;
  playStatusCounts: PlayStatusCounts;
  playMarkets: Record<string, number>;
};

export type GuardrailTriggeredCounts = {
  edge_sanity_triggered: number;
  proxy_cap_triggered: number;
  proxy_blocked: number;
  high_edge_non_total_blocked: number;
  driver_load_failures: number;
  exact_wager_mismatch: number;
  market_price_missing: number;
};

export type GuardrailOutcomeCounts = {
  fire_to_watch: number;
  watch_to_pass: number;
  fire_to_pass: number;
  bet_removed: number;
};

export type GuardrailBreakdownEntry = {
  triggered: GuardrailTriggeredCounts;
  outcome: GuardrailOutcomeCounts;
};

export type DateCardGroup<T> = { dateKey: string; label: string; cards: T[] };

export interface GameData {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  lifecycle_mode?: 'pregame' | 'active';
  display_status?: 'SCHEDULED' | 'ACTIVE';
  createdAt: string;
  odds: {
    h2hHome: number | null;
    h2hAway: number | null;
    h2hBook: string | null;
    h2hHomeBook: string | null;
    h2hAwayBook: string | null;
    total: number | null;
    totalBook: string | null;
    totalLineOver: number | null;
    totalLineOverBook: string | null;
    totalLineUnder: number | null;
    totalLineUnderBook: string | null;
    spreadHome: number | null;
    spreadAway: number | null;
    spreadHomeBook: string | null;
    spreadAwayBook: string | null;
    spreadPriceHome: number | null;
    spreadPriceHomeBook: string | null;
    spreadPriceAway: number | null;
    spreadPriceAwayBook: string | null;
    totalPriceOver: number | null;
    totalPriceOverBook: string | null;
    totalPriceUnder: number | null;
    totalPriceUnderBook: string | null;
    spreadIsMispriced: boolean | null;
    spreadMispriceType: string | null;
    spreadMispriceStrength: number | null;
    spreadOutlierBook: string | null;
    spreadOutlierDelta: number | null;
    spreadReviewFlag: boolean | null;
    spreadConsensusLine: number | null;
    spreadConsensusConfidence: string | null;
    spreadDispersionStddev: number | null;
    spreadSourceBookCount: number | null;
    totalIsMispriced: boolean | null;
    totalMispriceType: string | null;
    totalMispriceStrength: number | null;
    totalOutlierBook: string | null;
    totalOutlierDelta: number | null;
    totalReviewFlag: boolean | null;
    totalConsensusLine: number | null;
    totalConsensusConfidence: string | null;
    totalDispersionStddev: number | null;
    totalSourceBookCount: number | null;
    h2hConsensusHome: number | null;
    h2hConsensusAway: number | null;
    h2hConsensusConfidence: string | null;
    capturedAt: string | null;
  } | null;
  plays: Array<{
    cardType: string;
    cardTitle: string;
    kind?: 'PLAY' | 'EVIDENCE';
    status?: 'FIRE' | 'WATCH' | 'PASS';
    action?: 'FIRE' | 'HOLD' | 'PASS';
    prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
    confidence: number;
    tier: 'SUPER' | 'BEST' | 'WATCH' | null;
    reasoning: string;
    evPassed: boolean;
    driverKey: string;
    projectedTotal: number | null;
    edge: number | null;
    model_prob?: number | null;
    market_type?:
      | 'MONEYLINE'
      | 'SPREAD'
      | 'TOTAL'
      | 'PUCKLINE'
      | 'TEAM_TOTAL'
      | 'FIRST_PERIOD'
      | 'PROP'
      | 'INFO';
    selection?: { side: string; team?: string };
    line?: number;
    price?: number;
    reason_codes?: string[];
    tags?: string[];
    consistency?: {
      total_bias?:
        | 'OK'
        | 'INSUFFICIENT_DATA'
        | 'CONFLICTING_SIGNALS'
        | 'VOLATILE_ENV'
        | 'UNKNOWN';
    };
    one_p_model_call?:
      | 'BEST_OVER'
      | 'PLAY_OVER'
      | 'LEAN_OVER'
      | 'BEST_UNDER'
      | 'PLAY_UNDER'
      | 'LEAN_UNDER'
      | 'PASS'
      | null;
    one_p_bet_status?: 'FIRE' | 'HOLD' | 'PASS' | null;
    goalie_home_name?: string | null;
    goalie_away_name?: string | null;
    goalie_home_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
    goalie_away_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
    decision_v2?: {
      fair_prob?: number | null;
    };
  }>;
  true_play?: (GameData['plays'][number] & { source_card_id?: string }) | null;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
}

export interface ApiResponse {
  success: boolean;
  data: GameData[];
  error?: string;
}

export type LifecycleMode = 'pregame' | 'active';

export type DecisionPolarity = 'pro' | 'contra' | 'neutral';

export type DecisionContributor = {
  driver: DriverRow;
  polarity: DecisionPolarity;
};

export type DecisionModel = {
  status: 'FIRE' | 'WATCH' | 'PASS';
  primaryPlay: {
    pick: string;
    market: Market | 'NONE';
    status: 'FIRE' | 'WATCH' | 'PASS';
    direction: Direction | null;
    tier: DriverTier | null;
    confidence: number | null;
    source: 'expressionChoice' | 'drivers' | 'none';
  };
  whyReason: string;
  riskCodes: string[];
  topContributors: DecisionContributor[];
  allDrivers: DriverRow[];
  supportGrade: SupportGrade;
  passReasonCode: PassReasonCode | null;
  spreadCompare: SpreadCompare | null;
};

export type SportBuckets = {
  missingMapping: number;
  driverLoadFailed: number;
  noOdds: number;
  noProjection: number;
};

export type SportDiagnosticsMap = Record<string, SportBuckets>;

export type DiagnosticBucket =
  | 'missingMapping'
  | 'driverLoadFailed'
  | 'noOdds'
  | 'noProjection';

export type DiagnosticFilter = {
  sport: string;
  bucket: DiagnosticBucket;
} | null;

export type CardsUiState = {
  viewMode: ViewMode;
  lifecycleMode: LifecycleMode;
  filters: GameFilters;
  diagnosticFilter: DiagnosticFilter;
};

export type CardsUiAction =
  | { type: 'set_filters'; filters: GameFilters }
  | { type: 'reset_filters'; filters: GameFilters }
  | { type: 'set_view_mode'; viewMode: ViewMode; filters: GameFilters }
  | { type: 'set_lifecycle_mode'; lifecycleMode: LifecycleMode }
  | { type: 'set_diagnostic_filter'; diagnosticFilter: DiagnosticFilter };

export type CardsDerivedState = {
  effectiveFilters: GameFilters;
  enrichedCards: GameCard[];
  filteredCards: GameCard[];
  propCards: PropGameCardType[];
  totalCardsInView: number;
  groupedByDate: DateCardGroup<GameCard>[];
  propGroupedByDate: DateCardGroup<PropGameCardType>[];
  projectionItems: Array<{ game: GameData; play: GameData['plays'][number] }>;
  displayedCardsInView: number;
  activeFilterCount: number;
  todayEtKey: string;
  traceStats: {
    fetchedTotal: number;
    transformedTotal: number;
    displayedTotal: number;
    fetchedBySport: SportCountMap;
    transformedBySport: SportCountMap;
    displayedBySport: SportCountMap;
    fetchedTodayBySport: SportCountMap;
    transformedTodayBySport: SportCountMap;
    displayedTodayBySport: SportCountMap;
  };
  guardrailStats: {
    triggered: GuardrailTriggeredCounts;
    outcome: GuardrailOutcomeCounts;
    breakdownBySportMarketBook: Record<string, GuardrailBreakdownEntry>;
  };
  dropTraceStats: {
    droppedByReason: DropReasonCounts;
    droppedByReasonBySport: Record<string, DropReasonCounts>;
    droppedMetaBySport: Record<string, DroppedMeta>;
  };
  sportDiagnostics: SportDiagnosticsMap;
  diagnosticCards: GameCard[];
  hiddenDataErrors: number;
  hiddenDataErrorCards: GameCard[];
};

export type CardsPageState = CardsUiState &
  CardsDerivedState & {
    games: GameData[];
    gameMap: Map<string, GameData>;
    loading: boolean;
    error: string | null;
    diagnosticsEnabled: boolean;
    propsEnabled: boolean;
  };

export type CardsPageActions = {
  onFiltersChange: (filters: GameFilters) => void;
  onResetFilters: () => void;
  onModeChange: (viewMode: ViewMode) => void;
  onLifecycleModeChange: (lifecycleMode: LifecycleMode) => void;
  onDiagnosticFilterChange: (
    diagnosticFilter:
      | DiagnosticFilter
      | ((current: DiagnosticFilter) => DiagnosticFilter),
  ) => void;
};

export type CardsPageContextValue = {
  state: CardsPageState;
  actions: CardsPageActions;
};

export type {
  ExpressionStatus,
  GameCard,
  GameFilters,
  Market,
  PropGameCardType,
  PropPlayRow,
  Sport,
  ViewMode,
};
