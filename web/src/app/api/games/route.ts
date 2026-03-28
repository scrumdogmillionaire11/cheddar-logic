/**
 * GET /api/games
 *
 * Canonical pregame/active read surface for game cards in the current worker+DB architecture.
 * Returns all upcoming games from the odds API, joined with the latest
 * odds snapshot per game, plus any active driver play calls from card_payloads.
 * Games with no card_payloads still appear.
 *
 * Historical route families (`/api/models/*`, `/api/betting/projections`, `/api/soccer/slate`)
 * are deprecated references only and are not active runtime contracts.
 *
 * Query window:
 *   - Production default: midnight today America/New_York -> now + API_GAMES_HORIZON_HOURS (default 36h)
 *   - Dev override (optional): include recent past games via lookback window
 * Sort: game_time_utc ASC
 * Limit: 200
 *
 * Response:
 * {
 *   success: boolean,
 *   data: Array<{
 *     id: string,
 *     gameId: string,
 *     sport: string,
 *     homeTeam: string,
 *     awayTeam: string,
 *     gameTimeUtc: string,
 *     status: string,
 *     createdAt: string,
 *     odds: {
 *       h2hHome: number | null,
 *       h2hAway: number | null,
 *       h2hHomeBook: string | null,
 *       h2hAwayBook: string | null,
 *       total: number | null,
 *       totalLineOver: number | null,
 *       totalLineOverBook: string | null,
 *       totalLineUnder: number | null,
 *       totalLineUnderBook: string | null,
 *       spreadHome: number | null,
 *       spreadAway: number | null,
 *       spreadHomeBook: string | null,
 *       spreadAwayBook: string | null,
 *       spreadPriceHome: number | null,
 *       spreadPriceHomeBook: string | null,
 *       spreadPriceAway: number | null,
 *       spreadPriceAwayBook: string | null,
 *       totalPriceOver: number | null,
 *       totalPriceOverBook: string | null,
 *       totalPriceUnder: number | null,
 *       totalPriceUnderBook: string | null,
 *       spreadIsMispriced: boolean | null,
 *       spreadMispriceType: string | null,
 *       spreadMispriceStrength: number | null,
 *       spreadOutlierBook: string | null,
 *       spreadOutlierDelta: number | null,
 *       spreadReviewFlag: boolean | null,
 *       spreadConsensusLine: number | null,
 *       spreadConsensusConfidence: string | null,
 *       spreadDispersionStddev: number | null,
 *       spreadSourceBookCount: number | null,
 *       totalConsensusLine: number | null,
 *       totalConsensusConfidence: string | null,
 *       totalDispersionStddev: number | null,
 *       totalSourceBookCount: number | null,
 *       totalIsMispriced: boolean | null,
 *       totalMispriceType: string | null,
 *       totalMispriceStrength: number | null,
 *       totalOutlierBook: string | null,
 *       totalOutlierDelta: number | null,
 *       totalReviewFlag: boolean | null,
 *       h2hConsensusHome: number | null,
 *       h2hConsensusAway: number | null,
 *       h2hConsensusConfidence: string | null,
 *       capturedAt: string | null,
 *     } | null,
 *     true_play: Play | null,
 *     plays: Play[],
 *   }>,
 *   error?: string,
 * }
 */

import { NextResponse, NextRequest } from 'next/server';
import {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
  requireEntitlementForRequest,
  RESOURCE,
} from '../../../lib/api-security';
import type { ExpressionStatus, CanonicalMarketType, FtTrendContext } from '@/lib/types/game-card';
import type { PlayDisplayAction } from '@/lib/game-card/decision';

const ENABLE_WELCOME_HOME =
  process.env.ENABLE_WELCOME_HOME === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

const ENABLE_DEV_PAST_GAMES =
  process.env.ENABLE_DEV_PAST_GAMES === 'true' ||
  process.env.CHEDDAR_DEV_INCLUDE_PAST_GAMES === 'true';

const DEV_GAMES_LOOKBACK_HOURS = Number.parseInt(
  process.env.DEV_GAMES_LOOKBACK_HOURS ||
    process.env.CHEDDAR_DEV_GAMES_LOOKBACK_HOURS ||
    '24',
  10,
);

const API_GAMES_MAX_CARD_ROWS = Math.max(
  100,
  Number.parseInt(process.env.API_GAMES_MAX_CARD_ROWS || '1500', 10) || 1500,
);
const RAW_API_GAMES_HORIZON_HOURS = Number.parseInt(
  process.env.API_GAMES_HORIZON_HOURS || '36',
  10,
);
const API_GAMES_HORIZON_HOURS = Number.isFinite(RAW_API_GAMES_HORIZON_HOURS)
  ? RAW_API_GAMES_HORIZON_HOURS
  : 36;
const HAS_API_GAMES_HORIZON = API_GAMES_HORIZON_HOURS > 0;
const API_GAMES_INGEST_FAILURE_LOOKBACK_HOURS = 12;
const TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD = 0.5;

interface GameRow {
  id: string;
  game_id: string;
  sport: string;
  home_team: string;
  away_team: string;
  game_time_utc: string;
  status: string;
  created_at: string;
  h2h_home: number | null;
  h2h_away: number | null;
  h2h_book: string | null;
  h2h_home_book: string | null;
  h2h_away_book: string | null;
  total: number | null;
  total_book: string | null;
  total_line_over: number | null;
  total_line_over_book: string | null;
  total_line_under: number | null;
  total_line_under_book: string | null;
  spread_home: number | null;
  spread_away: number | null;
  spread_home_book: string | null;
  spread_away_book: string | null;
  spread_price_home: number | null;
  spread_price_home_book: string | null;
  spread_price_away: number | null;
  spread_price_away_book: string | null;
  total_price_over: number | null;
  total_price_over_book: string | null;
  total_price_under: number | null;
  total_price_under_book: string | null;
  spread_is_mispriced: number | null;
  spread_misprice_type: string | null;
  spread_misprice_strength: number | null;
  spread_outlier_book: string | null;
  spread_outlier_delta: number | null;
  spread_review_flag: number | null;
  spread_consensus_line: number | null;
  spread_consensus_confidence: string | null;
  spread_dispersion_stddev: number | null;
  spread_source_book_count: number | null;
  total_is_mispriced: number | null;
  total_misprice_type: string | null;
  total_misprice_strength: number | null;
  total_outlier_book: string | null;
  total_outlier_delta: number | null;
  total_review_flag: number | null;
  total_consensus_line: number | null;
  total_consensus_confidence: string | null;
  total_dispersion_stddev: number | null;
  total_source_book_count: number | null;
  h2h_consensus_home: number | null;
  h2h_consensus_away: number | null;
  h2h_consensus_confidence: string | null;
  odds_captured_at: string | null;
  projection_inputs_complete: boolean | null;
  projection_missing_inputs: string[];
  source_mapping_ok: boolean | null;
  source_mapping_failures: string[];
  ingest_failure_reason_code: string | null;
  ingest_failure_reason_detail: string | null;
}

type LifecycleMode = 'pregame' | 'active';
type DisplayStatus = 'SCHEDULED' | 'ACTIVE';

const ACTIVE_EXCLUDED_STATUSES = [
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'FINAL',
  'CLOSED',
  'COMPLETE',
  'COMPLETED',
  'FT',
];
const CORE_RUN_STATE_SPORTS = [
  'nba',
  'nhl',
  'ncaam',
  'soccer',
  'mlb',
  'nfl',
  'fpl',
  'nhl_props',
] as const;
const CORE_RUN_STATE_SPORT_SQL = CORE_RUN_STATE_SPORTS.map(
  (sport) => `'${sport}'`,
).join(', ');
const FINAL_GAME_RESULT_STATUSES = ['FINAL', 'FT', 'COMPLETE', 'COMPLETED', 'CLOSED'];

function toSqlUtc(date: Date): string {
  return date.toISOString().substring(0, 19).replace('T', ' ');
}

function getTableColumnNames(
  db: ReturnType<typeof getDatabaseReadOnly>,
  tableName: string,
): Set<string> {
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    return new Set(
      rows
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function buildOptionalOddsSelect(
  availableColumns: Set<string>,
  columnName: string,
): string {
  return availableColumns.has(columnName)
    ? `o.${columnName}`
    : `NULL AS ${columnName}`;
}

function resolveLifecycleMode(searchParams: URLSearchParams): LifecycleMode {
  const lifecycleParam = (searchParams.get('lifecycle') || '').toLowerCase();
  if (lifecycleParam === 'active') return 'active';
  return 'pregame';
}

function resolveSportFilter(searchParams: URLSearchParams): string | null {
  const normalized = normalizeSport(searchParams.get('sport'));
  if (!normalized || normalized === 'ALL') return null;
  return normalized;
}

function deriveDisplayStatus(lifecycleMode: LifecycleMode): DisplayStatus {
  return lifecycleMode === 'active' ? 'ACTIVE' : 'SCHEDULED';
}

interface CardPayloadRow {
  id: string;
  game_id: string;
  card_type: string;
  card_title: string;
  payload_data: string;
}

interface DisplayLogRow {
  id: number;
  pick_id: string;
  game_id: string;
  displayed_at: string;
}

interface Play {
  source_card_id?: string;
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
  projectedTotal: number | null;
  edge: number | null;
  edge_points?: number | null;
  edge_vs_consensus_pts?: number | null;
  edge_vs_best_available_pts?: number | null;
  execution_alpha_pts?: number | null;
  playable_edge?: boolean | null;
  odds_context?: Record<string, unknown> | null;
  p_fair?: number | null;
  p_implied?: number | null;
  edge_pct?: number | null;
  edge_delta_pct?: number | null;
  model_prob?: number | null;
  projection?: {
    margin_home?: number | null;
    total?: number | null;
    team_total?: number | null;
    win_prob_home?: number | null;
    score_home?: number | null;
    score_away?: number | null;
    projected_margin?: number | null;
    projected_total?: number | null;
    projected_team_total?: number | null;
    projected_score_home?: number | null;
    projected_score_away?: number | null;
  };
  status?: ExpressionStatus;
  kind?: 'PLAY' | 'EVIDENCE';
  canonical_market_key?: string;
  market_type?: CanonicalMarketType;
  selection?: { side: string; team?: string };
  line?: number;
  price?: number;
  ft_trend_context?: FtTrendContext;
  line_source?: string | null;
  price_source?: string | null;
  market_context?: {
    version?: string;
    market_type?: string | null;
    selection_side?: string | null;
    selection_team?: string | null;
    projection?: {
      margin_home?: number | null;
      total?: number | null;
      team_total?: number | null;
      win_prob_home?: number | null;
      score_home?: number | null;
      score_away?: number | null;
    };
    wager?: {
      called_line?: number | null;
      called_price?: number | null;
      line_source?: string | null;
      price_source?: string | null;
      period?: string | null;
    };
  };
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
  projection_inputs_complete?: boolean | null;
  missing_inputs?: string[];
  source_mapping_ok?: boolean | null;
  source_mapping_failures?: string[];
  ingest_failure_reason_code?: string | null;
  ingest_failure_reason_detail?: string | null;
  // Canonical decision fields
  // NOTE: 'BASE' | 'LEAN' | 'PASS' is the API-wire classification shape.
  // game-card.ts DecisionClassification uses 'PLAY' | 'LEAN' | 'NONE' (different).
  // Intentionally kept as local literal until contracts are reconciled (WI-0408 follow-up).
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: PlayDisplayAction;
  pass_reason_code?: string | null;
  one_p_model_call?:
    | 'BEST_OVER'
    | 'PLAY_OVER'
    | 'LEAN_OVER'
    | 'BEST_UNDER'
    | 'PLAY_UNDER'
    | 'LEAN_UNDER'
    | 'PASS'
    | null;
  one_p_bet_status?: PlayDisplayAction | null;
  goalie_home_name?: string | null;
  goalie_away_name?: string | null;
  goalie_home_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  goalie_away_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  decision_v2?: {
    direction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NONE';
    support_score: number;
    conflict_score: number;
    drivers_used: string[];
    driver_reasons: string[];
    watchdog_status: 'OK' | 'CAUTION' | 'BLOCKED';
    watchdog_reason_codes: string[];
    missing_data: {
      missing_fields: string[];
      source_attempts: Array<{
        field: string;
        source: string;
        result: 'FOUND' | 'MISSING' | 'ERROR';
        note?: string;
      }>;
      severity: 'INFO' | 'WARNING' | 'BLOCKING';
    };
    consistency: {
      pace_tier: string;
      event_env: string;
      event_direction_tag: string;
      vol_env: string;
      total_bias: string;
    };
    fair_prob: number | null;
    implied_prob: number | null;
    edge_pct: number | null;
    edge_delta_pct?: number | null;
    edge_method?:
      | 'ML_PROB'
      | 'MARGIN_DELTA'
      | 'TOTAL_DELTA'
      | 'ONE_PERIOD_DELTA'
      | null;
    edge_line_delta?: number | null;
    edge_lean?: 'OVER' | 'UNDER' | null;
    proxy_used?: boolean;
    proxy_capped?: boolean;
    exact_wager_valid?: boolean;
    pricing_trace?: {
      market_type?: string | null;
      market_side?: string | null;
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
  };
  // Prop-specific fields
  run_id?: string;
  created_at?: string;
  player_id?: string;
  player_name?: string;
  team_abbr?: string;
  game_id?: string;
  mu?: number | null;
  suggested_line?: number | null;
  threshold?: number | null;
  is_trending?: boolean;
  role_gate_pass?: boolean;
  data_quality?: string | null;
  l5_sog?: number[] | null;
  l5_mean?: number | null;
  market_price_over?: number | null;
  market_price_under?: number | null;
  market_bookmaker?: string | null;
  prop_decision?: {
    verdict: 'PLAY' | 'WATCH' | 'NO_PLAY' | 'PROJECTION';
    lean_side: 'OVER' | 'UNDER' | null;
    line: number | null;
    display_price: number | null;
    projection: number | null;
    line_delta: number | null;
    fair_prob: number | null;
    implied_prob: number | null;
    prob_edge_pp: number | null;
    ev: number | null;
    l5_mean: number | null;
    l5_trend: 'uptrend' | 'downtrend' | 'stable' | null;
    why: string;
    flags: string[];
  };
}

interface IngestFailureRow {
  game_id: string;
  reason_code: string;
  reason_detail: string | null;
  last_seen: string;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assessProjectionInputsFromRawData(
  sport: string,
  rawData: unknown,
): { projection_inputs_complete: boolean | null; projection_missing_inputs: string[] } {
  const raw = parseJsonObject(rawData);
  if (!raw) {
    return {
      projection_inputs_complete: null,
      projection_missing_inputs: [],
    };
  }

  const normalizedSport = String(sport || '').toUpperCase();
  const missingInputs: string[] = [];
  const espnMetrics = parseJsonObject(raw.espn_metrics);
  const homeEspnMetrics = parseJsonObject(espnMetrics?.home)?.metrics;
  const awayEspnMetrics = parseJsonObject(espnMetrics?.away)?.metrics;
  const homeMetrics = parseJsonObject(homeEspnMetrics);
  const awayMetrics = parseJsonObject(awayEspnMetrics);
  const homeRaw = parseJsonObject(raw.home);
  const awayRaw = parseJsonObject(raw.away);

  if (normalizedSport === 'NBA' || normalizedSport === 'NCAAM') {
    const homeAvgPoints =
      homeMetrics?.avgPoints ??
      raw.avg_points_home ??
      homeRaw?.avg_points;
    const awayAvgPoints =
      awayMetrics?.avgPoints ??
      raw.avg_points_away ??
      awayRaw?.avg_points;
    const homeAvgPointsAllowed =
      homeMetrics?.avgPointsAllowed ??
      raw.avg_points_allowed_home ??
      homeRaw?.avg_points_allowed;
    const awayAvgPointsAllowed =
      awayMetrics?.avgPointsAllowed ??
      raw.avg_points_allowed_away ??
      awayRaw?.avg_points_allowed;

    if (toFiniteNumber(homeAvgPoints) === null) missingInputs.push('home_avg_points');
    if (toFiniteNumber(awayAvgPoints) === null) missingInputs.push('away_avg_points');
    if (toFiniteNumber(homeAvgPointsAllowed) === null) {
      missingInputs.push('home_avg_points_allowed');
    }
    if (toFiniteNumber(awayAvgPointsAllowed) === null) {
      missingInputs.push('away_avg_points_allowed');
    }
  } else if (normalizedSport === 'NHL') {
    const homeGoalsFor =
      homeMetrics?.avgGoalsFor ??
      raw.avg_goals_for_home ??
      homeRaw?.avg_goals_for;
    const awayGoalsFor =
      awayMetrics?.avgGoalsFor ??
      raw.avg_goals_for_away ??
      awayRaw?.avg_goals_for;
    const homeGoalsAgainst =
      homeMetrics?.avgGoalsAgainst ??
      raw.avg_goals_against_home ??
      homeRaw?.avg_goals_against;
    const awayGoalsAgainst =
      awayMetrics?.avgGoalsAgainst ??
      raw.avg_goals_against_away ??
      awayRaw?.avg_goals_against;

    if (toFiniteNumber(homeGoalsFor) === null) missingInputs.push('home_avg_goals_for');
    if (toFiniteNumber(awayGoalsFor) === null) missingInputs.push('away_avg_goals_for');
    if (toFiniteNumber(homeGoalsAgainst) === null) {
      missingInputs.push('home_avg_goals_against');
    }
    if (toFiniteNumber(awayGoalsAgainst) === null) {
      missingInputs.push('away_avg_goals_against');
    }
  }

  return {
    projection_inputs_complete: missingInputs.length === 0,
    projection_missing_inputs: missingInputs,
  };
}

function deriveSourceMappingHealth(rawData: unknown): {
  source_mapping_ok: boolean | null;
  source_mapping_failures: string[];
} {
  const raw = parseJsonObject(rawData);
  const sourceContract = raw?.espn_metrics &&
    typeof raw.espn_metrics === 'object' &&
    (raw.espn_metrics as Record<string, unknown>).source_contract &&
    typeof (raw.espn_metrics as Record<string, unknown>).source_contract === 'object'
      ? ((raw.espn_metrics as Record<string, unknown>).source_contract as Record<string, unknown>)
      : null;

  return {
    source_mapping_ok:
      typeof sourceContract?.mapping_ok === 'boolean'
        ? (sourceContract.mapping_ok as boolean)
        : null,
    source_mapping_failures: Array.isArray(sourceContract?.mapping_failures)
      ? sourceContract.mapping_failures.map((item) => String(item))
      : [],
  };
}

type MarketType = NonNullable<Play['market_type']>;
type DecisionV2 = NonNullable<Play['decision_v2']>;
type StageCounterStage =
  | 'base_games'
  | 'card_rows'
  | 'parsed_rows'
  | 'wave1_skipped_no_d2'
  | 'plays_emitted'
  | 'games_with_plays';
type StageCounterBucket = Record<string, number>;
type StageCounterBySport = Record<string, StageCounterBucket>;
type StageCounters = Record<StageCounterStage, StageCounterBySport>;

const WAVE1_SPORTS = new Set(['NBA', 'NHL', 'NCAAM']);
const WAVE1_MARKETS = new Set<MarketType>([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
  'FIRST_PERIOD',
  'PROP',
]);
const COUNTER_ALL_MARKET = 'ALL';
const UNKNOWN_SPORT = 'UNKNOWN';
const SOCCER_AH_CANONICAL_KEYS = new Set([
  'asian_handicap_home',
  'asian_handicap_away',
]);
const SOCCER_AH_REMAP_TOKEN = 'MARKET_REMAP_AH_FROM_PROP';

type SportCardTypeContract = {
  playProducerCardTypes: Set<string>;
  evidenceOnlyCardTypes: Set<string>;
  expectedPlayableMarkets: Set<MarketType>;
};

const ACTIVE_SPORT_CARD_TYPE_CONTRACT: Record<string, SportCardTypeContract> = {
  NBA: {
    playProducerCardTypes: new Set([
      'nba-totals-call',
      'nba-spread-call',
      'nba-moneyline-call',
    ]),
    evidenceOnlyCardTypes: new Set([
      'nba-base-projection',
      'nba-total-projection',
      'nba-rest-advantage',
      'nba-matchup-style',
      'nba-blowout-risk',
      'nba-travel',
      'nba-lineup',
      'welcome-home-v2',
      // Legacy evidence alias retained for compatibility with historical rows.
      'nba-model-output',
    ]),
    expectedPlayableMarkets: new Set<MarketType>(['SPREAD', 'TOTAL']),
  },
  NHL: {
    playProducerCardTypes: new Set([
      'nhl-totals-call',
      'nhl-spread-call',
      'nhl-moneyline-call',
      'nhl-pace-totals',
      'nhl-pace-1p',
      'nhl-player-shots',
      'nhl-player-shots-1p',
    ]),
    evidenceOnlyCardTypes: new Set([
      'nhl-base-projection',
      'nhl-rest-advantage',
      'nhl-goalie',
      'nhl-goalie-certainty',
      'nhl-model-output',
      'nhl-shot-environment',
      'welcome-home-v2',
      // Legacy welcome-home alias retained for compatibility with historical rows.
      'nhl-welcome-home',
    ]),
    expectedPlayableMarkets: new Set<MarketType>([
      'MONEYLINE',
      'SPREAD',
      'TOTAL',
      'FIRST_PERIOD',
      'PROP',
    ]),
  },
  NCAAM: {
    playProducerCardTypes: new Set([
      'ncaam-base-projection',
      'ncaam-rest-advantage',
      'ncaam-ft-trend',
    ]),
    evidenceOnlyCardTypes: new Set(['ncaam-matchup-style']),
    expectedPlayableMarkets: new Set<MarketType>(['MONEYLINE', 'SPREAD']),
  },
  MLB: {
    playProducerCardTypes: new Set(['mlb-strikeout', 'mlb-f5', 'mlb-pitcher-k']),
    evidenceOnlyCardTypes: new Set(['mlb-model-output']),
    expectedPlayableMarkets: new Set<MarketType>(['PROP', 'FIRST_PERIOD']),
  },
};

function createStageCounters(): StageCounters {
  return {
    base_games: {},
    card_rows: {},
    parsed_rows: {},
    wave1_skipped_no_d2: {},
    plays_emitted: {},
    games_with_plays: {},
  };
}

function normalizeCounterSport(value: unknown): string {
  const sport = normalizeSport(value);
  return sport ?? UNKNOWN_SPORT;
}

function normalizeCounterMarket(value: unknown): string {
  const market = normalizeMarketType(value);
  return market ?? COUNTER_ALL_MARKET;
}

function incrementStageCounter(
  counters: StageCounters,
  stage: StageCounterStage,
  sport: unknown,
  market: unknown = COUNTER_ALL_MARKET,
  amount = 1,
): void {
  const normalizedSport = normalizeCounterSport(sport);
  const normalizedMarket =
    typeof market === 'string' &&
    market.trim().toUpperCase() === COUNTER_ALL_MARKET
      ? COUNTER_ALL_MARKET
      : normalizeCounterMarket(market);
  if (!counters[stage][normalizedSport]) {
    counters[stage][normalizedSport] = {};
  }
  counters[stage][normalizedSport][normalizedMarket] =
    (counters[stage][normalizedSport][normalizedMarket] ?? 0) + amount;
}

function bumpCount(store: Map<string, number>, key: string, amount = 1): void {
  store.set(key, (store.get(key) ?? 0) + amount);
}

function registerGameWithPlayableMarket(
  store: Map<string, Map<string, Set<string>>>,
  sport: unknown,
  market: unknown,
  gameId: string,
): void {
  const normalizedSport = normalizeCounterSport(sport);
  const normalizedMarket = normalizeCounterMarket(market);
  if (!store.has(normalizedSport)) {
    store.set(normalizedSport, new Map());
  }
  const marketMap = store.get(normalizedSport)!;
  if (!marketMap.has(normalizedMarket)) {
    marketMap.set(normalizedMarket, new Set());
  }
  marketMap.get(normalizedMarket)!.add(gameId);
}

function inferMarketFromCardType(cardType: string): MarketType | undefined {
  const normalized = cardType.trim().toLowerCase();
  if (normalized.includes('1p') || normalized.includes('first-period')) {
    return 'FIRST_PERIOD';
  }
  if (
    normalized.includes('double_chance') ||
    normalized.includes('double-chance')
  ) {
    return 'MONEYLINE';
  }
  if (normalized.includes('moneyline') || normalized.includes('-ml-')) {
    return 'MONEYLINE';
  }
  if (
    normalized.includes('spread') ||
    normalized.includes('puckline') ||
    normalized.includes('puck-line')
  ) {
    return 'SPREAD';
  }
  if (normalized.includes('total')) {
    return 'TOTAL';
  }
  if (
    normalized.includes('player-shots') ||
    normalized.includes('player_shots') ||
    normalized === 'mlb-strikeout' ||
    normalized === 'mlb-pitcher-k'
  ) {
    return 'PROP';
  }
  if (normalized === 'mlb-f5') {
    return 'FIRST_PERIOD';
  }
  return undefined;
}

function applyCardTypeKindContract(
  sport: unknown,
  cardType: string,
  fallbackKind: Play['kind'] | undefined,
): {
  kind: Play['kind'];
  downgradedOutOfContractPlay: boolean;
} {
  const normalizedSport = normalizeSport(sport);
  const normalizedCardType = cardType.trim().toLowerCase();
  const contract = normalizedSport
    ? ACTIVE_SPORT_CARD_TYPE_CONTRACT[normalizedSport]
    : undefined;
  const inferredKind = fallbackKind ?? 'PLAY';
  if (!contract) {
    return { kind: inferredKind, downgradedOutOfContractPlay: false };
  }
  if (contract.evidenceOnlyCardTypes.has(normalizedCardType)) {
    return { kind: 'EVIDENCE', downgradedOutOfContractPlay: false };
  }
  if (
    inferredKind === 'PLAY' &&
    !contract.playProducerCardTypes.has(normalizedCardType)
  ) {
    return { kind: 'EVIDENCE', downgradedOutOfContractPlay: true };
  }
  return { kind: inferredKind, downgradedOutOfContractPlay: false };
}

function isFirstPeriodCardType(cardType: string): boolean {
  const normalized = cardType.trim().toLowerCase();
  return normalized.includes('1p') || normalized.includes('first-period');
}

function isCanonicalTotalsCallPlay(play: Play): boolean {
  if (play.kind !== 'PLAY') return false;
  if (play.market_type !== 'TOTAL') return false;
  if (typeof play.projectedTotal !== 'number') return false;
  const normalizedCardType = String(play.cardType || '').toLowerCase();
  if (isFirstPeriodCardType(normalizedCardType)) return false;
  return normalizedCardType.includes('totals-call');
}

function isFallbackEvidenceTotalProjectionPlay(play: Play): boolean {
  if (play.kind !== 'EVIDENCE') return false;
  if (typeof play.projectedTotal !== 'number') return false;
  const normalizedCardType = String(play.cardType || '').toLowerCase();
  if (isFirstPeriodCardType(normalizedCardType)) return false;
  return normalizedCardType.includes('total-projection');
}

function emitTotalProjectionDriftWarnings(
  games: Array<{ gameId: string; sport: string; plays: Play[] }>,
): void {
  if (process.env.NODE_ENV === 'test') return;
  for (const game of games) {
    const canonicalPlay = game.plays.find(isCanonicalTotalsCallPlay);
    const fallbackPlay = game.plays.find(isFallbackEvidenceTotalProjectionPlay);
    if (!canonicalPlay || !fallbackPlay) continue;

    const canonicalProjectedTotal = canonicalPlay.projectedTotal as number;
    const fallbackProjectedTotal = fallbackPlay.projectedTotal as number;
    const delta = Math.abs(canonicalProjectedTotal - fallbackProjectedTotal);
    if (delta <= TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD) continue;

    console.warn('[API] /api/games total projection drift warning', {
      game_id: game.gameId,
      sport: game.sport,
      threshold: TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD,
      delta: Number(delta.toFixed(2)),
      canonical: {
        card_type: canonicalPlay.cardType,
        projected_total: canonicalProjectedTotal,
      },
      fallback: {
        card_type: fallbackPlay.cardType,
        projected_total: fallbackProjectedTotal,
      },
    });
  }
}

function buildPlayableMarketFamilyDiagnostics(counters: StageCounters): {
  expected_playable_markets: Record<string, MarketType[]>;
  emitted_playable_markets: Record<string, string[]>;
  missing_playable_markets: Record<string, string[]>;
} {
  const expected: Record<string, MarketType[]> = {};
  const emitted: Record<string, string[]> = {};
  const missing: Record<string, string[]> = {};

  for (const [sport, contract] of Object.entries(
    ACTIVE_SPORT_CARD_TYPE_CONTRACT,
  )) {
    expected[sport] = Array.from(contract.expectedPlayableMarkets).sort();
    const emittedMarkets = Object.entries(counters.plays_emitted[sport] ?? {})
      .filter(
        ([market, count]) =>
          market !== COUNTER_ALL_MARKET &&
          typeof count === 'number' &&
          count > 0,
      )
      .map(([market]) => market)
      .sort();
    emitted[sport] = emittedMarkets;
    const emittedSet = new Set(emittedMarkets);
    missing[sport] = Array.from(contract.expectedPlayableMarkets)
      .filter((market) => !emittedSet.has(market))
      .sort();
  }

  return {
    expected_playable_markets: expected,
    emitted_playable_markets: emitted,
    missing_playable_markets: missing,
  };
}

function hasMinimumViability(play: Play, marketType: MarketType): boolean {
  const side = play.selection?.side;
  const hasPrice =
    typeof play.price === 'number' && Number.isFinite(play.price);
  const isMoneylineFamilySide =
    side === 'HOME' ||
    side === 'AWAY' ||
    side === 'HOME_OR_DRAW' ||
    side === 'AWAY_OR_DRAW' ||
    side === 'HOME_OR_AWAY' ||
    side === 'HOME_DNB' ||
    side === 'AWAY_DNB';
  if (marketType === 'TOTAL') {
    // Price is sourced from odds snapshot at display time — only require side + line.
    return (
      (side === 'OVER' || side === 'UNDER') && typeof play.line === 'number'
    );
  }
  if (marketType === 'SPREAD') {
    return (
      (side === 'HOME' || side === 'AWAY') &&
      typeof play.line === 'number' &&
      hasPrice
    );
  }
  if (marketType === 'MONEYLINE') {
    return isMoneylineFamilySide && hasPrice;
  }
  return true;
}

function normalizeMarketType(value: unknown): Play['market_type'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();

  if (
    upper === 'MONEYLINE' ||
    upper === 'SPREAD' ||
    upper === 'TOTAL' ||
    upper === 'PUCKLINE' ||
    upper === 'TEAM_TOTAL' ||
    upper === 'FIRST_PERIOD' ||
    upper === 'PROP' ||
    upper === 'INFO'
  ) {
    return upper as Play['market_type'];
  }

  if (upper === 'PUCK_LINE') return 'PUCKLINE';
  if (upper === 'GAME_TOTAL') return 'TOTAL';
  if (upper === 'TEAMTOTAL') return 'TEAM_TOTAL';
  if (upper === 'FIRSTPERIOD') return 'FIRST_PERIOD';
  if (upper === 'DOUBLE_CHANCE' || upper === 'DOUBLECHANCE') {
    return 'MONEYLINE';
  }
  if (upper === 'DRAW_NO_BET' || upper === 'DRAWNOBET') {
    return 'MONEYLINE';
  }
  if (upper === 'ASIAN_HANDICAP') return 'SPREAD';
  return undefined;
}

function normalizeKeyToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isSoccerAsianHandicapPayload(params: {
  rowSport: unknown;
  cardType: string;
  payload: Record<string, unknown>;
  payloadPlay: Record<string, unknown> | null;
  payloadMarketContext: Record<string, unknown> | null;
}): boolean {
  const {
    rowSport,
    cardType,
    payload,
    payloadPlay,
    payloadMarketContext,
  } = params;

  const normalizedSport = normalizeSport(
    firstString(payload.sport, payloadPlay?.sport) ?? rowSport,
  );
  if (normalizedSport !== 'SOCCER') return false;

  const canonicalMarketKey = normalizeKeyToken(
    firstString(
      payload.canonical_market_key,
      payloadPlay?.canonical_market_key,
      payloadMarketContext?.canonical_market_key,
    ),
  );
  if (SOCCER_AH_CANONICAL_KEYS.has(canonicalMarketKey)) return true;

  const marketTypeToken = normalizeKeyToken(
    firstString(payload.market_type, payloadPlay?.market_type),
  );
  if (marketTypeToken.includes('asian_handicap')) return true;

  const marketKeyToken = normalizeKeyToken(
    firstString(payload.market_key, payloadPlay?.market_key),
  );
  if (marketKeyToken.includes('asian_handicap')) return true;

  const cardTypeToken = normalizeKeyToken(cardType);
  return cardTypeToken.includes('asian_handicap');
}

function normalizeTier(value: unknown): Play['tier'] {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'SUPER') return 'SUPER';
  if (upper === 'BEST' || upper === 'HOT') return 'BEST';
  if (upper === 'WATCH') return 'WATCH';
  return null;
}

function normalizeAction(value: unknown): Play['action'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'FIRE' || upper === 'HOLD' || upper === 'PASS') {
    return upper as Play['action'];
  }
  if (upper === 'WATCH') return 'HOLD';
  return undefined;
}

function normalizeStatus(value: unknown): Play['status'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'FIRE' || upper === 'WATCH' || upper === 'PASS') {
    return upper as Play['status'];
  }
  if (upper === 'HOLD') return 'WATCH';
  return undefined;
}

function normalizeClassification(
  value: unknown,
): Play['classification'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'BASE' || upper === 'LEAN' || upper === 'PASS') {
    return upper as Play['classification'];
  }
  return undefined;
}

function actionFromClassification(
  classification?: Play['classification'],
): Play['action'] | undefined {
  if (classification === 'BASE') return 'FIRE';
  if (classification === 'LEAN') return 'HOLD';
  if (classification === 'PASS') return 'PASS';
  return undefined;
}

function classificationFromAction(
  action?: Play['action'],
): Play['classification'] | undefined {
  if (action === 'FIRE') return 'BASE';
  if (action === 'HOLD') return 'LEAN';
  if (action === 'PASS') return 'PASS';
  return undefined;
}

function deriveNhl1PModelCall(
  reasonCodes: string[],
  prediction?: Play['prediction'],
): Play['one_p_model_call'] {
  if (reasonCodes.includes('NHL_1P_OVER_BEST')) return 'BEST_OVER';
  if (reasonCodes.includes('NHL_1P_OVER_PLAY')) return 'PLAY_OVER';
  if (reasonCodes.includes('NHL_1P_OVER_LEAN')) return 'LEAN_OVER';
  if (reasonCodes.includes('NHL_1P_UNDER_BEST')) return 'BEST_UNDER';
  if (reasonCodes.includes('NHL_1P_UNDER_PLAY')) return 'PLAY_UNDER';
  if (reasonCodes.includes('NHL_1P_UNDER_LEAN')) return 'LEAN_UNDER';
  if (reasonCodes.includes('NHL_1P_PASS_DEAD_ZONE')) return 'PASS';
  if (prediction === 'OVER') return 'LEAN_OVER';
  if (prediction === 'UNDER') return 'LEAN_UNDER';
  return null;
}

function statusFromAction(action?: Play['action']): Play['status'] | undefined {
  if (action === 'FIRE') return 'FIRE';
  if (action === 'HOLD') return 'WATCH';
  if (action === 'PASS') return 'PASS';
  return undefined;
}

function actionFromTier(tier?: Play['tier']): Play['action'] | undefined {
  if (tier === 'BEST' || tier === 'SUPER') return 'FIRE';
  if (tier === 'WATCH') return 'HOLD';
  return undefined;
}

function normalizeSelectionSide(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER' ||
    upper === 'FAV' ||
    upper === 'DOG' ||
    upper === 'NONE' ||
    upper === 'NEUTRAL' ||
    upper === 'HOME_OR_DRAW' ||
    upper === 'AWAY_OR_DRAW' ||
    upper === 'HOME_OR_AWAY' ||
    upper === 'HOME_DNB' ||
    upper === 'AWAY_DNB'
  ) {
    return upper;
  }
  return undefined;
}

function normalizePrediction(value: unknown): Play['prediction'] | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER' ||
    upper === 'NEUTRAL'
  ) {
    return upper as Play['prediction'];
  }
  if (upper.includes(' OVER ')) return 'OVER';
  if (upper.includes(' UNDER ')) return 'UNDER';
  return undefined;
}

function normalizeGoalieStatus(
  value: unknown,
): 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | undefined {
  // Status semantics:
  // CONFIRMED = official game-day roster (locked in)
  // EXPECTED = projected/likely but not yet confirmed (subject to change)
  // UNKNOWN = uncertain or unconfirmed
  //
  // Both CONFIRMED and EXPECTED must reach the UI so it can display
  // appropriate certainty levels. DO NOT collapse either to UNKNOWN.
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'CONFIRMED') return 'CONFIRMED';
  if (upper === 'EXPECTED') return 'EXPECTED';
  if (upper === 'UNKNOWN') return 'UNKNOWN';
  return undefined;
}

function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function resolveDecisionV2EdgePct(
  value: { edge_delta_pct?: unknown; edge_pct?: unknown } | null | undefined,
): number | undefined {
  if (!value) return undefined;
  return firstNumber(value.edge_delta_pct, value.edge_pct);
}

function normalizeSport(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  return upper || undefined;
}

function isWave1EligibleRow(
  sport: unknown,
  kind: Play['kind'] | undefined,
  marketType: Play['market_type'] | undefined,
): boolean {
  const normalizedSport = normalizeSport(sport);
  if (!normalizedSport || !WAVE1_SPORTS.has(normalizedSport)) return false;
  if ((kind ?? 'PLAY') !== 'PLAY') return false;
  if (!marketType) return false;
  return WAVE1_MARKETS.has(marketType);
}

function normalizeDecisionV2(value: unknown): Play['decision_v2'] | undefined {
  const input = toObject(value);
  if (!input) return undefined;

  const officialStatusRaw =
    typeof input.official_status === 'string'
      ? input.official_status.toUpperCase()
      : '';
  const official_status =
    officialStatusRaw === 'PLAY' ||
    officialStatusRaw === 'LEAN' ||
    officialStatusRaw === 'PASS'
      ? (officialStatusRaw as DecisionV2['official_status'])
      : null;
  if (!official_status) return undefined;

  const directionRaw =
    typeof input.direction === 'string' ? input.direction.toUpperCase() : '';
  const direction =
    directionRaw === 'HOME' ||
    directionRaw === 'AWAY' ||
    directionRaw === 'OVER' ||
    directionRaw === 'UNDER' ||
    directionRaw === 'NONE'
      ? (directionRaw as DecisionV2['direction'])
      : 'NONE';

  const watchdogStatusRaw =
    typeof input.watchdog_status === 'string'
      ? input.watchdog_status.toUpperCase()
      : '';
  const watchdog_status =
    watchdogStatusRaw === 'OK' ||
    watchdogStatusRaw === 'CAUTION' ||
    watchdogStatusRaw === 'BLOCKED'
      ? (watchdogStatusRaw as DecisionV2['watchdog_status'])
      : 'BLOCKED';

  const sharpStatusRaw =
    typeof input.sharp_price_status === 'string'
      ? input.sharp_price_status.toUpperCase()
      : '';
  const sharp_price_status =
    sharpStatusRaw === 'CHEDDAR' ||
    sharpStatusRaw === 'COTTAGE' ||
    sharpStatusRaw === 'PENDING_VERIFICATION' ||
    sharpStatusRaw === 'UNPRICED'
      ? (sharpStatusRaw as DecisionV2['sharp_price_status'])
      : 'UNPRICED';

  const playTierRaw =
    typeof input.play_tier === 'string' ? input.play_tier.toUpperCase() : '';
  const play_tier =
    playTierRaw === 'BEST' ||
    playTierRaw === 'GOOD' ||
    playTierRaw === 'OK' ||
    playTierRaw === 'BAD'
      ? (playTierRaw as DecisionV2['play_tier'])
      : 'BAD';

  const missingDataObject = toObject(input.missing_data);
  const consistencyObject = toObject(input.consistency);
  // Allow missing_data to be absent (it's optional), but consistency is required
  if (!consistencyObject) return undefined;

  return {
    direction,
    support_score: firstNumber(input.support_score, 0) ?? 0,
    conflict_score: firstNumber(input.conflict_score, 0) ?? 0,
    drivers_used: Array.isArray(input.drivers_used)
      ? input.drivers_used.map((item) => String(item))
      : [],
    driver_reasons: Array.isArray(input.driver_reasons)
      ? input.driver_reasons.map((item) => String(item))
      : [],
    watchdog_status,
    watchdog_reason_codes: Array.isArray(input.watchdog_reason_codes)
      ? input.watchdog_reason_codes.map((item) => String(item))
      : [],
    missing_data: {
      missing_fields: Array.isArray(missingDataObject?.missing_fields)
        ? missingDataObject.missing_fields.map((item) => String(item))
        : [],
      source_attempts: Array.isArray(missingDataObject?.source_attempts)
        ? missingDataObject.source_attempts
            .map((attempt) => toObject(attempt))
            .filter((attempt): attempt is Record<string, unknown> =>
              Boolean(attempt),
            )
            .map((attempt) => {
              const resultRaw =
                typeof attempt.result === 'string'
                  ? attempt.result.toUpperCase()
                  : 'ERROR';
              const result =
                resultRaw === 'FOUND' ||
                resultRaw === 'MISSING' ||
                resultRaw === 'ERROR'
                  ? (resultRaw as 'FOUND' | 'MISSING' | 'ERROR')
                  : 'ERROR';
              return {
                field: String(attempt.field ?? ''),
                source: String(attempt.source ?? ''),
                result,
                note:
                  typeof attempt.note === 'string' ? attempt.note : undefined,
              };
            })
        : [],
      severity:
        missingDataObject?.severity === 'INFO' ||
        missingDataObject?.severity === 'WARNING' ||
        missingDataObject?.severity === 'BLOCKING'
          ? (missingDataObject.severity as 'INFO' | 'WARNING' | 'BLOCKING')
          : 'INFO',
    },
    consistency: {
      pace_tier: String(consistencyObject.pace_tier ?? 'MISSING'),
      event_env: String(consistencyObject.event_env ?? 'MISSING'),
      event_direction_tag: String(
        consistencyObject.event_direction_tag ?? 'MISSING',
      ),
      vol_env: String(consistencyObject.vol_env ?? 'MISSING'),
      total_bias: String(consistencyObject.total_bias ?? 'MISSING'),
    },
    fair_prob:
      typeof input.fair_prob === 'number' && Number.isFinite(input.fair_prob)
        ? input.fair_prob
        : null,
    implied_prob:
      typeof input.implied_prob === 'number' &&
      Number.isFinite(input.implied_prob)
        ? input.implied_prob
        : null,
    edge_pct:
      typeof input.edge_pct === 'number' && Number.isFinite(input.edge_pct)
        ? input.edge_pct
        : null,
    edge_delta_pct:
      typeof resolveDecisionV2EdgePct(input) === 'number'
        ? resolveDecisionV2EdgePct(input)
        : null,
    edge_method:
      input.edge_method === 'ML_PROB' ||
      input.edge_method === 'MARGIN_DELTA' ||
      input.edge_method === 'TOTAL_DELTA' ||
      input.edge_method === 'ONE_PERIOD_DELTA'
        ? (input.edge_method as 'ML_PROB' | 'MARGIN_DELTA' | 'TOTAL_DELTA' | 'ONE_PERIOD_DELTA')
        : null,
    edge_line_delta:
      typeof input.edge_line_delta === 'number' &&
      Number.isFinite(input.edge_line_delta)
        ? input.edge_line_delta
        : null,
    edge_lean:
      input.edge_lean === 'OVER' || input.edge_lean === 'UNDER'
        ? (input.edge_lean as 'OVER' | 'UNDER')
        : null,
    proxy_used:
      typeof input.proxy_used === 'boolean' ? input.proxy_used : undefined,
    proxy_capped:
      typeof input.proxy_capped === 'boolean' ? input.proxy_capped : undefined,
    exact_wager_valid:
      typeof input.exact_wager_valid === 'boolean'
        ? input.exact_wager_valid
        : undefined,
    pricing_trace: toObject(input.pricing_trace)
      ? {
          market_type:
            typeof toObject(input.pricing_trace)?.market_type === 'string'
              ? String(toObject(input.pricing_trace)?.market_type)
              : null,
          market_side:
            typeof toObject(input.pricing_trace)?.market_side === 'string'
              ? String(toObject(input.pricing_trace)?.market_side)
              : null,
          market_line:
            firstNumber(toObject(input.pricing_trace)?.market_line) ?? null,
          market_price:
            firstNumber(toObject(input.pricing_trace)?.market_price) ?? null,
          line_source:
            typeof toObject(input.pricing_trace)?.line_source === 'string'
              ? String(toObject(input.pricing_trace)?.line_source)
              : null,
          price_source:
            typeof toObject(input.pricing_trace)?.price_source === 'string'
              ? String(toObject(input.pricing_trace)?.price_source)
              : null,
        }
      : undefined,
    sharp_price_status,
    price_reason_codes: Array.isArray(input.price_reason_codes)
      ? input.price_reason_codes.map((item) => String(item))
      : [],
    official_status,
    play_tier,
    primary_reason_code: String(input.primary_reason_code ?? 'UNKNOWN'),
    pipeline_version: 'v2',
    decided_at:
      typeof input.decided_at === 'string' && input.decided_at.trim().length > 0
        ? input.decided_at
        : new Date().toISOString(),
  };
}

function applyWave1DecisionFields(play: Play): void {
  const decisionV2 = play.decision_v2;
  if (!decisionV2) return;
  if (decisionV2.official_status === 'PLAY') {
    play.action = 'FIRE';
    play.classification = 'BASE';
    play.status = 'FIRE';
    play.pass_reason_code = null;
    return;
  }
  if (decisionV2.official_status === 'LEAN') {
    play.action = 'HOLD';
    play.classification = 'LEAN';
    play.status = 'WATCH';
    play.pass_reason_code = null;
    return;
  }
  play.action = 'PASS';
  play.classification = 'PASS';
  play.status = 'PASS';
  play.pass_reason_code = decisionV2.primary_reason_code;
}

function normalizePassReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (!code) return null;
  if (code.startsWith('PASS_')) return code;

  const mapped: Record<string, string> = {
    MISSING_LINE: 'PASS_MISSING_LINE',
    MISSING_EDGE: 'PASS_MISSING_EDGE',
    MISSING_SELECTION: 'PASS_MISSING_SELECTION',
    MISSING_PRICE: 'PASS_MISSING_PRICE',
    NO_MARKET_PRICE: 'PASS_NO_MARKET_PRICE',
    NO_STARTER_SIGNAL: 'PASS_MISSING_DRIVER_INPUTS',
  };

  return mapped[code] ?? code;
}

function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item) => typeof item === 'number' && Number.isFinite(item),
  ) as number[];
  return numbers.length > 0 ? numbers : undefined;
}

function normalizePlayerNameKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function getActiveRunIds(db: ReturnType<typeof getDatabaseReadOnly>): string[] {
  // Prefer per-sport rows (added by migration 021); fall back to singleton
  try {
    const successRows = db
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE id != 'singleton'
           AND LOWER(COALESCE(rs.sport, rs.id, '')) IN (${CORE_RUN_STATE_SPORT_SQL})
           AND rs.current_run_id IS NOT NULL
           AND TRIM(rs.current_run_id) != ''
           AND EXISTS (
             SELECT 1
             FROM job_runs jr
             WHERE jr.id = rs.current_run_id
               AND LOWER(jr.status) = 'success'
           )
         ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (successRows.length > 0) {
      return [...new Set(successRows.map((r) => r.current_run_id))];
    }

    const sportRows = db
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE rs.id != 'singleton'
           AND LOWER(COALESCE(rs.sport, rs.id, '')) IN (${CORE_RUN_STATE_SPORT_SQL})
           AND rs.current_run_id IS NOT NULL
           AND TRIM(rs.current_run_id) != ''
         ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`,
      )
      .all() as Array<{ current_run_id: string }>;
    if (sportRows.length > 0) {
      return [...new Set(sportRows.map((r) => r.current_run_id))];
    }
  } catch {
    // fall through to singleton
  }
  try {
    const row = db
      .prepare(
        `SELECT current_run_id FROM run_state WHERE id = 'singleton' LIMIT 1`,
      )
      .get() as { current_run_id?: string | null } | undefined;
    return row?.current_run_id ? [row.current_run_id] : [];
  } catch {
    return [];
  }
}

function getFallbackRunIdsFromCards(
  db: ReturnType<typeof getDatabaseReadOnly>,
): string[] {
  try {
    const row = db
      .prepare(
        `SELECT run_id
         FROM card_payloads
         WHERE run_id IS NOT NULL
           AND TRIM(run_id) != ''
         ORDER BY datetime(created_at) DESC, id DESC
         LIMIT 1`,
      )
      .get() as { run_id?: string | null } | undefined;
    return row?.run_id ? [String(row.run_id)] : [];
  } catch {
    return [];
  }
}

function getRunStatus(
  db: ReturnType<typeof getDatabaseReadOnly>,
  runId: string | null,
): string {
  if (!runId) return 'NONE';
  try {
    const stmt = db.prepare(
      `SELECT status FROM job_runs WHERE id = ? ORDER BY started_at DESC LIMIT 1`,
    );
    const row = stmt.get(runId) as { status?: string | null } | undefined;
    return row?.status ? String(row.status).toUpperCase() : 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}

function extractShotsFromRecentGames(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const shots = value
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const row = item as Record<string, unknown>;
      const direct = row.shots;
      if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
      if (typeof direct === 'string') {
        const parsed = Number(direct);
        if (Number.isFinite(parsed)) return parsed;
      }
      return undefined;
    })
    .filter(
      (num): num is number => typeof num === 'number' && Number.isFinite(num),
    );

  return shots.length > 0 ? shots : undefined;
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  const requestStartedAt = Date.now();
  const stageCounters = createStageCounters();
  const gamesWithPlayableMarkets = new Map<string, Map<string, Set<string>>>();
  const outOfContractPlayDowngrades = new Map<string, number>();
  const perf = {
    dbReadyMs: 0,
    loadGamesMs: 0,
    cardsQueryMs: 0,
    cardsParseMs: 0,
    cardRows: 0,
    totalMs: 0,
  };
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/games');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    const dbReadyStartedAt = Date.now();
    await ensureDbReady();
    perf.dbReadyMs = Date.now() - dbReadyStartedAt;

    if (process.env.ENABLE_AUTH_WALLS === 'true') {
      const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
      if (!access.ok) {
        return NextResponse.json(
          { success: false, error: access.error },
          { status: access.status }
        );
      }
    }

    db = getDatabaseReadOnly();
    let activeRunIds = getActiveRunIds(db);
    if (activeRunIds.length === 0) {
      activeRunIds = getFallbackRunIdsFromCards(db);
    }
    const currentRunId = activeRunIds[0] ?? null;
    const runStatus = getRunStatus(db, currentRunId);

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='games'`,
    );
    const hasGamesTable = tableCheckStmt.get();

    if (!hasGamesTable) {
      // Database is not initialized - return empty data
      const response = NextResponse.json(
        {
          success: true,
          data: [],
          meta: {
            current_run_id: currentRunId,
            generated_at: new Date().toISOString(),
            run_status: runStatus,
            items_count: 0,
          },
        },
        { headers: { 'Content-Type': 'application/json' } },
      );
      return addRateLimitHeaders(response, request);
    }

    const searchParams = request.nextUrl.searchParams;
    const lifecycleMode = resolveLifecycleMode(searchParams);
    const sportFilter = resolveSportFilter(searchParams);

    // Compute midnight America/New_York as a UTC string for the SQL param.
    // en-CA locale gives YYYY-MM-DD; shortOffset gives "GMT-5" / "GMT-4" (DST-aware).
    const now = new Date();
    const nowUtc = toSqlUtc(now);
    const etDateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
    }).format(now); // e.g. "2026-02-28"
    const tzPart = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(now)
      .find((p) => p.type === 'timeZoneName')!.value; // e.g. "GMT-5"
    const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
    const sign = offsetHours < 0 ? '-' : '+';
    const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
    const localMidnight = new Date(
      `${etDateStr}T00:00:00${sign}${absHours}:00`,
    );
    // Truncate to seconds — SQLite datetime() strips sub-second precision, so
    // "05:00:00.000" would be > "05:00:00" and exclude games at exactly midnight.
    const todayUtc = localMidnight
      .toISOString()
      .substring(0, 19)
      .replace('T', ' ');

    const isNonProd = process.env.NODE_ENV !== 'production';
    const shouldUseDevLookback =
      isNonProd &&
      ENABLE_DEV_PAST_GAMES &&
      Number.isFinite(DEV_GAMES_LOOKBACK_HOURS) &&
      DEV_GAMES_LOOKBACK_HOURS > 0;

    const lookbackUtc = shouldUseDevLookback
      ? new Date(now.getTime() - DEV_GAMES_LOOKBACK_HOURS * 60 * 60 * 1000)
          .toISOString()
          .substring(0, 19)
          .replace('T', ' ')
      : null;

    const gamesStartUtc = lookbackUtc ?? todayUtc;
    // Active mode uses a rolling 36h lookback so late-night games that started
    // before today's ET midnight boundary remain visible while in progress.
    // Pregame mode keeps using todayUtc (already-started games shouldn't appear
    // as pregame picks anyway).
    const ACTIVE_LOOKBACK_HOURS = Number(
      process.env.ACTIVE_GAMES_LOOKBACK_HOURS || 36,
    );
    const activeStartUtc =
      lookbackUtc ??
      new Date(now.getTime() - ACTIVE_LOOKBACK_HOURS * 60 * 60 * 1000)
        .toISOString()
        .substring(0, 19)
        .replace('T', ' ');
    const gamesEndUtc = HAS_API_GAMES_HORIZON
      ? new Date(now.getTime() + API_GAMES_HORIZON_HOURS * 60 * 60 * 1000)
          .toISOString()
          .substring(0, 19)
          .replace('T', ' ')
      : null;

    const lifecycleSql =
      lifecycleMode === 'active'
        ? `
        AND datetime(g.game_time_utc) <= datetime(?)
        AND UPPER(COALESCE(g.status, '')) NOT IN (${ACTIVE_EXCLUDED_STATUSES.map(
          (status) => `'${status}'`,
        ).join(', ')})
        AND NOT EXISTS (
          SELECT 1
          FROM game_results gr
          WHERE gr.game_id = g.game_id
            AND UPPER(COALESCE(gr.status, '')) IN (${FINAL_GAME_RESULT_STATUSES.map(
              (status) => `'${status}'`,
            ).join(', ')})
        )
      `
        : `
        AND datetime(g.game_time_utc) > datetime(?)
      `;

    const baseGamesSql = `
      SELECT
        g.id,
        g.game_id,
        g.sport,
        g.home_team,
        g.away_team,
        g.game_time_utc,
        g.status,
        g.created_at
      FROM games g
      WHERE datetime(g.game_time_utc) >= ?
        ${sportFilter ? 'AND UPPER(g.sport) = ?' : ''}
        AND NOT EXISTS (
          SELECT 1
          FROM card_results cr
          WHERE cr.game_id = g.game_id
            AND cr.status = 'settled'
        )
        ${lifecycleSql}
        ${gamesEndUtc ? 'AND datetime(g.game_time_utc) <= ?' : ''}
      ORDER BY g.game_time_utc ASC
      LIMIT 200
    `;

    const baseWindowCountSql = `
      SELECT COUNT(*) AS total
      FROM games g
      WHERE datetime(g.game_time_utc) >= ?
        ${sportFilter ? 'AND UPPER(g.sport) = ?' : ''}
        AND NOT EXISTS (
          SELECT 1
          FROM card_results cr
          WHERE cr.game_id = g.game_id
            AND cr.status = 'settled'
        )
        ${gamesEndUtc ? 'AND datetime(g.game_time_utc) <= ?' : ''}
    `;

    let baseWindowCount: number | null = null;
    if (isNonProd) {
      const baseWindowCountStmt = db.prepare(baseWindowCountSql);
      const countParams: string[] = [gamesStartUtc];
      if (sportFilter) {
        countParams.push(sportFilter);
      }
      if (gamesEndUtc) {
        countParams.push(gamesEndUtc);
      }
      const baseWindowCountRow = (
        baseWindowCountStmt.get(...countParams)
      ) as { total?: number } | undefined;
      baseWindowCount = Number(baseWindowCountRow?.total ?? 0);
    }

    const oddsSnapshotColumns = getTableColumnNames(db, 'odds_snapshots');
    const hasConsensusOddsColumns =
      oddsSnapshotColumns.has('spread_consensus_line') &&
      oddsSnapshotColumns.has('spread_consensus_confidence') &&
      oddsSnapshotColumns.has('spread_dispersion_stddev') &&
      oddsSnapshotColumns.has('spread_source_book_count') &&
      oddsSnapshotColumns.has('total_consensus_line') &&
      oddsSnapshotColumns.has('total_consensus_confidence') &&
      oddsSnapshotColumns.has('total_dispersion_stddev') &&
      oddsSnapshotColumns.has('total_source_book_count') &&
      oddsSnapshotColumns.has('h2h_consensus_home') &&
      oddsSnapshotColumns.has('h2h_consensus_away') &&
      oddsSnapshotColumns.has('h2h_consensus_confidence');
    if (!hasConsensusOddsColumns) {
      console.warn(
        '[api/games] odds_snapshots missing consensus columns; falling back to null consensus fields. Run migration 046_add_consensus_to_odds_snapshots.sql on the writer DB.',
      );
    }

    const loadGamesWithLatestOdds = (
      startUtc: string,
      endUtc: string | null,
    ): GameRow[] => {
      const baseGamesStmt = db.prepare(baseGamesSql);
      const gamesParams: string[] = [startUtc];
      if (sportFilter) {
        gamesParams.push(sportFilter);
      }
      gamesParams.push(nowUtc);
      if (endUtc) {
        gamesParams.push(endUtc);
      }
      const baseGames = (
        baseGamesStmt.all(...gamesParams)
      ) as Array<
        Omit<
          GameRow,
          | 'h2h_home'
          | 'h2h_away'
          | 'h2h_book'
          | 'h2h_home_book'
          | 'h2h_away_book'
          | 'total'
          | 'total_book'
          | 'total_line_over'
          | 'total_line_over_book'
          | 'total_line_under'
          | 'total_line_under_book'
          | 'spread_home'
          | 'spread_away'
          | 'spread_home_book'
          | 'spread_away_book'
          | 'spread_price_home'
          | 'spread_price_home_book'
          | 'spread_price_away'
          | 'spread_price_away_book'
          | 'total_price_over'
          | 'total_price_over_book'
          | 'total_price_under'
          | 'total_price_under_book'
          | 'spread_is_mispriced'
          | 'spread_misprice_type'
          | 'spread_misprice_strength'
          | 'spread_outlier_book'
          | 'spread_outlier_delta'
          | 'spread_review_flag'
          | 'spread_consensus_line'
          | 'spread_consensus_confidence'
          | 'spread_dispersion_stddev'
          | 'spread_source_book_count'
          | 'total_is_mispriced'
          | 'total_misprice_type'
          | 'total_misprice_strength'
          | 'total_outlier_book'
          | 'total_outlier_delta'
          | 'total_review_flag'
          | 'total_consensus_line'
          | 'total_consensus_confidence'
          | 'total_dispersion_stddev'
          | 'total_source_book_count'
          | 'h2h_consensus_home'
          | 'h2h_consensus_away'
          | 'h2h_consensus_confidence'
          | 'odds_captured_at'
        >
      >;

      if (baseGames.length === 0) {
        return [];
      }

      const gameIdsForOdds = baseGames.map((row) => row.game_id);
      const oddsPlaceholders = gameIdsForOdds.map(() => '?').join(', ');
      const latestOddsSql = `
        SELECT
          o.game_id,
          o.h2h_home,
          o.h2h_away,
          o.h2h_book,
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'h2h_home_book')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'h2h_away_book')},
          o.total,
          o.total_book,
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_line_over')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_line_over_book')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_line_under')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_line_under_book')},
          o.spread_home,
          o.spread_away,
          o.spread_home_book,
          o.spread_away_book,
          o.spread_price_home,
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_price_home_book')},
          o.spread_price_away,
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_price_away_book')},
          o.total_price_over,
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_price_over_book')},
          o.total_price_under,
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_price_under_book')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_is_mispriced')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_misprice_type')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_misprice_strength')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_outlier_book')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_outlier_delta')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_review_flag')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_consensus_line')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_consensus_confidence')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_dispersion_stddev')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'spread_source_book_count')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_is_mispriced')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_misprice_type')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_misprice_strength')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_outlier_book')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_outlier_delta')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_review_flag')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_consensus_line')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_consensus_confidence')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_dispersion_stddev')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'total_source_book_count')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'h2h_consensus_home')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'h2h_consensus_away')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'h2h_consensus_confidence')},
          o.captured_at AS odds_captured_at,
          o.raw_data
        FROM odds_snapshots o
        INNER JOIN (
          SELECT game_id, MAX(captured_at) AS max_captured_at
          FROM odds_snapshots
          WHERE game_id IN (${oddsPlaceholders})
          GROUP BY game_id
        ) latest
          ON latest.game_id = o.game_id
         AND latest.max_captured_at = o.captured_at
      `;

      const latestOddsStmt = db.prepare(latestOddsSql);
      const latestOddsRows = latestOddsStmt.all(...gameIdsForOdds) as Array<{
        game_id: string;
        h2h_home: number | null;
        h2h_away: number | null;
        h2h_book: string | null;
        h2h_home_book: string | null;
        h2h_away_book: string | null;
        total: number | null;
        total_book: string | null;
        total_line_over: number | null;
        total_line_over_book: string | null;
        total_line_under: number | null;
        total_line_under_book: string | null;
        spread_home: number | null;
        spread_away: number | null;
        spread_home_book: string | null;
        spread_away_book: string | null;
        spread_price_home: number | null;
        spread_price_home_book: string | null;
        spread_price_away: number | null;
        spread_price_away_book: string | null;
        total_price_over: number | null;
        total_price_over_book: string | null;
        total_price_under: number | null;
        total_price_under_book: string | null;
        spread_is_mispriced: number | null;
        spread_misprice_type: string | null;
        spread_misprice_strength: number | null;
        spread_outlier_book: string | null;
        spread_outlier_delta: number | null;
        spread_review_flag: number | null;
        spread_consensus_line: number | null;
        spread_consensus_confidence: string | null;
        spread_dispersion_stddev: number | null;
        spread_source_book_count: number | null;
        total_is_mispriced: number | null;
        total_misprice_type: string | null;
        total_misprice_strength: number | null;
        total_outlier_book: string | null;
        total_outlier_delta: number | null;
        total_review_flag: number | null;
        total_consensus_line: number | null;
        total_consensus_confidence: string | null;
        total_dispersion_stddev: number | null;
        total_source_book_count: number | null;
        h2h_consensus_home: number | null;
        h2h_consensus_away: number | null;
        h2h_consensus_confidence: string | null;
        odds_captured_at: string | null;
        raw_data: string | null;
      }>;

      const latestOddsByGameId = new Map(
        latestOddsRows.map((row) => [row.game_id, row]),
      );

      const ingestFailureSql = `
        SELECT game_id, reason_code, reason_detail, last_seen
        FROM odds_ingest_failures
        WHERE game_id IN (${oddsPlaceholders})
          AND datetime(last_seen) >= datetime('now', '-${API_GAMES_INGEST_FAILURE_LOOKBACK_HOURS} hours')
        ORDER BY last_seen DESC
      `;
      const ingestFailureRows = db.prepare(ingestFailureSql).all(
        ...gameIdsForOdds,
      ) as IngestFailureRow[];
      const latestIngestFailureByGameId = new Map<string, IngestFailureRow>();
      for (const row of ingestFailureRows) {
        if (!row.game_id || latestIngestFailureByGameId.has(row.game_id)) {
          continue;
        }
        latestIngestFailureByGameId.set(row.game_id, row);
      }

      return baseGames.map((game) => {
        const odds = latestOddsByGameId.get(game.game_id);
        const ingestFailure = latestIngestFailureByGameId.get(game.game_id);
        const projectionHealth = assessProjectionInputsFromRawData(
          game.sport,
          odds?.raw_data,
        );
        const sourceMappingHealth = deriveSourceMappingHealth(odds?.raw_data);
        return {
          ...game,
          h2h_home: odds?.h2h_home ?? null,
          h2h_away: odds?.h2h_away ?? null,
          h2h_book: odds?.h2h_book ?? null,
          h2h_home_book: odds?.h2h_home_book ?? null,
          h2h_away_book: odds?.h2h_away_book ?? null,
          total: odds?.total ?? null,
          total_book: odds?.total_book ?? null,
          total_line_over: odds?.total_line_over ?? null,
          total_line_over_book: odds?.total_line_over_book ?? null,
          total_line_under: odds?.total_line_under ?? null,
          total_line_under_book: odds?.total_line_under_book ?? null,
          spread_home: odds?.spread_home ?? null,
          spread_away: odds?.spread_away ?? null,
          spread_home_book: odds?.spread_home_book ?? null,
          spread_away_book: odds?.spread_away_book ?? null,
          spread_price_home: odds?.spread_price_home ?? null,
          spread_price_home_book: odds?.spread_price_home_book ?? null,
          spread_price_away: odds?.spread_price_away ?? null,
          spread_price_away_book: odds?.spread_price_away_book ?? null,
          total_price_over: odds?.total_price_over ?? null,
          total_price_over_book: odds?.total_price_over_book ?? null,
          total_price_under: odds?.total_price_under ?? null,
          total_price_under_book: odds?.total_price_under_book ?? null,
          spread_is_mispriced: odds?.spread_is_mispriced ?? null,
          spread_misprice_type: odds?.spread_misprice_type ?? null,
          spread_misprice_strength: odds?.spread_misprice_strength ?? null,
          spread_outlier_book: odds?.spread_outlier_book ?? null,
          spread_outlier_delta: odds?.spread_outlier_delta ?? null,
          spread_review_flag: odds?.spread_review_flag ?? null,
          spread_consensus_line: odds?.spread_consensus_line ?? null,
          spread_consensus_confidence:
            odds?.spread_consensus_confidence ?? null,
          spread_dispersion_stddev: odds?.spread_dispersion_stddev ?? null,
          spread_source_book_count: odds?.spread_source_book_count ?? null,
          total_is_mispriced: odds?.total_is_mispriced ?? null,
          total_misprice_type: odds?.total_misprice_type ?? null,
          total_misprice_strength: odds?.total_misprice_strength ?? null,
          total_outlier_book: odds?.total_outlier_book ?? null,
          total_outlier_delta: odds?.total_outlier_delta ?? null,
          total_review_flag: odds?.total_review_flag ?? null,
          total_consensus_line: odds?.total_consensus_line ?? null,
          total_consensus_confidence:
            odds?.total_consensus_confidence ?? null,
          total_dispersion_stddev: odds?.total_dispersion_stddev ?? null,
          total_source_book_count: odds?.total_source_book_count ?? null,
          h2h_consensus_home: odds?.h2h_consensus_home ?? null,
          h2h_consensus_away: odds?.h2h_consensus_away ?? null,
          h2h_consensus_confidence: odds?.h2h_consensus_confidence ?? null,
          odds_captured_at: odds?.odds_captured_at ?? null,
          projection_inputs_complete:
            projectionHealth.projection_inputs_complete,
          projection_missing_inputs:
            projectionHealth.projection_missing_inputs,
          source_mapping_ok: sourceMappingHealth.source_mapping_ok,
          source_mapping_failures: sourceMappingHealth.source_mapping_failures,
          ingest_failure_reason_code: ingestFailure?.reason_code ?? null,
          ingest_failure_reason_detail: ingestFailure?.reason_detail ?? null,
        };
      });
    };

    const loadGamesStartedAt = Date.now();
    const activeLifecycleFallbackApplied = false;
    // Active mode uses activeStartUtc (36h rolling lookback) so games started
    // before today's ET midnight boundary stay visible while in progress.
    // Pregame mode continues using gamesStartUtc (today midnight ET).
    const initialStartUtc =
      lifecycleMode === 'active' ? activeStartUtc : gamesStartUtc;
    let rows = loadGamesWithLatestOdds(initialStartUtc, gamesEndUtc);

    if (isNonProd && rows.length === 0 && !shouldUseDevLookback) {
      const fallbackLookbackHours = Number(
        process.env.DEV_GAMES_FALLBACK_HOURS || 72,
      );
      if (Number.isFinite(fallbackLookbackHours) && fallbackLookbackHours > 0) {
        const fallbackStartUtc = new Date(
          now.getTime() - fallbackLookbackHours * 60 * 60 * 1000,
        )
          .toISOString()
          .substring(0, 19)
          .replace('T', ' ');
        rows = loadGamesWithLatestOdds(fallbackStartUtc, gamesEndUtc);
      }
    }
    // Note: active mode no longer needs a secondary fallback — activeStartUtc
    // already spans 36 h so there is no scenario where rows drops to 0 for live
    // games solely due to the start-date boundary.
    perf.loadGamesMs = Date.now() - loadGamesStartedAt;

    for (const row of rows) {
      incrementStageCounter(
        stageCounters,
        'base_games',
        row.sport,
        COUNTER_ALL_MARKET,
      );
    }

    // Collect all game IDs for the card_payloads query
    const gameIds = rows.map((r) => r.game_id);
    const gameRowById = new Map(rows.map((r) => [r.game_id, r]));
    const sportByGameId = new Map(rows.map((r) => [r.game_id, r.sport]));

    // Build a plays map keyed by canonical game_id
    const playsMap = new Map<string, Play[]>();
    const playByCardId = new Map<string, Play>();
    const truePlayMap = new Map<string, Play>();
    const gameConsistencyMap = new Map<string, Play['consistency']>();
    const seenNhlShotsPlayKeys = new Set<string>();
    const seenMlbPitcherKPlayKeys = new Set<string>();
    const injuredNhlPlayerIds = new Set<string>();
    const injuredNhlPlayerNames = new Set<string>();

    try {
      const availabilityRows = db
        .prepare(
          `SELECT CAST(pa.player_id AS TEXT) AS player_id,
                  LOWER(TRIM(COALESCE(tp.player_name, ''))) AS player_name
           FROM player_availability pa
           LEFT JOIN tracked_players tp
             ON tp.player_id = pa.player_id
            AND UPPER(tp.sport) = UPPER(pa.sport)
           WHERE UPPER(pa.sport) = 'NHL'
             AND UPPER(pa.status) = 'INJURED'`,
        )
        .all() as Array<{ player_id?: string | null; player_name?: string | null }>;

      for (const row of availabilityRows) {
        const playerId = firstString(row.player_id);
        const playerName = normalizePlayerNameKey(row.player_name);
        if (playerId) injuredNhlPlayerIds.add(playerId);
        if (playerName) injuredNhlPlayerNames.add(playerName);
      }
    } catch {
      try {
        const fallbackRows = db
          .prepare(
            `SELECT CAST(player_id AS TEXT) AS player_id
             FROM player_availability
             WHERE UPPER(sport) = 'NHL'
               AND UPPER(status) = 'INJURED'`,
          )
          .all() as Array<{ player_id?: string | null }>;
        for (const row of fallbackRows) {
          const playerId = firstString(row.player_id);
          if (playerId) injuredNhlPlayerIds.add(playerId);
        }
      } catch {
        // fail-open if availability table is unavailable
      }
    }

    // STEP 1 FIX: Resolve external game IDs (ESPN, etc.) that map to our canonical game_ids
    // This allows props stored with external IDs to be joined to games with canonical IDs
    const externalToCanonicalMap = new Map<string, string>(); // external_game_id -> canonical game_id
    const allQueryableIds: string[] = [...gameIds]; // Start with canonical IDs

    if (gameIds.length > 0) {
      // Look up external game IDs that map to our canonical game IDs
      const idMapPlaceholders = gameIds.map(() => '?').join(', ');
      const idMapSql = `
        SELECT game_id, external_game_id
        FROM game_id_map
        WHERE game_id IN (${idMapPlaceholders})
      `;
      const idMapStmt = db.prepare(idMapSql);
      const idMapRows = idMapStmt.all(...gameIds) as Array<{
        game_id: string;
        external_game_id: string;
      }>;

      for (const row of idMapRows) {
        externalToCanonicalMap.set(row.external_game_id, row.game_id);
        const canonicalSport = sportByGameId.get(row.game_id);
        if (canonicalSport) {
          sportByGameId.set(row.external_game_id, canonicalSport);
        }
        allQueryableIds.push(row.external_game_id);
      }

      // SQLite doesn't support array binding; build placeholders for ALL IDs (canonical + external)
      const runIdPlaceholders =
        activeRunIds.length > 0 ? activeRunIds.map(() => '?').join(', ') : '';
      const runIdClause =
        activeRunIds.length > 0 ? `AND run_id IN (${runIdPlaceholders})` : '';
      const buildCardsSql = (queryableIds: string[], runClause: string) => {
        const queryPlaceholders = queryableIds.map(() => '?').join(', ');
        return `
        SELECT id, game_id, card_type, card_title, payload_data
        FROM card_payloads
        WHERE game_id IN (${queryPlaceholders})
          ${runClause}
          ${ENABLE_WELCOME_HOME ? '' : "AND card_type != 'welcome-home-v2'"}
        ORDER BY created_at DESC, id DESC
        LIMIT ${API_GAMES_MAX_CARD_ROWS}
      `;
      };
      let cardRows: CardPayloadRow[] = [];
      try {
        const cardsQueryStartedAt = Date.now();
        const cardsStmt = db.prepare(
          buildCardsSql(allQueryableIds, runIdClause),
        );
        const cardsParams =
          activeRunIds.length > 0
            ? [...allQueryableIds, ...activeRunIds]
            : [...allQueryableIds];
        cardRows = cardsStmt.all(...cardsParams) as CardPayloadRow[];

        if (activeRunIds.length > 0) {
          // Fallback per missing game id when scoped runs are partial (e.g., only NHL fresh run exists).
          // Without this, games outside active runs degrade as "drivers missing" even when valid card payloads exist.
          const coveredGameIds = new Set(cardRows.map((row) => row.game_id));
          const missingGameIds = allQueryableIds.filter(
            (gameId) => !coveredGameIds.has(gameId),
          );
          if (missingGameIds.length > 0) {
            const fallbackStmt = db.prepare(buildCardsSql(missingGameIds, ''));
            const fallbackRows = fallbackStmt.all(
              ...missingGameIds,
            ) as CardPayloadRow[];
            if (fallbackRows.length > 0) {
              const dedupedBySemanticKey = new Map<string, CardPayloadRow>();
              for (const row of [...cardRows, ...fallbackRows]) {
                const semanticKey = `${row.game_id}|${row.card_type}|${row.card_title}`;
                if (!dedupedBySemanticKey.has(semanticKey)) {
                  dedupedBySemanticKey.set(semanticKey, row);
                }
              }
              const dedupedById = new Map<string, CardPayloadRow>();
              for (const row of dedupedBySemanticKey.values()) {
                dedupedById.set(row.id, row);
              }
              cardRows = Array.from(dedupedById.values());
            }
          }
        }
        perf.cardsQueryMs += Date.now() - cardsQueryStartedAt;
      } catch {
        // card_payloads table not yet created; plays will be empty
      }

      let displayLogRows: DisplayLogRow[] = [];
      try {
        if (allQueryableIds.length > 0) {
          const displayLogPlaceholders = allQueryableIds.map(() => '?').join(', ');
          const displayLogStmt = db.prepare(`
            SELECT id, pick_id, game_id, displayed_at
            FROM card_display_log
            WHERE game_id IN (${displayLogPlaceholders})
            ORDER BY datetime(displayed_at) DESC, id DESC
          `);
          displayLogRows = displayLogStmt.all(...allQueryableIds) as DisplayLogRow[];

          if (displayLogRows.length > 0) {
            const dedupedCardRows = new Map<string, CardPayloadRow>();
            for (const row of cardRows) {
              dedupedCardRows.set(row.id, row);
            }
            const missingPickIds = Array.from(
              new Set(
                displayLogRows
                  .map((row) => String(row.pick_id || ''))
                  .filter((pickId) => pickId && !dedupedCardRows.has(pickId)),
              ),
            );
            if (activeRunIds.length === 0 && missingPickIds.length > 0) {
              const missingPayloadPlaceholders = missingPickIds
                .map(() => '?')
                .join(', ');
              const missingPayloadRows = db
                .prepare(
                  `
                  SELECT id, game_id, card_type, card_title, payload_data
                  FROM card_payloads
                  WHERE id IN (${missingPayloadPlaceholders})
                `,
                )
                .all(...missingPickIds) as CardPayloadRow[];
              for (const row of missingPayloadRows) {
                dedupedCardRows.set(row.id, row);
              }
            }
            cardRows = Array.from(dedupedCardRows.values());
          }
        }
      } catch {
        displayLogRows = [];
      }

      perf.cardRows = cardRows.length;
      const cardsParseStartedAt = Date.now();

      for (const cardRow of cardRows) {
        const canonicalGameIdForRow =
          externalToCanonicalMap.get(cardRow.game_id) ?? cardRow.game_id;
        const gameRow = gameRowById.get(canonicalGameIdForRow);
        const rowSport =
          normalizeSport(sportByGameId.get(canonicalGameIdForRow)) ??
          UNKNOWN_SPORT;
        const rowMarket = inferMarketFromCardType(cardRow.card_type);
        incrementStageCounter(stageCounters, 'card_rows', rowSport, rowMarket);

        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(cardRow.payload_data) as Record<string, unknown>;
        } catch {
          // Skip malformed rows silently
          continue;
        }

        const driverInputs =
          payload.driver !== null &&
          typeof payload.driver === 'object' &&
          'inputs' in (payload.driver as object)
            ? ((payload.driver as Record<string, unknown>).inputs as Record<
                string,
                unknown
              >)
            : null;

        const payloadPlay = toObject(payload.play);
        const payloadPlayObj = toObject(payloadPlay);
        const payloadFtTrendContext = toObject(
          (payload as Record<string, unknown>).ft_trend_context,
        );
        const payloadMarketContext =
          toObject((payload as Record<string, unknown>).market_context) ??
          toObject(payloadPlayObj?.market_context);
        const payloadMarketContextProjection = toObject(
          payloadMarketContext?.projection,
        );
        const payloadMarketContextWager = toObject(payloadMarketContext?.wager);
        const payloadSelection =
          toObject(payload.selection) ?? toObject(payloadPlay?.selection);
        const payloadSelectionRaw = firstString(
          (payload as Record<string, unknown>).selection,
          (payload as Record<string, unknown>).outcome,
        );
        const normalizedSelectionSide =
          normalizeSelectionSide(
            payloadSelection?.side ??
              payloadMarketContext?.selection_side ??
              payloadPlay?.side ??
              payloadSelectionRaw ??
              payload.prediction,
          ) ?? 'NONE';
        const normalizedAction = normalizeAction(
          payload.action ?? payloadPlay?.action,
        );
        const normalizedStatus = normalizeStatus(
          payload.status ?? payloadPlay?.status,
        );
        const normalizedClassification = normalizeClassification(
          payload.classification ??
            payloadPlay?.classification ??
            driverInputs?.classification,
        );
        const normalizedDecisionV2 = normalizeDecisionV2(
          (payload as Record<string, unknown>).decision_v2 ??
            payloadPlay?.decision_v2,
        );
        const normalizedTier = normalizeTier(payload.tier ?? payloadPlay?.tier);
        const baseNormalizedPrediction =
          normalizePrediction(payload.prediction) ??
          normalizePrediction(payloadPlay?.prediction) ??
          (normalizedSelectionSide === 'HOME' ||
          normalizedSelectionSide === 'AWAY' ||
          normalizedSelectionSide === 'OVER' ||
          normalizedSelectionSide === 'UNDER'
            ? normalizedSelectionSide
            : undefined) ??
          'NEUTRAL';
        const normalizedConfidence = firstNumber(
          payload.confidence,
          payloadPlay?.confidence,
        );
        const isSoccerAhPayload = isSoccerAsianHandicapPayload({
          rowSport,
          cardType: cardRow.card_type,
          payload,
          payloadPlay: payloadPlayObj,
          payloadMarketContext,
        });
        const normalizedMarketTypeRaw = normalizeMarketType(
          payload.market_type ??
            payloadPlay?.market_type ??
            payloadMarketContext?.market_type,
        );
        const normalizedMarketType =
          isSoccerAhPayload ? 'SPREAD' : normalizedMarketTypeRaw;
        const ahRemappedFromProp =
          isSoccerAhPayload && normalizedMarketTypeRaw === 'PROP';
        const isFtTrendCard =
          cardRow.card_type === 'ncaam-ft-trend';
        const normalizedFtTrendContext = isFtTrendCard
          ? (() => {
              const homeFtPct = firstNumber(
                payloadFtTrendContext?.home_ft_pct,
                driverInputs?.home_ft_pct,
              );
              const awayFtPct = firstNumber(
                payloadFtTrendContext?.away_ft_pct,
                driverInputs?.away_ft_pct,
              );
              const totalLine = firstNumber(
                payloadFtTrendContext?.total_line,
                driverInputs?.total_line,
                payload.odds_context &&
                  typeof payload.odds_context === 'object' &&
                  'total' in (payload.odds_context as object)
                  ? (payload.odds_context as Record<string, unknown>).total
                  : null,
              );

              const explicitSideRaw = firstString(
                payloadFtTrendContext?.advantaged_side,
              );
              const explicitSide =
                explicitSideRaw === 'HOME' || explicitSideRaw === 'AWAY'
                  ? explicitSideRaw
                  : explicitSideRaw === 'home' || explicitSideRaw === 'away'
                    ? (explicitSideRaw.toUpperCase() as 'HOME' | 'AWAY')
                    : null;
              const inferredSide =
                typeof homeFtPct === 'number' && typeof awayFtPct === 'number'
                  ? homeFtPct > awayFtPct
                    ? 'HOME'
                    : awayFtPct > homeFtPct
                      ? 'AWAY'
                      : null
                  : null;
              const advantagedSide = explicitSide ?? inferredSide;

              if (
                homeFtPct === null &&
                awayFtPct === null &&
                totalLine === null &&
                advantagedSide === null
              ) {
                return undefined;
              }

              return {
                home_ft_pct: homeFtPct ?? null,
                away_ft_pct: awayFtPct ?? null,
                total_line: totalLine ?? null,
                advantaged_side: advantagedSide,
              };
            })()
          : undefined;
        const normalizedDisplaySelectionSide =
          isFtTrendCard &&
          (normalizedFtTrendContext?.advantaged_side === 'HOME' ||
            normalizedFtTrendContext?.advantaged_side === 'AWAY')
            ? normalizedFtTrendContext.advantaged_side
            : normalizedSelectionSide;
        const normalizedPrediction =
          normalizedDisplaySelectionSide === 'HOME' ||
          normalizedDisplaySelectionSide === 'AWAY' ||
          normalizedDisplaySelectionSide === 'OVER' ||
          normalizedDisplaySelectionSide === 'UNDER'
            ? normalizedDisplaySelectionSide
            : baseNormalizedPrediction;
        const normalizedPlayerName = firstString(
          payloadSelection?.player_name,
          payloadPlay?.player_name,
          (payload as Record<string, unknown>).player_name,
        );
        const normalizedSelectionTeamBase = firstString(
          normalizedPlayerName,
          payloadSelection?.team,
          payloadMarketContext?.selection_team,
          payloadPlay?.team,
        );
        const normalizedSelectionTeam =
          isFtTrendCard
            ? normalizedDisplaySelectionSide === 'HOME'
              ? gameRow?.home_team ?? normalizedSelectionTeamBase
              : normalizedDisplaySelectionSide === 'AWAY'
                ? gameRow?.away_team ?? normalizedSelectionTeamBase
                : normalizedSelectionTeamBase
            : normalizedSelectionTeamBase;
        const normalizedLineBase = firstNumber(
          payload.line,
          payloadMarketContextWager?.called_line,
          (payload.market as Record<string, unknown>)?.line,
          payloadPlay?.line,
          payloadSelection?.line,
        );
        const normalizedLine =
          isFtTrendCard
            ? normalizedDisplaySelectionSide === 'HOME'
              ? gameRow?.spread_home ?? normalizedLineBase
              : normalizedDisplaySelectionSide === 'AWAY'
                ? gameRow?.spread_away ?? normalizedLineBase
                : normalizedLineBase
            : normalizedLineBase;
        const normalizedPriceBase = firstNumber(
          payload.price,
          payloadMarketContextWager?.called_price,
          payloadPlay?.price,
          payloadSelection?.price,
          normalizedSelectionSide === 'OVER'
            ? firstNumber((payload as Record<string, unknown>).over_price)
            : undefined,
          normalizedSelectionSide === 'UNDER'
            ? firstNumber((payload as Record<string, unknown>).under_price)
            : undefined,
        );
        const normalizedPrice =
          isFtTrendCard
            ? normalizedDisplaySelectionSide === 'HOME'
              ? gameRow?.spread_price_home ?? normalizedPriceBase
              : normalizedDisplaySelectionSide === 'AWAY'
                ? gameRow?.spread_price_away ?? normalizedPriceBase
                : normalizedPriceBase
            : normalizedPriceBase;
        const normalizedRunId = firstString(
          (payload as Record<string, unknown>).run_id,
          payloadPlay?.run_id,
        );
        const normalizedCreatedAt = firstString(
          (payload as Record<string, unknown>).created_at,
          payloadPlay?.created_at,
        );
        const normalizedPlayerId = firstString(
          payloadSelection?.player_id,
          payloadPlay?.player_id,
          (payload as Record<string, unknown>).player_id,
        );
        const normalizedTeamAbbr = firstString(
          (payload as Record<string, unknown>).team_abbr,
          payloadSelection?.team_abbr,
          payloadPlay?.team_abbr,
        );
        const normalizedGoalieHomeName = firstString(
          (payload as Record<string, unknown>).goalie_home_name,
          driverInputs?.home_goalie_name,
        );
        const normalizedGoalieAwayName = firstString(
          (payload as Record<string, unknown>).goalie_away_name,
          driverInputs?.away_goalie_name,
        );
        const normalizedGoalieHomeStatus = normalizeGoalieStatus(
          (payload as Record<string, unknown>).goalie_home_status ??
            driverInputs?.home_goalie_certainty,
        );
        const normalizedGoalieAwayStatus = normalizeGoalieStatus(
          (payload as Record<string, unknown>).goalie_away_status ??
            driverInputs?.away_goalie_certainty,
        );
        const normalizedGameId = firstString(
          (payload as Record<string, unknown>).game_id,
          payloadPlay?.game_id,
        );
        const payloadDecision = toObject((payload as Record<string, unknown>).decision);
        const normalizedMu = firstNumber(
          (payload as Record<string, unknown>).mu,
          payloadPlay?.mu,
          (payload.projection as Record<string, unknown>)?.mu,
          (payload.projection as Record<string, unknown>)?.total,
          payloadDecision?.model_projection,
          payloadDecision?.projection,
          driverInputs?.mu,
          driverInputs?.projection_final,
          driverInputs?.projection_raw,
          driverInputs?.projected_total,
          driverInputs?.expected_total,
          driverInputs?.expected_1p_total,
        );
        const normalizedSuggestedLine = firstNumber(
          (payload as Record<string, unknown>).suggested_line,
          payloadPlay?.suggested_line,
          normalizedLine,
        );
        const normalizedThreshold = firstNumber(
          (payload as Record<string, unknown>).threshold,
          payloadPlay?.threshold,
        );
        const normalizedIsTrending =
          typeof (payload as Record<string, unknown>).is_trending === 'boolean'
            ? ((payload as Record<string, unknown>).is_trending as boolean)
            : typeof payloadPlay?.is_trending === 'boolean'
              ? (payloadPlay.is_trending as boolean)
              : undefined;
        const normalizedRoleGatePass =
          typeof (payload as Record<string, unknown>).role_gate_pass ===
          'boolean'
            ? ((payload as Record<string, unknown>).role_gate_pass as boolean)
            : typeof payloadPlay?.role_gate_pass === 'boolean'
              ? (payloadPlay.role_gate_pass as boolean)
              : undefined;
        const normalizedDataQuality = firstString(
          (payload as Record<string, unknown>).data_quality,
          payloadPlay?.data_quality,
        );
        const payloadDrivers: Record<string, unknown> | null =
          payload.drivers && typeof payload.drivers === 'object'
            ? (payload.drivers as Record<string, unknown>)
            : null;
        const normalizedL5Sog =
          normalizeNumberArray((payload as Record<string, unknown>).l5_sog) ??
          normalizeNumberArray(payloadPlay?.l5_sog) ??
          normalizeNumberArray(payloadDrivers?.l5_sog) ??
          normalizeNumberArray(
            (payload as Record<string, unknown>).last5_sog,
          ) ??
          normalizeNumberArray(
            (payload as Record<string, unknown>).last5Shots,
          ) ??
          normalizeNumberArray((payload as Record<string, unknown>).l5) ??
          extractShotsFromRecentGames(
            (payload as Record<string, unknown>).last5Games,
          ) ??
          extractShotsFromRecentGames(
            (payload as Record<string, unknown>).recent_games,
          ) ??
          extractShotsFromRecentGames(payloadPlay?.last5Games) ??
          extractShotsFromRecentGames(payloadPlay?.recent_games);
        const normalizedL5Mean = firstNumber(
          (payload as Record<string, unknown>).l5_mean,
          payloadPlay?.l5_mean,
          payloadDrivers?.l5_avg,
          (payload as Record<string, unknown>).last5_mean,
          payloadPlay?.last5_mean,
          (payload as Record<string, unknown>).last5_avg,
          payloadPlay?.last5_avg,
          normalizedL5Sog && normalizedL5Sog.length > 0
            ? normalizedL5Sog.reduce((acc, value) => acc + value, 0) /
                normalizedL5Sog.length
            : undefined,
        );
        const payloadPropDecision = toObject(
          (payload as Record<string, unknown>).prop_decision,
        );
        const payloadPlayPropDecision = toObject(payloadPlay?.prop_decision);
        const rawPropDecision = payloadPropDecision ?? payloadPlayPropDecision;
        const rawPropDecisionVerdict = firstString(
          rawPropDecision?.verdict,
          payloadPlayPropDecision?.verdict,
        );
        const normalizedPropDecisionVerdict =
          rawPropDecisionVerdict === 'PLAY' ||
          rawPropDecisionVerdict === 'WATCH' ||
          rawPropDecisionVerdict === 'NO_PLAY' ||
          rawPropDecisionVerdict === 'PROJECTION'
            ? (rawPropDecisionVerdict as
                | 'PLAY'
                | 'WATCH'
                | 'NO_PLAY'
                | 'PROJECTION')
            : null;
        const normalizedPropDecision = rawPropDecision &&
          normalizedPropDecisionVerdict
          ? {
              verdict: normalizedPropDecisionVerdict,
              lean_side:
                firstString(
                  rawPropDecision.lean_side,
                  payloadPlayPropDecision?.lean_side,
                ) === 'OVER' ||
                firstString(
                  rawPropDecision.lean_side,
                  payloadPlayPropDecision?.lean_side,
                ) === 'UNDER'
                  ? (firstString(
                      rawPropDecision.lean_side,
                      payloadPlayPropDecision?.lean_side,
                    ) as 'OVER' | 'UNDER')
                  : null,
              line:
                firstNumber(
                  rawPropDecision.line,
                  payloadPlayPropDecision?.line,
                ) ?? null,
              display_price:
                firstNumber(
                  rawPropDecision.display_price,
                  payloadPlayPropDecision?.display_price,
                ) ?? null,
              projection:
                firstNumber(
                  rawPropDecision.projection,
                  payloadPlayPropDecision?.projection,
                ) ?? null,
              line_delta:
                firstNumber(
                  rawPropDecision.line_delta,
                  payloadPlayPropDecision?.line_delta,
                ) ?? null,
              fair_prob:
                firstNumber(
                  rawPropDecision.fair_prob,
                  payloadPlayPropDecision?.fair_prob,
                ) ?? null,
              implied_prob:
                firstNumber(
                  rawPropDecision.implied_prob,
                  payloadPlayPropDecision?.implied_prob,
                ) ?? null,
              prob_edge_pp:
                firstNumber(
                  rawPropDecision.prob_edge_pp,
                  payloadPlayPropDecision?.prob_edge_pp,
                ) ?? null,
              ev:
                firstNumber(
                  rawPropDecision.ev,
                  payloadPlayPropDecision?.ev,
                ) ?? null,
              l5_mean:
                firstNumber(
                  rawPropDecision.l5_mean,
                  payloadPlayPropDecision?.l5_mean,
                  normalizedL5Mean,
                ) ?? null,
              l5_trend:
                firstString(
                  rawPropDecision.l5_trend,
                  payloadPlayPropDecision?.l5_trend,
                ) === 'uptrend' ||
                firstString(
                  rawPropDecision.l5_trend,
                  payloadPlayPropDecision?.l5_trend,
                ) === 'downtrend' ||
                firstString(
                  rawPropDecision.l5_trend,
                  payloadPlayPropDecision?.l5_trend,
                ) === 'stable'
                  ? (firstString(
                      rawPropDecision.l5_trend,
                      payloadPlayPropDecision?.l5_trend,
                    ) as 'uptrend' | 'downtrend' | 'stable')
                  : null,
              why:
                firstString(
                  rawPropDecision.why,
                  payloadPlayPropDecision?.why,
                ) ?? '',
              flags: Array.from(
                new Set(
                  [
                    ...(Array.isArray(rawPropDecision.flags)
                      ? rawPropDecision.flags
                      : []),
                    ...(Array.isArray(payloadPlayPropDecision?.flags)
                      ? payloadPlayPropDecision.flags
                      : []),
                  ].map((value) => String(value)),
                ),
              ),
            }
          : undefined;
        const decimalToAmerican = (dec: number | null | undefined): number | null => {
          if (dec == null || dec <= 1) return null;
          return dec >= 2 ? Math.round((dec - 1) * 100) : Math.round(-100 / (dec - 1));
        };
        const rawPriceOver = firstNumber(
            (payload as Record<string, unknown>).over_price,
            (payload as Record<string, unknown>).market_price_over,
            payloadPlay?.over_price,
            payloadPlay?.market_price_over,
          ) ?? null;
        const rawPriceUnder = firstNumber(
            (payload as Record<string, unknown>).under_price,
            (payload as Record<string, unknown>).market_price_under,
            payloadPlay?.under_price,
            payloadPlay?.market_price_under,
          ) ?? null;
        // Prices stored as decimal odds (e.g. 1.83) — convert to American (-122)
        // Math.abs() handles negative American prices (-110, -115) which would
        // otherwise fail the > 10 check and be erroneously re-fed into decimalToAmerican()
        const normalizedPriceOver = rawPriceOver != null && Math.abs(rawPriceOver) > 10
          ? rawPriceOver  // already American (handles both +110 and -110)
          : decimalToAmerican(rawPriceOver);
        const normalizedPriceUnder = rawPriceUnder != null && Math.abs(rawPriceUnder) > 10
          ? rawPriceUnder  // already American (handles both +110 and -110)
          : decimalToAmerican(rawPriceUnder);
        const normalizedMarketBookmaker =
          firstString(
            (payload as Record<string, unknown>).market_bookmaker,
            payloadPlay?.market_bookmaker,
          ) ?? null;
        const payloadProjection = toObject(payload.projection);
        const payloadPlayProjection = toObject(payloadPlayObj?.projection);
        const normalizedProjectedTotal = firstNumber(
          payloadMarketContextProjection?.total,
          payloadMarketContextProjection?.team_total,
          payloadProjection?.total,
          payloadPlayProjection?.total,
          payloadMarketContextProjection?.projected_total,
          payloadMarketContextProjection?.projected_team_total,
          payloadProjection?.projected_total,
          payloadPlayProjection?.projected_total,
          payloadDecision?.model_projection,
          payloadDecision?.projection,
          driverInputs?.projection_final,
          driverInputs?.projection_raw,
          driverInputs?.projected_total,
          driverInputs?.expected_total,
          driverInputs?.expected_1p_total,
        );
        const normalizedEdge = firstNumber(
          payload.edge,
          payloadPlayObj?.edge,
          driverInputs?.projection_delta,
          driverInputs?.edge,
        );
        const normalizedEdgePoints = firstNumber(
          (payload as Record<string, unknown>).edge_points,
          payloadPlayObj?.edge_points,
          payloadMarketContextProjection?.edge_points,
        );
        // Prefer canonical decision_v2 values for wave-1 eligible rows;
        // legacy payload fields (p_fair, model_prob) may be stale pre-V2 values.
        const normalizedPFair = firstNumber(
          normalizedDecisionV2?.fair_prob,
          (payload as Record<string, unknown>).p_fair,
          payloadPlayObj?.p_fair,
        );
        const normalizedPImplied = firstNumber(
          normalizedDecisionV2?.implied_prob,
          (payload as Record<string, unknown>).p_implied,
          payloadPlayObj?.p_implied,
        );
        const normalizedEdgePct = firstNumber(
          normalizedDecisionV2?.edge_delta_pct,
          normalizedDecisionV2?.edge_pct,
          (payload as Record<string, unknown>).edge_pct,
          payloadPlayObj?.edge_pct,
        );
        const projectionWinProbHome = firstNumber(
          payloadMarketContextProjection?.win_prob_home,
          payloadProjection?.win_prob_home,
          payloadPlayProjection?.win_prob_home,
        );
        let normalizedModelProb = firstNumber(
          normalizedDecisionV2?.fair_prob,
          (payload as Record<string, unknown>).model_prob,
          payloadPlayObj?.model_prob,
          normalizedPFair,
        );
        if (
          normalizedModelProb === undefined &&
          normalizedMarketType === 'MONEYLINE' &&
          typeof projectionWinProbHome === 'number'
        ) {
          normalizedModelProb =
            normalizedSelectionSide === 'AWAY'
              ? 1 - projectionWinProbHome
              : projectionWinProbHome;
        }
        if (
          typeof normalizedModelProb === 'number' &&
          (!Number.isFinite(normalizedModelProb) ||
            normalizedModelProb < 0 ||
            normalizedModelProb > 1)
        ) {
          normalizedModelProb = undefined;
        }
        const normalizedLineSource = firstString(
          (payload as Record<string, unknown>).line_source,
          payloadPlayObj?.line_source,
          payloadMarketContextWager?.line_source,
          payloadPlayObj?.pricing_trace &&
            typeof payloadPlayObj.pricing_trace === 'object'
            ? (payloadPlayObj.pricing_trace as Record<string, unknown>)
                .line_source
            : undefined,
          normalizedDecisionV2?.pricing_trace?.line_source,
        );
        const normalizedPriceSource = firstString(
          (payload as Record<string, unknown>).price_source,
          payloadPlayObj?.price_source,
          payloadMarketContextWager?.price_source,
          payloadPlayObj?.pricing_trace &&
            typeof payloadPlayObj.pricing_trace === 'object'
            ? (payloadPlayObj.pricing_trace as Record<string, unknown>)
                .price_source
            : undefined,
          normalizedDecisionV2?.pricing_trace?.price_source,
        );
        // Extract NHL model v2 guard flags (SYNTHETIC_LINE, PROJECTION_ANOMALY)
        // from payload.decision.v2.flags so they surface alongside reason codes.
        const v2GuardFlags: unknown[] = (() => {
          const dec = toObject(
            (payload as Record<string, unknown>).decision,
          );
          const v2 = toObject(dec?.v2);
          return Array.isArray(v2?.flags) ? (v2.flags as unknown[]) : [];
        })();
        const combinedReasonCodes = [
          ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
          ...(Array.isArray(payloadPlay?.reason_codes)
            ? payloadPlay.reason_codes
            : []),
          ...(Array.isArray(driverInputs?.reason_codes)
            ? driverInputs.reason_codes
            : []),
          ...v2GuardFlags,
        ].map((value) => String(value));
        const combinedTags = [
          ...(Array.isArray(payload.tags) ? payload.tags : []),
          ...(Array.isArray(payloadPlay?.tags) ? payloadPlay.tags : []),
        ].map((value) => String(value));
        if (ahRemappedFromProp) {
          combinedReasonCodes.push(SOCCER_AH_REMAP_TOKEN);
          combinedTags.push(SOCCER_AH_REMAP_TOKEN);
        }
        const dedupedReasonCodes = Array.from(new Set(combinedReasonCodes));
        const dedupedTags = Array.from(new Set(combinedTags));

        const ftSpreadDisplayOverrideActive =
          isFtTrendCard &&
          (normalizedDisplaySelectionSide === 'HOME' ||
            normalizedDisplaySelectionSide === 'AWAY') &&
          normalizedDisplaySelectionSide !== normalizedSelectionSide;

        const resolvedActionBase: Play['action'] | undefined =
          (ftSpreadDisplayOverrideActive &&
          normalizedAction !== 'FIRE' &&
          normalizedAction !== 'HOLD' &&
          normalizedClassification !== 'BASE' &&
          normalizedClassification !== 'LEAN' &&
          normalizedStatus !== 'FIRE' &&
          normalizedStatus !== 'WATCH'
            ? actionFromTier(normalizedTier)
            : undefined) ??
          normalizedAction ??
          actionFromClassification(normalizedClassification) ??
          (normalizedStatus === 'FIRE'
            ? 'FIRE'
            : normalizedStatus === 'WATCH'
              ? 'HOLD'
              : normalizedStatus === 'PASS'
                ? 'PASS'
                : undefined);
        const resolvedAction: Play['action'] | undefined =
          ftSpreadDisplayOverrideActive && resolvedActionBase === 'PASS'
            ? actionFromTier(normalizedTier) ?? resolvedActionBase
            : resolvedActionBase;
        const resolvedClassification: Play['classification'] | undefined =
          normalizedClassification ?? classificationFromAction(resolvedAction);
        const resolvedStatus: Play['status'] | undefined =
          statusFromAction(resolvedAction) ?? normalizedStatus;
        const onePModelCall =
          cardRow.card_type === 'nhl-pace-1p'
            ? deriveNhl1PModelCall(dedupedReasonCodes, normalizedPrediction)
            : undefined;
        const onePBetStatus =
          cardRow.card_type === 'nhl-pace-1p'
            ? (resolvedAction ?? null)
            : undefined;

        const play: Play = {
          source_card_id: cardRow.id,
          cardType: cardRow.card_type,
          cardTitle: cardRow.card_title,
          prediction: normalizedPrediction,
          confidence: normalizedConfidence ?? 0,
          tier: normalizedTier,
          reasoning:
            typeof payload.reasoning === 'string'
              ? payload.reasoning
              : typeof payloadPlay?.reasoning === 'string'
                ? payloadPlay.reasoning
                : '',
          evPassed:
            payload.ev_passed === true || payloadPlay?.ev_passed === true,
          driverKey:
            payload.driver !== null &&
            typeof payload.driver === 'object' &&
            'key' in (payload.driver as object)
              ? String((payload.driver as Record<string, unknown>).key)
              : '',
          projectedTotal:
            typeof normalizedProjectedTotal === 'number'
              ? normalizedProjectedTotal
              : null,
          edge: typeof normalizedEdge === 'number' ? normalizedEdge : null,
          edge_points:
            typeof normalizedEdgePoints === 'number'
              ? normalizedEdgePoints
              : null,
          odds_context:
            payload.odds_context &&
            typeof payload.odds_context === 'object'
              ? (payload.odds_context as Record<string, unknown>)
              : null,
          p_fair: typeof normalizedPFair === 'number' ? normalizedPFair : null,
          p_implied:
            typeof normalizedPImplied === 'number' ? normalizedPImplied : null,
          edge_pct:
            typeof normalizedEdgePct === 'number' ? normalizedEdgePct : null,
          model_prob: normalizedModelProb,
          projection: {
            margin_home:
              firstNumber(
                payloadMarketContextProjection?.margin_home,
                payloadProjection?.margin_home,
                payloadPlayProjection?.margin_home,
                payloadMarketContextProjection?.projected_margin,
                payloadProjection?.projected_margin,
                payloadPlayProjection?.projected_margin,
              ) ?? null,
            total:
              firstNumber(
                payloadMarketContextProjection?.total,
                payloadProjection?.total,
                payloadPlayProjection?.total,
                payloadMarketContextProjection?.projected_total,
                payloadProjection?.projected_total,
                payloadPlayProjection?.projected_total,
                driverInputs?.projection_final,
                driverInputs?.projection_raw,
                driverInputs?.projected_total,
                driverInputs?.expected_total,
                driverInputs?.expected_1p_total,
              ) ?? null,
            team_total:
              firstNumber(
                payloadMarketContextProjection?.team_total,
                payloadProjection?.team_total,
                payloadPlayProjection?.team_total,
                payloadMarketContextProjection?.projected_team_total,
                payloadProjection?.projected_team_total,
                payloadPlayProjection?.projected_team_total,
              ) ?? null,
            win_prob_home:
              firstNumber(
                payloadMarketContextProjection?.win_prob_home,
                payloadProjection?.win_prob_home,
                payloadPlayProjection?.win_prob_home,
              ) ?? null,
            score_home:
              firstNumber(
                payloadMarketContextProjection?.score_home,
                payloadProjection?.score_home,
                payloadPlayProjection?.score_home,
                payloadMarketContextProjection?.projected_score_home,
                payloadProjection?.projected_score_home,
                payloadPlayProjection?.projected_score_home,
              ) ?? null,
            score_away:
              firstNumber(
                payloadMarketContextProjection?.score_away,
                payloadProjection?.score_away,
                payloadPlayProjection?.score_away,
                payloadMarketContextProjection?.projected_score_away,
                payloadProjection?.projected_score_away,
                payloadPlayProjection?.projected_score_away,
              ) ?? null,
            projected_margin:
              firstNumber(
                payloadMarketContextProjection?.projected_margin,
                payloadProjection?.projected_margin,
                payloadPlayProjection?.projected_margin,
                payloadMarketContextProjection?.margin_home,
                payloadProjection?.margin_home,
                payloadPlayProjection?.margin_home,
              ) ?? null,
            projected_total:
              firstNumber(
                payloadMarketContextProjection?.projected_total,
                payloadProjection?.projected_total,
                payloadPlayProjection?.projected_total,
                payloadMarketContextProjection?.total,
                payloadProjection?.total,
                payloadPlayProjection?.total,
                driverInputs?.projection_final,
                driverInputs?.projection_raw,
                driverInputs?.projected_total,
                driverInputs?.expected_total,
                driverInputs?.expected_1p_total,
              ) ?? null,
            projected_team_total:
              firstNumber(
                payloadMarketContextProjection?.projected_team_total,
                payloadProjection?.projected_team_total,
                payloadPlayProjection?.projected_team_total,
                payloadMarketContextProjection?.team_total,
                payloadProjection?.team_total,
                payloadPlayProjection?.team_total,
              ) ?? null,
            projected_score_home:
              firstNumber(
                payloadMarketContextProjection?.projected_score_home,
                payloadProjection?.projected_score_home,
                payloadPlayProjection?.projected_score_home,
                payloadMarketContextProjection?.score_home,
                payloadProjection?.score_home,
                payloadPlayProjection?.score_home,
              ) ?? null,
            projected_score_away:
              firstNumber(
                payloadMarketContextProjection?.projected_score_away,
                payloadProjection?.projected_score_away,
                payloadPlayProjection?.projected_score_away,
                payloadMarketContextProjection?.score_away,
                payloadProjection?.score_away,
                payloadPlayProjection?.score_away,
              ) ?? null,
          },
          status: resolvedStatus,
          // Canonical decision fields (preferred over legacy status field)
          classification: resolvedClassification,
          action: resolvedAction,
          pass_reason_code:
            normalizePassReasonCode(
              payload.pass_reason_code ??
                payload.pass_reason ??
                payloadPlay?.pass_reason_code ??
                payloadPlay?.pass_reason,
            ),
          one_p_model_call: onePModelCall,
          one_p_bet_status: onePBetStatus,
          goalie_home_name: normalizedGoalieHomeName ?? null,
          goalie_away_name: normalizedGoalieAwayName ?? null,
          goalie_home_status: normalizedGoalieHomeStatus ?? null,
          goalie_away_status: normalizedGoalieAwayStatus ?? null,
          decision_v2: normalizedDecisionV2,
          kind:
            payload.kind === 'PLAY' || payload.kind === 'EVIDENCE'
              ? (payload.kind as 'PLAY' | 'EVIDENCE')
              : payloadPlay?.kind === 'PLAY' || payloadPlay?.kind === 'EVIDENCE'
                ? (payloadPlay.kind as 'PLAY' | 'EVIDENCE')
                : undefined,
          canonical_market_key: firstString(
            payload.canonical_market_key,
            payloadPlay?.canonical_market_key,
            payloadMarketContext?.canonical_market_key,
          ),
          market_type:
            normalizedMarketType !== undefined
              ? normalizedMarketType
              : typeof (payload.recommendation as Record<string, unknown>)
                    ?.type === 'string'
                ? (() => {
                    const recommendationType = String(
                      (payload.recommendation as Record<string, unknown>).type,
                    ).toLowerCase();
                    if (recommendationType.includes('total')) return 'TOTAL';
                    if (recommendationType.includes('spread')) return 'SPREAD';
                    if (
                      recommendationType.includes('moneyline') ||
                      recommendationType.includes('ml')
                    )
                      return 'MONEYLINE';
                    if (
                      recommendationType.includes('prop') ||
                      recommendationType.includes('player')
                    )
                      return 'PROP';
                    return undefined;
                  })()
                : typeof payload.recommended_bet_type === 'string'
                  ? (() => {
                      const betType = String(
                        payload.recommended_bet_type,
                      ).toLowerCase();
                      if (betType === 'total') return 'TOTAL';
                      if (betType === 'spread') return 'SPREAD';
                      if (betType === 'moneyline' || betType === 'ml')
                        return 'MONEYLINE';
                      if (betType === 'prop' || betType === 'player_prop')
                        return 'PROP';
                      return undefined;
                    })()
                  : // Check legacy 'market' field
                    payload.market === 'ML' || payload.market === 'MONEYLINE'
                    ? 'MONEYLINE'
                    : payload.market === 'SPREAD'
                      ? 'SPREAD'
                      : payload.market === 'TOTAL'
                        ? 'TOTAL'
                        : // Infer from selection side
                          normalizedSelectionSide === 'OVER' ||
                            normalizedSelectionSide === 'UNDER'
                          ? 'TOTAL'
                          : normalizedSelectionSide === 'HOME' ||
                              normalizedSelectionSide === 'AWAY'
                            ? 'SPREAD'
                            : undefined,
          selection: {
            side: normalizedDisplaySelectionSide,
            team: normalizedSelectionTeam,
          },
          line: normalizedLine,
          price: normalizedPrice,
          ft_trend_context: normalizedFtTrendContext,
          line_source: normalizedLineSource ?? null,
          price_source: normalizedPriceSource ?? null,
          market_context: payloadMarketContext
            ? {
                version: firstString(payloadMarketContext.version) ?? 'v1',
                market_type:
                  isSoccerAhPayload
                    ? 'SPREAD'
                    : firstString(payloadMarketContext.market_type) ??
                      normalizedMarketType ??
                      null,
                selection_side:
                  firstString(payloadMarketContext.selection_side) ??
                  normalizedDisplaySelectionSide,
                selection_team:
                  firstString(payloadMarketContext.selection_team) ??
                  normalizedSelectionTeam ??
                  null,
                projection: payloadMarketContextProjection
                  ? {
                      margin_home:
                        firstNumber(
                          payloadMarketContextProjection.margin_home,
                        ) ?? null,
                      total:
                        firstNumber(payloadMarketContextProjection.total) ??
                        null,
                      team_total:
                        firstNumber(
                          payloadMarketContextProjection.team_total,
                        ) ?? null,
                      win_prob_home:
                        firstNumber(
                          payloadMarketContextProjection.win_prob_home,
                        ) ?? null,
                      score_home:
                        firstNumber(
                          payloadMarketContextProjection.score_home,
                        ) ?? null,
                      score_away:
                        firstNumber(
                          payloadMarketContextProjection.score_away,
                        ) ?? null,
                    }
                  : undefined,
                wager: payloadMarketContextWager
                  ? {
                      called_line:
                        firstNumber(payloadMarketContextWager.called_line) ??
                        normalizedLine ??
                        null,
                      called_price:
                        firstNumber(payloadMarketContextWager.called_price) ??
                        normalizedPrice ??
                        null,
                      line_source:
                        firstString(payloadMarketContextWager.line_source) ??
                        normalizedLineSource ??
                        null,
                      price_source:
                        firstString(payloadMarketContextWager.price_source) ??
                        normalizedPriceSource ??
                        null,
                    }
                  : undefined,
              }
            : undefined,
          reason_codes: dedupedReasonCodes,
          projection_inputs_complete:
            typeof payload.projection_inputs_complete === 'boolean'
              ? payload.projection_inputs_complete
              : typeof payloadPlay?.projection_inputs_complete === 'boolean'
                ? payloadPlay.projection_inputs_complete
                : null,
          missing_inputs: Array.from(
            new Set([
              ...(Array.isArray(payload.missing_inputs)
                ? payload.missing_inputs
                : []),
              ...(Array.isArray(payloadPlay?.missing_inputs)
                ? payloadPlay.missing_inputs
                : []),
            ].map((value) => String(value))),
          ),
          source_mapping_ok:
            typeof payload.source_mapping_ok === 'boolean'
              ? payload.source_mapping_ok
              : typeof payloadPlay?.source_mapping_ok === 'boolean'
                ? payloadPlay.source_mapping_ok
                : null,
          source_mapping_failures: Array.from(
            new Set([
              ...(Array.isArray(payload.source_mapping_failures)
                ? payload.source_mapping_failures
                : []),
              ...(Array.isArray(payloadPlay?.source_mapping_failures)
                ? payloadPlay.source_mapping_failures
                : []),
            ].map((value) => String(value))),
          ),
          tags: dedupedTags,
          run_id: normalizedRunId,
          created_at: normalizedCreatedAt,
          player_id: normalizedPlayerId,
          player_name: normalizedPlayerName,
          team_abbr: normalizedTeamAbbr,
          game_id: normalizedGameId ?? cardRow.game_id,
          mu: normalizedMu ?? null,
          suggested_line: normalizedSuggestedLine ?? null,
          threshold: normalizedThreshold ?? null,
          is_trending: normalizedIsTrending,
          role_gate_pass: normalizedRoleGatePass,
          data_quality: normalizedDataQuality ?? null,
          l5_sog: normalizedL5Sog ?? null,
          l5_mean: normalizedL5Mean ?? null,
          market_price_over: normalizedPriceOver,
          market_price_under: normalizedPriceUnder,
          market_bookmaker: normalizedMarketBookmaker,
          prop_decision: normalizedPropDecision,
          consistency:
            payload.consistency && typeof payload.consistency === 'object'
              ? {
                  total_bias:
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'OK' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'INSUFFICIENT_DATA' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'CONFLICTING_SIGNALS' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'VOLATILE_ENV' ||
                    (payload.consistency as Record<string, unknown>)
                      .total_bias === 'UNKNOWN'
                      ? ((payload.consistency as Record<string, unknown>)
                          .total_bias as
                          | 'OK'
                          | 'INSUFFICIENT_DATA'
                          | 'CONFLICTING_SIGNALS'
                          | 'VOLATILE_ENV'
                          | 'UNKNOWN')
                      : undefined,
                }
              : payloadPlay?.consistency &&
                  typeof payloadPlay.consistency === 'object'
                ? {
                    total_bias:
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'OK' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'INSUFFICIENT_DATA' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'CONFLICTING_SIGNALS' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'VOLATILE_ENV' ||
                      (payloadPlay.consistency as Record<string, unknown>)
                        .total_bias === 'UNKNOWN'
                        ? ((payloadPlay.consistency as Record<string, unknown>)
                            .total_bias as
                            | 'OK'
                            | 'INSUFFICIENT_DATA'
                            | 'CONFLICTING_SIGNALS'
                            | 'VOLATILE_ENV'
                            | 'UNKNOWN')
                        : undefined,
                  }
                : undefined,
        };

        const canonicalGameId = canonicalGameIdForRow;
        const playSport =
          normalizeSport(
            firstString(
              payload.sport,
              payloadPlay?.sport,
              payloadPlayObj?.sport,
            ),
          ) || normalizeSport(sportByGameId.get(canonicalGameId));
        const parsedSport = playSport ?? rowSport;
        const parsedMarket =
          normalizedMarketType ?? inferMarketFromCardType(cardRow.card_type);

        const isNhlPropPlay =
          parsedSport === 'NHL' &&
          parsedMarket === 'PROP' &&
          (cardRow.card_type === 'nhl-player-shots' ||
            cardRow.card_type === 'nhl-player-shots-1p' ||
            play.market_type === 'PROP');
        if (isNhlPropPlay) {
          const playerId = firstString(play.player_id);
          const playerName = normalizePlayerNameKey(play.player_name);
          const isInjured =
            (playerId ? injuredNhlPlayerIds.has(playerId) : false) ||
            (playerName ? injuredNhlPlayerNames.has(playerName) : false);
          if (isInjured) {
            continue;
          }

          const dedupeIdentity = playerId || playerName || 'unknown';
          const dedupePropType =
            firstString(payloadPlayObj?.prop_type, payloadPlayObj?.market, play.market_type) ||
            'prop';
          const dedupePeriod = firstString(payloadPlayObj?.period) || 'full_game';
          const dedupeSide =
            normalizeSelectionSide(
              play.selection?.side ?? play.prediction,
            ) || 'NONE';
          const dedupeKey = [
            canonicalGameId,
            cardRow.card_type,
            dedupeIdentity,
            dedupePropType,
            dedupePeriod,
            dedupeSide,
          ].join('|');

          if (seenNhlShotsPlayKeys.has(dedupeKey)) {
            continue;
          }
          seenNhlShotsPlayKeys.add(dedupeKey);

          // Ensure market_type is PROP so the no-market-type guard below doesn't
          // force this play to INFO/EVIDENCE before it reaches the props output.
          play.market_type = 'PROP';
        }

        // MLB pitcher K prop plays — deduplicate by (gameId, pitcher identity, side)
        // and ensure they flow through the props output path.
        const isMlbPitcherKPlay =
          parsedSport === 'MLB' &&
          parsedMarket === 'PROP' &&
          (cardRow.card_type === 'mlb-pitcher-k' ||
            play.market_type === 'PROP');
        if (isMlbPitcherKPlay) {
          const pitcherId = firstString(play.player_id);
          const pitcherName =
            normalizePlayerNameKey(play.player_name) ||
            normalizePlayerNameKey(
              (payloadPlay as Record<string, unknown> | null)?.pitcher_name,
            );
          const dedupeIdentity = pitcherId || pitcherName || 'unknown';
          const dedupeSide =
            normalizeSelectionSide(
              play.selection?.side ?? play.prediction,
            ) || 'NONE';
          const dedupeKey = [
            canonicalGameId,
            cardRow.card_type,
            dedupeIdentity,
            dedupeSide,
          ].join('|');

          if (seenMlbPitcherKPlayKeys.has(dedupeKey)) {
            continue;
          }
          seenMlbPitcherKPlayKeys.add(dedupeKey);

          // Ensure market_type is PROP so the no-market-type guard doesn't
          // force this play to INFO/EVIDENCE before reaching the props output.
          play.market_type = 'PROP';
        }

        incrementStageCounter(
          stageCounters,
          'parsed_rows',
          parsedSport,
          parsedMarket,
        );

        const fallbackKind =
          play.kind ?? (play.market_type === 'INFO' ? 'EVIDENCE' : 'PLAY');
        const kindContractResult = applyCardTypeKindContract(
          parsedSport,
          cardRow.card_type,
          fallbackKind,
        );
        play.kind = kindContractResult.kind;
        if (kindContractResult.downgradedOutOfContractPlay) {
          play.reason_codes = Array.from(
            new Set([
              ...(play.reason_codes ?? []),
              'PASS_CARD_TYPE_OUT_OF_CONTRACT',
            ]),
          );
          const key = `${normalizeCounterSport(parsedSport)}|${cardRow.card_type}`;
          bumpCount(outOfContractPlayDowngrades, key);
        }

        const wave1Eligible = isWave1EligibleRow(
          playSport,
          play.kind,
          play.market_type,
        );

        // PROP plays (nhl-player-shots etc.) carry action/status directly in the
        // payload — they don't use the wave-1 decision_v2 pipeline.  Skip the
        // wave-1 path for them so they aren't silently dropped.
        const isPropPlay = play.market_type === 'PROP';

        if (wave1Eligible && !isPropPlay) {
          // Wave-1 rows MUST have decision_v2 from worker - skip if missing
          if (!play.decision_v2) {
            incrementStageCounter(
              stageCounters,
              'wave1_skipped_no_d2',
              parsedSport,
              parsedMarket,
            );
            continue; // Skip plays without decision_v2 in wave-1
          }
          applyWave1DecisionFields(play);
          play.reason_codes = Array.from(
            new Set([
              ...(play.reason_codes ?? []),
              play.decision_v2.primary_reason_code,
            ]),
          );
        } else if (!play.consistency?.total_bias) {
          const totalDecision =
            payload.all_markets &&
            typeof payload.all_markets === 'object' &&
            (payload.all_markets as Record<string, unknown>).TOTAL &&
            typeof (payload.all_markets as Record<string, unknown>).TOTAL ===
              'object'
              ? ((payload.all_markets as Record<string, unknown>)
                  .TOTAL as Record<string, unknown>)
              : null;
          const decisionStatus =
            typeof totalDecision?.status === 'string'
              ? totalDecision.status
              : null;
          const decisionLine =
            typeof (
              totalDecision?.best_candidate as
                | Record<string, unknown>
                | undefined
            )?.line === 'number';
          const decisionEdge = typeof totalDecision?.edge === 'number';
          play.consistency = {
            total_bias:
              decisionStatus &&
              decisionStatus !== 'PASS' &&
              decisionLine &&
              decisionEdge
                ? 'OK'
                : 'INSUFFICIENT_DATA',
          };
        }

        if (!play.market_type) {
          if (play.kind === 'PLAY') {
            play.reason_codes = Array.from(
              new Set([...(play.reason_codes ?? []), 'PASS_MISSING_MARKET_TYPE']),
            );
          }
          play.market_type = 'INFO';
          play.kind = 'EVIDENCE';
          play.reason_codes = Array.from(
            new Set([...(play.reason_codes ?? []), 'PASS_UNREPAIRABLE_LEGACY']),
          );
        }

        if (!wave1Eligible && !hasMinimumViability(play, play.market_type)) {
          play.market_type = 'INFO';
          play.kind = 'EVIDENCE';
          play.reason_codes = Array.from(
            new Set([...(play.reason_codes ?? []), 'PASS_UNREPAIRABLE_LEGACY']),
          );
        }

        if (!gameConsistencyMap.has(canonicalGameId)) {
          gameConsistencyMap.set(
            canonicalGameId,
            play.consistency ?? { total_bias: 'UNKNOWN' },
          );
        }

        const existing = playsMap.get(canonicalGameId);
        if (existing) {
          existing.push(play);
        } else {
          playsMap.set(canonicalGameId, [play]);
        }
        playByCardId.set(cardRow.id, play);

        if (play.kind === 'PLAY') {
          incrementStageCounter(
            stageCounters,
            'plays_emitted',
            parsedSport,
            play.market_type,
          );
          registerGameWithPlayableMarket(
            gamesWithPlayableMarkets,
            parsedSport,
            play.market_type,
            canonicalGameId,
          );
        }
      }
      perf.cardsParseMs = Date.now() - cardsParseStartedAt;

      // WI-0584: Secondary dedup — keep only the most-recent card per (gameId, playerId, propType, side).
      // The SQL query returns rows newest-first (ORDER BY created_at DESC, id DESC), so the first
      // occurrence of a tuple is always the newest card.
      {
        const seenPropTupleKeys = new Set<string>();
        for (const [gid, gamePlays] of playsMap) {
          const dedupedPropPlays = gamePlays.filter((p) => {
            const isNhlProp =
              p.cardType === 'nhl-player-shots' ||
              p.cardType === 'nhl-player-shots-1p' ||
              p.market_type === 'PROP';
            if (!isNhlProp) return true;
            const pid = p.player_id ?? p.player_name ?? 'unknown';
            const pType = p.market_type ?? 'prop';
            const side =
              normalizeSelectionSide(p.selection?.side ?? p.prediction) ?? 'NONE';
            const tupleKey = `${gid}|${pid}|${pType}|${side}`;
            if (seenPropTupleKeys.has(tupleKey)) return false;
            seenPropTupleKeys.add(tupleKey);
            return true;
          });
          playsMap.set(gid, dedupedPropPlays);
        }
      }

      for (const displayLogRow of displayLogRows) {
        const canonicalGameId =
          externalToCanonicalMap.get(displayLogRow.game_id) ?? displayLogRow.game_id;
        const candidate = playByCardId.get(displayLogRow.pick_id);
        if (!candidate) continue;
        if ((candidate.kind ?? 'PLAY') !== 'PLAY') continue;
        const officialStatus =
          candidate.decision_v2?.official_status ??
          (candidate.action === 'FIRE'
            ? 'PLAY'
            : candidate.action === 'HOLD'
              ? 'LEAN'
              : candidate.status === 'FIRE'
                ? 'PLAY'
                : candidate.status === 'WATCH'
                  ? 'LEAN'
                  : 'PASS');
        if (officialStatus !== 'PLAY' && officialStatus !== 'LEAN') continue;

        // officialTier: PLAY=2, LEAN=1, other=0
        const officialTier = officialStatus === 'PLAY' ? 2 : officialStatus === 'LEAN' ? 1 : 0;

        const existing = truePlayMap.get(canonicalGameId);
        if (existing) {
          const existingStatus =
            existing.decision_v2?.official_status ??
            (existing.action === 'FIRE'
              ? 'PLAY'
              : existing.action === 'HOLD'
                ? 'LEAN'
                : existing.status === 'FIRE'
                  ? 'PLAY'
                  : existing.status === 'WATCH'
                    ? 'LEAN'
                    : 'PASS');
          const existingTier = existingStatus === 'PLAY' ? 2 : existingStatus === 'LEAN' ? 1 : 0;
          // Only replace if candidate is strictly better tier, or same tier with higher edge
          const candidateEdge =
            resolveDecisionV2EdgePct(candidate.decision_v2) ??
            candidate.edge ??
            -Infinity;
          const existingEdge =
            resolveDecisionV2EdgePct(existing.decision_v2) ??
            existing.edge ??
            -Infinity;
          if (officialTier < existingTier) continue;
          if (officialTier === existingTier && candidateEdge <= existingEdge) continue;
        }
        truePlayMap.set(canonicalGameId, candidate);
      }
    }

    for (const [sport, marketMap] of gamesWithPlayableMarkets.entries()) {
      const allGames = new Set<string>();
      for (const [market, gameIdsForMarket] of marketMap.entries()) {
        incrementStageCounter(
          stageCounters,
          'games_with_plays',
          sport,
          market,
          gameIdsForMarket.size,
        );
        for (const gameId of gameIdsForMarket) {
          allGames.add(gameId);
        }
      }
      incrementStageCounter(
        stageCounters,
        'games_with_plays',
        sport,
        COUNTER_ALL_MARKET,
        allGames.size,
      );
    }

    const pregameRowsDroppedNoOddsNoPlays =
      lifecycleMode === 'pregame'
        ? rows.reduce((count, row) => {
            const hasOdds =
              row.h2h_home !== null ||
              row.h2h_away !== null ||
              row.total !== null ||
              row.spread_home !== null ||
              row.spread_away !== null;
            const hasPlays = (playsMap.get(row.game_id)?.length ?? 0) > 0;
            const hasIngestFailure = Boolean(row.ingest_failure_reason_code);
            return !hasOdds && !hasPlays && !hasIngestFailure ? count + 1 : count;
          }, 0)
        : 0;

    const responseRows =
      lifecycleMode === 'pregame'
        ? rows.filter((row) => {
            const hasOdds =
              row.h2h_home !== null ||
              row.h2h_away !== null ||
              row.total !== null ||
              row.spread_home !== null ||
              row.spread_away !== null;
            const hasPlays = (playsMap.get(row.game_id)?.length ?? 0) > 0;
            const hasIngestFailure = Boolean(row.ingest_failure_reason_code);
            return hasOdds || hasPlays || hasIngestFailure;
          })
        : rows;

    // Deduplicate: when the schedule ingest seeds games with one game_id and the
    // odds ingest later creates a second game_id for the same real-world matchup
    // (same sport + teams + calendar date), both rows survive the filter above —
    // the stale seed via old card_payloads, the new row via fresh odds.
    // Resolution: keep the row with the most recent odds_captured_at; merge the
    // loser's playsMap entries onto the winner so its card decisions are preserved.
    const deduplicatedRows = (() => {
      const byMatchup = new Map<string, GameRow[]>();
      for (const row of responseRows) {
        const key = `${row.sport}|${row.away_team.toUpperCase()}|${row.home_team.toUpperCase()}|${row.game_time_utc.substring(0, 10)}`;
        const bucket = byMatchup.get(key);
        if (bucket) {
          bucket.push(row);
        } else {
          byMatchup.set(key, [row]);
        }
      }

      const result: GameRow[] = [];
      for (const group of byMatchup.values()) {
        if (group.length === 1) {
          result.push(group[0]);
          continue;
        }
        // Sort: row with most recent odds first; fall back to created_at
        group.sort((a, b) => {
          const aKey = a.odds_captured_at ?? a.created_at;
          const bKey = b.odds_captured_at ?? b.created_at;
          return bKey < aKey ? -1 : bKey > aKey ? 1 : 0;
        });
        const winner = group[0];
        // Merge playsMap entries from each loser onto the winner
        for (let i = 1; i < group.length; i++) {
          const loserId = group[i].game_id;
          const loserPlays = playsMap.get(loserId);
          if (loserPlays && loserPlays.length > 0) {
            const winnerPlays = playsMap.get(winner.game_id);
            if (winnerPlays) {
              winnerPlays.push(...loserPlays);
            } else {
              playsMap.set(winner.game_id, [...loserPlays]);
            }
            playsMap.delete(loserId);
          }
        }
        result.push(winner);
      }
      return result;
    })();

    const data = deduplicatedRows.map((row) => {
      const hasOdds =
        row.h2h_home !== null ||
        row.h2h_away !== null ||
        row.total !== null ||
        row.spread_home !== null ||
        row.spread_away !== null;

      const displayStatus = deriveDisplayStatus(lifecycleMode);

      return {
        id: row.id,
        gameId: row.game_id,
        sport: row.sport,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        gameTimeUtc: row.game_time_utc,
        status: row.status,
        lifecycle_mode: lifecycleMode,
        display_status: displayStatus,
        createdAt: row.created_at,
        projection_inputs_complete: row.projection_inputs_complete,
        projection_missing_inputs: row.projection_missing_inputs,
        source_mapping_ok: row.source_mapping_ok,
        source_mapping_failures: row.source_mapping_failures,
        ingest_failure_reason_code: row.ingest_failure_reason_code,
        ingest_failure_reason_detail: row.ingest_failure_reason_detail,
        odds: hasOdds
          ? {
              h2hHome: row.h2h_home,
              h2hAway: row.h2h_away,
              h2hBook: row.h2h_book ?? null,
              h2hHomeBook: row.h2h_home_book ?? null,
              h2hAwayBook: row.h2h_away_book ?? null,
              total: row.total,
              totalBook: row.total_book ?? null,
              totalLineOver: row.total_line_over,
              totalLineOverBook: row.total_line_over_book ?? null,
              totalLineUnder: row.total_line_under,
              totalLineUnderBook: row.total_line_under_book ?? null,
              spreadHome: row.spread_home,
              spreadAway: row.spread_away,
              spreadHomeBook: row.spread_home_book ?? null,
              spreadAwayBook: row.spread_away_book ?? null,
              spreadPriceHome: row.spread_price_home,
              spreadPriceHomeBook: row.spread_price_home_book ?? null,
              spreadPriceAway: row.spread_price_away,
              spreadPriceAwayBook: row.spread_price_away_book ?? null,
              totalPriceOver: row.total_price_over,
              totalPriceOverBook: row.total_price_over_book ?? null,
              totalPriceUnder: row.total_price_under,
              totalPriceUnderBook: row.total_price_under_book ?? null,
              spreadIsMispriced:
                row.spread_is_mispriced === null
                  ? null
                  : row.spread_is_mispriced === 1,
              spreadMispriceType: row.spread_misprice_type ?? null,
              spreadMispriceStrength: row.spread_misprice_strength,
              spreadOutlierBook: row.spread_outlier_book ?? null,
              spreadOutlierDelta: row.spread_outlier_delta,
              spreadReviewFlag:
                row.spread_review_flag === null
                  ? null
                  : row.spread_review_flag === 1,
              spreadConsensusLine: row.spread_consensus_line,
              spreadConsensusConfidence:
                row.spread_consensus_confidence ?? null,
              spreadDispersionStddev: row.spread_dispersion_stddev,
              spreadSourceBookCount: row.spread_source_book_count,
              totalIsMispriced:
                row.total_is_mispriced === null
                  ? null
                  : row.total_is_mispriced === 1,
              totalMispriceType: row.total_misprice_type ?? null,
              totalMispriceStrength: row.total_misprice_strength,
              totalOutlierBook: row.total_outlier_book ?? null,
              totalOutlierDelta: row.total_outlier_delta,
              totalReviewFlag:
                row.total_review_flag === null
                  ? null
                  : row.total_review_flag === 1,
              totalConsensusLine: row.total_consensus_line,
              totalConsensusConfidence:
                row.total_consensus_confidence ?? null,
              totalDispersionStddev: row.total_dispersion_stddev,
              totalSourceBookCount: row.total_source_book_count,
              h2hConsensusHome: row.h2h_consensus_home,
              h2hConsensusAway: row.h2h_consensus_away,
              h2hConsensusConfidence:
                row.h2h_consensus_confidence ?? null,
              capturedAt: row.odds_captured_at,
            }
          : null,
        consistency: gameConsistencyMap.get(row.game_id) ?? {
          total_bias: 'UNKNOWN',
        },
        true_play: truePlayMap.get(row.game_id) ?? null,
        plays: playsMap.get(row.game_id) ?? [],
      };
    });

    emitTotalProjectionDriftWarnings(data);

    // NOTE: card_display_log writes intentionally removed.
    // Worker owns all DB writes (single-writer architecture).

    // Join diagnostics for game ID mapping (dev mode only)
    const isDev = process.env.NODE_ENV !== 'production';
    const joinDebug = isDev
      ? {
          canonical_game_ids_queried: gameIds.length,
          external_ids_resolved: externalToCanonicalMap.size,
          total_queryable_ids: allQueryableIds.length,
          plays_found: Array.from(playsMap.values()).reduce(
            (acc, plays) => acc + plays.length,
            0,
          ),
          games_with_plays: playsMap.size,
        }
      : undefined;
    const playableMarketDiagnostics =
      buildPlayableMarketFamilyDiagnostics(stageCounters);
    const outOfContractRows = Array.from(outOfContractPlayDowngrades.entries())
      .map(([key, count]) => {
        const delimiterIndex = key.indexOf('|');
        const sport =
          delimiterIndex >= 0
            ? key.substring(0, delimiterIndex)
            : UNKNOWN_SPORT;
        const card_type =
          delimiterIndex >= 0 ? key.substring(delimiterIndex + 1) : key;
        return { sport, card_type, count };
      })
      .sort((a, b) => b.count - a.count);
    const flowDiagnostics = isDev
      ? {
          stage_counters: stageCounters,
          query_window: {
            start_utc: gamesStartUtc,
            end_utc: gamesEndUtc,
            now_utc: nowUtc,
            horizon_hours: HAS_API_GAMES_HORIZON
              ? API_GAMES_HORIZON_HOURS
              : null,
            dev_lookback_applied: Boolean(lookbackUtc),
            active_fallback_applied: activeLifecycleFallbackApplied,
            lifecycle_mode: lifecycleMode,
            base_window_count: baseWindowCount,
            returned_count: deduplicatedRows.length,
            deduped_count: responseRows.length - deduplicatedRows.length,
            dropped_no_odds_no_plays: pregameRowsDroppedNoOddsNoPlays,
            active_excluded_statuses:
              lifecycleMode === 'active' ? ACTIVE_EXCLUDED_STATUSES : [],
          },
          card_type_contract: {
            active_sports: Object.keys(ACTIVE_SPORT_CARD_TYPE_CONTRACT),
            ...playableMarketDiagnostics,
            out_of_contract_play_rows: outOfContractRows,
          },
        }
      : undefined;

    perf.totalMs = Date.now() - requestStartedAt;
    if (isDev) {
      console.info('[API] /api/games flow diagnostics', {
        run_status: runStatus,
        active_run_ids: activeRunIds.length,
        stage_counters: stageCounters,
        missing_playable_markets:
          playableMarketDiagnostics.missing_playable_markets,
      });
    }
    if (perf.totalMs > 1500) {
      console.warn('[API] /api/games slow request', {
        total_ms: perf.totalMs,
        db_ready_ms: perf.dbReadyMs,
        load_games_ms: perf.loadGamesMs,
        cards_query_ms: perf.cardsQueryMs,
        cards_parse_ms: perf.cardsParseMs,
        card_rows: perf.cardRows,
        active_run_ids: activeRunIds.length,
      });
    }

    const response = NextResponse.json(
      {
        success: true,
        data,
        meta: {
          current_run_id: currentRunId,
          generated_at: new Date().toISOString(),
          run_status: runStatus,
          items_count: data.length,
          perf_ms:
            process.env.NODE_ENV !== 'production'
              ? {
                  total: perf.totalMs,
                  db_ready: perf.dbReadyMs,
                  load_games: perf.loadGamesMs,
                  cards_query: perf.cardsQueryMs,
                  cards_parse: perf.cardsParseMs,
                  card_rows: perf.cardRows,
                }
              : undefined,
          diagnostics: flowDiagnostics,
        },
        ...(joinDebug ? { join_debug: joinDebug } : {}),
      },
      { headers: { 'Content-Type': 'application/json' } },
    );
    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[API] Error fetching games:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const response = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    return addRateLimitHeaders(response, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
