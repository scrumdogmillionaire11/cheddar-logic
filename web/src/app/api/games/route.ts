/**
 * GET /api/games
 *
 * Returns all upcoming games from the odds API, joined with the latest
 * odds snapshot per game, plus any active driver play calls from card_payloads.
 * Games with no card_payloads still appear.
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
 *       total: number | null,
 *       spreadHome: number | null,
 *       spreadAway: number | null,
 *       spreadPriceHome: number | null,
 *       spreadPriceAway: number | null,
 *       totalPriceOver: number | null,
 *       totalPriceUnder: number | null,
 *       capturedAt: string | null,
 *     } | null,
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
} from '../../../lib/api-security';

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
  total: number | null;
  spread_home: number | null;
  spread_away: number | null;
  spread_price_home: number | null;
  spread_price_away: number | null;
  total_price_over: number | null;
  total_price_under: number | null;
  odds_captured_at: string | null;
}

interface CardPayloadRow {
  id: string;
  game_id: string;
  card_type: string;
  card_title: string;
  payload_data: string;
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
  p_fair?: number | null;
  p_implied?: number | null;
  edge_pct?: number | null;
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
  status?: 'FIRE' | 'WATCH' | 'PASS';
  kind?: 'PLAY' | 'EVIDENCE';
  market_type?:
    | 'MONEYLINE'
    | 'SPREAD'
    | 'TOTAL'
    | 'PUCKLINE'
    | 'TEAM_TOTAL'
    | 'PROP'
    | 'INFO';
  selection?: { side: string; team?: string };
  line?: number;
  price?: number;
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
  // Canonical decision fields
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
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
  one_p_bet_status?: 'FIRE' | 'HOLD' | 'PASS' | null;
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
    edge_method?: 'ML_PROB' | 'MARGIN_DELTA' | 'TOTAL_DELTA' | null;
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
    sharp_price_status: 'CHEDDAR' | 'COTTAGE' | 'UNPRICED';
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
]);
const COUNTER_ALL_MARKET = 'ALL';
const UNKNOWN_SPORT = 'UNKNOWN';

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
    ]),
    expectedPlayableMarkets: new Set<MarketType>(['SPREAD', 'TOTAL']),
  },
  NHL: {
    playProducerCardTypes: new Set([
      'nhl-totals-call',
      'nhl-spread-call',
      'nhl-moneyline-call',
      'nhl-pace-totals',
    ]),
    evidenceOnlyCardTypes: new Set([
      'nhl-base-projection',
      'nhl-rest-advantage',
      'nhl-goalie',
      'nhl-goalie-certainty',
      'nhl-model-output',
      'nhl-shot-environment',
      'nhl-pace-1p',
      'welcome-home-v2',
    ]),
    expectedPlayableMarkets: new Set<MarketType>([
      'MONEYLINE',
      'SPREAD',
      'TOTAL',
    ]),
  },
  NCAAM: {
    playProducerCardTypes: new Set([
      'ncaam-base-projection',
      'ncaam-rest-advantage',
      'ncaam-matchup-style',
      'ncaam-ft-trend',
      'ncaam-ft-spread',
    ]),
    evidenceOnlyCardTypes: new Set([]),
    expectedPlayableMarkets: new Set<MarketType>(['MONEYLINE', 'SPREAD']),
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
    return (side === 'HOME' || side === 'AWAY') && hasPrice;
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
    upper === 'PROP' ||
    upper === 'INFO'
  ) {
    return upper as Play['market_type'];
  }

  if (upper === 'PUCK_LINE') return 'PUCKLINE';
  if (upper === 'TEAMTOTAL') return 'TEAM_TOTAL';
  return undefined;
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
    upper === 'NEUTRAL'
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
    edge_method:
      input.edge_method === 'ML_PROB' ||
      input.edge_method === 'MARGIN_DELTA' ||
      input.edge_method === 'TOTAL_DELTA'
        ? (input.edge_method as 'ML_PROB' | 'MARGIN_DELTA' | 'TOTAL_DELTA')
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

function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item) => typeof item === 'number' && Number.isFinite(item),
  ) as number[];
  return numbers.length > 0 ? numbers : undefined;
}

function getActiveRunIds(db: ReturnType<typeof getDatabaseReadOnly>): string[] {
  // Prefer per-sport rows (added by migration 021); fall back to singleton
  try {
    const successRows = db
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE id != 'singleton'
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
        `SELECT current_run_id
         FROM run_state
         WHERE id != 'singleton'
           AND current_run_id IS NOT NULL
           AND TRIM(current_run_id) != ''
         ORDER BY datetime(updated_at) DESC, id ASC`,
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

    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    // if (!access.ok) {
    //   return NextResponse.json(
    //     { success: false, error: access.error },
    //     { status: access.status }
    //   );
    // }

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

    // Compute midnight America/New_York as a UTC string for the SQL param.
    // en-CA locale gives YYYY-MM-DD; shortOffset gives "GMT-5" / "GMT-4" (DST-aware).
    const now = new Date();
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
    const gamesEndUtc = HAS_API_GAMES_HORIZON
      ? new Date(now.getTime() + API_GAMES_HORIZON_HOURS * 60 * 60 * 1000)
          .toISOString()
          .substring(0, 19)
          .replace('T', ' ')
      : null;

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
        AND NOT EXISTS (
          SELECT 1
          FROM card_results cr
          WHERE cr.game_id = g.game_id
            AND cr.status = 'settled'
        )
        ${gamesEndUtc ? 'AND datetime(g.game_time_utc) <= ?' : ''}
      ORDER BY g.game_time_utc ASC
      LIMIT 200
    `;

    const loadGamesWithLatestOdds = (
      startUtc: string,
      endUtc: string | null,
    ): GameRow[] => {
      const baseGamesStmt = db.prepare(baseGamesSql);
      const baseGames = (
        endUtc
          ? baseGamesStmt.all(startUtc, endUtc)
          : baseGamesStmt.all(startUtc)
      ) as Array<
        Omit<
          GameRow,
          | 'h2h_home'
          | 'h2h_away'
          | 'total'
          | 'spread_home'
          | 'spread_away'
          | 'spread_price_home'
          | 'spread_price_away'
          | 'total_price_over'
          | 'total_price_under'
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
          o.total,
          o.spread_home,
          o.spread_away,
          o.spread_price_home,
          o.spread_price_away,
          o.total_price_over,
          o.total_price_under,
          o.captured_at AS odds_captured_at
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
        total: number | null;
        spread_home: number | null;
        spread_away: number | null;
        spread_price_home: number | null;
        spread_price_away: number | null;
        total_price_over: number | null;
        total_price_under: number | null;
        odds_captured_at: string | null;
      }>;

      const latestOddsByGameId = new Map(
        latestOddsRows.map((row) => [row.game_id, row]),
      );

      return baseGames.map((game) => {
        const odds = latestOddsByGameId.get(game.game_id);
        return {
          ...game,
          h2h_home: odds?.h2h_home ?? null,
          h2h_away: odds?.h2h_away ?? null,
          total: odds?.total ?? null,
          spread_home: odds?.spread_home ?? null,
          spread_away: odds?.spread_away ?? null,
          spread_price_home: odds?.spread_price_home ?? null,
          spread_price_away: odds?.spread_price_away ?? null,
          total_price_over: odds?.total_price_over ?? null,
          total_price_under: odds?.total_price_under ?? null,
          odds_captured_at: odds?.odds_captured_at ?? null,
        };
      });
    };

    const loadGamesStartedAt = Date.now();
    let rows = loadGamesWithLatestOdds(gamesStartUtc, gamesEndUtc);

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
    const sportByGameId = new Map(rows.map((r) => [r.game_id, r.sport]));

    // Build a plays map keyed by canonical game_id
    const playsMap = new Map<string, Play[]>();
    const gameConsistencyMap = new Map<string, Play['consistency']>();

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
              const deduped = new Map<string, CardPayloadRow>();
              for (const row of [...cardRows, ...fallbackRows]) {
                deduped.set(row.id, row);
              }
              cardRows = Array.from(deduped.values());
            }
          }
        }
        perf.cardsQueryMs += Date.now() - cardsQueryStartedAt;
      } catch {
        // card_payloads table not yet created; plays will be empty
      }

      perf.cardRows = cardRows.length;
      const cardsParseStartedAt = Date.now();

      for (const cardRow of cardRows) {
        const canonicalGameIdForRow =
          externalToCanonicalMap.get(cardRow.game_id) ?? cardRow.game_id;
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
        const payloadMarketContext =
          toObject((payload as Record<string, unknown>).market_context) ??
          toObject(payloadPlayObj?.market_context);
        const payloadMarketContextProjection = toObject(
          payloadMarketContext?.projection,
        );
        const payloadMarketContextWager = toObject(payloadMarketContext?.wager);
        const payloadSelection =
          toObject(payload.selection) ?? toObject(payloadPlay?.selection);
        const normalizedSelectionSide =
          normalizeSelectionSide(
            payloadSelection?.side ??
              payloadMarketContext?.selection_side ??
              payloadPlay?.side ??
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
        const normalizedPrediction =
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
        const normalizedMarketType = normalizeMarketType(
          payload.market_type ??
            payloadPlay?.market_type ??
            payloadMarketContext?.market_type,
        );
        const normalizedPlayerName = firstString(
          payloadSelection?.player_name,
          payloadPlay?.player_name,
          (payload as Record<string, unknown>).player_name,
        );
        const normalizedSelectionTeam = firstString(
          normalizedPlayerName,
          payloadSelection?.team,
          payloadMarketContext?.selection_team,
          payloadPlay?.team,
        );
        const normalizedLine = firstNumber(
          payload.line,
          payloadMarketContextWager?.called_line,
          (payload.market as Record<string, unknown>)?.line,
          payloadPlay?.line,
          payloadSelection?.line,
        );
        const normalizedPrice = firstNumber(
          payload.price,
          payloadMarketContextWager?.called_price,
          payloadPlay?.price,
          payloadSelection?.price,
        );
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
        const normalizedGameId = firstString(
          (payload as Record<string, unknown>).game_id,
          payloadPlay?.game_id,
        );
        const normalizedMu = firstNumber(
          (payload as Record<string, unknown>).mu,
          payloadPlay?.mu,
          (payload.projection as Record<string, unknown>)?.mu,
          (payload.projection as Record<string, unknown>)?.total,
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
        const normalizedPFair = firstNumber(
          (payload as Record<string, unknown>).p_fair,
          payloadPlayObj?.p_fair,
          normalizedDecisionV2?.fair_prob,
        );
        const normalizedPImplied = firstNumber(
          (payload as Record<string, unknown>).p_implied,
          payloadPlayObj?.p_implied,
          normalizedDecisionV2?.implied_prob,
        );
        const normalizedEdgePct = firstNumber(
          (payload as Record<string, unknown>).edge_pct,
          payloadPlayObj?.edge_pct,
          normalizedDecisionV2?.edge_pct,
        );
        const projectionWinProbHome = firstNumber(
          payloadMarketContextProjection?.win_prob_home,
          payloadProjection?.win_prob_home,
          payloadPlayProjection?.win_prob_home,
        );
        let normalizedModelProb = firstNumber(
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
        const combinedReasonCodes = [
          ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
          ...(Array.isArray(payloadPlay?.reason_codes)
            ? payloadPlay.reason_codes
            : []),
          ...(Array.isArray(driverInputs?.reason_codes)
            ? driverInputs.reason_codes
            : []),
        ].map((value) => String(value));
        const combinedTags = [
          ...(Array.isArray(payload.tags) ? payload.tags : []),
          ...(Array.isArray(payloadPlay?.tags) ? payloadPlay.tags : []),
        ].map((value) => String(value));

        const resolvedAction: Play['action'] | undefined =
          normalizedAction ??
          actionFromClassification(normalizedClassification) ??
          (normalizedStatus === 'FIRE'
            ? 'FIRE'
            : normalizedStatus === 'WATCH'
              ? 'HOLD'
              : normalizedStatus === 'PASS'
                ? 'PASS'
                : undefined);
        const resolvedClassification: Play['classification'] | undefined =
          normalizedClassification ?? classificationFromAction(resolvedAction);
        const resolvedStatus: Play['status'] | undefined =
          statusFromAction(resolvedAction) ?? normalizedStatus;
        const onePModelCall =
          cardRow.card_type === 'nhl-pace-1p'
            ? deriveNhl1PModelCall(combinedReasonCodes, normalizedPrediction)
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
            typeof payload.pass_reason_code === 'string'
              ? payload.pass_reason_code
              : typeof payloadPlay?.pass_reason_code === 'string'
                ? payloadPlay.pass_reason_code
                : null,
          one_p_model_call: onePModelCall,
          one_p_bet_status: onePBetStatus,
          decision_v2: normalizedDecisionV2,
          kind:
            payload.kind === 'PLAY' || payload.kind === 'EVIDENCE'
              ? (payload.kind as 'PLAY' | 'EVIDENCE')
              : payloadPlay?.kind === 'PLAY' || payloadPlay?.kind === 'EVIDENCE'
                ? (payloadPlay.kind as 'PLAY' | 'EVIDENCE')
                : undefined,
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
            side: normalizedSelectionSide,
            team: normalizedSelectionTeam,
          },
          line: normalizedLine,
          price: normalizedPrice,
          line_source: normalizedLineSource ?? null,
          price_source: normalizedPriceSource ?? null,
          market_context: payloadMarketContext
            ? {
                version: firstString(payloadMarketContext.version) ?? 'v1',
                market_type:
                  firstString(payloadMarketContext.market_type) ??
                  normalizedMarketType ??
                  null,
                selection_side:
                  firstString(payloadMarketContext.selection_side) ??
                  normalizedSelectionSide,
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
          reason_codes: combinedReasonCodes,
          tags: combinedTags,
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

        if (wave1Eligible) {
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
          play.reason_codes = Array.from(
            new Set([...(play.reason_codes ?? []), 'PASS_MISSING_MARKET_TYPE']),
          );
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

    const data = rows.map((row) => {
      const hasOdds =
        row.h2h_home !== null ||
        row.h2h_away !== null ||
        row.total !== null ||
        row.spread_home !== null ||
        row.spread_away !== null;

      return {
        id: row.id,
        gameId: row.game_id,
        sport: row.sport,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        gameTimeUtc: row.game_time_utc,
        status: row.status,
        createdAt: row.created_at,
        odds: hasOdds
          ? {
              h2hHome: row.h2h_home,
              h2hAway: row.h2h_away,
              total: row.total,
              spreadHome: row.spread_home,
              spreadAway: row.spread_away,
              spreadPriceHome: row.spread_price_home,
              spreadPriceAway: row.spread_price_away,
              totalPriceOver: row.total_price_over,
              totalPriceUnder: row.total_price_under,
              capturedAt: row.odds_captured_at,
            }
          : null,
        consistency: gameConsistencyMap.get(row.game_id) ?? {
          total_bias: 'UNKNOWN',
        },
        plays: playsMap.get(row.game_id) ?? [],
      };
    });

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
            horizon_hours: HAS_API_GAMES_HORIZON
              ? API_GAMES_HORIZON_HOURS
              : null,
            dev_lookback_applied: Boolean(lookbackUtc),
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
