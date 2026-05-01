/**
 * GET /api/games
 *
 * Canonical pregame/active read surface for game cards in the current worker+DB architecture.
 * Returns all upcoming games from the odds API, joined with the latest
 * odds snapshot per game, plus any active driver play calls from card_payloads.
 * Games with no card_payloads still appear.
 *
 * Historical route families (`/api/models/*`, `/api/betting/projections`)
 * are deprecated references only and are not active runtime contracts.
 *
 * Query window:
 *   - Pregame: today midnight ET → end of tomorrow ET (23:59:59 ET, per horizon-contract v1)
 *   - Active: yesterday midnight ET → now (started games not yet settled)
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
import cheddarData from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
  requireEntitlementForRequest,
  RESOURCE,
} from '@/lib/api-security';
import type { ExpressionStatus, CanonicalMarketType } from '@/lib/types';
import type { PlayDisplayAction } from '@/lib/game-card/decision';
import {
  toObject,
  firstString,
  firstNumber,
  normalizeMarketType,
  normalizeTier,
  normalizeAction,
  normalizeStatus,
  normalizeClassification,
  normalizeSelectionSide,
  normalizePrediction,
  normalizeGoalieStatus,
  normalizeSport,
  normalizePassReasonCode,
  normalizePlayerNameKey,
  normalizeNumberArray,
  extractShotsFromRecentGames,
} from '@/lib/games/normalizers';
import {
  ACTIVE_SPORT_CARD_TYPE_CONTRACT,
  inferMarketFromCardType,
  applyCardTypeKindContract,
  isWave1EligibleRow,
  deriveNhl1PModelCall,
  normalizeDecisionV2,
  resolveDecisionV2EdgePct,
  applyWave1DecisionFields,
} from '@/lib/games/market-inference';
import {
  createStageCounters,
  normalizeCounterSport,
  incrementStageCounter,
  bumpCount,
  registerGameWithPlayableMarket,
  buildPlayableMarketFamilyDiagnostics,
  COUNTER_ALL_MARKET,
  UNKNOWN_SPORT,
} from '@/lib/games/stage-counters';
import {
  assessProjectionInputsFromRawData,
  deriveSourceMappingHealth,
  hasMinimumViability,
  getActiveRunIds,
  getFallbackRunIdsFromCards,
  getRunStatus,
} from '@/lib/games/validators';
import {
  getTableColumnNames,
  buildOptionalOddsSelect,
} from '@/lib/games/query-builder';
import {
  createGamesStageMetrics,
  createGamesStageTracker,
  normalizeGamesStageMetrics,
  type GamesStageMetricRecord,
} from './perf-metrics';
import {
  resolveGamesQueryStartUtc,
  resolveGamesQueryWindow,
} from './query-layer';
import { prepareGamesServiceRows } from './service-layer';
import { emitTotalProjectionDriftWarnings } from './transform-layer';
import { isProjectionSurfaceCardType } from '@/lib/games/projection-surface';
import {
  resolveMlbFallbackOfficialStatus,
  hasMlbFallbackDropReason,
  hasMlbFallbackActionableSelection,
  hasMlbFallbackMarketContext,
  getMlbFallbackSnapshotEpoch,
} from '@/lib/game-card/transform/adapters/v1-legacy-repair';
import { readRuntimeCanonicalDecision } from '@/lib/runtime-decision-authority';

const { getDatabaseReadOnly, closeReadOnlyInstance } = cheddarData as {
  getDatabaseReadOnly: typeof import('@cheddar-logic/data').getDatabaseReadOnly;
  closeReadOnlyInstance: typeof import('@cheddar-logic/data').closeReadOnlyInstance;
};

const buildDecisionOutcomeFromDecisionV2 = (
  cheddarData as {
    buildDecisionOutcomeFromDecisionV2: (decisionV2: unknown) => {
      status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
      reasons?: { blockers?: unknown[] };
    };
  }
).buildDecisionOutcomeFromDecisionV2;

const ENABLE_WELCOME_HOME =
  process.env.ENABLE_WELCOME_HOME === 'true' ||
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';


const API_GAMES_MAX_CARD_ROWS = Math.max(
  100,
  Number.parseInt(process.env.API_GAMES_MAX_CARD_ROWS || '5000', 10) || 5000,
);
const API_GAMES_PROP_PRIORITY_SQL =
  "(LOWER(card_type) LIKE '%player%' OR LOWER(card_type) = 'mlb-pitcher-k')";
const PROP_FALLBACK_CARD_TYPES = new Set<string>([
  'nhl-player-shots',
  'nhl-player-shots-1p',
  'nhl-player-blk',
  'mlb-pitcher-k',
]);
const MLB_GAME_LINE_FALLBACK_CARD_TYPES = ['mlb-full-game', 'mlb-full-game-ml'] as const;
const MLB_GAME_LINE_PRIMARY_CARD_TYPE = 'mlb-f5';
const RAW_API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES = Number.parseInt(
  process.env.API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES || '90',
  10,
);
const API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES =
  Number.isFinite(RAW_API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES) &&
  RAW_API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES > 0
    ? RAW_API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES
    : 90;
const RAW_API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES = Number.parseInt(
  process.env.API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES || '10',
  10,
);
const API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES =
  Number.isFinite(RAW_API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES) &&
  RAW_API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES > 0
    ? RAW_API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES
    : 10;
const API_GAMES_INGEST_FAILURE_LOOKBACK_HOURS = 12;
const RAW_API_GAMES_TIMEOUT_MS = Number.parseInt(
  process.env.API_GAMES_TIMEOUT_MS || '5000',
  10,
);
const API_GAMES_TIMEOUT_MS =
  Number.isFinite(RAW_API_GAMES_TIMEOUT_MS) && RAW_API_GAMES_TIMEOUT_MS > 0
    ? RAW_API_GAMES_TIMEOUT_MS
    : 5000;
const RAW_API_GAMES_SLOW_WARN_MS = Number.parseInt(
  process.env.API_GAMES_SLOW_WARN_MS || '3000',
  10,
);
const API_GAMES_SLOW_WARN_MS =
  Number.isFinite(RAW_API_GAMES_SLOW_WARN_MS) &&
  RAW_API_GAMES_SLOW_WARN_MS > 0
    ? RAW_API_GAMES_SLOW_WARN_MS
    : 3000;
const API_GAMES_BUSY_TIMEOUT_MS =
  API_GAMES_TIMEOUT_MS > 250
    ? Math.max(250, API_GAMES_TIMEOUT_MS - 250)
    : API_GAMES_TIMEOUT_MS;

export interface GameRow {
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
  public_bets_pct_home: number | null;
  public_bets_pct_away: number | null;
  public_handle_pct_home: number | null;
  public_handle_pct_away: number | null;
  splits_source: string | null;
  odds_captured_at: string | null;
  projection_inputs_complete: boolean | null;
  projection_missing_inputs: string[];
  source_mapping_ok: boolean | null;
  source_mapping_failures: string[];
  ingest_failure_reason_code: string | null;
  ingest_failure_reason_detail: string | null;
}

export type LifecycleMode = 'pregame' | 'active';
export type DisplayStatus = 'SCHEDULED' | 'ACTIVE';

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
const ACTIVE_GAME_SPORTS = ['NBA', 'NHL', 'MLB', 'NFL'] as const;
const ACTIVE_GAME_SPORT_SQL = ACTIVE_GAME_SPORTS.map(
  (sport) => `'${sport}'`,
).join(', ');
const ACTIVE_GAME_SPORT_SET = new Set<string>(ACTIVE_GAME_SPORTS);
const INVALID_SPORT_FILTER = '__INVALID_SPORT_FILTER__';
const FINAL_GAME_RESULT_STATUSES = ['FINAL', 'FT', 'COMPLETE', 'COMPLETED', 'CLOSED'];
const PROJECTION_ONLY_LINE_SOURCES = new Set<string>([
  'PROJECTION_FLOOR',
  'SYNTHETIC_FALLBACK',
]);

function resolveLifecycleMode(searchParams: URLSearchParams): LifecycleMode {
  const lifecycleParam = (searchParams.get('lifecycle') || '').toLowerCase();
  if (lifecycleParam === 'active') return 'active';
  return 'pregame';
}

function resolveSportFilter(searchParams: URLSearchParams): string | null {
  const normalized = normalizeSport(searchParams.get('sport'));
  if (!normalized || normalized === 'ALL') return null;
  return ACTIVE_GAME_SPORT_SET.has(normalized)
    ? normalized
    : INVALID_SPORT_FILTER;
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
  created_at: string;
}

type ProjectionSettlementPolicy = {
  market_family: 'MLB_F5_TOTAL';
  grading_mode: 'OFFICIAL' | 'TRACK_ONLY';
  official_call: 'UNDER_3_5' | 'OVER_4_5' | null;
  reason_code: 'CLEAR_UNDER' | 'CLEAR_OVER' | 'GRAY_ZONE_NO_CALL';
};

export interface Play {
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
    // Pitcher-K prop fields
    k_mean?: number | null;
    probability_ladder?: Record<string, unknown> | null;
    fair_prices?: Record<string, unknown> | null;
    // MLB F5 projected run splits
    projected_home_f5_runs?: number | null;
    projected_away_f5_runs?: number | null;
  };
  status?: ExpressionStatus;
  kind?: 'PLAY' | 'EVIDENCE';
  canonical_market_key?: string;
  market_type?: CanonicalMarketType;
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
      period?: string | null;
    };
  };
  reason_codes?: string[];
    projection_inputs_complete?: boolean | null;
    missing_inputs?: string[];
    core_inputs_complete?: boolean | null;
    core_missing_inputs?: string[];
    feature_flags?: string[];
    market_status?: {
      has_odds?: boolean | null;
      freshness_tier?: string | null;
      execution_blocked?: boolean | null;
    } | null;
  tags?: string[];
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
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
  decision_outcome?: {
    status: 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
    reasons?: {
      blockers?: string[];
    };
  } | null;
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
    canonical_envelope_v2?: {
      official_status?: 'PLAY' | 'LEAN' | 'PASS';
      terminal_reason_family?: string;
      primary_reason_code?: string;
      reason_codes?: string[];
      is_actionable?: boolean;
      execution_status?: 'EXECUTABLE' | 'PROJECTION_ONLY' | 'BLOCKED';
      publish_ready?: boolean;
    };
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
  basis?: 'PROJECTION_ONLY' | 'ODDS_BACKED';
  execution_status?: 'EXECUTABLE' | 'PROJECTION_ONLY' | 'BLOCKED';
  projection_source?: string | null;
  execution_gate?: {
    drop_reason?: {
      drop_reason_code: string;
      drop_reason_layer: string;
      recovery_bucket?: RecoveryBucket;
    } | null;
    blocked_by?: string[];
    [key: string]: unknown;
  } | null;
  prop_display_state?: 'PLAY' | 'WATCH' | 'PROJECTION_ONLY';
  projection_settlement_policy?: ProjectionSettlementPolicy | null;
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
    // Pitcher-K prop fields
    k_mean: number | null;
    probability_ladder: Record<string, unknown> | null;
    fair_prices: Record<string, unknown> | null;
    playability: Record<string, unknown> | null;
    projection_source: string | null;
    status_cap: string | null;
    pass_reason_code: string | null;
    missing_inputs: string[];
  };
  true_play_authority_source?: 'CARD_PAYLOADS_DECISION_V2';
  true_play_authority_version?: 'ADR-0003';
  true_play_authority_rationale?: string;
}

function normalizeApiMarketStatus(value: unknown): {
  has_odds?: boolean | null;
  freshness_tier?: string | null;
  execution_blocked?: boolean | null;
} | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return {
    has_odds: typeof raw.has_odds === 'boolean' ? raw.has_odds : null,
    freshness_tier:
      typeof raw.freshness_tier === 'string' ? raw.freshness_tier : null,
    execution_blocked:
      typeof raw.execution_blocked === 'boolean'
        ? raw.execution_blocked
        : null,
  };
}

function normalizeProjectionSettlementPolicy(
  value: unknown,
): ProjectionSettlementPolicy | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const marketFamily = firstString(raw.market_family);
  const gradingMode = firstString(raw.grading_mode);
  const officialCallValue = raw.official_call;
  const officialCall =
    officialCallValue === null ? null : firstString(officialCallValue);
  const reasonCode = firstString(raw.reason_code);

  if (marketFamily !== 'MLB_F5_TOTAL') return null;
  if (gradingMode !== 'OFFICIAL' && gradingMode !== 'TRACK_ONLY') return null;
  if (
    officialCall !== null &&
    officialCall !== 'UNDER_3_5' &&
    officialCall !== 'OVER_4_5'
  ) {
    return null;
  }
  if (
    reasonCode !== 'CLEAR_UNDER' &&
    reasonCode !== 'CLEAR_OVER' &&
    reasonCode !== 'GRAY_ZONE_NO_CALL'
  ) {
    return null;
  }
  if (gradingMode === 'OFFICIAL' && officialCall === null) return null;
  if (gradingMode === 'TRACK_ONLY' && officialCall !== null) return null;
  if (gradingMode === 'OFFICIAL' && reasonCode === 'GRAY_ZONE_NO_CALL') {
    return null;
  }
  if (gradingMode === 'TRACK_ONLY' && reasonCode !== 'GRAY_ZONE_NO_CALL') {
    return null;
  }

  return {
    market_family: marketFamily,
    grading_mode: gradingMode,
    official_call: officialCall,
    reason_code: reasonCode,
  };
}

function normalizeDiagnosticToken(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!value || typeof value !== 'object') return null;

  const entry = value as Record<string, unknown>;
  const code =
    typeof entry.code === 'string'
      ? entry.code.trim()
      : typeof entry.status === 'string'
        ? entry.status.trim().toUpperCase()
        : '';
  const team = typeof entry.team === 'string' ? entry.team.trim() : '';
  const sport = typeof entry.sport === 'string' ? entry.sport.trim().toUpperCase() : '';
  if (code && sport && team) return `${code}:${sport}:${team}`;
  if (code && team) return `${code}:${team}`;
  if (code && sport) return `${code}:${sport}`;

  for (const key of ['reason', 'code', 'label', 'message', 'field', 'key']) {
    if (typeof entry[key] === 'string' && entry[key]!.trim().length > 0) {
      return entry[key]!.trim();
    }
  }

  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? json : null;
  } catch {
    return null;
  }
}

function normalizeDiagnosticArray(values: unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => normalizeDiagnosticToken(value))
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

const TRUE_PLAY_AUTHORITY_SOURCE = 'CARD_PAYLOADS_DECISION_V2' as const;
const TRUE_PLAY_AUTHORITY_VERSION = 'ADR-0003' as const;
const TRUE_PLAY_AUTHORITY_RATIONALE =
  'status_rank>edge_delta_pct>support_score>created_at>source_card_id';
type DropReasonMeta = {
  drop_reason_code: string;
  drop_reason_layer: string;
  recovery_bucket?: RecoveryBucket;
};

type RecoveryBucket =
  | 'hard-fail'
  | 'soft-pass'
  | 'degraded-output'
  | 'hidden-output'
  | 'retry'
  | 'fallback';

function resolveRecoveryBucket(code: string, layer: string): RecoveryBucket {
  const normalized = code.trim().toUpperCase();
  const normalizedLayer = layer.trim().toLowerCase();

  if (
    normalized.includes('MODEL_STATUS') ||
    normalized.includes('MISSING_EDGE') ||
    normalized.includes('CALIBRATION') ||
    normalized === 'TIMESTAMP_MISSING' ||
    normalized === 'TIMESTAMP_PARSE_ERROR' ||
    normalized === 'GAME_ID_INVALID' ||
    normalized === 'INVARIANT_BREACH'
  ) {
    return 'hard-fail';
  }

  if (normalized.includes('RETRYABLE')) {
    return 'retry';
  }

  if (
    normalized === 'ESPN_NULL_OBSERVATION' ||
    normalized === 'ESPN_NULL_ALERT_FAILED' ||
    normalized === 'STALE_RECOVERY_REFRESH_FAILED' ||
    normalized === 'STALE_RECOVERY_RELOAD_FAILED' ||
    normalized === 'NEUTRAL_VALUE_COERCE_SILENT' ||
    normalized === 'PRICE_VALIDATION_FAILED' ||
    normalized === 'LINE_CONTEXT_MISSING' ||
    normalized === 'CAPTURED_AT_MISSING' ||
    normalized === 'CAPTURED_AT_MS_INVALID'
  ) {
    return 'hidden-output';
  }

  if (
    normalized === 'SIGMA_FALLBACK_DEGRADED' ||
    normalized === 'HEAVY_FAVORITE_PRICE_CAP' ||
    normalized === 'PLAY_CONTRADICTION_CAPPED' ||
    normalized === 'LINE_DELTA_COMPUTATION_FAILED' ||
    normalized === 'TIMESTAMP_AGE_INVALID' ||
    normalized === 'PRICING_STATUS_MISSING' ||
    normalized.startsWith('BULLPEN_CONTEXT_')
  ) {
    return 'degraded-output';
  }

  if (
    normalized === 'NO_EDGE_AT_PRICE' ||
    normalized === 'MODEL_PROB_MISSING' ||
    normalized === 'WATCHDOG_MARKET_UNAVAILABLE' ||
    normalized === 'STALE_MARKET' ||
    normalized === 'WATCHDOG_PARSE_FAILURE' ||
    normalized === 'WATCHDOG_CONSISTENCY_MISSING' ||
    normalized === 'GOALIE_UNCONFIRMED' ||
    normalized === 'GOALIE_CONFLICTING' ||
    normalized === 'INJURY_UNCERTAIN' ||
    normalized === 'TIMESTAMP_RESOLVER_FALLBACK' ||
    normalized === 'PRICING_STATUS_FALLBACK' ||
    normalized === 'DECISION_ENVELOPE_FALLBACK'
  ) {
    return 'fallback';
  }

  if (
    normalized === 'EDGE_CLEAR' ||
    normalized === 'AVAILABILITY_GATE_DEGRADED' ||
    normalized.startsWith('PASS_EXECUTION_GATE_') ||
    normalized === 'PROJECTION_ONLY_EXCLUSION' ||
    normalizedLayer === 'worker_gate'
  ) {
    return 'soft-pass';
  }

  return 'fallback';
}

function buildDropReasonMeta(
  code: string,
  layer: string,
  recoveryBucket?: RecoveryBucket,
): DropReasonMeta {
  return {
    drop_reason_code: code,
    drop_reason_layer: layer,
    recovery_bucket: recoveryBucket ?? resolveRecoveryBucket(code, layer),
  };
}

function buildPlayDecisionOutcome(play: Play) {
  const decisionV2 =
    play?.decision_v2 && typeof play.decision_v2 === 'object'
      ? (play.decision_v2 as Record<string, unknown>)
      : null;
  if (!decisionV2) return null;
  return buildDecisionOutcomeFromDecisionV2(decisionV2);
}

export function resolveLiveOfficialStatus(play: Play): 'PLAY' | 'LEAN' | 'PASS' | 'INVALID' {
  const invalidEnforcementEnabled = process.env.ENABLE_INVALID_DECISION_ENFORCEMENT !== 'false';
  const decisionOutcome = play.decision_outcome ?? buildPlayDecisionOutcome(play);
  if (!decisionOutcome) return invalidEnforcementEnabled ? 'INVALID' : 'PASS';
  const outcomeStatus = String(decisionOutcome.status || '').toUpperCase();
  if (outcomeStatus === 'INVALID') return 'INVALID';
  if (outcomeStatus === 'PLAY') return 'PLAY';
  if (outcomeStatus === 'SLIGHT_EDGE') return 'LEAN';
  return 'PASS';
}

function resolveTruePlayStatusRank(play: Play): number {
  const officialStatus = resolveLiveOfficialStatus(play);
  if (officialStatus === 'PLAY') return 2;
  if (officialStatus === 'LEAN') return 1;
  if (officialStatus === 'INVALID') return -1;
  return 0;
}

function resolveTruePlayEdge(play: Play): number {
  const edge = resolveDecisionV2EdgePct(play.decision_v2) ?? play.edge;
  return Number.isFinite(edge) ? Number(edge) : -Infinity;
}

function resolveTruePlaySupportScore(play: Play): number {
  const score = play.decision_v2?.support_score;
  return Number.isFinite(score) ? Number(score) : -Infinity;
}

function resolveTruePlayCreatedAtEpoch(play: Play): number {
  if (!play.created_at) return 0;
  const parsed = Date.parse(play.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareTruePlayAuthority(a: Play, b: Play): number {
  const statusDelta = resolveTruePlayStatusRank(a) - resolveTruePlayStatusRank(b);
  if (statusDelta !== 0) return statusDelta;

  const edgeDelta = resolveTruePlayEdge(a) - resolveTruePlayEdge(b);
  if (edgeDelta !== 0) return edgeDelta;

  const supportDelta = resolveTruePlaySupportScore(a) - resolveTruePlaySupportScore(b);
  if (supportDelta !== 0) return supportDelta;

  const createdAtDelta =
    resolveTruePlayCreatedAtEpoch(a) - resolveTruePlayCreatedAtEpoch(b);
  if (createdAtDelta !== 0) return createdAtDelta;

  const aId = String(a.source_card_id ?? '');
  const bId = String(b.source_card_id ?? '');
  if (aId === bId) return 0;
  return aId > bId ? 1 : -1;
}

function annotateAuthoritativePlay(play: Play): Play {
  return {
    ...play,
    true_play_authority_source: TRUE_PLAY_AUTHORITY_SOURCE,
    true_play_authority_version: TRUE_PLAY_AUTHORITY_VERSION,
    true_play_authority_rationale: TRUE_PLAY_AUTHORITY_RATIONALE,
  };
}

export function selectAuthoritativeTruePlay(plays: Play[]): Play | null {
  const eligible = plays.filter((play) => {
    if ((play.kind ?? 'PLAY') !== 'PLAY') return false;
    const officialStatus = resolveLiveOfficialStatus(play);
    return officialStatus === 'PLAY' || officialStatus === 'LEAN';
  });
  if (eligible.length === 0) return null;

  const winner = eligible.reduce((best, candidate) => {
    if (!best) return candidate;
    return compareTruePlayAuthority(candidate, best) > 0 ? candidate : best;
  }, null as Play | null);

  return winner ? annotateAuthoritativePlay(winner) : null;
}

function resolveNhl1PGoalieTruthRank(play: Play): number {
  if (play.cardType !== 'nhl-pace-1p') return 0;
  const homeConfirmed = play.goalie_home_status === 'CONFIRMED' ? 1 : 0;
  const awayConfirmed = play.goalie_away_status === 'CONFIRMED' ? 1 : 0;
  return homeConfirmed + awayConfirmed;
}

function resolveProjectionSourceTruthRank(play: Play): number {
  const projectionSource = (
    play.projection_source ??
    play.prop_decision?.projection_source ??
    ''
  )
    .trim()
    .toUpperCase();

  if (projectionSource === 'FULL_MODEL') return 3;
  if (projectionSource === 'DEGRADED_MODEL') return 2;
  if (projectionSource === 'SYNTHETIC_FALLBACK') return 0;
  if (play.reason_codes?.includes('PASS_SYNTHETIC_FALLBACK')) return 0;
  return 1;
}

function resolveProjectionSurfaceDedupeKey(play: Play): string | null {
  if (play.market_type === 'PROP') return null;
  if (!isProjectionSurfaceCardType(play.cardType)) return null;
  const market =
    play.canonical_market_key ??
    play.market_type ??
    inferMarketFromCardType(play.cardType) ??
    'UNKNOWN';
  return `${play.cardType}|${market}`;
}

function compareProjectionSurfaceTruth(a: Play, b: Play): number {
  const goalieTruthDelta =
    resolveNhl1PGoalieTruthRank(a) - resolveNhl1PGoalieTruthRank(b);
  if (goalieTruthDelta !== 0) return goalieTruthDelta;

  const projectionSourceDelta =
    resolveProjectionSourceTruthRank(a) - resolveProjectionSourceTruthRank(b);
  if (projectionSourceDelta !== 0) return projectionSourceDelta;

  const createdAtDelta =
    resolveTruePlayCreatedAtEpoch(a) - resolveTruePlayCreatedAtEpoch(b);
  if (createdAtDelta !== 0) return createdAtDelta;

  const aId = String(a.source_card_id ?? '');
  const bId = String(b.source_card_id ?? '');
  if (aId === bId) return 0;
  return aId > bId ? 1 : -1;
}

export function dedupeProjectionSurfacePlays(plays: Play[]): Play[] {
  const byKey = new Map<string, Play>();
  const passthrough: Play[] = [];

  for (const play of plays) {
    const key = resolveProjectionSurfaceDedupeKey(play);
    if (!key) {
      passthrough.push(play);
      continue;
    }

    const existing = byKey.get(key);
    if (!existing || compareProjectionSurfaceTruth(play, existing) > 0) {
      byKey.set(key, play);
    }
  }

  return [...passthrough, ...byKey.values()];
}

function parseCardPayloadData(payloadData: string): Record<string, unknown> | null {
  try {
    return JSON.parse(payloadData) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isNativeTotalBiasActionable(play: {
  market_type?: Play['market_type'] | null;
  status?: Play['status'] | null;
  line?: number | null;
  edge_pct?: number | null;
  edge?: number | null;
}): boolean {
  const nativeTotalStatus =
    typeof play.status === 'string' ? play.status.toUpperCase() : null;
  const nativeTotalLine = typeof play.line === 'number';
  const nativeTotalEdge =
    typeof play.edge_pct === 'number' || typeof play.edge === 'number';

  return Boolean(
    play.market_type === 'TOTAL' &&
      nativeTotalStatus !== null &&
      nativeTotalStatus !== 'PASS' &&
      nativeTotalLine &&
      nativeTotalEdge,
  );
}

function isEligibleMlbGameLineFallbackRow(params: {
  row: CardPayloadRow;
  payload: Record<string, unknown>;
  latestOddsCapturedAtByCanonicalId: Map<string, string | null>;
  canonicalGameId: string;
  nowEpochMs: number;
}): boolean {
  const { row, payload, latestOddsCapturedAtByCanonicalId, canonicalGameId, nowEpochMs } =
    params;
  if (!MLB_GAME_LINE_FALLBACK_CARD_TYPES.includes(row.card_type as (typeof MLB_GAME_LINE_FALLBACK_CARD_TYPES)[number])) {
    return false;
  }

  const basis = firstString(payload.basis)?.toUpperCase();
  if (basis !== 'ODDS_BACKED') return false;

  const executionStatus = firstString(payload.execution_status)?.toUpperCase();
  if (executionStatus !== 'EXECUTABLE') return false;

  const officialStatus = resolveMlbFallbackOfficialStatus(payload);
  if (officialStatus !== 'PLAY' && officialStatus !== 'LEAN') return false;

  if (hasMlbFallbackDropReason(payload)) return false;
  if (!hasMlbFallbackActionableSelection(payload)) return false;
  if (!hasMlbFallbackMarketContext(payload, row.card_type)) return false;

  const snapshotEpoch = getMlbFallbackSnapshotEpoch(row, payload);
  if (!Number.isFinite(snapshotEpoch)) return false;
  const snapshotAgeMinutes = (nowEpochMs - snapshotEpoch) / 60000;
  if (
    !Number.isFinite(snapshotAgeMinutes) ||
    snapshotAgeMinutes < 0 ||
    snapshotAgeMinutes > API_GAMES_MLB_FALLBACK_MAX_AGE_MINUTES
  ) {
    return false;
  }

  const latestOddsIso = latestOddsCapturedAtByCanonicalId.get(canonicalGameId) ?? null;
  if (!latestOddsIso) return false;
  const latestOddsEpoch = Date.parse(latestOddsIso);
  if (!Number.isFinite(latestOddsEpoch)) return false;
  const oddsDeltaMinutes = (latestOddsEpoch - snapshotEpoch) / 60000;
  if (oddsDeltaMinutes > API_GAMES_MLB_FALLBACK_ODDS_TOLERANCE_MINUTES) return false;

  return true;
}

export function mergeMlbGameLineFallbackRows(params: {
  currentRows: CardPayloadRow[];
  fallbackRows: CardPayloadRow[];
  externalToCanonicalMap: Map<string, string>;
  latestOddsCapturedAtByCanonicalId: Map<string, string | null>;
  nowEpochMs?: number;
}): CardPayloadRow[] {
  const {
    currentRows,
    fallbackRows,
    externalToCanonicalMap,
    latestOddsCapturedAtByCanonicalId,
    nowEpochMs = Date.now(),
  } = params;

  if (currentRows.length === 0 || fallbackRows.length === 0) {
    return currentRows;
  }

  const currentMlbF5ByCanonicalGameId = new Set<string>();
  const currentByCanonicalType = new Set<string>();

  for (const row of currentRows) {
    const canonicalGameId = externalToCanonicalMap.get(row.game_id) ?? row.game_id;
    const semanticKey = `${canonicalGameId}|${row.card_type}`;
    currentByCanonicalType.add(semanticKey);
    if (row.card_type === MLB_GAME_LINE_PRIMARY_CARD_TYPE) {
      currentMlbF5ByCanonicalGameId.add(canonicalGameId);
    }
  }

  const missingSemanticKeys = new Set<string>();
  for (const canonicalGameId of currentMlbF5ByCanonicalGameId) {
    for (const cardType of MLB_GAME_LINE_FALLBACK_CARD_TYPES) {
      const semanticKey = `${canonicalGameId}|${cardType}`;
      if (!currentByCanonicalType.has(semanticKey)) {
        missingSemanticKeys.add(semanticKey);
      }
    }
  }

  if (missingSemanticKeys.size === 0) return currentRows;

  const selectedFallbackRows = new Map<string, CardPayloadRow>();
  for (const row of fallbackRows) {
    if (
      !MLB_GAME_LINE_FALLBACK_CARD_TYPES.includes(
        row.card_type as (typeof MLB_GAME_LINE_FALLBACK_CARD_TYPES)[number],
      )
    ) {
      continue;
    }
    const canonicalGameId = externalToCanonicalMap.get(row.game_id) ?? row.game_id;
    const semanticKey = `${canonicalGameId}|${row.card_type}`;
    if (!missingSemanticKeys.has(semanticKey)) continue;
    if (selectedFallbackRows.has(semanticKey)) continue;

    const payload = parseCardPayloadData(row.payload_data);
    if (!payload) continue;

    if (
      !isEligibleMlbGameLineFallbackRow({
        row,
        payload,
        latestOddsCapturedAtByCanonicalId,
        canonicalGameId,
        nowEpochMs,
      })
    ) {
      continue;
    }

    selectedFallbackRows.set(semanticKey, row);
  }

  if (selectedFallbackRows.size === 0) return currentRows;
  return [...currentRows, ...selectedFallbackRows.values()];
}

function mergePropFallbackRows(params: {
  currentRows: CardPayloadRow[];
  fallbackRows: CardPayloadRow[];
  externalToCanonicalMap: Map<string, string>;
}): CardPayloadRow[] {
  const { currentRows, fallbackRows, externalToCanonicalMap } = params;

  const semanticKeys = new Set<string>();
  const mergedRows = [...currentRows];

  for (const row of currentRows) {
    const cardType = String(row.card_type || '').trim().toLowerCase();
    if (!PROP_FALLBACK_CARD_TYPES.has(cardType)) continue;
    const canonicalGameId = externalToCanonicalMap.get(row.game_id) ?? row.game_id;
    semanticKeys.add(`${canonicalGameId}|${cardType}|${row.card_title}`);
  }

  for (const row of fallbackRows) {
    const cardType = String(row.card_type || '').trim().toLowerCase();
    if (!PROP_FALLBACK_CARD_TYPES.has(cardType)) continue;

    const canonicalGameId = externalToCanonicalMap.get(row.game_id) ?? row.game_id;
    const semanticKey = `${canonicalGameId}|${cardType}|${row.card_title}`;
    if (semanticKeys.has(semanticKey)) continue;

    semanticKeys.add(semanticKey);
    mergedRows.push(row);
  }

  const dedupedById = new Map<string, CardPayloadRow>();
  for (const row of mergedRows) {
    dedupedById.set(row.id, row);
  }
  return Array.from(dedupedById.values());
}

interface IngestFailureRow {
  game_id: string;
  reason_code: string;
  reason_detail: string | null;
  last_seen: string;
}

type ApiGamesResponseMode = 'full' | 'degraded_base_games' | 'stale_cache';
type GamesTimeoutStage =
  | 'db_ready'
  | 'db_open'
  | 'load_games'
  | 'cards_query'
  | 'cards_parse'
  | 'response_build';
type GamesApiDataRow = {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  lifecycle_mode: LifecycleMode;
  display_status: DisplayStatus;
  createdAt: string;
  projection_inputs_complete: boolean | null;
  projection_missing_inputs: string[];
  source_mapping_ok: boolean | null;
  source_mapping_failures: string[];
  ingest_failure_reason_code: string | null;
  ingest_failure_reason_detail: string | null;
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
    publicBetsPctHome: number | null;
    publicBetsPctAway: number | null;
    publicHandlePctHome: number | null;
    publicHandlePctAway: number | null;
    splitsSource: string | null;
    capturedAt: string | null;
  } | null;
  consistency: Play['consistency'];
  true_play: Play | null;
  plays: Play[];
};
type GamesResponseMeta = {
  current_run_id: string | null;
  generated_at: string;
  run_status: ReturnType<typeof getRunStatus> | null;
  items_count: number;
  response_mode: ApiGamesResponseMode;
  timeout_fallback: boolean;
  timeout_stage?: GamesTimeoutStage;
  cache_age_ms?: number | null;
  stage_metrics: GamesStageMetricRecord;
  perf_ms?:
    | {
        total: number;
        db_ready: number;
        load_games: number;
        cards_query: number;
        cards_parse: number;
        card_rows: number;
        stage_metrics: GamesStageMetricRecord;
      }
    | undefined;
  diagnostics?: Record<string, unknown> | undefined;
};
type GamesResponsePayload = {
  success: true;
  data: GamesApiDataRow[];
  meta: GamesResponseMeta;
  join_debug?: Record<string, unknown>;
};
type GamesPerf = {
  dbReadyMs: number;
  loadGamesMs: number;
  cardsQueryMs: number;
  cardsParseMs: number;
  cardRows: number;
  totalMs: number;
  stageMetrics: GamesStageMetricRecord;
};
type GamesPayloadCacheEntry = {
  payload: GamesResponsePayload;
  cachedAt: number;
};

const lastGoodGamesPayloadCache = new Map<string, GamesPayloadCacheEntry>();

class GamesRouteTimeoutError extends Error {
  stage: GamesTimeoutStage;
  elapsedMs: number;

  constructor(stage: GamesTimeoutStage, elapsedMs: number) {
    super(
      `[API] /api/games request budget exceeded at ${stage} after ${elapsedMs}ms`,
    );
    this.name = 'GamesRouteTimeoutError';
    this.stage = stage;
    this.elapsedMs = elapsedMs;
  }
}

function createGamesCacheKey(
  lifecycleMode: LifecycleMode,
  sportFilter: string | null,
): string {
  return `${lifecycleMode}|${sportFilter ?? 'ALL'}`;
}

function createGamesRequestBudget(requestStartedAt: number) {
  const deadlineAt = requestStartedAt + API_GAMES_TIMEOUT_MS;
  return {
    timeoutMs: API_GAMES_TIMEOUT_MS,
    elapsedMs(): number {
      return Date.now() - requestStartedAt;
    },
    remainingMs(): number {
      return Math.max(0, deadlineAt - Date.now());
    },
    assertWithin(stage: GamesTimeoutStage): void {
      const elapsedMs = Date.now() - requestStartedAt;
      if (elapsedMs > API_GAMES_TIMEOUT_MS) {
        throw new GamesRouteTimeoutError(stage, elapsedMs);
      }
    },
  };
}

function isRecoverableGamesTimeoutError(error: unknown): boolean {
  if (error instanceof GamesRouteTimeoutError) {
    return true;
  }
  const message = String(
    error instanceof Error ? error.message : error ?? '',
  ).toLowerCase();
  return (
    message.includes('sqlite_busy') ||
    message.includes('database is locked') ||
    message.includes('database is busy') ||
    message.includes('busy_timeout')
  );
}

function isNonRecoverableGamesDbError(error: unknown): boolean {
  const message = String(
    error instanceof Error ? error.message : error ?? '',
  ).toLowerCase();
  return (
    message.includes('database file not found') ||
    message.includes('malformed and cannot be opened')
  );
}

function deriveTimeoutStage(
  error: unknown,
  fallbackStage: GamesTimeoutStage,
): GamesTimeoutStage {
  return error instanceof GamesRouteTimeoutError ? error.stage : fallbackStage;
}

export function buildGamesResponseData(
  rows: GameRow[],
  lifecycleMode: LifecycleMode,
  options?: {
    gameConsistencyMap?: Map<string, Play['consistency']>;
    truePlayMap?: Map<string, Play>;
    playsMap?: Map<string, Play[]>;
  },
): GamesApiDataRow[] {
  const gameConsistencyMap = options?.gameConsistencyMap ?? new Map();
  const truePlayMap = options?.truePlayMap ?? new Map();
  const playsMap = options?.playsMap ?? new Map();

  return rows.map((row) => {
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
            h2hConsensusConfidence: row.h2h_consensus_confidence ?? null,
            publicBetsPctHome: row.public_bets_pct_home ?? null,
            publicBetsPctAway: row.public_bets_pct_away ?? null,
            publicHandlePctHome: row.public_handle_pct_home ?? null,
            publicHandlePctAway: row.public_handle_pct_away ?? null,
            splitsSource: row.splits_source ?? null,
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
}

export function buildGamesSuccessPayload(params: {
  data: GamesApiDataRow[];
  currentRunId: string | null;
  runStatus: ReturnType<typeof getRunStatus> | null;
  perf: GamesPerf;
  responseMode: ApiGamesResponseMode;
  isDev: boolean;
  timeoutFallback?: boolean;
  timeoutStage?: GamesTimeoutStage;
  cacheAgeMs?: number | null;
  diagnostics?: Record<string, unknown>;
  joinDebug?: Record<string, unknown>;
  generatedAt?: string;
}): GamesResponsePayload {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const payload: GamesResponsePayload = {
    success: true,
    data: params.data,
    meta: {
      current_run_id: params.currentRunId,
      generated_at: generatedAt,
      run_status: params.runStatus,
      items_count: params.data.length,
      response_mode: params.responseMode,
      timeout_fallback: params.timeoutFallback ?? false,
      timeout_stage: params.timeoutStage,
      cache_age_ms: params.cacheAgeMs ?? null,
      stage_metrics: normalizeGamesStageMetrics(params.perf.stageMetrics),
      perf_ms: params.isDev
        ? {
            total: params.perf.totalMs,
            db_ready: params.perf.dbReadyMs,
            load_games: params.perf.loadGamesMs,
            cards_query: params.perf.cardsQueryMs,
            cards_parse: params.perf.cardsParseMs,
            card_rows: params.perf.cardRows,
            stage_metrics: normalizeGamesStageMetrics(params.perf.stageMetrics),
          }
        : undefined,
      diagnostics: params.diagnostics,
    },
  };
  if (params.joinDebug) {
    payload.join_debug = params.joinDebug;
  }
  return payload;
}

export function buildGamesTimeoutFallbackPayload(params: {
  rows: GameRow[] | null;
  lifecycleMode: LifecycleMode;
  currentRunId: string | null;
  runStatus: ReturnType<typeof getRunStatus> | null;
  perf: GamesPerf;
  timeoutStage: GamesTimeoutStage;
  cacheEntry?: GamesPayloadCacheEntry | null;
  isDev: boolean;
}): GamesResponsePayload | null {
  if (params.rows) {
    return buildGamesSuccessPayload({
      data: buildGamesResponseData(params.rows, params.lifecycleMode),
      currentRunId: params.currentRunId,
      runStatus: params.runStatus,
      perf: params.perf,
      responseMode: 'degraded_base_games',
      isDev: params.isDev,
      timeoutFallback: true,
      timeoutStage: params.timeoutStage,
      cacheAgeMs: null,
    });
  }

  if (!params.cacheEntry) {
    return null;
  }

  const cacheAgeMs = Math.max(0, Date.now() - params.cacheEntry.cachedAt);
  return {
    ...params.cacheEntry.payload,
    meta: {
      ...params.cacheEntry.payload.meta,
      response_mode: 'stale_cache',
      timeout_fallback: true,
      timeout_stage: params.timeoutStage,
      cache_age_ms: cacheAgeMs,
      stage_metrics: normalizeGamesStageMetrics(params.perf.stageMetrics),
      perf_ms: params.isDev
        ? {
            total: params.perf.totalMs,
            db_ready: params.perf.dbReadyMs,
            load_games: params.perf.loadGamesMs,
            cards_query: params.perf.cardsQueryMs,
            cards_parse: params.perf.cardsParseMs,
            card_rows: params.perf.cardRows,
            stage_metrics: normalizeGamesStageMetrics(params.perf.stageMetrics),
          }
        : undefined,
    },
  };
}

function normalizeDecisionBasisToken(
  value: string | null | undefined,
): Play['basis'] | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (normalized === 'ODDS_BACKED') return 'ODDS_BACKED';
  return undefined;
}

function normalizeExecutionStatusToken(
  value: string | null | undefined,
): Play['execution_status'] | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'EXECUTABLE') return 'EXECUTABLE';
  if (normalized === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (normalized === 'BLOCKED') return 'BLOCKED';
  return undefined;
}

function normalizeReasonCodeToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  if (normalized.length === 0) return null;
  // Historical DB rows can contain MARKET_DATA_STALE, STALE_MARKET_INPUT, and
  // WATCHDOG_STALE_SNAPSHOT. Normalize them on read; new writers emit only
  // STALE_MARKET / STALE_SNAPSHOT.
  const historicalStaleReasonCodes: Record<string, string> = {
    [['MARKET', 'DATA', 'STALE'].join('_')]: 'STALE_MARKET',
    [['STALE', 'MARKET', 'INPUT'].join('_')]: 'STALE_MARKET',
    [['WATCHDOG', 'STALE', 'SNAPSHOT'].join('_')]: 'STALE_SNAPSHOT',
  };
  return historicalStaleReasonCodes[normalized] ?? normalized;
}

function normalizeDropReasonMeta(value: unknown): DropReasonMeta | null {
  const raw = toObject(value);
  const code = normalizeReasonCodeToken(raw?.drop_reason_code);
  const layer =
    typeof raw?.drop_reason_layer === 'string'
      ? raw.drop_reason_layer.trim()
      : '';

  if (!code || layer.length === 0) {
    return null;
  }

  const normalizedBucket =
    typeof raw?.recovery_bucket === 'string' && raw.recovery_bucket.trim().length > 0
      ? (raw.recovery_bucket.trim().toLowerCase() as RecoveryBucket)
      : undefined;

  return buildDropReasonMeta(code, layer, normalizedBucket);
}

function resolveDerivedDropReason({
  executionGate,
  decisionV2,
  passReasonCode,
}: {
  executionGate: Record<string, unknown> | null;
  decisionV2: Play['decision_v2'] | undefined;
  passReasonCode: string | null;
}): DropReasonMeta | null {
  const canonicalEnvelope =
    decisionV2 && typeof decisionV2 === 'object'
      ? decisionV2.canonical_envelope_v2
      : null;
  const explicitDropReason = normalizeDropReasonMeta(executionGate?.drop_reason);
  if (explicitDropReason) return explicitDropReason;

  const envelopePrimaryReason = normalizeReasonCodeToken(
    canonicalEnvelope?.primary_reason_code,
  );
  if (
    (canonicalEnvelope?.official_status === 'PASS' ||
      canonicalEnvelope?.official_status === 'LEAN') &&
    envelopePrimaryReason
  ) {
    return buildDropReasonMeta(envelopePrimaryReason, 'decision_canonical_envelope');
  }

  const watchdogReasonCode =
    Array.isArray(decisionV2?.watchdog_reason_codes) &&
    decisionV2.watchdog_reason_codes.length > 0
      ? normalizeReasonCodeToken(decisionV2.watchdog_reason_codes[0])
      : null;
  if (decisionV2?.watchdog_status === 'BLOCKED' && watchdogReasonCode) {
    return buildDropReasonMeta(watchdogReasonCode, 'decision_watchdog');
  }

  const priceReasonCode =
    Array.isArray(decisionV2?.price_reason_codes) &&
    decisionV2.price_reason_codes.length > 0
      ? decisionV2.price_reason_codes
          .map((value) => normalizeReasonCodeToken(value))
          .find((value) => value != null && value !== 'EDGE_CLEAR') ?? null
      : null;
  if (
    ((canonicalEnvelope?.official_status === 'PASS' ||
      canonicalEnvelope?.official_status === 'LEAN') ||
      decisionV2?.official_status === 'PASS' ||
      decisionV2?.official_status === 'LEAN') &&
    priceReasonCode
  ) {
    return buildDropReasonMeta(priceReasonCode, 'decision_price');
  }

  const normalizedPassReasonCode = normalizeReasonCodeToken(passReasonCode);
  if (normalizedPassReasonCode) {
    return buildDropReasonMeta(normalizedPassReasonCode, 'publish_pass_reason');
  }

  const primaryReasonCode = normalizeReasonCodeToken(decisionV2?.primary_reason_code);
  if (
    ((canonicalEnvelope?.official_status === 'PASS' ||
      canonicalEnvelope?.official_status === 'LEAN') ||
      decisionV2?.official_status === 'PASS' ||
      decisionV2?.official_status === 'LEAN') &&
    primaryReasonCode
  ) {
    return buildDropReasonMeta(primaryReasonCode, 'decision_primary');
  }

  return null;
}

function resolveExecutionGateDebug({
  rawExecutionGate,
  decisionV2,
  passReasonCode,
}: {
  rawExecutionGate: Record<string, unknown> | null;
  decisionV2: Play['decision_v2'] | undefined;
  passReasonCode: string | null;
}): Play['execution_gate'] | null {
  const blockedBy = Array.isArray(rawExecutionGate?.blocked_by)
    ? Array.from(
        new Set(
          rawExecutionGate.blocked_by
            .map((value) => normalizeReasonCodeToken(value))
            .filter((value): value is string => value !== null),
        ),
      )
    : [];
  const dropReason = resolveDerivedDropReason({
    executionGate: rawExecutionGate,
    decisionV2,
    passReasonCode,
  });

  if (!rawExecutionGate && blockedBy.length === 0 && !dropReason) {
    return null;
  }

  return {
    ...(rawExecutionGate ?? {}),
    blocked_by: blockedBy.length > 0 ? blockedBy : undefined,
    drop_reason: dropReason,
  };
}

function collectPlayReasonCodes({
  payloadReasonCodes,
  payloadPlayReasonCodes,
  driverReasonCodes,
  v2GuardFlags,
  decisionV2,
  passReasonCode,
  executionGate,
  pipelineBlockingReasonCodes,
}: {
  payloadReasonCodes: unknown[];
  payloadPlayReasonCodes: unknown[];
  driverReasonCodes: unknown[];
  v2GuardFlags: unknown[];
  decisionV2: Play['decision_v2'] | undefined;
  passReasonCode: string | null;
  executionGate: Play['execution_gate'] | null;
  pipelineBlockingReasonCodes: unknown[];
}): string[] {
  const combinedReasonCodes = [
    ...payloadReasonCodes,
    ...payloadPlayReasonCodes,
    ...driverReasonCodes,
    ...v2GuardFlags,
    ...(decisionV2?.watchdog_reason_codes ?? []),
    ...(decisionV2?.price_reason_codes ?? []),
    decisionV2?.primary_reason_code,
    passReasonCode,
    ...(executionGate?.blocked_by ?? []),
    executionGate?.drop_reason?.drop_reason_code,
    ...pipelineBlockingReasonCodes,
  ]
    .map((value) => normalizeReasonCodeToken(value))
    .filter((value): value is string => value !== null);

  return Array.from(new Set(combinedReasonCodes));
}

function isProjectionOnlyPlayPayload(play: Play): boolean {
  const lineSource = play.line_source?.trim().toUpperCase() ?? null;
  const marketLineSource =
    play.market_context?.wager?.line_source?.trim().toUpperCase() ?? null;
  const projectionSource =
    play.prop_decision?.projection_source?.trim().toUpperCase() ?? null;

  return (
    play.basis === 'PROJECTION_ONLY' ||
    play.execution_status === 'PROJECTION_ONLY' ||
    play.prop_display_state === 'PROJECTION_ONLY' ||
    (lineSource != null && PROJECTION_ONLY_LINE_SOURCES.has(lineSource)) ||
    (marketLineSource != null &&
      PROJECTION_ONLY_LINE_SOURCES.has(marketLineSource)) ||
    projectionSource === 'SYNTHETIC_FALLBACK'
  );
}

export async function GET(request: NextRequest) {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  const requestStartedAt = Date.now();
  const budget = createGamesRequestBudget(requestStartedAt);
  const stageCounters = createStageCounters();
  const gamesWithPlayableMarkets = new Map<string, Map<string, Set<string>>>();
  const outOfContractPlayDowngrades = new Map<string, number>();
  const perf: GamesPerf = {
    dbReadyMs: 0,
    loadGamesMs: 0,
    cardsQueryMs: 0,
    cardsParseMs: 0,
    cardRows: 0,
    totalMs: 0,
    stageMetrics: createGamesStageMetrics(),
  };
  const stageTracker = createGamesStageTracker(perf.stageMetrics);
  const isDev = process.env.NODE_ENV !== 'production';
  let currentStage: GamesTimeoutStage = 'db_ready';
  let lifecycleMode: LifecycleMode = 'pregame';
  let sportFilter: string | null = null;
  let rows: GameRow[] | null = null;
  let activeRunIds: string[] = [];
  let currentRunId: string | null = null;
  let runStatus: ReturnType<typeof getRunStatus> | null = null;
  let cacheKey: string | null = null;
  try {
    // Security checks: rate limiting, input validation
    const securityCheck = performSecurityChecks(request, '/api/games');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    stageTracker.enter('query');
    currentStage = 'db_ready';
    const dbReadyStartedAt = Date.now();
    await ensureDbReady();
    perf.dbReadyMs = Date.now() - dbReadyStartedAt;
    budget.assertWithin('db_ready');

    const access = requireEntitlementForRequest(request, RESOURCE.CHEDDAR_BOARD);
    if (!access.ok) {
      return NextResponse.json(
        { success: false, error: access.error },
        { status: access.status }
      );
    }

    currentStage = 'db_open';
    db = getDatabaseReadOnly();
    const busyTimeoutMs = Math.max(
      1,
      Math.min(API_GAMES_BUSY_TIMEOUT_MS, Math.max(1, budget.remainingMs())),
    );
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    budget.assertWithin('db_open');

    activeRunIds = getActiveRunIds(db);
    if (activeRunIds.length === 0) {
      activeRunIds = getFallbackRunIdsFromCards(db);
    }
    currentRunId = activeRunIds[0] ?? null;
    runStatus = getRunStatus(db, currentRunId);

    // Check if database is empty or uninitialized
    const tableCheckStmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='games'`,
    );
    const hasGamesTable = tableCheckStmt.get();

    if (!hasGamesTable) {
      // Database is not initialized - return empty data
      stageTracker.enter('transform');
      perf.totalMs = Date.now() - requestStartedAt;
      stageTracker.finish();
      const payload = buildGamesSuccessPayload({
        data: [],
        currentRunId,
        runStatus,
        perf,
        responseMode: 'full',
        isDev,
      });
      const response = NextResponse.json(payload, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (cacheKey) {
        lastGoodGamesPayloadCache.set(cacheKey, {
          payload,
          cachedAt: Date.now(),
        });
      }
      return addRateLimitHeaders(response, request);
    }

    const searchParams = request.nextUrl.searchParams;
    lifecycleMode = resolveLifecycleMode(searchParams);
    sportFilter = resolveSportFilter(searchParams);
    cacheKey = createGamesCacheKey(lifecycleMode, sportFilter);
    if (sportFilter === INVALID_SPORT_FILTER) {
      return NextResponse.json(
        { success: false, error: 'Unknown sport filter' },
        { status: 400 },
      );
    }

    const now = new Date();
    const isNonProd = isDev;
    const queryWindow = resolveGamesQueryWindow({
      now,
      lifecycleMode,
    });
    const {
      nowUtc,
      gamesStartUtc,
      activeStartUtc,
      gamesEndUtc,
    } = queryWindow;

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
        AND UPPER(g.sport) IN (${ACTIVE_GAME_SPORT_SQL})
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
        AND UPPER(g.sport) IN (${ACTIVE_GAME_SPORT_SQL})
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
          | 'public_bets_pct_home'
          | 'public_bets_pct_away'
          | 'public_handle_pct_home'
          | 'public_handle_pct_away'
          | 'splits_source'
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
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'public_bets_pct_home')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'public_bets_pct_away')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'public_handle_pct_home')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'public_handle_pct_away')},
          ${buildOptionalOddsSelect(oddsSnapshotColumns, 'splits_source')},
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
        public_bets_pct_home: number | null;
        public_bets_pct_away: number | null;
        public_handle_pct_home: number | null;
        public_handle_pct_away: number | null;
        splits_source: string | null;
        odds_captured_at: string | null;
        raw_data: string | null;
      }>;

      const latestOddsByGameId = new Map(
        latestOddsRows.map((row) => [row.game_id, row]),
      );

      const eventAliasToleranceMinutesRaw = Number(
        process.env.API_GAMES_EVENT_ALIAS_TOLERANCE_MINUTES || 30,
      );
      const eventAliasToleranceMs =
        Number.isFinite(eventAliasToleranceMinutesRaw) &&
        eventAliasToleranceMinutesRaw > 0
          ? eventAliasToleranceMinutesRaw * 60_000
          : 30 * 60_000;

      const normalizeEventAliasTime = (value: string | null): number | null => {
        if (typeof value !== 'string' || value.trim().length === 0) return null;
        const epochMs = Date.parse(value);
        return Number.isFinite(epochMs) ? epochMs : null;
      };

      const buildEventAliasKey = (game: {
        sport: string;
        away_team: string;
        home_team: string;
        game_time_utc: string | null;
      }): string => {
        const dayToken =
          typeof game.game_time_utc === 'string' && game.game_time_utc.length >= 10
            ? game.game_time_utc.slice(0, 10)
            : 'unknown-day';
        return [
          String(game.sport || '').toUpperCase(),
          String(game.away_team || '').toUpperCase(),
          String(game.home_team || '').toUpperCase(),
          dayToken,
        ].join('|');
      };

      const baseGameIdsByAliasKey = new Map<string, string[]>();
      for (const game of baseGames) {
        const aliasKey = buildEventAliasKey(game);
        const existing = baseGameIdsByAliasKey.get(aliasKey) ?? [];
        existing.push(game.game_id);
        baseGameIdsByAliasKey.set(aliasKey, existing);
      }

      const resolveLatestOddsForGame = (
        game: (typeof baseGames)[number],
      ): (typeof latestOddsRows)[number] | null => {
        const direct = latestOddsByGameId.get(game.game_id);
        if (direct) return direct;

        const gameTimeMs = normalizeEventAliasTime(game.game_time_utc);
        const aliasIds = baseGameIdsByAliasKey.get(buildEventAliasKey(game)) ?? [];
        if (aliasIds.length === 0) return null;

        let bestCandidate: (typeof latestOddsRows)[number] | null = null;
        let bestCapturedAtMs = -1;

        for (const aliasId of aliasIds) {
          if (aliasId === game.game_id) continue;
          const candidateGame = baseGames.find((row) => row.game_id === aliasId);
          if (!candidateGame) continue;

          const candidateTimeMs = normalizeEventAliasTime(candidateGame.game_time_utc);
          if (
            gameTimeMs !== null &&
            candidateTimeMs !== null &&
            Math.abs(candidateTimeMs - gameTimeMs) > eventAliasToleranceMs
          ) {
            continue;
          }

          const candidateOdds = latestOddsByGameId.get(aliasId);
          if (!candidateOdds) continue;

          const candidateCapturedAtMs = normalizeEventAliasTime(
            candidateOdds.odds_captured_at,
          );
          const rankingValue = candidateCapturedAtMs ?? 0;
          if (!bestCandidate || rankingValue > bestCapturedAtMs) {
            bestCandidate = candidateOdds;
            bestCapturedAtMs = rankingValue;
          }
        }

        return bestCandidate;
      };

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
        const odds = resolveLatestOddsForGame(game);
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
          public_bets_pct_home: odds?.public_bets_pct_home ?? null,
          public_bets_pct_away: odds?.public_bets_pct_away ?? null,
          public_handle_pct_home: odds?.public_handle_pct_home ?? null,
          public_handle_pct_away: odds?.public_handle_pct_away ?? null,
          splits_source: odds?.splits_source ?? null,
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

    currentStage = 'load_games';
    const loadGamesStartedAt = Date.now();
    const activeLifecycleFallbackApplied = false;
    // Active mode uses activeStartUtc (yesterday midnight ET) so late-night
    // games started before today's ET midnight boundary remain visible while
    // in progress. Pregame uses gamesStartUtc (today midnight ET).
    const initialStartUtc = resolveGamesQueryStartUtc({
      lifecycleMode,
      activeStartUtc,
      gamesStartUtc,
    });
    rows = loadGamesWithLatestOdds(initialStartUtc, gamesEndUtc);

    if (isNonProd && rows.length === 0) {
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
    // (yesterday midnight ET) covers all games that could still be in-progress.
    perf.loadGamesMs = Date.now() - loadGamesStartedAt;
    budget.assertWithin('load_games');

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
    const truePlayMap = new Map<string, Play>();
    const gameConsistencyMap = new Map<string, Play['consistency']>();
    const seenNhlShotsPlayKeys = new Set<string>();
    const seenMlbPitcherKPlayKeys = new Set<string>();
    const injuredNhlPlayerIds = new Set<string>();
    const injuredNhlPlayerNames = new Set<string>();
    // Collect normalized drop reasons for dev-mode diagnostics.
    const parsedDropReasons: DropReasonMeta[] = [];

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
        SELECT id, game_id, card_type, card_title, payload_data, created_at
        FROM card_payloads
        WHERE game_id IN (${queryPlaceholders})
          ${runClause}
          ${ENABLE_WELCOME_HOME ? '' : "AND card_type NOT IN ('welcome-home', 'welcome-home-v2')"}
        ORDER BY
          CASE WHEN ${API_GAMES_PROP_PRIORITY_SQL} THEN 0 ELSE 1 END,
          created_at DESC,
          id DESC
        LIMIT ${API_GAMES_MAX_CARD_ROWS}
      `;
      };
      let cardRows: CardPayloadRow[] = [];
      try {
        currentStage = 'cards_query';
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
                const canonicalGameId =
                  externalToCanonicalMap.get(row.game_id) ?? row.game_id;
                const semanticKey = `${canonicalGameId}|${row.card_type}|${row.card_title}`;
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

          // MLB full-game fallback merge by canonical (game_id, card_type) so
          // current-run mlb-f5 rows do not mask publishable full-game rows.
          if (allQueryableIds.length > 0) {
            const fallbackStmt = db.prepare(buildCardsSql(allQueryableIds, ''));
            const fallbackRows = fallbackStmt.all(
              ...allQueryableIds,
            ) as CardPayloadRow[];
            if (fallbackRows.length > 0) {
              cardRows = mergePropFallbackRows({
                currentRows: cardRows,
                fallbackRows,
                externalToCanonicalMap,
              });

              // Re-enable MLB full-game fallback merge with strict eligibility guards
              // so active-run filtering does not drop valid publishable game-line rows.
              const latestOddsCapturedAtByCanonicalId = new Map(
                rows.map((row) => [row.game_id, row.odds_captured_at]),
              );
              cardRows = mergeMlbGameLineFallbackRows({
                currentRows: cardRows,
                fallbackRows,
                externalToCanonicalMap,
                latestOddsCapturedAtByCanonicalId,
              });
            }
          }
        }
        perf.cardsQueryMs += Date.now() - cardsQueryStartedAt;
        budget.assertWithin('cards_query');
      } catch (error) {
        if (isRecoverableGamesTimeoutError(error)) {
          throw error;
        }
        const message = String(
          error instanceof Error ? error.message : error ?? '',
        ).toLowerCase();
        if (!message.includes('no such table')) {
          throw error;
        }
        // card_payloads table not yet created; plays will be empty
      }

      // ADR-0003 true-play authority: live selection must be computed only from
      // card_payloads decision data. card_display_log remains historical/analytics
      // evidence and is intentionally excluded from live authority selection.

      perf.cardRows = cardRows.length;
      stageTracker.enter('service');
      currentStage = 'cards_parse';
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
        const payloadPipelineState = toObject(payload.pipeline_state);
        const payloadMarketContext =
          toObject((payload as Record<string, unknown>).market_context) ??
          toObject(payloadPlayObj?.market_context);
        const payloadMarketContextProjection = toObject(
          payloadMarketContext?.projection,
        );
        const payloadMarketContextWager = toObject(payloadMarketContext?.wager);
        const normalizedDecisionV2 = normalizeDecisionV2(
          (payload as Record<string, unknown>).decision_v2 ??
            payloadPlay?.decision_v2,
        );
        const canonicalEnvelope =
          normalizedDecisionV2?.canonical_envelope_v2 &&
          typeof normalizedDecisionV2.canonical_envelope_v2 === 'object'
            ? normalizedDecisionV2.canonical_envelope_v2
            : null;
        const canonicalEnvelopeSelectionSide = firstString(
          canonicalEnvelope?.selection_side,
          canonicalEnvelope?.direction,
        );
        const canonicalEnvelopeSelectionTeam = firstString(
          canonicalEnvelope?.selection_team,
        );
        const payloadSelection =
          toObject(payload.selection) ?? toObject(payloadPlay?.selection);
        const payloadSelectionRaw = firstString(
          (payload as Record<string, unknown>).selection,
          (payload as Record<string, unknown>).outcome,
        );
        const normalizedSelectionSide =
          normalizeSelectionSide(
            canonicalEnvelopeSelectionSide ??
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
        const normalizedMarketTypeRaw = normalizeMarketType(
          payload.market_type ??
            payloadPlay?.market_type ??
            payloadMarketContext?.market_type,
        );
        const normalizedMarketType =
          rowSport === 'MLB' && normalizedMarketTypeRaw === 'FIRST_PERIOD'
            ? ('FIRST_5_INNINGS' as const)
            : normalizedMarketTypeRaw;
        const inferredMarketTypeFromCardType = inferMarketFromCardType(
          cardRow.card_type,
        );
        const normalizedDisplaySelectionSide = normalizedSelectionSide;
        const normalizedPrediction =
          normalizedDisplaySelectionSide === 'HOME' ||
          normalizedDisplaySelectionSide === 'AWAY' ||
          normalizedDisplaySelectionSide === 'OVER' ||
          normalizedDisplaySelectionSide === 'UNDER'
            ? normalizedDisplaySelectionSide
            : baseNormalizedPrediction;
        const normalizedPlayerName = firstString(
          (payload as Record<string, unknown>).player_name,
          payloadPlay?.player_name,
          payloadSelection?.player_name,
        );
        const normalizedSelectionTeamBase = firstString(
          normalizedPlayerName,
          canonicalEnvelopeSelectionTeam,
          payloadSelection?.team,
          payloadMarketContext?.selection_team,
          payloadPlay?.team,
        );
        const normalizedSelectionTeam = normalizedSelectionTeamBase;
        const normalizedLineBase = firstNumber(
          payload.line,
          payloadMarketContextWager?.called_line,
          (payload.market as Record<string, unknown>)?.line,
          payloadPlay?.line,
          payloadSelection?.line,
        );
        const normalizedLine = normalizedLineBase;
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
        const normalizedPrice = normalizedPriceBase;
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
        const payloadDecisionBasisMeta = toObject(
          (payload as Record<string, unknown>).decision_basis_meta,
        );
        const normalizedDecisionBasis = normalizeDecisionBasisToken(
          firstString(
            (payload as Record<string, unknown>).basis,
            (payload as Record<string, unknown>).decision_basis,
            payloadDecisionBasisMeta?.decision_basis,
            payloadPlay?.basis,
            payloadPlay?.decision_basis,
          ),
        );
        const normalizedExecutionStatus = normalizeExecutionStatusToken(
          firstString(
            (payload as Record<string, unknown>).execution_status,
            payloadPlay?.execution_status,
          ),
        );
        const normalizedPassReasonCode = normalizePassReasonCode(
          payload.pass_reason_code ??
            payload.pass_reason ??
            payloadPlay?.pass_reason_code ??
            payloadPlay?.pass_reason,
        );
        const normalizedExecutionGate = resolveExecutionGateDebug({
          rawExecutionGate:
            toObject((payload as Record<string, unknown>).execution_gate) ??
            toObject(payloadPlay?.execution_gate),
          decisionV2: normalizedDecisionV2,
          passReasonCode: normalizedPassReasonCode,
        });
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
        const rawPropDisplayState = firstString(
          (payload as Record<string, unknown>).prop_display_state,
          payloadPlay?.prop_display_state,
        );
        const normalizedPropDisplayState =
          rawPropDisplayState === 'PLAY' ||
          rawPropDisplayState === 'WATCH' ||
          rawPropDisplayState === 'PROJECTION_ONLY'
            ? (rawPropDisplayState as 'PLAY' | 'WATCH' | 'PROJECTION_ONLY')
            : undefined;
        const rawPropDecisionVerdict = firstString(
          rawPropDecision?.verdict,
          payloadPlayPropDecision?.verdict,
        );
        // 'PASS' is the pitcher-K model's projection-only verdict — map it to
        // 'PROJECTION' so the card's k_mean and related fields are not dropped.
        const normalizedPropDecisionVerdict: 'PLAY' | 'WATCH' | 'NO_PLAY' | 'PROJECTION' | null =
          rawPropDecisionVerdict === 'PLAY' ? 'PLAY'
          : rawPropDecisionVerdict === 'WATCH' ? 'WATCH'
          : rawPropDecisionVerdict === 'NO_PLAY' ? 'NO_PLAY'
          : rawPropDecisionVerdict === 'PROJECTION' || rawPropDecisionVerdict === 'PASS' ? 'PROJECTION'
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
              // Pitcher-K prop fields
              k_mean:
                firstNumber(
                  rawPropDecision.k_mean,
                  payloadPlayPropDecision?.k_mean,
                ) ?? null,
              probability_ladder:
                (rawPropDecision.probability_ladder != null &&
                typeof rawPropDecision.probability_ladder === 'object'
                  ? (rawPropDecision.probability_ladder as Record<string, unknown>)
                  : null) ??
                (payloadPlayPropDecision?.probability_ladder != null &&
                typeof payloadPlayPropDecision.probability_ladder === 'object'
                  ? (payloadPlayPropDecision.probability_ladder as Record<string, unknown>)
                  : null),
              fair_prices:
                (rawPropDecision.fair_prices != null &&
                typeof rawPropDecision.fair_prices === 'object'
                  ? (rawPropDecision.fair_prices as Record<string, unknown>)
                  : null) ??
                (payloadPlayPropDecision?.fair_prices != null &&
                typeof payloadPlayPropDecision.fair_prices === 'object'
                  ? (payloadPlayPropDecision.fair_prices as Record<string, unknown>)
                  : null),
              playability:
                (rawPropDecision.playability != null &&
                typeof rawPropDecision.playability === 'object'
                  ? (rawPropDecision.playability as Record<string, unknown>)
                  : null) ??
                (payloadPlayPropDecision?.playability != null &&
                typeof payloadPlayPropDecision.playability === 'object'
                  ? (payloadPlayPropDecision.playability as Record<string, unknown>)
                  : null),
              projection_source:
                firstString(
                  rawPropDecision.projection_source,
                  payloadPlayPropDecision?.projection_source,
                ) ?? null,
              status_cap:
                firstString(
                  rawPropDecision.status_cap,
                  payloadPlayPropDecision?.status_cap,
                ) ?? null,
              pass_reason_code:
                firstString(
                  rawPropDecision.pass_reason_code,
                  payloadPlayPropDecision?.pass_reason_code,
                ) ?? null,
              missing_inputs: Array.from(
                new Set(
                  [
                    ...(Array.isArray(rawPropDecision.missing_inputs)
                      ? rawPropDecision.missing_inputs
                      : []),
                    ...(Array.isArray(payloadPlayPropDecision?.missing_inputs)
                      ? payloadPlayPropDecision.missing_inputs
                      : []),
                  ].map((value) => String(value)),
                ),
              ),
            }
          : undefined;
        const normalizedProjectionSettlementPolicy =
          normalizeProjectionSettlementPolicy(
            (payload as Record<string, unknown>).projection_settlement_policy ??
              payloadPlayObj?.projection_settlement_policy,
          );
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
        const combinedReasonCodes = collectPlayReasonCodes({
          payloadReasonCodes: Array.isArray(payload.reason_codes)
            ? payload.reason_codes
            : [],
          payloadPlayReasonCodes: Array.isArray(payloadPlay?.reason_codes)
            ? payloadPlay.reason_codes
            : [],
          driverReasonCodes: Array.isArray(driverInputs?.reason_codes)
            ? driverInputs.reason_codes
            : [],
          v2GuardFlags,
          decisionV2: normalizedDecisionV2,
          passReasonCode: normalizedPassReasonCode,
          executionGate: normalizedExecutionGate,
          pipelineBlockingReasonCodes: Array.isArray(
            payloadPipelineState?.blocking_reason_codes,
          )
            ? payloadPipelineState.blocking_reason_codes
            : [],
        });
        const combinedTags = [
          ...(Array.isArray(payload.tags) ? payload.tags : []),
          ...(Array.isArray(payloadPlay?.tags) ? payloadPlay.tags : []),
        ].map((value) => String(value));
        const dedupedReasonCodes = combinedReasonCodes;
        const dedupedTags = Array.from(new Set(combinedTags));

        // MLB full-game legacy rows (no decision_v2) carry native status/edge
        // directly in payload fields. Preserve those statuses without relaxing
        // fail-closed canonical reads for modern/non-MLB rows.
        const isMlbFullGameCardType = (MLB_GAME_LINE_FALLBACK_CARD_TYPES as readonly string[]).includes(
          cardRow.card_type,
        );
        const hasLegacyNativeDecisionFields =
          normalizedDecisionV2 == null &&
          (typeof payload.status === 'string' ||
            typeof payload.action === 'string' ||
            typeof payload.classification === 'string' ||
            typeof payloadPlay?.status === 'string' ||
            typeof payloadPlay?.action === 'string' ||
            typeof payloadPlay?.classification === 'string');
        const isMlbFullGameLegacyDecisionPlay =
          isMlbFullGameCardType && hasLegacyNativeDecisionFields;
        const isProjectionSurfaceLegacyDecisionPlay =
          isProjectionSurfaceCardType(cardRow.card_type) &&
          hasLegacyNativeDecisionFields &&
          normalizedDecisionV2 == null;
        const runtimeDecision = isMlbFullGameLegacyDecisionPlay
          || isProjectionSurfaceLegacyDecisionPlay
          ? null
          : readRuntimeCanonicalDecision(
              {
                decision_v2: (normalizedDecisionV2 ?? null) as Record<string, unknown> | null,
                action: normalizedAction,
                classification: normalizedClassification,
                status: normalizedStatus,
                pass_reason_code: normalizedPassReasonCode,
              },
              { stage: 'read_api' },
            );
        const resolvedAction: Play['action'] = runtimeDecision?.action ?? normalizedAction;
        const resolvedClassification: Play['classification'] =
          runtimeDecision?.classification ?? normalizedClassification;
        const resolvedStatus: Play['status'] = runtimeDecision?.status ?? normalizedStatus;
        const legacyMlbDecisionV2 = (isMlbFullGameLegacyDecisionPlay
          ? {
              official_status:
                resolvedAction === 'FIRE'
                  ? 'PLAY'
                  : resolvedAction === 'HOLD'
                    ? 'LEAN'
                    : 'PASS',
              direction:
                normalizedSelectionSide === 'HOME' ||
                normalizedSelectionSide === 'AWAY' ||
                normalizedSelectionSide === 'OVER' ||
                normalizedSelectionSide === 'UNDER'
                  ? normalizedSelectionSide
                  : 'NONE',
              fair_prob: normalizedPFair ?? null,
              implied_prob: normalizedPImplied ?? null,
              edge_pct: normalizedEdgePct ?? null,
              edge_delta_pct: normalizedEdgePct ?? null,
              play_tier: null,
              support_score: null,
              conflict_score: null,
              drivers_used: [],
              driver_reasons: [],
              primary_reason_code: normalizedPassReasonCode ?? 'EDGE_CLEAR',
              watchdog_status: 'OK',
              watchdog_reason_codes: [],
              sharp_price_status: null,
              price_reason_codes: [],
              missing_data: {
                missing_fields: [],
                source_attempts: [],
                severity: 'INFO',
              },
              consistency: {
                total_bias: 'UNKNOWN',
              },
              pricing_trace: {
                line_source: null,
                price_source: null,
              },
              pipeline_version: 'v2',
              decided_at: cardRow.created_at,
            }
          : normalizedDecisionV2) as Play['decision_v2'];
        const decisionOutcome = legacyMlbDecisionV2
          ? buildDecisionOutcomeFromDecisionV2(legacyMlbDecisionV2)
          : null;
        const decisionOutcomeBlockers = Array.isArray(
          decisionOutcome?.reasons?.blockers,
        )
          ? decisionOutcome.reasons.blockers.filter(
              (value: unknown): value is string =>
                typeof value === 'string' && value.length > 0,
            )
          : [];
        const normalizedDecisionOutcome = decisionOutcome
          ? {
              ...decisionOutcome,
              reasons: {
                ...(decisionOutcome.reasons ?? {}),
                blockers: decisionOutcomeBlockers,
              },
            }
          : null;
        const resolvedPassReasonCode =
          normalizedPassReasonCode ?? decisionOutcomeBlockers[0] ?? null;
        const dedupedReasonCodesWithOutcome = Array.from(
          new Set([...dedupedReasonCodes, ...decisionOutcomeBlockers]),
        );
        const onePModelCall =
          cardRow.card_type === 'nhl-pace-1p'
            ? deriveNhl1PModelCall(dedupedReasonCodesWithOutcome, normalizedPrediction)
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
            // Pitcher-K prop fields (belt-and-suspenders fallback for transform)
            k_mean:
              firstNumber(
                payloadProjection?.k_mean,
                payloadPlayProjection?.k_mean,
              ) ?? null,
            probability_ladder:
              (payloadProjection?.probability_ladder != null &&
              typeof payloadProjection.probability_ladder === 'object'
                ? (payloadProjection.probability_ladder as Record<string, unknown>)
                : null) ??
              (payloadPlayProjection?.probability_ladder != null &&
              typeof payloadPlayProjection.probability_ladder === 'object'
                ? (payloadPlayProjection.probability_ladder as Record<string, unknown>)
                : null),
            fair_prices:
              (payloadProjection?.fair_prices != null &&
              typeof payloadProjection.fair_prices === 'object'
                ? (payloadProjection.fair_prices as Record<string, unknown>)
                : null) ??
              (payloadPlayProjection?.fair_prices != null &&
              typeof payloadPlayProjection.fair_prices === 'object'
                ? (payloadPlayProjection.fair_prices as Record<string, unknown>)
                : null),
            // MLB F5 projected run splits
            projected_home_f5_runs:
              firstNumber(
                payloadProjection?.projected_home_f5_runs,
                payloadPlayProjection?.projected_home_f5_runs,
              ) ?? null,
            projected_away_f5_runs:
              firstNumber(
                payloadProjection?.projected_away_f5_runs,
                payloadPlayProjection?.projected_away_f5_runs,
              ) ?? null,
          },
          status: resolvedStatus,
          // Canonical decision fields (preferred over legacy status field)
          classification: resolvedClassification,
          action: resolvedAction,
          pass_reason_code: resolvedPassReasonCode,
          decision_outcome: normalizedDecisionOutcome,
          one_p_model_call: onePModelCall,
          one_p_bet_status: onePBetStatus,
          goalie_home_name: normalizedGoalieHomeName ?? null,
          goalie_away_name: normalizedGoalieAwayName ?? null,
          goalie_home_status: normalizedGoalieHomeStatus ?? null,
          goalie_away_status: normalizedGoalieAwayStatus ?? null,
          decision_v2: legacyMlbDecisionV2,
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
              : inferredMarketTypeFromCardType !== undefined
                ? inferredMarketTypeFromCardType
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
          reason_codes: dedupedReasonCodesWithOutcome,
          projection_inputs_complete:
            typeof payload.core_inputs_complete === 'boolean'
              ? payload.core_inputs_complete
              : typeof payloadPlay?.core_inputs_complete === 'boolean'
                ? payloadPlay.core_inputs_complete
                : typeof payload.projection_inputs_complete === 'boolean'
                  ? payload.projection_inputs_complete
                  : typeof payloadPlay?.projection_inputs_complete === 'boolean'
                    ? payloadPlay.projection_inputs_complete
                    : null,
          core_inputs_complete:
            typeof payload.core_inputs_complete === 'boolean'
              ? payload.core_inputs_complete
              : typeof payloadPlay?.core_inputs_complete === 'boolean'
                ? payloadPlay.core_inputs_complete
                : null,
          missing_inputs: normalizeDiagnosticArray([
              ...(Array.isArray(payload.core_missing_inputs)
                ? payload.core_missing_inputs
                : Array.isArray(payload.missing_inputs)
                  ? payload.missing_inputs
                  : []),
              ...(Array.isArray(payloadPlay?.core_missing_inputs)
                ? payloadPlay.core_missing_inputs
                : []),
              ...(Array.isArray(payloadPlay?.missing_inputs)
                ? payloadPlay.missing_inputs
                : []),
            ]),
          core_missing_inputs: normalizeDiagnosticArray([
              ...(Array.isArray(payload.core_missing_inputs)
                ? payload.core_missing_inputs
                : []),
              ...(Array.isArray(payloadPlay?.core_missing_inputs)
                ? payloadPlay.core_missing_inputs
                : []),
            ]),
          feature_flags: Array.from(
            new Set([
              ...(Array.isArray(payload.feature_flags) ? payload.feature_flags : []),
              ...(Array.isArray(payloadPlay?.feature_flags)
                ? payloadPlay.feature_flags
                : []),
            ].map((value) => String(value))),
          ),
          market_status:
            normalizeApiMarketStatus(payload.market_status) ??
            normalizeApiMarketStatus(payloadPlay?.market_status),
          source_mapping_ok:
            typeof payload.source_mapping_ok === 'boolean'
              ? payload.source_mapping_ok
              : typeof payloadPlay?.source_mapping_ok === 'boolean'
                ? payloadPlay.source_mapping_ok
                : null,
          source_mapping_failures: normalizeDiagnosticArray([
              ...(Array.isArray(payload.source_mapping_failures)
                ? payload.source_mapping_failures
                : []),
              ...(Array.isArray(payloadPlay?.source_mapping_failures)
                ? payloadPlay.source_mapping_failures
                : []),
            ]),
          tags: dedupedTags,
          run_id: normalizedRunId,
          created_at: normalizedCreatedAt ?? cardRow.created_at,
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
          basis: normalizedDecisionBasis,
          execution_status: normalizedExecutionStatus,
          projection_settlement_policy: normalizedProjectionSettlementPolicy,
          projection_source:
            firstString(
              payload.projection_source,
              payloadPlay?.projection_source,
              normalizedPropDecision?.projection_source,
            ) ?? null,
          execution_gate: normalizedExecutionGate,
          prop_display_state: normalizedPropDisplayState,
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

        // PROP plays (nhl-player-shots, mlb-pitcher-k) and designated projection-surface
        // card types (nhl-pace-1p, mlb-f5, mlb-f5-ml, mlb-full-game, mlb-full-game-ml)
        // must pass through even when PROJECTION_ONLY.
        // - PROP plays are shown in the Player Props tab with propVerdict='PROJECTION'
        // - these card types are the sole source for Game Props surfaces in degraded windows
        // Filtering them here means those tabs are permanently empty.
        const isProjectionSurfaceType =
          isProjectionSurfaceCardType(cardRow.card_type);
        const isPropMarket = play.market_type === 'PROP';

        if (play.execution_gate?.drop_reason) {
          parsedDropReasons.push(play.execution_gate.drop_reason);
        }

        if (isProjectionOnlyPlayPayload(play) && !isPropMarket && !isProjectionSurfaceType) {
          continue;
        }

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
            cardRow.card_type === 'nhl-player-blk' ||
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
            play.canonical_market_key === 'pitcher_strikeouts');
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
        const sportCardTypeContract =
          ACTIVE_SPORT_CARD_TYPE_CONTRACT[normalizeSport(parsedSport) ?? ''];
        const playProducerCardTypes =
          sportCardTypeContract?.playProducerCardTypes;
        const kindContractResult = applyCardTypeKindContract(
          parsedSport,
          cardRow.card_type,
          fallbackKind,
          sportCardTypeContract,
        );
        play.kind = kindContractResult.kind;
        const isDeclaredPlayProducerCardType =
          playProducerCardTypes?.has(cardRow.card_type) === true;
        if (isDeclaredPlayProducerCardType && play.kind !== 'PLAY') {
          play.kind = 'PLAY';
        }
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
        // isMlbFullGameLegacyDecisionPlay is computed above (before readRuntimeCanonicalDecision).
        const isPropPlay = play.market_type === 'PROP';

        if (wave1Eligible && !isPropPlay) {
          if (!isMlbFullGameLegacyDecisionPlay && !isProjectionSurfaceLegacyDecisionPlay) {
            // Wave-1 rows MUST have worker-published canonical decision_v2.
            if (!play.decision_v2) {
              incrementStageCounter(
                stageCounters,
                'wave1_skipped_no_d2',
                parsedSport,
                parsedMarket,
              );
              continue;
            }
            applyWave1DecisionFields(play);
            play.reason_codes = Array.from(
              new Set([
                ...(play.reason_codes ?? []),
                play.decision_v2.primary_reason_code,
              ]),
            );
          }
        }

        if (
          (!wave1Eligible ||
            isPropPlay ||
            isMlbFullGameLegacyDecisionPlay ||
            isProjectionSurfaceLegacyDecisionPlay) &&
          !play.consistency?.total_bias
        ) {
          const nativeTotalBiasOk = isNativeTotalBiasActionable(play);
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
              nativeTotalBiasOk ||
              (decisionStatus &&
                decisionStatus !== 'PASS' &&
                decisionLine &&
                decisionEdge)
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
        }

        if (!wave1Eligible && !hasMinimumViability(play, play.market_type)) {
          play.market_type = 'INFO';
          play.kind = 'EVIDENCE';
          play.reason_codes = Array.from(
            new Set([...(play.reason_codes ?? []), 'PASS_MISSING_MARKET_TYPE']),
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
      budget.assertWithin('cards_parse');

      // WI-0584: Secondary dedup — keep only the most-recent card per
      // (gameId, playerId, prop family, side). Use canonical_market_key/cardType
      // instead of generic PROP so different prop families do not collapse.
      // The SQL query returns rows newest-first (ORDER BY created_at DESC, id DESC), so the first
      // occurrence of a tuple is always the newest card.
      {
        const seenPropTupleKeys = new Set<string>();
        for (const [gid, gamePlays] of playsMap) {
          const dedupedPropPlays = gamePlays.filter((p) => {
            const isProp = p.market_type === 'PROP';
            if (!isProp) return true;
            const pid = p.player_id ?? p.player_name ?? 'unknown';
            const pType =
              p.canonical_market_key ??
              p.cardType ??
              p.market_type ??
              'prop';
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

      for (const [gid, gamePlays] of playsMap) {
        playsMap.set(gid, dedupeProjectionSurfacePlays(gamePlays));
      }

      for (const [canonicalGameId, plays] of playsMap.entries()) {
        const authoritativePlay = selectAuthoritativeTruePlay(plays);
        if (authoritativePlay) {
          truePlayMap.set(canonicalGameId, authoritativePlay);
        }
      }
    }

    stageTracker.enter('service');

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

    // Service layer keeps rows where hasOdds || hasPlays || hasIngestFailure,
    // then deduplicates byMatchup using odds_captured_at recency.
    const {
      responseRows,
      deduplicatedRows,
      pregameRowsDroppedNoOddsNoPlays,
    } = prepareGamesServiceRows({
      rows,
      lifecycleMode,
      playsMap,
    });

    stageTracker.enter('transform');
    currentStage = 'response_build';
    const data = buildGamesResponseData(deduplicatedRows, lifecycleMode, {
      gameConsistencyMap,
      truePlayMap,
      playsMap,
    });
    budget.assertWithin('response_build');

    emitTotalProjectionDriftWarnings(data);

    // NOTE: card_display_log writes intentionally removed.
    // Worker owns all DB writes (single-writer architecture).

    // Join diagnostics for game ID mapping (dev mode only)
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
      buildPlayableMarketFamilyDiagnostics(stageCounters, ACTIVE_SPORT_CARD_TYPE_CONTRACT);
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
    // Build drop_summary for dev-mode diagnostics: group by drop_reason_code, count, record layer
    const buildDropSummary = (
      dropReasons: DropReasonMeta[],
    ): Array<{ drop_reason_code: string; drop_reason_layer: string; count: number }> => {
      const countMap = new Map<string, { drop_reason_layer: string; count: number }>();
      for (const dr of dropReasons) {
        const existing = countMap.get(dr.drop_reason_code);
        if (existing) {
          existing.count += 1;
        } else {
          countMap.set(dr.drop_reason_code, { drop_reason_layer: dr.drop_reason_layer, count: 1 });
        }
      }
      return Array.from(countMap.entries())
        .map(([drop_reason_code, { drop_reason_layer, count }]) => ({
          drop_reason_code,
          drop_reason_layer,
          count,
        }))
        .sort((a, b) => b.count - a.count);
    };

    // Empty-state diagnostics: always returned when active lifecycle has 0 results.
    // Explains WHY the list is empty so the UI can display meaningful messaging
    // and CardsPageContext never silently falls back to pregame.
    const emptyStateDiagnostics = lifecycleMode === 'active' && data.length === 0
      ? (() => {
          const startedGamesCount = rows.length;
          let actionableRowsCount = 0;
          let passedRowsCount = 0;
          for (const plays of playsMap.values()) {
            for (const play of plays) {
              if (play.status === 'PASS') {
                passedRowsCount++;
              } else {
                actionableRowsCount++;
              }
            }
          }
          const totalRowsInWindow = rows.length;
          const settlementDrops = parsedDropReasons.filter(
            (dr) => dr.drop_reason_code?.startsWith('PASS_EXECUTION_GATE') ||
                    dr.drop_reason_code?.startsWith('SETTLEMENT'),
          ).length;
          let reason: 'NO_ACTIVE_GAMES' | 'NO_ACTIONABLE_ROWS' | 'ALL_ROWS_PASSED' | 'SETTLEMENT_GATE' | 'UNKNOWN';
          if (startedGamesCount === 0) {
            reason = 'NO_ACTIVE_GAMES';
          } else if (settlementDrops > 0 && actionableRowsCount === 0) {
            reason = 'SETTLEMENT_GATE';
          } else if (passedRowsCount > 0 && actionableRowsCount === 0) {
            reason = 'ALL_ROWS_PASSED';
          } else if (actionableRowsCount === 0) {
            reason = 'NO_ACTIONABLE_ROWS';
          } else {
            reason = 'UNKNOWN';
          }
          return {
            reason,
            started_games_count: startedGamesCount,
            actionable_rows_count: actionableRowsCount,
            passed_rows_count: passedRowsCount,
            total_rows_in_window: totalRowsInWindow,
          };
        })()
      : undefined;

    const flowDiagnostics = isDev
      ? {
          stage_counters: stageCounters,
          query_window: {
            start_utc: gamesStartUtc,
            end_utc: gamesEndUtc,
            now_utc: nowUtc,
            horizon_contract: 'v1-et-boundary-aware',
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
          drop_summary: buildDropSummary(parsedDropReasons),
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
    if (perf.totalMs > API_GAMES_SLOW_WARN_MS) {
      console.warn('[API] /api/games slow request', {
        total_ms: perf.totalMs,
        db_ready_ms: perf.dbReadyMs,
        load_games_ms: perf.loadGamesMs,
        cards_query_ms: perf.cardsQueryMs,
        cards_parse_ms: perf.cardsParseMs,
        card_rows: perf.cardRows,
        active_run_ids: activeRunIds.length,
        response_mode: 'full',
      });
    }

    stageTracker.finish();
    const combinedDiagnostics: Record<string, unknown> | undefined =
      emptyStateDiagnostics || flowDiagnostics
        ? { ...flowDiagnostics, ...(emptyStateDiagnostics ? { empty_state: emptyStateDiagnostics } : {}) }
        : undefined;
    const payload = buildGamesSuccessPayload({
      data,
      currentRunId,
      runStatus,
      perf,
      responseMode: 'full',
      isDev,
      diagnostics: combinedDiagnostics,
      joinDebug,
    });
    if (cacheKey) {
      lastGoodGamesPayloadCache.set(cacheKey, {
        payload,
        cachedAt: Date.now(),
      });
    }
    const response = NextResponse.json(payload, {
      headers: { 'Content-Type': 'application/json' },
    });
    response.headers.set('X-Games-Mode', String(payload?.meta?.response_mode ?? 'full'));
    response.headers.set('X-Games-Count', String(Array.isArray(payload?.data) ? payload.data.length : 0));
    return addRateLimitHeaders(response, request);
  } catch (error) {
    stageTracker.finish();
    perf.totalMs = Date.now() - requestStartedAt;
    if (
      !isNonRecoverableGamesDbError(error) &&
      isRecoverableGamesTimeoutError(error)
    ) {
      const timeoutStage = deriveTimeoutStage(error, currentStage);
      stageTracker.enter('transform');
      const fallbackPayload = buildGamesTimeoutFallbackPayload({
        rows,
        lifecycleMode,
        currentRunId,
        runStatus,
        perf,
        timeoutStage,
        cacheEntry: cacheKey ? lastGoodGamesPayloadCache.get(cacheKey) : null,
        isDev,
      });
      stageTracker.finish();
      if (fallbackPayload) {
        fallbackPayload.meta.stage_metrics = normalizeGamesStageMetrics(
          perf.stageMetrics,
        );
        if (fallbackPayload.meta.perf_ms) {
          fallbackPayload.meta.perf_ms.stage_metrics =
            fallbackPayload.meta.stage_metrics;
        }
        console.warn('[API] /api/games timeout fallback', {
          response_mode: fallbackPayload.meta.response_mode,
          timeout_stage: timeoutStage,
          elapsed_ms: perf.totalMs,
          cache_age_ms: fallbackPayload.meta.cache_age_ms ?? null,
          row_count: fallbackPayload.data.length,
          error: error instanceof Error ? error.message : String(error),
        });
        const response = NextResponse.json(fallbackPayload, {
          headers: { 'Content-Type': 'application/json' },
        });
        response.headers.set('X-Games-Mode', String(fallbackPayload?.meta?.response_mode ?? 'timeout_fallback'));
        response.headers.set('X-Games-Count', String(Array.isArray(fallbackPayload?.data) ? fallbackPayload.data.length : 0));
        return addRateLimitHeaders(response, request);
      }
    }

    console.error('[API] Error fetching games:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const response = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    response.headers.set('X-Games-Mode', 'error');
    response.headers.set('X-Games-Count', '0');
    return addRateLimitHeaders(response, request);
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
