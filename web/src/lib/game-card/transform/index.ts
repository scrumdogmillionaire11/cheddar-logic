/**
 * Transform and deduplicate GameData into normalized GameCard with canonical Play
 * Based on FILTER-FEATURE.md design
 */

import type {
  GameCard,
  DriverRow,
  EvidenceItem,
  Sport,
  Market,
  CanonicalMarketType,
  DriverTier,
  Direction,
  Play,
  TruthStatus,
  ValueStatus,
  PriceFlag,
  SelectionSide,
  PropGameCard,
  PropPlayRow,
  DecisionLabel,
  DecisionClassification,
  CanonicalGate,
  CanonicalBet,
  BetSide,
  DecisionData,
  CardQuality,
  DecisionV2,
  ExpressionStatus,
  PitcherKFairPrices,
  PitcherKProbabilityLadder,
  PlayabilityBand,
  ProjectionSource,
  StatusCap,
} from '../../types';
import type {
  CanonicalPlay,
  MarketType,
  SelectionKey,
} from '../../types';
import type { Sport as CanonicalSport } from '../../types/canonical-play';
import { deduplicateDrivers, resolvePlayDisplayDecision } from '../decision';
import { DRIVER_ROLES } from '../driver-scoring';
import {
  derivePlayDecision,
  EDGE_SANITY_NON_TOTAL_THRESHOLD,
  EDGE_SANITY_GATE_CODE,
  PROXY_CAP_GATE_CODE,
  EDGE_VERIFICATION_TAG,
  hasEdgeVerificationSignals,
} from '../../play-decision/decision-logic';
import {
  getSportCardTypeContract,
  getSourcePlayAction,
  isEvidenceItem,
  isPlayItem,
  isWelcomeHomePlay,
  normalizeCardType,
  resolveSourceModelProb,
} from './adapters/v1-legacy-repair';
import { isWelcomeHomeCardType } from '../welcome-home';
import {
  NO_ACTIONABLE_IGNORE_REASON_CODES,
  isExplicitNoEdgeReasonCode,
  isFetchFailureReasonCode,
  normalizePassReasonCode,
} from './reason-codes';
import {
  type CanonicalSide,
  buildMarketKey,
  buildMarkets,
  mapCanonicalToLegacyMarket,
  inferMarketFromPlay,
  mapCanonicalToBetMarketType,
  normalizeSideForCanonicalMarket,
  normalizeSideToken,
} from './market-normalize';
import {
  buildWave1PickText,
  directionToLean,
  getPlayWhyCode,
  getRiskTagsFromText,
  hasPlaceholderText,
  toDiagnosticToken,
} from './title-inference';
import { buildFinalMarketDecision } from './decision-surface';

const ENABLE_WELCOME_HOME =
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

const TIER_SCORE: Record<DriverTier, number> = {
  BEST: 1,
  SUPER: 0.72,
  GOOD: 0.6,
  WATCH: 0.52,
  OK: 0.3,
  BAD: 0.1,
};

const OPPOSITE_DIRECTION: Partial<Record<Direction, Direction>> = {
  HOME: 'AWAY',
  AWAY: 'HOME',
  OVER: 'UNDER',
  UNDER: 'OVER',
};

const PROXY_SIGNAL_TAGS = new Set<string>([
  'PROXY_MODEL_PROB_INFERRED',
]);
const WAVE1_SPORTS = new Set(['NBA', 'NHL']);
const WAVE1_MARKETS = new Set<CanonicalMarketType>([
  'MONEYLINE',
  'SPREAD',
  'TOTAL',
  'PUCKLINE',
  'TEAM_TOTAL',
  'FIRST_PERIOD',
]);
const PROJECTION_ONLY_LINE_SOURCES = new Set<string>([
  'PROJECTION_FLOOR',
  'SYNTHETIC_FALLBACK',
]);

type ApiPropDisplayState = 'PLAY' | 'WATCH' | 'PROJECTION_ONLY';

interface ApiPropDecision {
  verdict?: string;
  lean_side?: string | null;
  line?: number | null;
  display_price?: number | null;
  projection?: number | null;
  k_mean?: number | null;
  probability_ladder?: PitcherKProbabilityLadder | null;
  fair_prices?: PitcherKFairPrices | null;
  playability?: PlayabilityBand | null;
  projection_source?: ProjectionSource | null;
  status_cap?: StatusCap | null;
  missing_inputs?: string[];
  pass_reason_code?: string | null;
  pass_reason?: string | null;
  line_delta?: number | null;
  fair_prob?: number | null;
  implied_prob?: number | null;
  prob_edge_pp?: number | null;
  ev?: number | null;
  l5_trend?: string | null;
  why?: string;
  flags?: string[];
}

// API types from cards page
export interface ApiPlay {
  source_card_id?: string;
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
  projectedTotal?: number | null;
  edge?: number | null;
  edge_points?: number | null;
  odds_context?: Record<string, unknown> | null;
  p_fair?: number | null;
  p_implied?: number | null;
  edge_pct?: number | null;
  edge_delta_pct?: number | null;
  model_prob?: number | null;
  proxy_used?: boolean;
  line_source?: string | null;
  price_source?: string | null;
  projection?: {
    k_mean?: number | null;
    margin_home?: number | null;
    total?: number | null;
    team_total?: number | null;
    goal_diff?: number | null;
    score_home?: number | null;
    score_away?: number | null;
    projected_margin?: number | null;
    projected_total?: number | null;
    projected_total_low?: number | null;
    projected_total_high?: number | null;
    projected_home_f5_runs?: number | null;
    projected_away_f5_runs?: number | null;
    projected_team_total?: number | null;
    projected_goal_diff?: number | null;
    projected_score_home?: number | null;
    projected_score_away?: number | null;
    win_prob_home?: number | null;
    probability_ladder?: PitcherKProbabilityLadder | null;
    fair_prices?: PitcherKFairPrices | null;
  };
  projection_source?: ProjectionSource | null;
  status_cap?: StatusCap | null;
  playability?: PlayabilityBand | null;
  status?: 'FIRE' | 'WATCH' | 'PASS';
  classification?: 'BASE' | 'LEAN' | 'PASS';
  action?: 'FIRE' | 'HOLD' | 'PASS';
  pass_reason_code?: string | null;
  pass_reason?: string | null;
  basis?: 'PROJECTION_ONLY' | 'ODDS_BACKED';
  execution_status?: 'EXECUTABLE' | 'PROJECTION_ONLY' | 'BLOCKED';
  execution_gate?: {
    should_bet?: boolean;
    drop_reason?: {
      drop_reason_code: string;
      drop_reason_layer: string;
      recovery_bucket?: RecoveryBucket;
    } | null;
    blocked_by?: string[];
  } | null;
  prop_decision?: ApiPropDecision | null;
  prop_display_state?: ApiPropDisplayState;
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
  market_type?: CanonicalMarketType;
  selection?: { side?: string; team?: string };
  line?: number;
  price?: number;
  reason_codes?: string[];
  projection_inputs_complete?: boolean | null;
  missing_inputs?: string[];
  source_mapping_ok?: boolean | null;
  source_mapping_failures?: string[];
  tags?: string[];
  recommendation?: { type?: string };
  recommended_bet_type?: string;
  canonical_market_key?: string;
  market_price_over?: number | null;
  market_price_under?: number | null;
  market_bookmaker?: string | null;
  kind?: 'PLAY' | 'EVIDENCE';
  evidence_for_play_id?: string;
  aggregation_key?: string;
  goalie_home_name?: string | null;
  goalie_away_name?: string | null;
  nhl_totals_status?: {
    status?: 'PLAY' | 'SLIGHT EDGE' | 'PASS';
    delta?: number;
    absDelta?: number;
    reasonCodes?: string[];
  } | null;
  goalie_home_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  goalie_away_status?: 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN' | null;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
  decision_v2?: DecisionV2;
}

interface GameData {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  createdAt: string;
  odds: {
    h2hHome: number | null;
    h2hAway: number | null;
    total: number | null;
    spreadHome: number | null;
    spreadAway: number | null;
    spreadPriceHome: number | null;
    spreadPriceAway: number | null;
    totalPriceOver: number | null;
    totalPriceUnder: number | null;
    capturedAt: string | null;
    // Consensus / splits fields (optional — present after migrations)
    spreadConsensusConfidence?: string | null;
    publicBetsPctHome?: number | null;
    publicBetsPctAway?: number | null;
    publicHandlePctHome?: number | null;
    publicHandlePctAway?: number | null;
    splitsSource?: string | null;
  } | null;
  projection_inputs_complete?: boolean | null;
  projection_missing_inputs?: string[];
  source_mapping_ok?: boolean | null;
  source_mapping_failures?: string[];
  ingest_failure_reason_code?: string | null;
  ingest_failure_reason_detail?: string | null;
  consistency?: {
    total_bias?:
      | 'OK'
      | 'INSUFFICIENT_DATA'
      | 'CONFLICTING_SIGNALS'
      | 'VOLATILE_ENV'
      | 'UNKNOWN';
  };
  true_play?: ApiPlay | null;
  plays: ApiPlay[];
}

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

function resolveDecisionV2EdgePct(
  decisionV2: Pick<DecisionV2, 'edge_pct' | 'edge_delta_pct'> | null | undefined,
): number | null {
  if (typeof decisionV2?.edge_delta_pct === 'number') return decisionV2.edge_delta_pct;
  if (typeof decisionV2?.edge_pct === 'number') return decisionV2.edge_pct;
  return null;
}

function normalizeReasonCode(value: unknown): string | null {
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

function stringifyMissingInputValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Record<string, unknown>;
  for (const key of ['reason', 'code', 'label', 'message', 'field', 'key']) {
    if (typeof entry[key] === 'string' && entry[key].trim().length > 0) {
      return entry[key].trim();
    }
  }

  try {
    const json = JSON.stringify(value);
    return json && json !== '{}' ? json : null;
  } catch {
    return null;
  }
}

function normalizeMissingInputs(values: unknown): string[] {
  if (!Array.isArray(values)) return [];

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const display = stringifyMissingInputValue(value);
    if (!display || seen.has(display)) continue;
    seen.add(display);
    normalized.push(display);
  }

  return normalized;
}

function normalizeDropReasonMeta(
  value: ApiPlay['execution_gate'] extends { drop_reason?: infer T } ? T : unknown,
): DropReasonMeta | null {
  if (!value || typeof value !== 'object') return null;

  const code = normalizeReasonCode(
    (value as { drop_reason_code?: unknown }).drop_reason_code,
  );
  const layer =
    typeof (value as { drop_reason_layer?: unknown }).drop_reason_layer === 'string'
      ? String((value as { drop_reason_layer?: unknown }).drop_reason_layer).trim()
      : '';

  if (!code || layer.length === 0) return null;

  const normalizedBucket =
    typeof (value as { recovery_bucket?: unknown }).recovery_bucket === 'string' &&
    String((value as { recovery_bucket?: unknown }).recovery_bucket).trim().length > 0
      ? (String((value as { recovery_bucket?: unknown }).recovery_bucket)
          .trim()
          .toLowerCase() as RecoveryBucket)
      : undefined;

  return buildDropReasonMeta(code, layer, normalizedBucket);
}

function getCanonicalEnvelopeFromPlay(
  play: ApiPlay | null | undefined
): Record<string, unknown> | null {
  if (!play || !play.decision_v2) return null;
  const envelope = play.decision_v2.canonical_envelope_v2;
  return envelope && typeof envelope === 'object'
    ? (envelope as Record<string, unknown>)
    : null;
}

function getCanonicalEnvelopeSelection(
  play: ApiPlay | null | undefined
): { side: string | null; team: string | null } {
  const canonicalEnvelope = getCanonicalEnvelopeFromPlay(play);
  const side =
    canonicalEnvelope &&
    (typeof canonicalEnvelope.selection_side === 'string' ||
      typeof canonicalEnvelope.direction === 'string')
      ? String(canonicalEnvelope.selection_side ?? canonicalEnvelope.direction)
      : null;
  const team =
    canonicalEnvelope && typeof canonicalEnvelope.selection_team === 'string'
      ? canonicalEnvelope.selection_team
      : null;
  return { side, team };
}

function resolveCanonicalOfficialStatus(
  play: ApiPlay | null | undefined
): string | null {
  if (!play) return null;
  const canonicalEnvelope = getCanonicalEnvelopeFromPlay(play);
  // Canonical envelope is authoritative; fail closed when absent.
  if (
    canonicalEnvelope?.official_status &&
    typeof canonicalEnvelope.official_status === 'string'
  ) {
    return canonicalEnvelope.official_status;
  }
  return null;
}

function resolvePlayDropReason(play: ApiPlay | null | undefined): DropReasonMeta | null {
  if (!play) return null;

  const canonicalEnvelope = getCanonicalEnvelopeFromPlay(play);
  const explicitDropReason = normalizeDropReasonMeta(play.execution_gate?.drop_reason);
  if (explicitDropReason) return explicitDropReason;

  // Prefer canonical envelope primary reason if available
  const envelopePrimary =
    canonicalEnvelope &&
    typeof canonicalEnvelope.primary_reason_code === 'string'
      ? normalizeReasonCode(canonicalEnvelope.primary_reason_code)
      : null;
  if (
    envelopePrimary &&
    (canonicalEnvelope?.official_status === 'PASS' ||
      canonicalEnvelope?.official_status === 'LEAN')
  ) {
    return buildDropReasonMeta(envelopePrimary, 'decision_canonical_envelope');
  }

  const watchdogReasonCode =
    Array.isArray(play.decision_v2?.watchdog_reason_codes) &&
    play.decision_v2.watchdog_reason_codes.length > 0
      ? normalizeReasonCode(play.decision_v2.watchdog_reason_codes[0])
      : null;
  if (play.decision_v2?.watchdog_status === 'BLOCKED' && watchdogReasonCode) {
    return buildDropReasonMeta(watchdogReasonCode, 'decision_watchdog');
  }

  const priceReasonCode =
    Array.isArray(play.decision_v2?.price_reason_codes) &&
    play.decision_v2.price_reason_codes.length > 0
      ? play.decision_v2.price_reason_codes
          .map((value) => normalizeReasonCode(value))
          .find((value) => value != null && value !== 'EDGE_CLEAR') ?? null
      : null;
  if (
    (play.decision_v2?.official_status === 'PASS' ||
      play.decision_v2?.official_status === 'LEAN') &&
    priceReasonCode
  ) {
    return buildDropReasonMeta(priceReasonCode, 'decision_price');
  }

  const passReasonCode = normalizePassReasonCode(play.pass_reason_code ?? null);
  if (passReasonCode) {
    return buildDropReasonMeta(passReasonCode, 'publish_pass_reason');
  }

  const primaryReasonCode = normalizeReasonCode(play.decision_v2?.primary_reason_code);
  if (
    (play.decision_v2?.official_status === 'PASS' ||
      play.decision_v2?.official_status === 'LEAN') &&
    primaryReasonCode
  ) {
    return buildDropReasonMeta(primaryReasonCode, 'decision_primary');
  }

  return null;
}

function collectNoActionablePlayInputs(game: GameData): string[] {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const push = (token: string | null) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    diagnostics.push(token);
  };

  const evidenceOnlyPlays = game.plays.filter((play) => isEvidenceItem(play, game.sport));
  const contract = getSportCardTypeContract(game.sport);
  const hasPlayProducerSignals = contract
    ? game.plays.some((play) =>
        contract.playProducerCardTypes.has(normalizeCardType(play.cardType || '')),
      )
    : game.plays.some((play) => (play.kind ?? 'PLAY') === 'PLAY');

  if (evidenceOnlyPlays.length === 0) {
    return ['play_candidates:evidence_only'];
  }

  if (game.ingest_failure_reason_code === 'TEAM_MAPPING_UNMAPPED') {
    push('fetch_failure:team_mapping_unmapped');
  }
  if (game.source_mapping_ok === false) {
    push('fetch_failure:source_mapping_failed');
  }
  if (game.projection_inputs_complete === false) {
    push('fetch_failure:projection_inputs_incomplete');
  }

  let hasExplicitNoEdgeSignals = false;
  // WI-0511: collect unrecognized codes so we can emit specific tokens instead of generic fallback
  const unknownSignalCodes: string[] = [];
  for (const play of evidenceOnlyPlays) {
    if (typeof play.pass_reason_code === 'string') {
      const code = play.pass_reason_code.toUpperCase();
      if (!NO_ACTIONABLE_IGNORE_REASON_CODES.has(code)) {
        if (isExplicitNoEdgeReasonCode(code)) {
          hasExplicitNoEdgeSignals = true;
        } else if (isFetchFailureReasonCode(code)) {
          push(toDiagnosticToken('fetch_reason', code));
        } else {
          unknownSignalCodes.push(code);
        }
      }
    }
    for (const reasonCode of play.reason_codes ?? []) {
      const code = String(reasonCode).toUpperCase();
      if (NO_ACTIONABLE_IGNORE_REASON_CODES.has(code)) continue;
      if (isExplicitNoEdgeReasonCode(code)) {
        hasExplicitNoEdgeSignals = true;
      } else if (isFetchFailureReasonCode(code)) {
        push(toDiagnosticToken('fetch_reason', code));
      } else {
        unknownSignalCodes.push(code);
      }
    }
    for (const missingInput of normalizeMissingInputs(play.missing_inputs)) {
      push(toDiagnosticToken('fetch_missing', missingInput));
    }
    for (const mappingFailure of play.source_mapping_failures ?? []) {
      push(toDiagnosticToken('fetch_mapping_failure', mappingFailure));
    }
  }

  if (diagnostics.length > 0) {
    return diagnostics.slice(0, 8);
  }

  if (unknownSignalCodes.length > 0) {
    // WI-0511: emit specific unclassified_reason tokens instead of generic unclassified fallback
    for (const code of unknownSignalCodes) {
      push(toDiagnosticToken('unclassified_reason', code));
    }
    return diagnostics.length > 0
      ? diagnostics.slice(0, 8)
      : ['fetch_failure:unclassified_signals'];
  }

  if (hasExplicitNoEdgeSignals) {
    return [];
  }

  if (!hasPlayProducerSignals) {
    return ['fetch_failure:no_play_producer_signals'];
  }

  // WI-0511: play producer signals exist but produced no actionable output
  return ['fetch_failure:play_producer_no_output'];
}

type DedupeCandidate = {
  play: ApiPlay;
  inference: ReturnType<typeof inferMarketFromPlay>;
};

function hasPlayableBet(
  play: ApiPlay,
  canonical: CanonicalMarketType | undefined,
  side: CanonicalSide,
): boolean {
  if (canonical === 'MONEYLINE') {
    return (side === 'HOME' || side === 'AWAY') && typeof play.price === 'number';
  }
  if (canonical === 'SPREAD' || canonical === 'PUCKLINE') {
    return (
      (side === 'HOME' || side === 'AWAY') &&
      typeof play.line === 'number' &&
      typeof play.price === 'number'
    );
  }
  if (
    canonical === 'TOTAL' ||
    canonical === 'TEAM_TOTAL' ||
    canonical === 'FIRST_PERIOD'
  ) {
    return (
      (side === 'OVER' || side === 'UNDER') &&
      typeof play.line === 'number'
    );
  }
  if (canonical === 'PROP') {
    return typeof play.line === 'number' || typeof play.price === 'number';
  }
  return false;
}

function isProjectionOnlyCardPlay(play: ApiPlay): boolean {
  const lineSource = play.line_source?.trim().toUpperCase() ?? null;
  const projectionSource =
    play.prop_decision?.projection_source ??
    play.projection_source ??
    null;

  return (
    play.basis === 'PROJECTION_ONLY' ||
    play.execution_status === 'PROJECTION_ONLY' ||
    play.prop_display_state === 'PROJECTION_ONLY' ||
    (lineSource != null && PROJECTION_ONLY_LINE_SOURCES.has(lineSource)) ||
    projectionSource === 'SYNTHETIC_FALLBACK'
  );
}

function shouldSuppressNoActionableNonTotalPass(play: ApiPlay): boolean {
  if (play.market_type === 'TOTAL' || play.market_type === 'TEAM_TOTAL') {
    return false;
  }

  const displayAction = resolvePlayDisplayDecision(play).action;
  if (displayAction !== 'PASS') return false;

  const reasonCodes = Array.isArray(play.reason_codes)
    ? play.reason_codes
    : [];
  const hasWeakSupportPass = reasonCodes.includes('PASS_DRIVER_SUPPORT_WEAK');
  const hasEdgeSanityNonTotal =
    reasonCodes.includes('PASS_EDGE_SANITY_NON_TOTAL') ||
    reasonCodes.includes('DOWNGRADED_EDGE_SANITY_NON_TOTAL');

  return hasWeakSupportPass && hasEdgeSanityNonTotal;
}

function isRenderableGameSurfacePlay(game: GameData, play: ApiPlay): boolean {
  return (
    !isProjectionOnlyCardPlay(play) &&
    !shouldSuppressNoActionableNonTotalPass(play) &&
    isPlayItem(play, game.sport) &&
    play.market_type !== 'PROP'
  );
}

function isProjectionOnlyGameSurfacePlay(
  game: GameData,
  play: ApiPlay,
): boolean {
  return (
    isProjectionOnlyCardPlay(play) &&
    isPlayItem(play, game.sport) &&
    play.market_type !== 'PROP'
  );
}

function shouldExcludeProjectionOnlyGameSurface(game: GameData): boolean {
  const hasRenderablePlay = game.plays.some((play) =>
    isRenderableGameSurfacePlay(game, play),
  );
  if (hasRenderablePlay) return false;

  const hasSuppressedNonTotalPass = game.plays.some((play) =>
    shouldSuppressNoActionableNonTotalPass(play) &&
    isPlayItem(play, game.sport) &&
    play.market_type !== 'PROP',
  );
  if (hasSuppressedNonTotalPass) return true;

  return game.plays.some((play) =>
    isProjectionOnlyGameSurfacePlay(game, play),
  );
}

function playDecisionRank(play: ApiPlay): number {
  const action = getSourcePlayAction(play);
  if (action === 'FIRE') return 3;
  if (action === 'HOLD') return 2;
  if (action === 'PASS') return 1;
  return 0;
}

function playValueRank(play: ApiPlay): number {
  const edge = typeof play.edge === 'number' ? play.edge : null;
  if (edge !== null && edge >= 0.04) return 3;
  if (edge !== null && edge >= 0.015) return 2;
  if (edge !== null && edge > 0) return 1;
  return 0;
}

function playSourcePriority(
  play: ApiPlay,
  inference: ReturnType<typeof inferMarketFromPlay>,
): number {
  if (
    inference.canonical === 'TOTAL' ||
    inference.canonical === 'TEAM_TOTAL'
  ) {
    if (play.cardType === 'nhl-totals-call') return 2;
    if (play.cardType === 'nhl-pace-totals') return 1;
  }
  return 0;
}

function timestampMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function comparePlayCandidates(a: DedupeCandidate, b: DedupeCandidate): number {
  const aHasBet = hasPlayableBet(
    a.play,
    a.inference.canonical,
    normalizeSideToken(a.play.selection?.side ?? a.play.prediction),
  );
  const bHasBet = hasPlayableBet(
    b.play,
    b.inference.canonical,
    normalizeSideToken(b.play.selection?.side ?? b.play.prediction),
  );
  if (aHasBet !== bHasBet) return aHasBet ? 1 : -1;

  const actionDelta = playDecisionRank(a.play) - playDecisionRank(b.play);
  if (actionDelta !== 0) return actionDelta;

  const valueDelta = playValueRank(a.play) - playValueRank(b.play);
  if (valueDelta !== 0) return valueDelta;

  const sourcePriorityDelta =
    playSourcePriority(a.play, a.inference) -
    playSourcePriority(b.play, b.inference);
  if (sourcePriorityDelta !== 0) return sourcePriorityDelta;

  const aModelProb =
    resolveSourceModelProb(a.play) ?? a.play.decision_v2?.fair_prob ?? undefined;
  const bModelProb =
    resolveSourceModelProb(b.play) ?? b.play.decision_v2?.fair_prob ?? undefined;
  if (aModelProb !== undefined || bModelProb !== undefined) {
    if (aModelProb === undefined) return -1;
    if (bModelProb === undefined) return 1;
  }

  const createdDelta =
    timestampMs(a.play.created_at) - timestampMs(b.play.created_at);
  if (createdDelta !== 0) return createdDelta;

  const edgeDelta =
    (typeof a.play.edge === 'number' ? a.play.edge : -Infinity) -
    (typeof b.play.edge === 'number' ? b.play.edge : -Infinity);
  if (edgeDelta !== 0) return edgeDelta;

  return 0;
}

function dedupePlayCandidates(game: GameData, plays: ApiPlay[]): ApiPlay[] {
  const byKey = new Map<string, DedupeCandidate>();

  for (const play of plays) {
    const inference = inferMarketFromPlay(play);
    const side = normalizeSideToken(play.selection?.side ?? play.prediction);
    const marketKey = buildMarketKey(inference.canonical, side);
    const dedupeKey = `${game.sport}|${game.gameId}|${marketKey}`;
    const current: DedupeCandidate = { play, inference };
    const existing = byKey.get(dedupeKey);
    if (!existing || comparePlayCandidates(current, existing) > 0) {
      byKey.set(dedupeKey, current);
    }
  }

  return Array.from(byKey.values()).map((entry) => entry.play);
}

function decisionFromAction(action: 'FIRE' | 'HOLD' | 'PASS'): DecisionLabel {
  if (action === 'FIRE') return 'FIRE';
  if (action === 'HOLD') return 'WATCH';
  return 'PASS';
}

function decisionClassificationFromAction(
  action: 'FIRE' | 'HOLD' | 'PASS',
): DecisionClassification {
  if (action === 'FIRE') return 'PLAY';
  if (action === 'HOLD') return 'LEAN';
  return 'NONE';
}

function actionFromDecision(decision: DecisionLabel): 'FIRE' | 'HOLD' | 'PASS' {
  if (decision === 'FIRE') return 'FIRE';
  if (decision === 'WATCH') return 'HOLD';
  return 'PASS';
}

function mapDirectionToBetSide(direction: Direction): BetSide | null {
  if (direction === 'HOME') return 'home';
  if (direction === 'AWAY') return 'away';
  if (direction === 'OVER') return 'over';
  if (direction === 'UNDER') return 'under';
  return null;
}

function validateCanonicalBet(bet: CanonicalBet): boolean {
  if (bet.market_type === 'moneyline') {
    return (
      (bet.side === 'home' || bet.side === 'away') && bet.line === undefined
    );
  }
  if (bet.market_type === 'spread') {
    return (
      (bet.side === 'home' || bet.side === 'away') &&
      typeof bet.line === 'number'
    );
  }
  if (bet.market_type === 'total') {
    return (
      (bet.side === 'over' || bet.side === 'under') &&
      typeof bet.line === 'number'
    );
  }
  if (bet.market_type === 'team_total') {
    return (
      (bet.side === 'over' || bet.side === 'under') &&
      typeof bet.line === 'number' &&
      (bet.team === 'home' || bet.team === 'away')
    );
  }
  if (bet.market_type === 'player_prop') {
    return (
      (bet.side === 'over' || bet.side === 'under') &&
      (typeof bet.line === 'number' || Number.isFinite(bet.odds_american))
    );
  }
  return false;
}

function isWave1EligibleDecisionPlay(play: ApiPlay, sport: string): boolean {
  if (!play.decision_v2) return false;
  if ((play.kind ?? 'PLAY') !== 'PLAY') return false;
  if (!WAVE1_SPORTS.has(normalizeSport(sport))) return false;
  if (!play.market_type) return false;
  return WAVE1_MARKETS.has(play.market_type);
}

function statusFromOfficial(
  official: DecisionV2['official_status'],
): ExpressionStatus {
  if (official === 'PLAY') return 'FIRE';
  if (official === 'LEAN') return 'WATCH';
  return 'PASS';
}

function actionFromOfficial(
  official: DecisionV2['official_status'],
): 'FIRE' | 'HOLD' | 'PASS' {
  if (official === 'PLAY') return 'FIRE';
  if (official === 'LEAN') return 'HOLD';
  return 'PASS';
}

function resolveMoneylineExecutionActionOverride(
  play: ApiPlay | null | undefined,
  fallbackAction: 'FIRE' | 'HOLD' | 'PASS',
): 'FIRE' | 'HOLD' | 'PASS' | null {
  if (!play || play.market_type !== 'MONEYLINE') return null;

  if (play.execution_status === 'BLOCKED') return 'PASS';
  if (play.execution_status === 'PROJECTION_ONLY') return 'PASS';
  if (play.execution_status !== 'EXECUTABLE') return null;

  const canonicalStatus = resolveCanonicalOfficialStatus(play);
  if (canonicalStatus === 'PLAY') return 'FIRE';
  if (canonicalStatus === 'LEAN') return 'HOLD';
  if (canonicalStatus === 'PASS') return 'PASS';

  if (fallbackAction === 'PASS') {
    return play.action === 'FIRE' || play.action === 'HOLD' ? play.action : 'HOLD';
  }

  return fallbackAction;
}

function selectWave1DecisionCandidate(
  plays: ApiPlay[],
  sport: string,
): ApiPlay | null {
  const candidates = plays.filter((play) =>
    isWave1EligibleDecisionPlay(play, sport),
  );
  if (candidates.length === 0) return null;

  const officialRank = (
    official: DecisionV2['official_status'],
  ): number => {
    if (official === 'PLAY') return 3;
    if (official === 'LEAN') return 2;
    return 1;
  };

  const marketPriority = (play: ApiPlay): number => {
    if (sport.toUpperCase() !== 'MLB') return 99;
    const cardType = play.cardType?.toLowerCase() || '';
    if (cardType === 'mlb-full-game-ml') return 0;
    if (cardType === 'mlb-full-game') return 1;
    return 99;
  };

  const sorted = [...candidates].sort((a, b) => {
    const aDecision = a.decision_v2!;
    const bDecision = b.decision_v2!;
    const statusDiff =
      officialRank(bDecision.official_status) -
      officialRank(aDecision.official_status);
    if (statusDiff !== 0) return statusDiff;

    const marketPriorityDiff = marketPriority(a) - marketPriority(b);
    if (marketPriorityDiff !== 0) return marketPriorityDiff;

    const aEdge = resolveDecisionV2EdgePct(aDecision) ?? -1;
    const bEdge = resolveDecisionV2EdgePct(bDecision) ?? -1;
    if (bEdge !== aEdge) return bEdge - aEdge;

    return bDecision.support_score - aDecision.support_score;
  });

  return sorted[0];
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function edgeTierFromPct(edgePct: number): 'BEST' | 'GOOD' | 'OK' | 'BAD' {
  if (edgePct >= 0.08) return 'BEST';
  if (edgePct >= 0.04) return 'GOOD';
  if (edgePct >= 0.015) return 'OK';
  return 'BAD';
}

/**
 * Normalize sport string to Sport type
 */
function normalizeSport(sport: unknown): Sport {
  if (typeof sport !== 'string') return 'UNKNOWN';
  const sportUpper = sport.toUpperCase();
  if (
    sportUpper === 'NHL' ||
    sportUpper === 'NBA' ||
    sportUpper === 'MLB' ||
    sportUpper === 'NFL'
  ) {
    return sportUpper as Sport;
  }
  return 'UNKNOWN';
}

/**
 * Convert API Play to normalized DriverRow
 */
function playToDriver(play: ApiPlay): DriverRow {
  const direction: Direction =
    play.prediction === 'NEUTRAL' ? 'NEUTRAL' : play.prediction;
  const tier: DriverTier = play.tier || 'WATCH';
  const inference = inferMarketFromPlay(play);
  const market = inference.market;

  return {
    key: play.driverKey || `${play.cardType}_${market.toLowerCase()}`,
    market,
    tier,
    direction,
    confidence: play.confidence,
    note: play.reasoning,
    cardType: play.cardType,
    cardTitle: play.cardTitle,
    role: DRIVER_ROLES[play.cardType] ?? 'CONTEXT',
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sortDriversByStrength(drivers: DriverRow[]): DriverRow[] {
  const mlbMarketPriority = (driver: DriverRow): number => {
    const cardType = driver.cardType?.toLowerCase() || '';
    if (cardType === 'mlb-full-game-ml') return 0;
    if (cardType === 'mlb-full-game') return 1;
    return 99;
  };

  return [...drivers].sort((a, b) => {
    const tierDiff = TIER_SCORE[b.tier] - TIER_SCORE[a.tier];
    if (tierDiff !== 0) return tierDiff;

    const marketPriorityDiff = mlbMarketPriority(a) - mlbMarketPriority(b);
    if (marketPriorityDiff !== 0) return marketPriorityDiff;

    const aConf = typeof a.confidence === 'number' ? a.confidence : 0.6;
    const bConf = typeof b.confidence === 'number' ? b.confidence : 0.6;
    return bConf - aConf;
  });
}

function isRiskOnlyDriver(driver: DriverRow): boolean {
  const text = `${driver.key} ${driver.cardTitle} ${driver.note}`.toLowerCase();
  return (
    text.includes('blowout risk') ||
    (driver.market === 'RISK' && text.includes('blowout'))
  );
}

function directionScore(drivers: DriverRow[], direction: Direction): number {
  return drivers
    .filter((driver) => driver.direction === direction)
    .reduce((sum, driver) => {
      const confidence =
        typeof driver.confidence === 'number'
          ? clamp(driver.confidence, 0, 1)
          : 0.6;
      return sum + TIER_SCORE[driver.tier] * confidence;
    }, 0);
}

function truthStatusFromStrength(truthStrength: number): TruthStatus {
  if (truthStrength >= 0.67) return 'STRONG';
  if (truthStrength >= 0.58) return 'MEDIUM';
  return 'WEAK';
}

function americanToImpliedProbability(price?: number): number | undefined {
  if (price === undefined || Number.isNaN(price)) return undefined;
  if (price > 0) return 100 / (price + 100);
  return Math.abs(price) / (Math.abs(price) + 100);
}

function pickTruthDriver(drivers: DriverRow[]): DriverRow | null {
  const candidates = drivers.filter(
    (driver) => driver.direction !== 'NEUTRAL' && !isRiskOnlyDriver(driver),
  );
  if (candidates.length === 0) return null;
  return sortDriversByStrength(candidates)[0];
}

function selectExpressionMarket(
  direction: Direction,
  truthStatus: TruthStatus,
  driver: DriverRow,
  odds: GameData['odds'],
): Market | 'NONE' {
  if (direction === 'OVER' || direction === 'UNDER') {
    return odds?.total !== null && odds?.total !== undefined ? 'TOTAL' : 'NONE';
  }

  const mlPrice =
    direction === 'HOME'
      ? (odds?.h2hHome ?? undefined)
      : (odds?.h2hAway ?? undefined);
  const hasMLOdds = mlPrice !== undefined && mlPrice !== null;
  const hasSpreadOdds =
    (odds?.spreadHome !== null && odds?.spreadHome !== undefined) ||
    (odds?.spreadAway !== null && odds?.spreadAway !== undefined);

  const spreadHint =
    driver.note.toLowerCase().includes('spread') ||
    driver.cardTitle.toLowerCase().includes('spread') ||
    driver.key.toLowerCase().includes('spread');

  if (hasSpreadOdds && spreadHint && truthStatus !== 'WEAK') {
    return 'SPREAD';
  }

  if (
    hasMLOdds &&
    typeof mlPrice === 'number' &&
    mlPrice <= -240 &&
    hasSpreadOdds &&
    truthStatus === 'STRONG'
  ) {
    return 'SPREAD';
  }

  if (hasMLOdds) {
    return 'ML';
  }

  if (hasSpreadOdds) {
    return 'SPREAD';
  }

  return 'NONE';
}

function getPriceFlags(
  market: Market | 'NONE',
  direction: Direction | null,
  price?: number,
): PriceFlag[] {
  if (market !== 'ML') return [];
  if (direction !== 'HOME' && direction !== 'AWAY') return [];
  if (price === undefined) return ['VIG_HEAVY'];

  const flags = new Set<PriceFlag>();
  if (price <= -240) flags.add('PRICE_TOO_STEEP');
  return Array.from(flags);
}

function getValueStatus(edge?: number): ValueStatus {
  if (edge === undefined) return 'BAD';
  if (edge >= 0.04) return 'GOOD';
  if (edge >= 0.015) return 'OK';
  return 'BAD';
}

/**
 * Build canonical Play object at transform time
 */
function buildPlay(game: GameData, drivers: DriverRow[]): Play {
  const canonicalTruePlay =
    game.true_play &&
    !isProjectionOnlyCardPlay(game.true_play) &&
    !shouldSuppressNoActionableNonTotalPass(game.true_play) &&
    game.true_play.market_type !== 'PROP' &&
    isPlayItem(game.true_play, game.sport) &&
    (ENABLE_WELCOME_HOME || !isWelcomeHomePlay(game.true_play))
      ? game.true_play
      : null;
  // Game mode must not promote player props into canonical game-line play slots.
  // Props are rendered via transformPropGames in cards props mode only.
  const basePlayCandidates = game.plays.filter((play) =>
    isRenderableGameSurfacePlay(game, play),
  );
  const hasCanonicalInCandidates = canonicalTruePlay
    ? basePlayCandidates.some((play) => {
        if (play.source_card_id && canonicalTruePlay.source_card_id) {
          return play.source_card_id === canonicalTruePlay.source_card_id;
        }
        return (
          play.cardType === canonicalTruePlay.cardType &&
          play.created_at === canonicalTruePlay.created_at
        );
      })
    : false;
  const playCandidates =
    canonicalTruePlay && !hasCanonicalInCandidates
      ? [canonicalTruePlay, ...basePlayCandidates]
      : [...basePlayCandidates];
  const dedupedPlayCandidates = dedupePlayCandidates(game, playCandidates);
  const evidenceCandidates = game.plays.filter((play) =>
    !isProjectionOnlyCardPlay(play) && isEvidenceItem(play, game.sport),
  );
  const scopedPlayCandidates = ENABLE_WELCOME_HOME
    ? dedupedPlayCandidates
    : dedupedPlayCandidates.filter((play) => !isWelcomeHomePlay(play));
  const scopedEvidenceCandidates = ENABLE_WELCOME_HOME
    ? evidenceCandidates
    : evidenceCandidates.filter((play) => !isWelcomeHomePlay(play));
  const wave1DecisionPlay =
    canonicalTruePlay &&
    isWave1EligibleDecisionPlay(canonicalTruePlay, game.sport) &&
    canonicalTruePlay.decision_v2
      ? canonicalTruePlay
      : selectWave1DecisionCandidate(scopedPlayCandidates, game.sport);
  if (wave1DecisionPlay?.decision_v2) {
    const decisionV2 = wave1DecisionPlay.decision_v2;
    const canonicalSelection = getCanonicalEnvelopeSelection(wave1DecisionPlay);
    const canonicalSelectionDirection = normalizeSideToken(canonicalSelection.side);
    const effectiveDecisionV2: DecisionV2 = {
      ...decisionV2,
      direction:
        canonicalSelectionDirection !== 'NONE'
          ? canonicalSelectionDirection
          :
        decisionV2.direction ??
        'NONE',
      missing_data: {
        ...decisionV2.missing_data,
        missing_fields: normalizeMissingInputs(decisionV2.missing_data?.missing_fields),
      },
    };
    const officialStatus = effectiveDecisionV2.official_status;
    const status = statusFromOfficial(officialStatus);
    const action = actionFromOfficial(officialStatus);
    const marketType = wave1DecisionPlay.market_type ?? 'INFO';
    const market = mapCanonicalToLegacyMarket(marketType);
    const direction =
      effectiveDecisionV2.direction === 'NONE' ? null : effectiveDecisionV2.direction;
    const wave1PickText = buildWave1PickText(
      wave1DecisionPlay,
      game,
      effectiveDecisionV2.direction,
    );
    const edgeVerificationBlocked = hasEdgeVerificationSignals({
      tags: wave1DecisionPlay.tags,
      reason_codes: wave1DecisionPlay.reason_codes,
      decision_v2: effectiveDecisionV2,
    });
    const pick =
      officialStatus === 'PASS'
        ? edgeVerificationBlocked && wave1PickText !== 'NO PLAY'
          ? `${wave1PickText} (Verification Required)`
          : 'NO PLAY'
        : wave1PickText;
    const edgePct = resolveDecisionV2EdgePct(effectiveDecisionV2);
    const projectedMargin =
      typeof wave1DecisionPlay.projection?.projected_margin === 'number'
        ? wave1DecisionPlay.projection.projected_margin
        : typeof wave1DecisionPlay.projection?.margin_home === 'number'
          ? wave1DecisionPlay.projection.margin_home
          : null;
    const projectedTotal =
      typeof wave1DecisionPlay.projectedTotal === 'number'
        ? wave1DecisionPlay.projectedTotal
        : typeof wave1DecisionPlay.projection?.projected_total === 'number'
          ? wave1DecisionPlay.projection.projected_total
          : typeof wave1DecisionPlay.projection?.total === 'number'
            ? wave1DecisionPlay.projection.total
            : null;
    const projectedTeamTotal =
      typeof wave1DecisionPlay.projection?.projected_team_total === 'number'
        ? wave1DecisionPlay.projection.projected_team_total
        : typeof wave1DecisionPlay.projection?.team_total === 'number'
          ? wave1DecisionPlay.projection.team_total
          : null;
    const projectedGoalDiff =
      typeof wave1DecisionPlay.projection?.projected_goal_diff === 'number'
        ? wave1DecisionPlay.projection.projected_goal_diff
        : typeof wave1DecisionPlay.projection?.goal_diff === 'number'
          ? wave1DecisionPlay.projection.goal_diff
          : null;
    const projectedScoreHome =
      typeof wave1DecisionPlay.projection?.projected_score_home === 'number'
        ? wave1DecisionPlay.projection.projected_score_home
        : typeof wave1DecisionPlay.projection?.score_home === 'number'
          ? wave1DecisionPlay.projection.score_home
          : null;
    const projectedScoreAway =
      typeof wave1DecisionPlay.projection?.projected_score_away === 'number'
        ? wave1DecisionPlay.projection.projected_score_away
        : typeof wave1DecisionPlay.projection?.score_away === 'number'
          ? wave1DecisionPlay.projection.score_away
          : null;
    const edgePoints =
      typeof wave1DecisionPlay.edge_points === 'number'
        ? wave1DecisionPlay.edge_points
        : null;
    const projectionComparison =
      wave1DecisionPlay.odds_context?.projection_comparison as Record<string, unknown> | undefined | null;
    const edgeVsConsensusPts =
      typeof projectionComparison?.edge_vs_consensus_pts === 'number'
        ? projectionComparison.edge_vs_consensus_pts
        : null;
    const edgeVsBestAvailablePts =
      typeof projectionComparison?.edge_vs_best_available_pts === 'number'
        ? projectionComparison.edge_vs_best_available_pts
        : null;
    const executionAlphaPts =
      typeof projectionComparison?.execution_alpha_pts === 'number'
        ? projectionComparison.execution_alpha_pts
        : null;
    const playableEdge =
      typeof projectionComparison?.playable_edge === 'boolean'
        ? projectionComparison.playable_edge
        : null;
    const betMarketType = mapCanonicalToBetMarketType(marketType);
    const betSide = direction ? mapDirectionToBetSide(direction) : null;
    const requiresLineForBet =
      betMarketType === 'spread' ||
      betMarketType === 'total' ||
      betMarketType === 'team_total';
    const hasRequiredLine =
      !requiresLineForBet || typeof wave1DecisionPlay.line === 'number';
    const candidateBet: CanonicalBet | null =
      (officialStatus === 'PLAY' || officialStatus === 'LEAN') &&
      betMarketType &&
      betSide &&
      hasRequiredLine &&
      typeof wave1DecisionPlay.price === 'number'
        ? {
            market_type: betMarketType,
            side: betSide,
            team:
              direction === 'HOME'
                ? 'home'
                : direction === 'AWAY'
                  ? 'away'
                  : undefined,
            line:
              typeof wave1DecisionPlay.line === 'number'
                ? wave1DecisionPlay.line
                : undefined,
            odds_american: wave1DecisionPlay.price,
            as_of_iso: game.odds?.capturedAt || game.createdAt,
          }
        : null;
    const bet = candidateBet && validateCanonicalBet(candidateBet) ? candidateBet : null;
    const valueStatus: ValueStatus =
      decisionV2.play_tier === 'BEST' || decisionV2.play_tier === 'GOOD'
        ? 'GOOD'
        : decisionV2.play_tier === 'OK'
          ? 'OK'
          : 'BAD';
    const mergedReasonCodes = Array.from(
      new Set([
        ...(wave1DecisionPlay.reason_codes ?? []),
        ...effectiveDecisionV2.watchdog_reason_codes,
        ...effectiveDecisionV2.price_reason_codes,
        effectiveDecisionV2.primary_reason_code,
        ...(edgeVerificationBlocked
          ? ['BLOCKED_BET_VERIFICATION_REQUIRED']
          : []),
      ]),
    );
    const tags = Array.from(new Set([...(wave1DecisionPlay.tags ?? [])]));
    if (edgeVerificationBlocked) {
      tags.push('LINE_NOT_CONFIRMED');
    }
    if (
      effectiveDecisionV2.proxy_capped === true ||
      effectiveDecisionV2.price_reason_codes.includes('PROXY_EDGE_CAPPED') ||
      effectiveDecisionV2.price_reason_codes.includes('PROXY_EDGE_BLOCKED')
    ) {
      tags.push('PROXY_CARD');
    }
    const gates: CanonicalGate[] = effectiveDecisionV2.watchdog_reason_codes.map((code) => ({
      code,
      severity: effectiveDecisionV2.watchdog_status === 'BLOCKED' ? 'BLOCK' : 'WARN',
      blocks_bet: effectiveDecisionV2.watchdog_status === 'BLOCKED',
    }));
    if (
      edgeVerificationBlocked &&
      !gates.some((gate) => gate.code === EDGE_SANITY_GATE_CODE)
    ) {
      gates.push({
        code: EDGE_SANITY_GATE_CODE,
        severity: 'BLOCK',
        blocks_bet: true,
      });
    }

    const hasBlockingGateV2 = gates.some((g) => g.blocks_bet);
    const finalBet = hasBlockingGateV2 ? null : bet;

    return {
      market_key: `${marketType}|${effectiveDecisionV2.direction}`,
      decision: status === 'FIRE' ? 'FIRE' : status === 'WATCH' ? 'WATCH' : 'PASS',
      classificationLabel:
        officialStatus === 'PLAY' ? 'PLAY' : officialStatus === 'LEAN' ? 'LEAN' : 'NONE',
      bet: finalBet,
      gates,
      decision_data: {
        status: status === 'FIRE' ? 'FIRE' : status === 'WATCH' ? 'WATCH' : 'PASS',
        truth:
          effectiveDecisionV2.support_score >= 0.6
            ? 'STRONG'
            : effectiveDecisionV2.support_score >= 0.45
              ? 'MEDIUM'
              : 'WEAK',
        value_tier: valueStatus,
        edge_pct: edgePct,
        edge_tier: effectiveDecisionV2.play_tier,
        coinflip: false,
        reason_code: effectiveDecisionV2.primary_reason_code,
      },
      transform_meta: {
        quality: effectiveDecisionV2.watchdog_status === 'BLOCKED' ? 'DEGRADED' : 'OK',
        missing_inputs: normalizeMissingInputs(
          effectiveDecisionV2.missing_data.missing_fields,
        ),
        placeholders_found: [],
        drop_reason: resolvePlayDropReason(wave1DecisionPlay),
      },
      market_type: marketType,
      kind: 'PLAY',
      evidence_count: scopedEvidenceCandidates.length,
      consistency: {
        total_bias:
          decisionV2.consistency.total_bias === 'OK' ||
          decisionV2.consistency.total_bias === 'INSUFFICIENT_DATA' ||
          decisionV2.consistency.total_bias === 'CONFLICTING_SIGNALS' ||
          decisionV2.consistency.total_bias === 'VOLATILE_ENV' ||
          decisionV2.consistency.total_bias === 'UNKNOWN'
            ? decisionV2.consistency.total_bias
            : 'UNKNOWN',
      },
      selection: wave1DecisionPlay.selection
        || canonicalSelection.side
        ? {
            side: (
              canonicalSelection.side ??
              wave1DecisionPlay.selection?.side ??
              'NONE'
            ) as SelectionSide,
            team:
              canonicalSelection.team ?? wave1DecisionPlay.selection?.team,
          }
        : undefined,
      reason_codes: mergedReasonCodes,
      tags: Array.from(new Set(tags)),
      execution_status: wave1DecisionPlay.execution_status,
      classification:
        officialStatus === 'PLAY' ? 'BASE' : officialStatus === 'LEAN' ? 'LEAN' : 'PASS',
      action,
      pass_reason_code:
        officialStatus === 'PASS' ? effectiveDecisionV2.primary_reason_code : null,
      decision_v2: effectiveDecisionV2,
      final_market_decision: buildFinalMarketDecision({
        decisionV2: effectiveDecisionV2,
        reasonCodes: mergedReasonCodes,
        passReasonCode: officialStatus === 'PASS' ? effectiveDecisionV2.primary_reason_code : null,
        edge: edgePct,
        goalieHomeStatus: wave1DecisionPlay.goalie_home_status,
        goalieAwayStatus: wave1DecisionPlay.goalie_away_status,
      }),
      status,
      market,
      pick,
      lean: directionToLean(effectiveDecisionV2.direction, game),
      side: direction as Direction | null,
      truthStatus:
        effectiveDecisionV2.support_score >= 0.6
          ? 'STRONG'
          : effectiveDecisionV2.support_score >= 0.45
            ? 'MEDIUM'
            : 'WEAK',
      truthStrength: clamp(effectiveDecisionV2.support_score, 0.5, 0.95),
      conflict: effectiveDecisionV2.conflict_score,
      modelProb:
        typeof effectiveDecisionV2.fair_prob === 'number'
          ? effectiveDecisionV2.fair_prob
          : undefined,
      impliedProb:
        typeof effectiveDecisionV2.implied_prob === 'number'
          ? effectiveDecisionV2.implied_prob
          : undefined,
      edge: edgePct ?? undefined,
      edgePoints: edgePoints ?? undefined,
      edgeVsConsensusPts: edgeVsConsensusPts ?? undefined,
      edgeVsBestAvailablePts: edgeVsBestAvailablePts ?? undefined,
      executionAlphaPts: executionAlphaPts ?? undefined,
      playableEdge: playableEdge ?? undefined,
      projectedMargin: projectedMargin ?? undefined,
      projectedTotal: projectedTotal ?? undefined,
      projectedTeamTotal: projectedTeamTotal ?? undefined,
      projectedGoalDiff: projectedGoalDiff ?? undefined,
      projectedScoreHome: projectedScoreHome ?? undefined,
      projectedScoreAway: projectedScoreAway ?? undefined,
      valueStatus,
      betAction: (officialStatus === 'PLAY' || officialStatus === 'LEAN') && finalBet ? 'BET' : 'NO_PLAY',
      priceFlags: [],
      line: wave1DecisionPlay.line,
      price: wave1DecisionPlay.price,
      lineSource: effectiveDecisionV2.pricing_trace?.line_source ?? undefined,
      priceSource: effectiveDecisionV2.pricing_trace?.price_source ?? undefined,
      updatedAt: game.odds?.capturedAt || game.createdAt,
      whyCode: effectiveDecisionV2.primary_reason_code,
      whyText: effectiveDecisionV2.primary_reason_code.replace(/_/g, ' '),
    };
  }
  const inferredPlays = scopedPlayCandidates.map((sourcePlay) => ({
    sourcePlay,
    inference: inferMarketFromPlay(sourcePlay),
  }));
  const canonicalPlayableCount = inferredPlays.filter(
    ({ inference }) => inference.canonical && inference.canonical !== 'INFO',
  ).length;
  const truthDriver = pickTruthDriver(drivers);

  if (!truthDriver) {
    // Distinguish: no driver plays loaded vs plays exist but no truth driver qualified
    const hasNoOdds = game.odds === null;
    const hasNoPlays = game.plays.length === 0;
    const hasPlayItems = game.plays.some((play) =>
      isPlayItem(play, game.sport),
    );
    const hasEvidenceOnly =
      !hasPlayItems &&
      game.plays.some((play) => isEvidenceItem(play, game.sport));
    const sourceMappingFailures = Array.from(
      new Set([
        ...(Array.isArray(game.source_mapping_failures)
          ? game.source_mapping_failures
          : []),
        ...game.plays.flatMap((play) =>
          Array.isArray(play.source_mapping_failures)
            ? play.source_mapping_failures
            : [],
        ),
      ]),
    );
    const projectionMissingInputs = Array.from(
      new Set([
        ...normalizeMissingInputs(game.projection_missing_inputs),
        ...game.plays.flatMap((play) =>
          normalizeMissingInputs(play.missing_inputs),
        ),
      ]),
    );
    const hasMappingFailure =
      game.ingest_failure_reason_code === 'TEAM_MAPPING_UNMAPPED' ||
      game.source_mapping_ok === false || sourceMappingFailures.length > 0;
    const hasProjectionInputsFailure =
      game.projection_inputs_complete === false ||
      game.plays.some((play) => play.projection_inputs_complete === false) ||
      projectionMissingInputs.length > 0;
    const noActionablePlayInputs = hasEvidenceOnly
      ? collectNoActionablePlayInputs(game)
      : [];
    const hasFetchFailureInputs =
      hasEvidenceOnly && noActionablePlayInputs.length > 0;
    const missingDataCode: string =
      hasNoOdds && hasNoPlays
        ? 'MISSING_DATA_NO_ODDS'
        : hasMappingFailure
          ? 'MISSING_DATA_TEAM_MAPPING'
          : hasProjectionInputsFailure
            ? 'MISSING_DATA_PROJECTION_INPUTS'
            : hasNoPlays
              ? 'MISSING_DATA_DRIVERS'
          : hasEvidenceOnly
            ? 'PASS_NO_ACTIONABLE_PLAY'
            : 'PASS_MISSING_DRIVER_INPUTS';
    const missingDataText: string =
      hasNoOdds && hasNoPlays
        ? 'No odds available'
        : hasMappingFailure
          ? `Team mapping unresolved${game.ingest_failure_reason_detail ? `: ${game.ingest_failure_reason_detail}` : sourceMappingFailures.length ? `: ${sourceMappingFailures.join(', ')}` : ''}`
          : hasProjectionInputsFailure
            ? `Missing projection inputs${projectionMissingInputs.length ? `: ${projectionMissingInputs.join(', ')}` : ''}`
            : hasNoPlays
              ? 'Driver output unavailable'
            : hasEvidenceOnly
              ? hasFetchFailureInputs
                ? `No actionable play${noActionablePlayInputs.length ? `: ${noActionablePlayInputs.join(', ')}` : ''}`
                : 'No edge'
            : 'Missing driver inputs';
    const missingInputs = hasMappingFailure
      ? sourceMappingFailures.length > 0
        ? sourceMappingFailures
        : ['team_mapping']
      : hasProjectionInputsFailure
        ? projectionMissingInputs.length > 0
          ? projectionMissingInputs
          : ['projection_inputs']
        : hasEvidenceOnly
          ? hasFetchFailureInputs
            ? noActionablePlayInputs
            : []
          : ['drivers'];
    const isHealthyNoEdge =
      hasEvidenceOnly &&
      !hasNoOdds &&
      !hasMappingFailure &&
      !hasProjectionInputsFailure &&
      !hasFetchFailureInputs;
    return {
      market_key: 'INFO|NONE',
      decision: 'PASS',
      classificationLabel: 'NONE',
      bet: null,
      gates: [
        {
          code: missingDataCode,
          severity: isHealthyNoEdge ? 'WARN' : 'BLOCK',
          blocks_bet: !isHealthyNoEdge,
        },
      ],
      decision_data: {
        status: 'PASS',
        truth: 'WEAK',
        value_tier: 'BAD',
        edge_pct: null,
        edge_tier: 'BAD',
        coinflip: false,
        reason_code: missingDataCode,
      },
      transform_meta: {
        quality: isHealthyNoEdge ? 'OK' : 'DEGRADED',
        missing_inputs: missingInputs,
        placeholders_found: [],
        drop_reason: null,
      },
      status: 'PASS',
      market: 'NONE',
      pick: 'NO PLAY',
      lean: 'NO LEAN',
      side: null,
      truthStatus: 'WEAK',
      truthStrength: 0.5,
      conflict: 0,
      valueStatus: 'BAD',
      betAction: 'NO_PLAY',
      priceFlags: ['VIG_HEAVY'],
      updatedAt: game.odds?.capturedAt || game.createdAt,
      whyCode: missingDataCode,
      whyText: missingDataText,
      market_type: 'INFO',
      kind: 'PLAY',
      consistency: {
        total_bias: game.consistency?.total_bias ?? 'UNKNOWN',
      },
      reason_codes: [missingDataCode],
      tags: [],
      final_market_decision: buildFinalMarketDecision({
        decisionV2: null,
        reasonCodes: [missingDataCode],
        passReasonCode: missingDataCode,
        edge: null,
      }),
    };
  }

  const truthDirection = truthDriver.direction;
  const oppositeDirection = OPPOSITE_DIRECTION[truthDirection];
  const supportScore = directionScore(drivers, truthDirection);
  const opposeScore = oppositeDirection
    ? directionScore(drivers, oppositeDirection)
    : 0;
  const totalScore = supportScore + opposeScore;
  const net = totalScore > 0 ? (supportScore - opposeScore) / totalScore : 0;
  const conflict = totalScore > 0 ? clamp(opposeScore / totalScore, 0, 1) : 0;
  const truthStrength = clamp(0.5 + net * 0.3, 0.5, 0.8);
  const truthStatus = truthStatusFromStrength(truthStrength);

  // Check if there's a PROP play first (preferred for player props view)
  const propPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'PROP' && p.confidence >= 0.0,
  );

  // Check if there's an explicit high-confidence SPREAD or TOTAL play available
  // Prefer those over defaulting to MONEYLINE
  const spreadPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'SPREAD' && p.confidence >= 0.6 && p.tier !== null,
  );
  const totalPlay = scopedPlayCandidates.find(
    (p) => p.market_type === 'TOTAL' && p.confidence >= 0.6 && p.tier !== null,
  );

  // If we have a PROP play, use it for the canonical play object
  // Otherwise, default to SPREAD/TOTAL/MONEYLINE logic
  let market: Market | 'NONE';
  let direction: Direction;
  let isPropMarket = false;

  if (propPlay) {
    // For PROP plays, preserve them as-is for the player props view
    market = 'UNKNOWN'; // Use UNKNOWN as placeholder since PROP isn't in Market enum
    direction = (propPlay.prediction as Direction) || 'NEUTRAL';
    isPropMarket = true;
  } else if (spreadPlay) {
    market = 'SPREAD';
    const spreadSide = normalizeSideToken(
      spreadPlay.selection?.side ?? spreadPlay.prediction,
    );
    if (spreadSide === 'HOME' || spreadSide === 'AWAY') {
      direction = spreadSide;
    } else if (truthDirection === 'HOME' || truthDirection === 'AWAY') {
      direction = truthDirection;
    } else {
      direction = 'NEUTRAL';
    }
  } else if (totalPlay) {
    market = 'TOTAL';
    const totalSide = normalizeSideToken(
      totalPlay.selection?.side ?? totalPlay.prediction,
    );
    if (totalSide === 'OVER' || totalSide === 'UNDER') {
      direction = totalSide;
    } else if (truthDirection === 'OVER' || truthDirection === 'UNDER') {
      direction = truthDirection;
    } else {
      direction = 'NEUTRAL';
    }
  } else {
    // Fall back to standard market selection logic
    market = selectExpressionMarket(
      truthDirection,
      truthStatus,
      truthDriver,
      game.odds,
    );
    direction = truthDirection;
  }

  // Build pick string with proper price/line
  let pick = 'NO PLAY';
  let price: number | undefined;
  let line: number | undefined;

  if (isPropMarket && propPlay) {
    // For PROP plays, use the selection and line/price from the prop play
    const playerName = propPlay.selection?.team || 'Player';
    const propSelection =
      propPlay.selection?.side || propPlay.prediction || 'UNKNOWN';
    line = propPlay.line;
    price = propPlay.price;
    if (line !== undefined) {
      pick = `${playerName} ${propSelection} ${line}`;
    } else if (price !== undefined) {
      pick = `${playerName} ${propSelection} (${price > 0 ? '+' : ''}${price})`;
    } else {
      pick = `${playerName} ${propSelection}`;
    }
  } else {
    const teamName =
      direction === 'HOME'
        ? game.homeTeam
        : direction === 'AWAY'
          ? game.awayTeam
          : '';

    if (market === 'ML') {
      price =
        direction === 'HOME'
          ? (game.odds?.h2hHome ?? undefined)
          : (game.odds?.h2hAway ?? undefined);
      if (price !== undefined) {
        const priceStr = price > 0 ? `+${price}` : `${price}`;
        pick = `${teamName} ML ${priceStr}`;
      } else {
        pick = `${teamName} ML (Price N/A)`;
      }
    } else if (market === 'SPREAD') {
      line =
        direction === 'HOME'
          ? (game.odds?.spreadHome ?? undefined)
          : (game.odds?.spreadAway ?? undefined);
      price =
        direction === 'HOME'
          ? (game.odds?.spreadPriceHome ?? undefined)
          : (game.odds?.spreadPriceAway ?? undefined);
      if (line !== undefined) {
        const lineStr = line > 0 ? `+${line}` : `${line}`;
        pick = `${teamName} ${lineStr}`;
      } else {
        pick = `${teamName} Spread (Line N/A)`;
      }
    } else if (market === 'TOTAL') {
      line = game.odds?.total ?? undefined;
      // Get the over/under price based on direction
      if (market === 'TOTAL') {
        price =
          direction === 'OVER'
            ? (game.odds?.totalPriceOver ?? undefined)
            : (game.odds?.totalPriceUnder ?? undefined);
      }
      if (line !== undefined) {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} ${typeof line === 'number' ? +line.toFixed(1) : line}`;
      } else {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} (Line N/A)`;
      }
    }
  }

  const sourcePlayByTruthDriver = scopedPlayCandidates.find(
    (play) => play.driverKey === truthDriver.key,
  );
  const rankedSourceCandidates = scopedPlayCandidates
    .map((play) => {
      const inference = inferMarketFromPlay(play);
      const side = normalizeSideToken(play.selection?.side ?? play.prediction);
      return {
        play,
        inference,
        hasPlayableBet: hasPlayableBet(play, inference.canonical, side),
        hasModelProb: resolveSourceModelProb(play) !== undefined,
        actionRank: playDecisionRank(play),
        valueRank: playValueRank(play),
        truthDriverMatch: play.driverKey === truthDriver.key ? 1 : 0,
        createdMs: timestampMs(play.created_at),
      };
    })
    .sort((a, b) => {
      if (a.hasPlayableBet !== b.hasPlayableBet)
        return a.hasPlayableBet ? -1 : 1;
      if (a.hasModelProb !== b.hasModelProb) return a.hasModelProb ? -1 : 1;
      if (a.actionRank !== b.actionRank) return b.actionRank - a.actionRank;
      if (a.truthDriverMatch !== b.truthDriverMatch)
        return b.truthDriverMatch - a.truthDriverMatch;
      if (a.valueRank !== b.valueRank) return b.valueRank - a.valueRank;
      if (a.createdMs !== b.createdMs) return b.createdMs - a.createdMs;
      return 0;
    });

  // Prefer PROP play if available, otherwise use best ranked source candidate
  const hasMlbFullGameMoneylineCandidate =
    normalizeSport(game.sport) === 'MLB' &&
    rankedSourceCandidates.some(
      (candidate) =>
        candidate.inference.canonical === 'MONEYLINE' &&
        candidate.play.cardType?.toLowerCase() === 'mlb-full-game-ml' &&
        candidate.actionRank >= 2,
    );

  const preferredCanonical = hasMlbFullGameMoneylineCandidate
    ? 'MONEYLINE'
    : market === 'TOTAL'
      ? 'TOTAL'
      : market === 'SPREAD'
        ? 'SPREAD'
        : market === 'ML'
          ? 'MONEYLINE'
          : undefined;
  const marketAlignedCandidates = preferredCanonical
    ? rankedSourceCandidates.filter(
        (candidate) => candidate.inference.canonical === preferredCanonical,
      )
    : rankedSourceCandidates;
  const marketAlignedPlayableCandidates = marketAlignedCandidates.filter(
    (candidate) => candidate.hasPlayableBet,
  );
  const sourceCandidatePool =
    marketAlignedPlayableCandidates.length > 0
      ? marketAlignedCandidates
      : rankedSourceCandidates;
  const authoritativeCanonicalStatus = resolveCanonicalOfficialStatus(
    canonicalTruePlay,
  );
  const authoritativeAction = canonicalTruePlay
    ? getSourcePlayAction(canonicalTruePlay)
    : undefined;
  const authoritativeSelectedSource =
    canonicalTruePlay &&
    (authoritativeCanonicalStatus === 'PLAY' ||
      authoritativeCanonicalStatus === 'LEAN' ||
      authoritativeAction === 'FIRE' ||
      authoritativeAction === 'HOLD')
      ? {
          play: canonicalTruePlay,
          inference: inferMarketFromPlay(canonicalTruePlay),
        }
      : null;

  const selectedSource =
    authoritativeSelectedSource ??
    (isPropMarket && propPlay
      ? {
          play: propPlay,
          inference: inferMarketFromPlay(propPlay),
        }
      : (sourceCandidatePool[0] ??
        rankedSourceCandidates[0] ??
        (sourcePlayByTruthDriver
          ? {
              play: sourcePlayByTruthDriver,
              inference: inferMarketFromPlay(sourcePlayByTruthDriver),
            }
          : null)));
  const sourcePlay = selectedSource?.play ?? scopedPlayCandidates[0];
  const sourceCanonicalStatus = resolveCanonicalOfficialStatus(sourcePlay);
  const sourceAction =
    sourceCanonicalStatus === 'PLAY'
      ? 'FIRE'
      : sourceCanonicalStatus === 'LEAN'
        ? 'HOLD'
        : sourceCanonicalStatus === 'PASS'
          ? 'PASS'
          : (getSourcePlayAction(sourcePlay) ?? 'PASS');
  const moneylineExecutionActionOverride =
    resolveMoneylineExecutionActionOverride(sourcePlay, sourceAction);
  const sourceExplicitPass = sourceAction === 'PASS';
  const sourceInference =
    selectedSource?.inference ??
    (sourcePlay
      ? inferMarketFromPlay(sourcePlay)
      : { market, canonical: undefined, reasonCodes: [], tags: [] });
  const sourceCanonicalSelection = getCanonicalEnvelopeSelection(sourcePlay);
  const sourceSide = normalizeSideToken(
    sourceCanonicalSelection.side ??
      sourcePlay?.selection?.side ??
      sourcePlay?.prediction,
  );
  const sourceHasPlayableBet =
    Boolean(sourcePlay) &&
    hasPlayableBet(sourcePlay, sourceInference.canonical, sourceSide);

  if (!isPropMarket && sourceHasPlayableBet && sourceInference.canonical) {
    if (
      sourceInference.canonical === 'MONEYLINE' &&
      (sourceSide === 'HOME' || sourceSide === 'AWAY')
    ) {
      market = 'ML';
      direction = sourceSide;
      line = undefined;
      price = typeof sourcePlay?.price === 'number' ? sourcePlay.price : price;
    } else if (
      (sourceInference.canonical === 'SPREAD' ||
        sourceInference.canonical === 'PUCKLINE') &&
      (sourceSide === 'HOME' || sourceSide === 'AWAY')
    ) {
      market = 'SPREAD';
      direction = sourceSide;
      line = typeof sourcePlay?.line === 'number' ? sourcePlay.line : line;
      price = typeof sourcePlay?.price === 'number' ? sourcePlay.price : price;
    } else if (
      (sourceInference.canonical === 'TOTAL' ||
        sourceInference.canonical === 'TEAM_TOTAL') &&
      (sourceSide === 'OVER' || sourceSide === 'UNDER')
    ) {
      market = 'TOTAL';
      direction = sourceSide;
      line = typeof sourcePlay?.line === 'number' ? sourcePlay.line : line;
      price = typeof sourcePlay?.price === 'number' ? sourcePlay.price : price;
    }
  }

  if (!isPropMarket) {
    const teamName =
      direction === 'HOME'
        ? game.homeTeam
        : direction === 'AWAY'
          ? game.awayTeam
          : '';
    if (market === 'ML') {
      if (price === undefined) {
        price =
          direction === 'HOME'
            ? (game.odds?.h2hHome ?? undefined)
            : (game.odds?.h2hAway ?? undefined);
      }
      if (direction === 'HOME' || direction === 'AWAY') {
        pick = `${teamName} ML ${price !== undefined ? (price > 0 ? `+${price}` : `${price}`) : '(Price N/A)'}`;
      }
    } else if (market === 'SPREAD') {
      if (line === undefined) {
        line =
          direction === 'HOME'
            ? (game.odds?.spreadHome ?? undefined)
            : (game.odds?.spreadAway ?? undefined);
      }
      if (price === undefined) {
        price =
          direction === 'HOME'
            ? (game.odds?.spreadPriceHome ?? undefined)
            : (game.odds?.spreadPriceAway ?? undefined);
      }
      if (direction === 'HOME' || direction === 'AWAY') {
        pick = `${teamName} ${line !== undefined ? (line > 0 ? `+${line}` : `${line}`) : 'Spread (Line N/A)'}`;
      }
    } else if (market === 'TOTAL') {
      if (line === undefined) {
        line = game.odds?.total ?? undefined;
      }
      if (price === undefined) {
        price =
          direction === 'OVER'
            ? (game.odds?.totalPriceOver ?? undefined)
            : (game.odds?.totalPriceUnder ?? undefined);
      }
      if (direction === 'OVER' || direction === 'UNDER') {
        pick = `${direction === 'OVER' ? 'Over' : 'Under'} ${
          line !== undefined
            ? typeof line === 'number' ? +line.toFixed(1) : line
            : '(Line N/A)'
        }`;
      }
    }
  }
  // Resolve market type: prefer selected market, then source canonical fallback.
  const inferredMarketTypeFromSelection =
    market === 'TOTAL'
      ? 'TOTAL'
      : market === 'SPREAD'
        ? 'SPREAD'
        : market === 'ML'
          ? 'MONEYLINE'
          : undefined;
  const resolvedMarketType =
    isPropMarket && propPlay?.market_type === 'PROP'
      ? 'PROP'
      : (inferredMarketTypeFromSelection ??
        sourceInference.canonical ??
        'INFO');
  const normalizedSide = normalizeSideForCanonicalMarket(
    resolvedMarketType,
    normalizeSideToken(direction),
  );
  if (normalizedSide === 'NONE') {
    direction = 'NEUTRAL';
    if (resolvedMarketType !== 'PROP') {
      price = undefined;
      if (resolvedMarketType === 'SPREAD' || resolvedMarketType === 'TOTAL') {
        line = undefined;
      }
    }
  } else {
    direction = normalizedSide;
  }

  const sourceModelProb = resolveSourceModelProb(sourcePlay);
  const modelProb = sourceModelProb;
  const projectedTotal =
    typeof sourcePlay?.projectedTotal === 'number'
      ? sourcePlay.projectedTotal
      : typeof sourcePlay?.projection?.projected_total === 'number'
        ? sourcePlay.projection.projected_total
        : typeof sourcePlay?.projection?.total === 'number'
          ? sourcePlay.projection.total
          : undefined;
  const projectedTotalLow =
    typeof sourcePlay?.projection?.projected_total_low === 'number'
      ? sourcePlay.projection.projected_total_low
      : undefined;
  const projectedTotalHigh =
    typeof sourcePlay?.projection?.projected_total_high === 'number'
      ? sourcePlay.projection.projected_total_high
      : undefined;
  const projectedHomeF5Runs =
    typeof sourcePlay?.projection?.projected_home_f5_runs === 'number'
      ? sourcePlay.projection.projected_home_f5_runs
      : undefined;
  const projectedAwayF5Runs =
    typeof sourcePlay?.projection?.projected_away_f5_runs === 'number'
      ? sourcePlay.projection.projected_away_f5_runs
      : undefined;

  const impliedProb =
    resolvedMarketType === 'MONEYLINE' ||
    resolvedMarketType === 'SPREAD' ||
    resolvedMarketType === 'TOTAL'
      ? americanToImpliedProbability(price)
      : undefined;
  const edge = impliedProb !== undefined && modelProb !== undefined ? modelProb - impliedProb : undefined;
  const valueStatus = getValueStatus(edge);
  const displayMarketForPriceFlags =
    resolvedMarketType === 'MONEYLINE'
      ? 'ML'
      : resolvedMarketType === 'SPREAD'
        ? 'SPREAD'
        : resolvedMarketType === 'TOTAL'
          ? 'TOTAL'
          : 'NONE';
  const priceFlags = getPriceFlags(
    displayMarketForPriceFlags,
    direction,
    price,
  );

  const needsSteepFavoritePremium = typeof price === 'number' && price <= -240;
  let edgeThreshold = 0.02;
  if (truthStatus === 'WEAK') edgeThreshold += 0.015;
  if (conflict >= 0.35) edgeThreshold += 0.01;
  if (needsSteepFavoritePremium) edgeThreshold += 0.02;

  let betAction: 'BET' | 'NO_PLAY' = 'NO_PLAY';
  const isEdgeBackedMarket =
    (resolvedMarketType === 'MONEYLINE' ||
      resolvedMarketType === 'SPREAD' ||
      resolvedMarketType === 'TOTAL') &&
    typeof price === 'number';
  if (isEdgeBackedMarket && edge !== undefined && edge >= edgeThreshold) {
    betAction = 'BET';
  }

  const isTotalWithLineNoPrice =
    (resolvedMarketType === 'TOTAL' || resolvedMarketType === 'TEAM_TOTAL') &&
    (direction === 'OVER' || direction === 'UNDER') &&
    typeof line === 'number' &&
    typeof price !== 'number';
  if (
    isTotalWithLineNoPrice &&
    (sourceAction === 'FIRE' || sourceAction === 'HOLD')
  ) {
    betAction = 'BET';
  }

  if (
    priceFlags.includes('PRICE_TOO_STEEP') &&
    (edge === undefined || edge < 0.06)
  ) {
    betAction = 'NO_PLAY';
  }

  if (edge === undefined && !isTotalWithLineNoPrice) {
    betAction = 'NO_PLAY';
  }

  const whyMarket: Market | 'NONE' =
    resolvedMarketType === 'MONEYLINE'
      ? 'ML'
      : resolvedMarketType === 'SPREAD'
        ? 'SPREAD'
        : resolvedMarketType === 'TOTAL'
          ? 'TOTAL'
          : 'NONE';
  let whyCode = getPlayWhyCode(betAction, whyMarket, drivers, priceFlags);
  let whyText = whyCode.replace(/_/g, ' ');
  const totalBias =
    sourcePlay?.consistency?.total_bias ??
    game.consistency?.total_bias ??
    'UNKNOWN';

  const riskTags = getRiskTagsFromText(
    sourcePlay?.cardTitle ?? '',
    sourcePlay?.reasoning ?? '',
    truthDriver.cardTitle,
    truthDriver.note,
  );
  const tags = [...new Set([...(sourceInference.tags ?? []), ...riskTags])];
  const hasPlaceholderDrivers = drivers.some(
    (driver) =>
      hasPlaceholderText(driver.note) || hasPlaceholderText(driver.cardTitle),
  );
  const placeholderMatches = new Set<string>();
  if (hasPlaceholderDrivers) {
    placeholderMatches.add('drivers');
  }
  if (
    hasPlaceholderText(sourcePlay?.reasoning) ||
    hasPlaceholderText(sourcePlay?.cardTitle)
  ) {
    placeholderMatches.add('play_text');
  }

  const sourceAggregationKey = sourcePlay?.aggregation_key;
  const linkedEvidence = scopedEvidenceCandidates.filter((evidence) => {
    if (
      sourcePlay?.driverKey &&
      evidence.evidence_for_play_id === sourcePlay.driverKey
    )
      return true;
    if (
      sourceAggregationKey &&
      evidence.aggregation_key === sourceAggregationKey
    )
      return true;
    return false;
  });

  const hasPlaceholderEvidence = linkedEvidence.some((evidence) => {
    const hit =
      hasPlaceholderText(evidence.reasoning) ||
      hasPlaceholderText(evidence.cardTitle);
    if (hit) placeholderMatches.add('evidence');
    return hit;
  });

  const reasonCodes: string[] = [...sourceInference.reasonCodes];
  if (!sourcePlay?.kind) reasonCodes.push('PASS_MISSING_KIND');
  if (hasPlaceholderDrivers || hasPlaceholderEvidence) {
    reasonCodes.push('PASS_DATA_ERROR');
    tags.push('DATA_ERROR_PLACEHOLDER');
  }

  // For PROP plays, the validation is different
  if (resolvedMarketType === 'PROP') {
    if (
      !sourceCanonicalSelection.side &&
      !sourceCanonicalSelection.team &&
      !sourcePlay?.selection?.side &&
      !sourcePlay?.selection?.team
    )
      reasonCodes.push('PASS_MISSING_SELECTION');
  } else {
    if (!sourceInference.canonical)
      reasonCodes.push('PASS_MISSING_MARKET_TYPE');
    if (sourceInference.canonical === 'TOTAL' && line === undefined)
      reasonCodes.push('PASS_MISSING_LINE');
    if (
      (sourceInference.canonical === 'SPREAD' ||
        sourceInference.canonical === 'MONEYLINE') &&
      direction === 'NEUTRAL'
    ) {
      reasonCodes.push('PASS_MISSING_SELECTION');
    }
    if (
      (sourceInference.canonical === 'SPREAD' ||
        sourceInference.canonical === 'MONEYLINE') &&
      price === undefined
    ) {
      reasonCodes.push('PASS_NO_MARKET_PRICE');
    }
  }

  if (edge === undefined && !isTotalWithLineNoPrice)
    reasonCodes.push('PASS_MISSING_EDGE');
  const requiresModelProbForEdge =
    (resolvedMarketType === 'MONEYLINE' ||
      resolvedMarketType === 'SPREAD' ||
      resolvedMarketType === 'TOTAL') &&
    typeof price === 'number';
  if (
    requiresModelProbForEdge &&
    modelProb === undefined &&
    (sourceAction === 'FIRE' || sourceAction === 'HOLD')
  ) {
    reasonCodes.push('PASS_DATA_ERROR');
  }
  if (canonicalPlayableCount === 0) reasonCodes.push('PASS_NO_PRIMARY_SUPPORT');
  if (betAction === 'NO_PLAY' && !reasonCodes.includes(whyCode))
    reasonCodes.push(whyCode);

  const hasExplicitTotalsConsistencyBlock =
    resolvedMarketType === 'TOTAL' &&
    totalBias !== 'OK' &&
    totalBias !== 'UNKNOWN';

  if (hasExplicitTotalsConsistencyBlock) {
    reasonCodes.push('PASS_TOTAL_INSUFFICIENT_DATA');
    tags.push('CONSISTENCY_BLOCK_TOTALS');
    whyCode = 'PASS_TOTAL_INSUFFICIENT_DATA';
    whyText = 'PASS TOTAL INSUFFICIENT DATA';
  }

  const hasTeamContext =
    direction === 'HOME' ||
    direction === 'AWAY' ||
    Boolean(sourcePlay?.selection?.team);

  // Invariant violations only apply to standard markets, not PROP
  const hasTotalInvariantViolation =
    resolvedMarketType === 'TOTAL' &&
    !(
      (direction === 'OVER' || direction === 'UNDER') &&
      typeof line === 'number'
    );
  const hasSpreadInvariantViolation =
    resolvedMarketType === 'SPREAD' &&
    !(
      (direction === 'HOME' || direction === 'AWAY') &&
      typeof line === 'number'
    );
  const hasMoneylineInvariantViolation =
    resolvedMarketType === 'MONEYLINE' &&
    !((direction === 'HOME' || direction === 'AWAY') && hasTeamContext);

  if (betAction === 'NO_PLAY' || hasExplicitTotalsConsistencyBlock) {
    pick = 'NO PLAY';
  }

  // For PROP plays, don't enforce standard market invariants
  const forcedPass =
    resolvedMarketType !== 'PROP' &&
    (hasTotalInvariantViolation ||
      hasSpreadInvariantViolation ||
      hasMoneylineInvariantViolation);
  if (forcedPass) {
    if (hasTotalInvariantViolation) reasonCodes.push('PASS_MISSING_LINE');
    if (hasSpreadInvariantViolation) {
      reasonCodes.push('PASS_MISSING_SELECTION');
      reasonCodes.push('PASS_MISSING_LINE');
    }
    if (hasMoneylineInvariantViolation)
      reasonCodes.push('PASS_MISSING_SELECTION');
    pick = 'NO PLAY';
  }

  const hardPass = forcedPass;

  // Build initial play object for canonical decision
  const playForDecision: CanonicalPlay = {
    play_id:
      sourcePlay?.driverKey ?? `${game.id}:${resolvedMarketType}:${direction}`,
    sport: game.sport as CanonicalSport,
    game_id: game.gameId,
    market_type: resolvedMarketType as MarketType,
    side:
      direction === 'HOME' ||
      direction === 'AWAY' ||
      direction === 'OVER' ||
      direction === 'UNDER'
        ? direction
        : undefined,
    selection_key: direction as SelectionKey,
    line,
    price_american: price,
    model: {
      edge,
      confidence: truthStrength,
    },
    warning_tags: tags,
    classification: 'PASS',
    action: 'PASS',
    created_at: game.createdAt,
  };

  // Market context: refine later with real availability checks
  const marketContext = {
    market_available: Boolean(game?.odds), // refine later if you have per-market availability
    time_window_ok: true, // refine later based on game time
    wrapper_blocks: false, // set true in wrappers (NHL goalie, Soccer scope, etc.)
  };

  // Always derive the full decision shape so decision.play stays populated.
  // When a stored backend decision exists on a non-wave1 payload, keep that
  // official status authoritative instead of re-deriving from web thresholds.
  const baseDecision = derivePlayDecision(playForDecision, marketContext, {
    sport: playForDecision.sport,
  });
  const storedStatus = resolveCanonicalOfficialStatus(sourcePlay);
  const decision =
    storedStatus === 'PLAY' || storedStatus === 'LEAN' || storedStatus === 'PASS'
      ? {
          ...baseDecision,
          classification:
            storedStatus === 'PLAY'
              ? 'BASE'
              : storedStatus === 'LEAN'
                ? 'LEAN'
                : 'PASS',
          action:
            storedStatus === 'PLAY'
              ? 'FIRE'
              : storedStatus === 'LEAN'
                ? 'HOLD'
                : 'PASS',
          reason_source: 'canonical' as const,
        }
      : {
          ...baseDecision,
          reason_source: 'NON_CANONICAL_RENDER_FALLBACK' as const,
        };
  const market_key = buildMarketKey(
    resolvedMarketType,
    normalizeSideForCanonicalMarket(
      resolvedMarketType,
      normalizeSideToken(direction),
    ),
  );
  let candidateBet: CanonicalBet | null = null;
  const betMarketType = mapCanonicalToBetMarketType(resolvedMarketType);
  const betSide = mapDirectionToBetSide(direction);
  if (
    betMarketType &&
    betSide &&
    typeof price === 'number' &&
    pick !== 'NO PLAY'
  ) {
    candidateBet = {
      market_type: betMarketType,
      side: betSide,
      line,
      odds_american: price,
      as_of_iso: game.odds?.capturedAt || game.createdAt,
    };
  }

  if (
    candidateBet &&
    !validateCanonicalBet(candidateBet) &&
    (sourceAction === 'FIRE' || sourceAction === 'HOLD')
  ) {
    reasonCodes.push('PASS_DATA_ERROR');
    candidateBet = null;
  }

  const oppositeSelectedDirection = OPPOSITE_DIRECTION[direction];
  const directionalDrivers = drivers.filter(
    (driver) => driver.direction !== 'NEUTRAL',
  );
  const scoreDriver = (driver: DriverRow): number => {
    const conf =
      typeof driver.confidence === 'number' ? clamp01(driver.confidence) : 0.6;
    return TIER_SCORE[driver.tier] * conf;
  };
  const proDriverScores = directionalDrivers
    .filter((driver) => driver.direction === direction)
    .map(scoreDriver)
    .sort((a, b) => b - a);
  const contraDriverScores = oppositeSelectedDirection
    ? directionalDrivers
        .filter((driver) => driver.direction === oppositeSelectedDirection)
        .map(scoreDriver)
        .sort((a, b) => b - a)
    : [];
  const topProScore = proDriverScores[0] ?? 0;
  const strongProCount = proDriverScores.filter((score) => score >= 0.6).length;
  const strongContraCount = contraDriverScores.filter(
    (score) => score >= 0.6,
  ).length;

  if (strongProCount < 2) reasonCodes.push('PASS_DRIVER_SUPPORT_WEAK');
  if (strongContraCount > 0) reasonCodes.push('PASS_DRIVER_CONFLICT');

  const edgePct = typeof edge === 'number' ? edge : null;
  const edgeTier = edgePct === null ? 'BAD' : edgeTierFromPct(edgePct);
  const valueScore =
    edgeTier === 'BEST'
      ? 1
      : edgeTier === 'GOOD'
        ? 0.8
        : edgeTier === 'OK'
          ? 0.6
          : 0.2;
  const missingCoreDataPenalty =
    (candidateBet ? 0 : 0.2) +
    (typeof price === 'number' ? 0 : 0.1) +
    (resolvedMarketType === 'MONEYLINE' ||
    resolvedMarketType === 'PROP' ||
    typeof line === 'number'
      ? 0
      : 0.1);
  const coverageScore = clamp01(
    0.45 +
      (strongProCount >= 2 ? 0.2 : 0) +
      (linkedEvidence.length > 0 ? 0.1 : 0) +
      (hasExplicitTotalsConsistencyBlock ? -0.15 : 0) -
      missingCoreDataPenalty,
  );
  const modelScore =
    0.45 * clamp01(truthStrength) + 0.35 * valueScore + 0.2 * coverageScore;

  let scoreDecision: DecisionLabel = 'PASS';
  if (modelScore >= 0.7) scoreDecision = 'FIRE';
  else if (modelScore >= 0.55) scoreDecision = 'WATCH';

  if (truthStatus === 'WEAK' || valueStatus === 'BAD') {
    if (scoreDecision === 'FIRE') scoreDecision = 'WATCH';
  }
  if (strongProCount < 2 || topProScore < 0.6 || strongContraCount > 0) {
    if (scoreDecision === 'FIRE') scoreDecision = 'WATCH';
  }

  const longshotOdds = typeof price === 'number' && price >= 400;
  const longshotGuardPassed =
    truthStatus === 'STRONG' && (edgePct ?? -1) >= 0.06 && strongProCount >= 2;
  if (longshotOdds && !longshotGuardPassed) {
    reasonCodes.push('PASS_LONGSHOT_GUARD');
    if (scoreDecision === 'FIRE') scoreDecision = 'WATCH';
  }

  let reasonCodesUnique = Array.from(new Set(reasonCodes));
  const gates: CanonicalGate[] = [];
  const gateCodes = new Set<string>();
  const sourceExecutionGateShouldBet =
    sourcePlay?.execution_gate?.should_bet === true;
  const sourceStoredActionable =
    sourceAction === 'FIRE' || sourceAction === 'HOLD';
  const nonBlockingReasonCodes = new Set<string>([
    'PASS_DRIVER_SUPPORT_WEAK',
    'PASS_DRIVER_CONFLICT',
  ]);
  if (sourceStoredActionable && sourceExecutionGateShouldBet) {
    // Legacy MLB degraded-total cards can carry this diagnostic while the
    // worker execution gate still marks the LEAN executable. In that case the
    // stored action/gate owns actionability; keep the code visible as context
    // without removing the bet.
    nonBlockingReasonCodes.add('PASS_CONFIDENCE_GATE');
  }
  for (const code of reasonCodesUnique) {
    if (nonBlockingReasonCodes.has(code)) {
      gates.push({ code, severity: 'WARN', blocks_bet: false });
      continue;
    }
    if (
      code.startsWith('PASS_') ||
      code === 'NO_VALUE_AT_PRICE' ||
      code === 'PRICE_TOO_STEEP' ||
      code === 'MISSING_PRICE_EDGE'
    ) {
      gateCodes.add(code);
    }
  }
  if (hasExplicitTotalsConsistencyBlock) gateCodes.add('TOTALS_BLOCKED');
  if (longshotOdds && !longshotGuardPassed)
    gateCodes.add('PASS_LONGSHOT_GUARD');

  for (const code of gateCodes) {
    gates.push({ code, severity: 'BLOCK', blocks_bet: true });
  }

  // WI-0333: Coinflip detection - require BOTH market odds AND model fair_prob ~50%
  const marketCoinflip =
    resolvedMarketType === 'MONEYLINE' &&
    typeof game.odds?.h2hHome === 'number' &&
    typeof game.odds?.h2hAway === 'number' &&
    Math.abs(game.odds.h2hHome) <= 120 &&
    Math.abs(game.odds.h2hAway) <= 120;
  const modelFairProb = modelProb;
  const modelCoinflip = typeof modelFairProb === 'number' && modelFairProb >= 0.45 && modelFairProb <= 0.55;
  const coinflip = marketCoinflip && modelCoinflip;
  const mispricing = marketCoinflip && !modelCoinflip; // Market says coinflip, model has conviction
  
  if (coinflip) {
    gates.push({ code: 'COINFLIP', severity: 'WARN', blocks_bet: false });
  }
  if (mispricing && typeof edge === 'number' && edge > 0.05) {
    // Tag as mispricing opportunity, not coinflip
    if (!tags.includes('MISPRICING')) {
      tags.push('MISPRICING');
    }
  }

  const decisionAction =
    decision.action === 'FIRE' ||
    decision.action === 'HOLD' ||
    decision.action === 'PASS'
      ? decision.action
      : 'PASS';
  const canonicalTruePlayStatus = canonicalTruePlay
    ? resolveCanonicalOfficialStatus(canonicalTruePlay)
    : null;
  let finalDecision: DecisionLabel = decisionFromAction(decisionAction);
  if (sourceExplicitPass) {
    finalDecision = 'PASS';
  }
  
  // WI-DECISION-FIX: Edge is the master gate
  // If edge < 1%, force PASS regardless of other signals
  const hasMinimumEdge = typeof edge === 'number' && edge >= 0.01;
  if (!hasMinimumEdge && typeof edge === 'number') {
    finalDecision = 'PASS';
    reasonCodesUnique.push('PASS_INSUFFICIENT_EDGE');
  } else {
    // Only allow scoreDecision to affect decision if edge gate passes and
    // the source record did not already resolve to explicit PASS.
    if (!sourceExplicitPass) {
      if (scoreDecision === 'PASS') finalDecision = 'PASS';
      if (scoreDecision === 'WATCH' && finalDecision === 'FIRE')
        finalDecision = 'WATCH';
      if (scoreDecision === 'FIRE') finalDecision = 'FIRE';
    }
  }
  if (
    sourceAction === 'FIRE' &&
    !hardPass &&
    !hasExplicitTotalsConsistencyBlock
  ) {
    finalDecision = 'FIRE';
  } else if (
    sourceAction === 'HOLD' &&
    !hardPass &&
    !hasExplicitTotalsConsistencyBlock &&
    finalDecision === 'PASS'
  ) {
    finalDecision = 'WATCH';
  }
  if (
    !hardPass &&
    !hasExplicitTotalsConsistencyBlock &&
    (canonicalTruePlayStatus === 'PLAY' || canonicalTruePlayStatus === 'LEAN')
  ) {
    finalDecision = canonicalTruePlayStatus === 'PLAY' ? 'FIRE' : 'WATCH';
  }
  if (
    !hardPass &&
    !hasExplicitTotalsConsistencyBlock &&
    moneylineExecutionActionOverride
  ) {
    finalDecision = decisionFromAction(moneylineExecutionActionOverride);
  }
  if (hardPass) finalDecision = 'PASS';

  // Canonical NHL totals status must come from worker payload only.
  const isNhlTotalsCard =
    normalizeSport(game.sport) === 'NHL' &&
    (sourcePlay?.cardType === 'nhl-totals-call' ||
      resolvedMarketType === 'TOTAL');
  const canonicalNhlTotalsStatus = sourcePlay?.nhl_totals_status?.status;
  if (isNhlTotalsCard && canonicalNhlTotalsStatus) {
    if (canonicalNhlTotalsStatus === 'PLAY' && !hardPass) {
      finalDecision = 'FIRE';
    } else if (canonicalNhlTotalsStatus === 'SLIGHT EDGE' && finalDecision !== 'PASS') {
      finalDecision = 'WATCH';
    } else if (canonicalNhlTotalsStatus === 'PASS') {
      finalDecision = 'PASS';
    }
  }

  const hasBlockingGate = gates.some((gate) => gate.blocks_bet);
  let finalBet = candidateBet;
  if (betAction === 'NO_PLAY') finalBet = null;
  
  // WI-DECISION-FIX: Don't remove bet for proxy-capped plays with positive edge
  const proxyTriggeredEarly = tags.some((tag) => PROXY_SIGNAL_TAGS.has(tag));
  const hasPositiveEdge = typeof edge === 'number' && edge >= 0.01;
  const shouldKeepBetDespiteGates = proxyTriggeredEarly && hasPositiveEdge && finalBet && decision.classification !== 'LEAN';
  
  if (hasBlockingGate && !shouldKeepBetDespiteGates) {
    finalBet = null;
    if (finalDecision !== 'PASS') finalDecision = 'WATCH';
  }
  if (moneylineExecutionActionOverride === 'PASS') {
    finalBet = null;
    finalDecision = 'PASS';
  }
  if (!finalBet && finalDecision === 'FIRE') {
    finalDecision = 'WATCH';
  }
  if (!finalBet && hardPass) {
    finalDecision = 'PASS';
  }

  if (hasPlaceholderText(whyText)) {
    placeholderMatches.add('why_text');
  }
  const missingInputs = new Set<string>();
  if (!sourcePlay) missingInputs.add('play');
  if (!game.odds?.capturedAt) missingInputs.add('odds_timestamp');
  if (directionalDrivers.length === 0) missingInputs.add('drivers');
  if (finalDecision === 'FIRE' && !finalBet) missingInputs.add('bet');
  if (finalBet && requiresModelProbForEdge && modelProb === undefined)
    missingInputs.add('model_prob');

  let quality: CardQuality = 'OK';
  const placeholdersFound = Array.from(placeholderMatches);
  const hasFatalInputGap =
    missingInputs.has('drivers') ||
    missingInputs.has('model_prob') ||
    missingInputs.has('play');
  if (placeholdersFound.length > 0 || hasFatalInputGap) {
    quality = 'BROKEN';
  } else if (missingInputs.size > 0) {
    quality = 'DEGRADED';
  }

  if (quality === 'DEGRADED' && finalDecision === 'FIRE') {
    finalDecision = 'WATCH';
  }

  if (quality === 'BROKEN') {
    const brokenCodes = ['PASS_DATA_ERROR'];
    if (missingInputs.has('drivers')) {
      brokenCodes.push('MISSING_DATA_DRIVERS');
    }
    reasonCodesUnique = Array.from(
      new Set([...reasonCodesUnique, ...brokenCodes]),
    );
    gateCodes.add('PASS_DATA_ERROR');
    finalBet = null;
    finalDecision = 'PASS';
    pick = 'NO PLAY';
  }

  const preGuardDecision = finalDecision;
  const preGuardHasBet = Boolean(finalBet);
  const edgeSanityTriggered =
    typeof edge === 'number' &&
    edge > EDGE_SANITY_NON_TOTAL_THRESHOLD &&
    resolvedMarketType !== 'TOTAL' &&
    resolvedMarketType !== 'TEAM_TOTAL';
  const proxyTriggered = tags.some((tag) => PROXY_SIGNAL_TAGS.has(tag));

  if (edgeSanityTriggered) {
    tags.push(EDGE_VERIFICATION_TAG);
    gateCodes.add(EDGE_SANITY_GATE_CODE);
  }
  if (proxyTriggered) {
    tags.push('PROXY_CARD');
    // WI-DECISION-FIX: Only add blocking gate if no positive edge
    if (!hasMinimumEdge) {
      gateCodes.add(PROXY_CAP_GATE_CODE);
    }
  }

  // WI-DECISION-FIX: Edge sanity adds gate but may remove bet depending on decision
  if (edgeSanityTriggered && proxyTriggered) {
    // Both gates triggered - only PASS if edge insufficient
    if (!hasMinimumEdge) {
      finalDecision = 'PASS';
      reasonCodesUnique.push('PASS_PROXY_EDGE_SANITY_COMBO');
      finalBet = null;
    } else {
      // Both triggered but edge is good: degrade to WATCH and block bet for verification
      finalDecision = 'WATCH';
      reasonCodesUnique.push('DOWNGRADED_PROXY_EDGE_SANITY_COMBO');
      reasonCodesUnique.push('BLOCKED_BET_VERIFICATION_REQUIRED');
      finalBet = null;
    }
  } else if (edgeSanityTriggered) {
    // Edge sanity always removes bet (the gate blocks execution)
    finalBet = null;
    if (finalDecision === 'PASS') {
      reasonCodesUnique.push('PASS_EDGE_SANITY_NON_TOTAL');
    } else if (finalDecision === 'WATCH') {
      // WATCH with edge sanity remains WATCH, but bet is blocked pending verification
      reasonCodesUnique.push('DOWNGRADED_EDGE_SANITY_NON_TOTAL');
      reasonCodesUnique.push('BLOCKED_BET_VERIFICATION_REQUIRED');
    } else if (finalDecision === 'FIRE') {
      // FIRE with edge sanity downgrades to WATCH and blocks bet pending verification
      finalDecision = 'WATCH';
      reasonCodesUnique.push('DOWNGRADED_EDGE_SANITY_NON_TOTAL');
      reasonCodesUnique.push('BLOCKED_BET_VERIFICATION_REQUIRED');
    }
  } else if (proxyTriggered) {
    // WI-DECISION-FIX: Proxy cap downgrades tier (FIRE→WATCH) but keeps bet recommendation
    const hasStrongSignal =
      truthStrength >= 0.62 && quality !== 'BROKEN' && !edgeSanityTriggered;
    
    if (finalDecision === 'FIRE') {
      // FIRE with proxy → downgrade to WATCH but KEEP bet
      finalDecision = 'WATCH';
      reasonCodesUnique.push('DOWNGRADED_PROXY_CAPPED');
    } else if (finalDecision === 'WATCH' && !hasStrongSignal) {
      // WATCH with weak signal + proxy → PASS and remove bet
      finalDecision = 'PASS';
      finalBet = null;
      reasonCodesUnique.push('PASS_PROXY_CAPPED');
    }
  }

  if (preGuardDecision === 'FIRE' && finalDecision === 'WATCH') {
    tags.push('OUTCOME_FIRE_TO_WATCH');
  }
  if (preGuardDecision === 'WATCH' && finalDecision === 'PASS') {
    tags.push('OUTCOME_WATCH_TO_PASS');
  }
  if (preGuardDecision === 'FIRE' && finalDecision === 'PASS') {
    tags.push('OUTCOME_FIRE_TO_PASS');
  }
  if (preGuardHasBet && !finalBet) {
    tags.push('OUTCOME_BET_REMOVED');
  }

  for (const code of gateCodes) {
    if (!gates.some((gate) => gate.code === code)) {
      gates.push({ code, severity: 'BLOCK', blocks_bet: true });
    }
  }

  const finalAction = actionFromDecision(finalDecision);
  const finalClassificationLabel =
    decisionClassificationFromAction(finalAction);
  const resolvedDisplayDecision = resolvePlayDisplayDecision({
    action: finalAction,
    classification:
      finalAction === 'FIRE'
        ? 'BASE'
        : finalAction === 'HOLD'
          ? 'LEAN'
          : 'PASS',
  });

  const pickWithContext = pick;
  if (!finalBet) {
    pick = 'NO PLAY';
  }
  const finalBetAction: 'BET' | 'NO_PLAY' = finalBet ? 'BET' : 'NO_PLAY';
  if (
    finalBetAction === 'NO_PLAY' &&
    edgeSanityTriggered &&
    pickWithContext &&
    pickWithContext !== 'NO PLAY'
  ) {
    pick = `${pickWithContext} (Verification Required)`;
  }
  reasonCodesUnique = Array.from(new Set(reasonCodesUnique));
  const dedupedTags = Array.from(new Set(tags));
  const passReasonCode =
    reasonCodesUnique.find((code) => code.startsWith('PASS_')) ?? null;
  const sourcePassReasonCode = normalizePassReasonCode(
    decision.play?.pass_reason_code ?? null,
  );
  const resolvedPassReasonCode =
    finalDecision === 'PASS'
      ? (sourcePassReasonCode ??
        passReasonCode ??
        gates.find((gate) => gate.blocks_bet)?.code ??
        null)
      : null;
  const decisionReasonCode =
    finalDecision === 'PASS'
      ? (resolvedPassReasonCode ?? whyCode)
      : edgeSanityTriggered && finalDecision === 'WATCH'
        ? 'DOWNGRADED_EDGE_SANITY_NON_TOTAL'
        : proxyTriggered && finalDecision === 'WATCH'
          ? PROXY_CAP_GATE_CODE
          : whyCode;
  const decisionData: DecisionData = {
    status: finalDecision,
    truth: truthStatus,
    value_tier: valueStatus,
    edge_pct: edgePct,
    edge_tier: edgeTier,
    coinflip,
    reason_code: decisionReasonCode,
  };

  return {
    market_key,
    decision: finalDecision,
    classificationLabel: finalClassificationLabel,
    bet: finalBet,
    gates,
    decision_data: decisionData,
    transform_meta: {
      quality,
      missing_inputs: Array.from(missingInputs),
      placeholders_found: placeholdersFound,
      drop_reason: resolvePlayDropReason(
        propPlay ?? spreadPlay ?? totalPlay ?? scopedPlayCandidates[0],
      ),
    },
    market_type: resolvedMarketType,
    kind: 'PLAY',
    evidence_count: linkedEvidence.length,
    consistency: {
      total_bias: totalBias,
    },
    selection:
      resolvedMarketType === 'PROP' && propPlay?.selection?.side
        ? {
            side: propPlay.selection.side as SelectionSide,
            team: propPlay.selection.team,
          }
        : direction === 'HOME' ||
            direction === 'AWAY' ||
            direction === 'OVER' ||
            direction === 'UNDER'
          ? {
              side: direction as SelectionSide,
              team:
                direction === 'HOME'
                  ? game.homeTeam
                  : direction === 'AWAY'
                    ? game.awayTeam
                    : undefined,
            }
          : undefined,
    reason_codes: reasonCodesUnique,
    tags: dedupedTags,
    execution_status: sourcePlay?.execution_status,
    reason_source: decision.reason_source,
    // Canonical fields (preferred)
    classification: resolvedDisplayDecision.classification,
    action: resolvedDisplayDecision.action,
    pass_reason_code: resolvedPassReasonCode,
    final_market_decision: buildFinalMarketDecision({
      decisionV2: sourcePlay?.decision_v2,
      fallbackOfficialStatus:
        resolvedDisplayDecision.action === 'FIRE'
          ? 'PLAY'
          : resolvedDisplayDecision.action === 'HOLD'
            ? 'LEAN'
            : 'PASS',
      reasonCodes: reasonCodesUnique,
      passReasonCode: resolvedPassReasonCode,
      edge: edgePct,
      goalieHomeStatus: sourcePlay?.goalie_home_status,
      goalieAwayStatus: sourcePlay?.goalie_away_status,
    }),
    market,
    pick,
    lean:
      resolvedMarketType === 'PROP' && propPlay?.selection?.team
        ? propPlay.selection.team
        : direction === 'HOME'
          ? game.homeTeam
          : direction === 'AWAY'
            ? game.awayTeam
            : direction,
    side: direction,
    truthStatus,
    truthStrength,
    conflict,
    modelProb,
    impliedProb,
    edge,
    projectedTotal,
    projectedTotalLow,
    projectedTotalHigh,
    projectedHomeF5Runs,
    projectedAwayF5Runs,
    projectionSource: sourcePlay?.projection_source ?? undefined,
    statusCap: sourcePlay?.status_cap ?? undefined,
    playability: sourcePlay?.playability ?? undefined,
    valueStatus,
    betAction: finalBetAction,
    priceFlags,
    line,
    price,
    updatedAt: game.odds?.capturedAt || game.createdAt,
    whyCode,
    whyText,
  };
}

/**
 * Transform GameData to normalized GameCard with deduped drivers and canonical Play
 */
export function transformToGameCard(game: GameData): GameCard {
  // Convert plays to drivers and dedupe
  // Keep game-mode driver/truth calculations scoped to non-prop markets.
  const rawDrivers = game.plays
    .filter((play) => isRenderableGameSurfacePlay(game, play))
    .map(playToDriver);
  const scopedRawDrivers = ENABLE_WELCOME_HOME
    ? rawDrivers
    : rawDrivers.filter((driver) => isWelcomeHomeCardType(driver.cardType) === false);
  const drivers = deduplicateDrivers(scopedRawDrivers);
  const evidenceSource = ENABLE_WELCOME_HOME
    ? game.plays.filter((play) => isEvidenceItem(play, game.sport))
    : game.plays.filter(
        (play) =>
          !isWelcomeHomePlay(play) && isEvidenceItem(play, game.sport),
      );
  const evidence: EvidenceItem[] = evidenceSource.map((play, index) => ({
    id: `${game.gameId}:evidence:${play.driverKey || play.cardType || index}`,
    cardType: play.cardType,
    cardTitle: play.cardTitle,
    reasoning: play.reasoning,
    driverKey: play.driverKey,
    selection: play.selection?.side
      ? {
          side: play.selection.side as
            | 'OVER'
            | 'UNDER'
            | 'HOME'
            | 'AWAY'
            | 'FAV'
            | 'DOG'
            | 'NONE',
          team: play.selection.team,
        }
      : undefined,
    aggregation_key: play.aggregation_key,
    evidence_for_play_id: play.evidence_for_play_id,
  }));

  // Build canonical play object
  const play = buildPlay(game, drivers);

  // Determine updatedAt (prefer odds captured_at over created_at)
  const updatedAt = game.odds?.capturedAt || game.createdAt;
  const normalizedSport = normalizeSport(game.sport);
  const initialTags = normalizedSport === 'UNKNOWN' ? ['unknown_sport'] : [];

  // Collect market signal data from odds snapshot (populated after WI-0666/0667)
  const marketSignals = game.odds
    ? {
        publicBetsPctHome: game.odds.publicBetsPctHome ?? null,
        publicBetsPctAway: game.odds.publicBetsPctAway ?? null,
        publicHandlePctHome: game.odds.publicHandlePctHome ?? null,
        publicHandlePctAway: game.odds.publicHandlePctAway ?? null,
        splitsSource: game.odds.splitsSource ?? null,
        spreadConsensusConfidence: game.odds.spreadConsensusConfidence ?? null,
      }
    : undefined;

  return {
    id: game.id,
    gameId: game.gameId,
    sport: normalizedSport,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    startTime: game.gameTimeUtc,
    updatedAt,
    status: game.status,
    markets: buildMarkets(game.odds),
    play,
    drivers,
    evidence,
    tags: initialTags,
    marketSignals,
  };
}

function cardDecisionRank(card: GameCard): number {
  const decision = card.play?.decision;
  if (decision === 'FIRE') return 3;
  if (decision === 'WATCH') return 2;
  if (decision === 'PASS') return 1;
  const action = card.play?.action;
  if (action === 'FIRE') return 3;
  if (action === 'HOLD') return 2;
  return 1;
}

function cardValueRank(card: GameCard): number {
  const value = card.play?.valueStatus;
  if (value === 'GOOD') return 3;
  if (value === 'OK') return 2;
  if (value === 'BAD') return 1;
  return 0;
}

function toEpochMs(value?: string): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function compareCardsForDedupe(next: GameCard, current: GameCard): number {
  const nextHasBet = Boolean(next.play?.bet);
  const currentHasBet = Boolean(current.play?.bet);
  if (nextHasBet !== currentHasBet) return nextHasBet ? 1 : -1;

  const decisionDelta = cardDecisionRank(next) - cardDecisionRank(current);
  if (decisionDelta !== 0) return decisionDelta;

  const valueDelta = cardValueRank(next) - cardValueRank(current);
  if (valueDelta !== 0) return valueDelta;

  const updatedDelta =
    toEpochMs(next.play?.updatedAt ?? next.updatedAt) -
    toEpochMs(current.play?.updatedAt ?? current.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;

  const edgeDelta =
    (typeof next.play?.edge === 'number' ? next.play.edge : -Infinity) -
    (typeof current.play?.edge === 'number' ? current.play.edge : -Infinity);
  if (edgeDelta !== 0) return edgeDelta;

  // Stable tie-break so dedupe selection does not depend on map insertion order.
  return next.id.localeCompare(current.id);
}

function getCardMarketKey(card: GameCard): string {
  if (card.play?.market_key) return card.play.market_key;
  const side = normalizeSideToken(
    card.play?.selection?.side ?? card.play?.side ?? 'NONE',
  );
  if (card.play?.market_type)
    return buildMarketKey(card.play.market_type, side);
  const canonical =
    card.play?.market === 'ML'
      ? 'MONEYLINE'
      : card.play?.market === 'SPREAD'
        ? 'SPREAD'
        : card.play?.market === 'TOTAL'
          ? 'TOTAL'
          : 'INFO';
  return buildMarketKey(canonical as CanonicalMarketType, side);
}

function dedupeCardsByGameMarket(cards: GameCard[]): GameCard[] {
  const byKey = new Map<string, GameCard>();
  for (const card of cards) {
    const dedupeKey = `${card.sport}|${card.gameId}|${getCardMarketKey(card)}`;
    const existing = byKey.get(dedupeKey);
    if (!existing || compareCardsForDedupe(card, existing) > 0) {
      byKey.set(dedupeKey, card);
    }
  }
  return Array.from(byKey.values());
}

type ContractReport = {
  fire_with_no_bet: string[];
  play_with_no_bet: string[];
  blocked_with_bet: string[];
  coinflip_non_ml: string[];
  edge_repeated_value_counts: Array<{ edge: string; count: number }>;
};

function buildContractReport(cards: GameCard[]): ContractReport {
  const fire_with_no_bet: string[] = [];
  const play_with_no_bet: string[] = [];
  const blocked_with_bet: string[] = [];
  const coinflip_non_ml: string[] = [];
  const edgeCounts = new Map<string, number>();

  try {
    for (const card of cards) {
      const play = card.play;
      if (!play) continue;

      try {
        const key = `${card.gameId}:${play.market_key ?? getCardMarketKey(card)}`;
        const hasBet = Boolean(play.bet);
        const hasBlockingGate = (play.gates ?? []).some((gate) => gate.blocks_bet);
        const decision =
          play.decision ??
          (play.action === 'FIRE'
            ? 'FIRE'
            : play.action === 'HOLD'
              ? 'WATCH'
              : 'PASS');
        const classification =
          play.classificationLabel ??
          (play.classification === 'BASE'
            ? 'PLAY'
            : play.classification === 'LEAN'
              ? 'LEAN'
              : 'NONE');

        if (decision === 'FIRE' && !hasBet) fire_with_no_bet.push(key);
        if (classification === 'PLAY' && !hasBet) play_with_no_bet.push(key);
        if (hasBlockingGate && hasBet) blocked_with_bet.push(key);

        // Defensive check: ensure priceFlags is an array before calling includes
        const priceFlags = Array.isArray(play.priceFlags) ? play.priceFlags : [];
        if (priceFlags.includes('COINFLIP') && play.market !== 'ML')
          coinflip_non_ml.push(key);

        if (typeof play.edge === 'number' && Number.isFinite(play.edge)) {
          const edgeKey = (play.edge * 100).toFixed(1);
          edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) ?? 0) + 1);
        }
      } catch (cardError) {
        // Skip cards with processing errors instead of crashing the report
        console.warn(
          '[buildContractReport] Failed to process card',
          card.gameId,
          cardError,
        );
        continue;
      }
    }
  } catch (loopError) {
    console.warn('[buildContractReport] Error during cards loop:', loopError);
  }

  const edge_repeated_value_counts = Array.from(edgeCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([edge, count]) => ({ edge, count }));

  return {
    fire_with_no_bet,
    play_with_no_bet,
    blocked_with_bet,
    coinflip_non_ml,
    edge_repeated_value_counts,
  };
}

function assertContractInDev(cards: GameCard[]): void {
  if (process.env.NODE_ENV === 'production') return;

  let report: ContractReport | null = null;

  try {
    report = buildContractReport(cards);
  } catch (error) {
    console.error(
      '[cards-contract-report] FATAL: Failed to build report:',
      error instanceof Error ? error.message : String(error),
    );
    console.error('[cards-contract-report] Error stack:', error);
    // Still throw so we catch the issue
    throw new Error(
      'Game card transform failed to build contract report. See console for details.',
    );
  }

  if (!report) {
    console.error('[cards-contract-report] FATAL: Report is null after build');
    throw new Error('Contract report build returned null');
  }

  let hasHardFailure = false;
  try {
    hasHardFailure =
      (report.fire_with_no_bet?.length ?? 0) > 0 ||
      (report.play_with_no_bet?.length ?? 0) > 0 ||
      (report.blocked_with_bet?.length ?? 0) > 0 ||
      (report.coinflip_non_ml?.length ?? 0) > 0;
  } catch (failureError) {
    console.error(
      '[cards-contract-report] FATAL: Error checking hasHardFailure:',
      failureError,
    );
    throw failureError;
  }

  if (hasHardFailure) {
    console.error('[cards-contract-report]', JSON.stringify(report, null, 2));
    console.error('[cards-contract-details] fire_with_no_bet:', report.fire_with_no_bet);
    console.error('[cards-contract-details] play_with_no_bet:', report.play_with_no_bet);
    console.error('[cards-contract-details] blocked_with_bet:', report.blocked_with_bet);
    console.error('[cards-contract-details] coinflip_non_ml:', report.coinflip_non_ml);
    console.error(
      '[cards-contract-debug] Total cards processed:',
      cards.length,
    );
    console.error(
      '[cards-contract-debug] Cards with plays:',
      cards.filter((c) => !!c.play).length,
    );
    throw new Error(
      'Game card transform contract violation. See [cards-contract-report] for offending game_ids.',
    );
  }

  console.info('[cards-contract-report]', report);
}

/**
 * Transform array of GameData to GameCard[]
 */
export function transformGames(games: GameData[]): GameCard[] {
  const transformed = games
    .filter((game) => !shouldExcludeProjectionOnlyGameSurface(game))
    .map(transformToGameCard);
  const deduped = dedupeCardsByGameMarket(transformed);
  assertContractInDev(deduped);
  return deduped;
}

function isPlaceholderPlayerName(value?: string | null): boolean {
  if (!value) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower === 'unknown player' ||
    lower === 'player' ||
    /^player\s*#?\d+$/i.test(trimmed)
  );
}

function extractPlayerId(play: ApiPlay): string {
  if (play.player_id) return String(play.player_id);

  const selectionTeam = play.selection?.team;
  if (selectionTeam) {
    const idMatch = selectionTeam.match(/#(\d+)/);
    if (idMatch?.[1]) return idMatch[1];
  }

  return selectionTeam || 'unknown';
}

function inferPlayerNameFromText(play: ApiPlay): string | undefined {
  const fromPayload = play.player_name;
  if (fromPayload && !isPlaceholderPlayerName(fromPayload)) {
    return fromPayload;
  }

  const selectionTeam = play.selection?.team;
  if (selectionTeam && !isPlaceholderPlayerName(selectionTeam)) {
    return selectionTeam;
  }

  const title = play.cardTitle || '';
  const titlePatterns = [
    /shots\s+on\s+goal\s*[-:]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(?:shots\s+on\s+goal|sog|over|under)/i,
    /player\s+prop\s*[-:]\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/i,
  ];

  for (const pattern of titlePatterns) {
    const match = title.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && !isPlaceholderPlayerName(candidate)) {
      return candidate;
    }
  }

  const reasoning = play.reasoning || '';
  const reasoningMatch = reasoning.match(
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/,
  );
  const reasoningCandidate = reasoningMatch?.[1]?.trim();
  if (reasoningCandidate && !isPlaceholderPlayerName(reasoningCandidate)) {
    return reasoningCandidate;
  }

  return undefined;
}

const PROP_VERDICT_RANK: Record<
  NonNullable<PropPlayRow['propVerdict']>,
  number
> = {
  PLAY: 4,
  WATCH: 3,
  NO_PLAY: 2,
  PROJECTION: 1,
};

function isProjectionOnlyPropPlay(
  play: ApiPlay,
  propDecision?: ApiPropDecision | null,
): boolean {
  if (propDecision?.projection_source === 'SYNTHETIC_FALLBACK') {
    return true;
  }
  return isProjectionOnlyCardPlay(play);
}

function normalizePropVerdict(
  play: ApiPlay,
  propDecision?: ApiPropDecision | null,
): PropPlayRow['propVerdict'] {
  const rawVerdict = propDecision?.verdict;
  const statusCap = propDecision?.status_cap ?? play.status_cap ?? null;

  if (isProjectionOnlyPropPlay(play, propDecision)) {
    return 'PROJECTION';
  }

  if (statusCap === 'PASS' && (rawVerdict === 'PLAY' || rawVerdict === 'WATCH')) {
    return 'NO_PLAY';
  }

  if (
    rawVerdict === 'PLAY' ||
    rawVerdict === 'WATCH' ||
    rawVerdict === 'PROJECTION'
  ) {
    return rawVerdict;
  }

  if (rawVerdict === 'PASS') {
    return 'NO_PLAY';
  }

  if (play.prop_display_state === 'PLAY') {
    return 'PLAY';
  }

  if (play.prop_display_state === 'WATCH') {
    return 'WATCH';
  }

  if (play.prop_display_state === 'PROJECTION_ONLY') {
    return 'PROJECTION';
  }

  return undefined;
}

function normalizePropDedupeName(name: string | undefined): string {
  if (!name) return '';
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildPropRowDedupeKey(row: PropPlayRow): string {
  const normalizedName = normalizePropDedupeName(row.playerName);
  const identity = normalizedName || row.playerId || '';
  return `${identity}|${row.propType}`;
}

function dedupePropPlayRows(rows: PropPlayRow[]): PropPlayRow[] {
  const deduped: PropPlayRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const rowKey = buildPropRowDedupeKey(row);
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    deduped.push(row);
  }
  return deduped;
}

function normalizeMatchupKeyPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function buildPropGameMatchupKey(card: PropGameCard): string {
  return [
    card.sport,
    card.gameTimeUtc,
    normalizeMatchupKeyPart(card.homeTeam),
    normalizeMatchupKeyPart(card.awayTeam),
  ].join('|');
}

/**
 * Transform games to PropGameCard format - for player props view
 * Groups all PROP plays under each game as rows
 */
export function transformPropGames(games: GameData[]): PropGameCard[] {
  const propGames: PropGameCard[] = [];
  const playerNameById = new Map<string, string>();

  for (const game of games) {
    for (const play of game.plays) {
      if (play.market_type !== 'PROP') continue;
      const playerId = extractPlayerId(play);
      const inferredName = inferPlayerNameFromText(play);
      if (playerId && inferredName) {
        playerNameById.set(playerId, inferredName);
      }
    }
  }

  for (const game of games) {
    // Extract all PROP plays from this game.
    // PROJECTION_ONLY plays are intentionally included — normalizePropVerdict converts
    // them to propVerdict='PROJECTION' / status='NO_PLAY' so they render as projections
    // in the Player Props tab. Filtering them here would leave the tab empty whenever
    // the model runs without live prop line prices (common during the day).
    const propPlays = game.plays.filter(
      (p) => p.market_type === 'PROP',
    );

    // Skip games with no props
    if (propPlays.length === 0) continue;

    // Convert each play to a PropPlayRow
    const propPlayRows: PropPlayRow[] = propPlays.map((play) => {
      const playerId = extractPlayerId(play);
      const inferredName = inferPlayerNameFromText(play);
      const mappedName = playerNameById.get(playerId);
      const playerName = inferredName || mappedName || 'Unknown Player';

      // Infer prop type from card title or type
      let propType = 'Unknown';
      const titleLower = (play.cardTitle || '').toLowerCase();
      const canonicalMarketKey = String(
        (play as unknown as Record<string, unknown>).canonical_market_key || '',
      ).toLowerCase();
      if (canonicalMarketKey === 'player_shots') {
        propType = 'Shots';
      } else if (canonicalMarketKey === 'player_blocked_shots') {
        propType = 'Blocked Shots';
      } else if (canonicalMarketKey === 'player_shots_on_target') {
        propType = 'Shots on Goal';
      } else if (canonicalMarketKey === 'to_score_or_assist') {
        propType = 'To Score or Assist';
      } else if (canonicalMarketKey === 'pitcher_strikeouts' || titleLower.includes('strikeout')) {
        propType = 'Strikeouts';
      } else if (titleLower.includes('blocked shots') || play.cardType === 'nhl-player-blk') {
        propType = 'Blocked Shots';
      } else if (titleLower.includes('shots') || titleLower.includes('sog')) {
        propType = 'Shots on Goal';
      } else if (titleLower.includes('points')) {
        propType = 'Points';
      } else if (titleLower.includes('assists')) {
        propType = 'Assists';
      } else if (titleLower.includes('rebounds')) {
        propType = 'Rebounds';
      }

      const rawPropDecision = play.prop_decision;
      const rawPropDisplayState = play.prop_display_state;
      const propVerdict = normalizePropVerdict(play, rawPropDecision);

      let status: PropPlayRow['status'] = 'NO_PLAY';
      if (propVerdict === 'PLAY') {
        status = 'FIRE';
      } else if (propVerdict === 'WATCH') {
        status = 'WATCH';
      } else if (propVerdict === 'PROJECTION' || propVerdict === 'NO_PLAY') {
        status = 'NO_PLAY';
      } else {
        // Legacy fallback: no prop verdict fields and not projection-only/fallback.
        const resolvedAction = resolvePlayDisplayDecision({
          action: play.action,
        }).action;
        if (resolvedAction === 'FIRE') {
          status = 'FIRE';
        } else if (resolvedAction === 'HOLD') {
          status = play.action === 'HOLD' ? 'HOLD' : 'WATCH';
        } else {
          status = 'NO_PLAY';
        }
      }

      const canonicalPropProjection =
        typeof rawPropDecision?.k_mean === 'number'
          ? rawPropDecision.k_mean
          : typeof play.projection?.k_mean === 'number'
            ? play.projection.k_mean
            : typeof rawPropDecision?.projection === 'number'
              ? rawPropDecision.projection
              : play.mu ?? play.projectedTotal ?? null;
      const kMean =
        typeof rawPropDecision?.k_mean === 'number'
          ? rawPropDecision.k_mean
          : typeof play.projection?.k_mean === 'number'
            ? play.projection.k_mean
            : null;
      const probabilityLadder =
        rawPropDecision?.probability_ladder ??
        play.projection?.probability_ladder ??
        null;
      const fairPrices =
        rawPropDecision?.fair_prices ?? play.projection?.fair_prices ?? null;
      const playability =
        rawPropDecision?.playability ?? play.playability ?? null;
      const projectionSource =
        rawPropDecision?.projection_source ?? play.projection_source ?? null;
      const statusCap = rawPropDecision?.status_cap ?? play.status_cap ?? null;
      const missingInputs = normalizeMissingInputs(
        rawPropDecision?.missing_inputs ?? play.missing_inputs,
      );
      const passReasonCode =
        rawPropDecision?.pass_reason_code ?? play.pass_reason_code ?? null;
      const passReason =
        rawPropDecision?.pass_reason ?? play.pass_reason ?? null;
      const mu = canonicalPropProjection;
      const canonicalPropLine =
        typeof rawPropDecision?.line === 'number'
          ? rawPropDecision.line
          : typeof play.line === 'number'
            ? play.line
            : null;
      const suggestedLine = play.suggested_line ?? null;
      const edge =
        play.edge ??
        (mu !== null && canonicalPropLine !== null
          ? mu - canonicalPropLine
          : null);

      return {
        runId: play.run_id,
        createdAt: play.created_at,
        playerId,
        playerName,
        teamAbbr: play.team_abbr ?? undefined,
        gameId: game.gameId,
        propType,
        line: canonicalPropLine ?? play.suggested_line ?? null,
        projection: canonicalPropProjection,
        mu,
        kMean,
        probabilityLadder,
        fairPrices,
        suggestedLine,
        threshold: play.threshold ?? null,
        confidence: play.confidence ?? null,
        price: play.price ?? null,
        status,
        action: play.action,
        edge,
        isTrending: play.is_trending,
        roleGatePass: play.role_gate_pass,
        dataQuality: play.data_quality ?? null,
        reasonCodes: play.reason_codes,
        missingInputs: missingInputs.length > 0 ? missingInputs : undefined,
        projectionSource,
        statusCap,
        playability,
        passReasonCode,
        passReason,
        basis: play.basis,
        l5Sog: play.l5_sog ?? undefined,
        l5Mean: play.l5_mean ?? null,
        marketLine: canonicalPropLine,
        priceOver: play.market_price_over ?? null,
        priceUnder: play.market_price_under ?? null,
        bookmaker: play.market_bookmaker ?? null,
        sourceCardType: play.cardType,
        sourceCardTitle: play.cardTitle,
        updatedAtUtc: game.odds?.capturedAt || game.createdAt,
        reasoning: play.reasoning,
        propVerdict,
        leanSide:
          rawPropDecision?.lean_side === 'OVER' ||
          rawPropDecision?.lean_side === 'UNDER'
            ? rawPropDecision.lean_side
            : null,
        displayPrice:
          typeof rawPropDecision?.display_price === 'number'
            ? rawPropDecision.display_price
            : null,
        lineDelta:
          typeof rawPropDecision?.line_delta === 'number'
            ? rawPropDecision.line_delta
            : null,
        fairProb:
          typeof rawPropDecision?.fair_prob === 'number'
            ? rawPropDecision.fair_prob
            : null,
        impliedProb:
          typeof rawPropDecision?.implied_prob === 'number'
            ? rawPropDecision.implied_prob
            : null,
        probEdgePp:
          typeof rawPropDecision?.prob_edge_pp === 'number'
            ? rawPropDecision.prob_edge_pp
            : null,
        ev:
          typeof rawPropDecision?.ev === 'number' ? rawPropDecision.ev : null,
        l5Trend:
          rawPropDecision?.l5_trend === 'uptrend' ||
          rawPropDecision?.l5_trend === 'downtrend' ||
          rawPropDecision?.l5_trend === 'stable'
            ? rawPropDecision.l5_trend
            : null,
        propWhy: rawPropDecision?.why ?? undefined,
        propFlags: Array.isArray(rawPropDecision?.flags)
          ? rawPropDecision.flags
          : undefined,
        propDisplayState: rawPropDisplayState as PropPlayRow['propDisplayState'] | undefined,
      };
    });

    // Sort rows by canonical props verdict, then priced edge quality, then line delta.
    propPlayRows.sort((a, b) => {
      const verdictRankA = a.propVerdict ? PROP_VERDICT_RANK[a.propVerdict] : 0;
      const verdictRankB = b.propVerdict ? PROP_VERDICT_RANK[b.propVerdict] : 0;
      if (verdictRankA !== verdictRankB) {
        return verdictRankB - verdictRankA;
      }
      if (a.propVerdict === 'NO_PLAY' && b.propVerdict === 'NO_PLAY') {
        const noPlayGapA =
          typeof a.lineDelta === 'number'
            ? Math.abs(a.lineDelta)
            : Number.NEGATIVE_INFINITY;
        const noPlayGapB =
          typeof b.lineDelta === 'number'
            ? Math.abs(b.lineDelta)
            : Number.NEGATIVE_INFINITY;
        if (noPlayGapA !== noPlayGapB) {
          return noPlayGapB - noPlayGapA;
        }
      }
      if ((a.probEdgePp ?? Number.NEGATIVE_INFINITY) !== (b.probEdgePp ?? Number.NEGATIVE_INFINITY)) {
        return (b.probEdgePp ?? Number.NEGATIVE_INFINITY) - (a.probEdgePp ?? Number.NEGATIVE_INFINITY);
      }
      if ((a.lineDelta ?? Number.NEGATIVE_INFINITY) !== (b.lineDelta ?? Number.NEGATIVE_INFINITY)) {
        return (b.lineDelta ?? Number.NEGATIVE_INFINITY) - (a.lineDelta ?? Number.NEGATIVE_INFINITY);
      }
      if ((a.confidence ?? 0) !== (b.confidence ?? 0)) {
        return (b.confidence ?? 0) - (a.confidence ?? 0);
      }
      return (b.edge ?? 0) - (a.edge ?? 0);
    });

    const dedupedPropPlayRows = dedupePropPlayRows(propPlayRows);

    const maxConfidence = Math.max(
      ...dedupedPropPlayRows.map((p) => p.confidence ?? 0),
    );

    // Build prop game card
    const propGameCard: PropGameCard = {
      gameId: game.gameId,
      sport: normalizeSport(game.sport),
      gameTimeUtc: game.gameTimeUtc,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      status: game.status,
      oddsUpdatedUtc: game.odds?.capturedAt ?? undefined,
      moneyline:
        game.odds?.h2hHome && game.odds?.h2hAway
          ? { home: game.odds.h2hHome, away: game.odds.h2hAway }
          : undefined,
      total: game.odds?.total ? { line: game.odds.total } : undefined,
      propPlays: dedupedPropPlayRows,
      maxConfidence,
      tags: [], // add filtering tags as needed
    };

    propGames.push(propGameCard);
  }

  const mergedByMatchup = new Map<string, PropGameCard>();
  for (const card of propGames) {
    const matchupKey = buildPropGameMatchupKey(card);
    const existing = mergedByMatchup.get(matchupKey);
    if (!existing) {
      mergedByMatchup.set(matchupKey, card);
      continue;
    }

    const mergedRows = dedupePropPlayRows([...existing.propPlays, ...card.propPlays]);
    existing.propPlays = mergedRows;
    existing.maxConfidence = Math.max(
      existing.maxConfidence,
      card.maxConfidence,
      ...mergedRows.map((p) => p.confidence ?? 0),
    );
  }

  const dedupedPropGames = Array.from(mergedByMatchup.values());

  // Sort games by max confidence desc
  dedupedPropGames.sort((a, b) => b.maxConfidence - a.maxConfidence);

  return dedupedPropGames;
}
