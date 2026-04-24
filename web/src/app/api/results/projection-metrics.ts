import cheddarData from '@cheddar-logic/data';

export type ProjectionMetricInputRow = {
  sport: string | null;
  cardType: string | null;
  payload: Record<string, unknown> | null;
  gameResultMetadata: Record<string, unknown> | null;
  actualResult?: string | null;
  periodToken?: string | null;
  playerId?: string | null;
  playerName?: string | null;
  canonicalMarketKey?: string | null;
  propType?: string | null;
  directionToken?: string | null;
  officialStatus?: string | null;
  fallbackStatus?: string | null;
  canonicalProjectionRaw?: number | null;
  canonicalProjectionValue?: number | null;
  canonicalWinProbability?: number | null;
  canonicalEdgePp?: number | null;
  canonicalConfidenceScore?: number | null;
  canonicalConfidenceBand?: string | null;
  canonicalTrackingRole?: string | null;
};

export type ResultCardMode = 'ODDS_BACKED' | 'PROJECTION_ONLY';

export type ProjectionSummaryRow = {
  actualsAvailable: boolean;
  bias: number | null;
  cardFamily: string;
  directionalAccuracy: number | null;
  directionalWins: number;
  directionalLosses: number;
  overWins: number;
  overLosses: number;
  underWins: number;
  underLosses: number;
  familyLabel: string;
  mae: number | null;
  rowsSeen: number;
  sampleSize: number;
};

export type ProjectionValueSegment = {
  bucketRangeLabel: string; // e.g., "2.0-2.5"
  projectionMin: number;
  projectionMax: number;
  actualsAvailable: boolean;
  bias: number | null;
  mae: number | null;
  directionalAccuracy: number | null;
  directionalWins: number;
  directionalLosses: number;
  overWins: number;
  overLosses: number;
  underWins: number;
  underLosses: number;
  sampleSize: number;
  rowsSeen: number;
};

export type ProjectionSummaryWithSegments = ProjectionSummaryRow & {
  segments?: ProjectionValueSegment[];
};

type ProjectionAccumulator = {
  absErrorSum: number;
  biasSum: number;
  cardFamily: string;
  directionCorrectCount: number;
  directionSampleCount: number;
  directionLossCount: number;
  overWins: number;
  overLosses: number;
  underWins: number;
  underLosses: number;
  rowsSeen: number;
  sampleSize: number;
};

// PROJECTION_FAMILY_LABELS drives projection accuracy summaries (buildProjectionSummaries).
// It intentionally covers families that are ALWAYS PROJECTION_ONLY — sub-period and
// prop markets that never fetch live odds (per WI-0727).
// Full-game odds-backed families (NHL_TOTAL, NHL_ML, NHL_SPREAD, NBA_*, MLB_*) live only
// in CARD_FAMILY_MAP below, which feeds the betting ledger path in /api/results.
// Note: NHL_1P_TOTAL is PROJECTION_ONLY only — it appears here but NOT in CARD_FAMILY_MAP.
// MLB F5 is intentionally excluded: no bookmaker odds exist for F5 markets, so
// displaying them on /results (even projection-only) implies false bet tracking.
const PROJECTION_FAMILY_LABELS: Record<string, string> = {
  MLB_PITCHER_K: 'MLB Pitcher K',
  NHL_1P_TOTAL: 'NHL 1P Total',
  NHL_PLAYER_BLOCKS: 'NHL Player Blocks',
  NHL_PLAYER_SHOTS: 'NHL Player Shots',
  NHL_PLAYER_SHOTS_1P: 'NHL Player Shots 1P',
};

// Raw card_type strings that map to projection families.
// Used by /api/results route.ts to run a direct query against card_results
// (bypassing card_display_log) for games whose final result is known.
// These card types are never displayed in the betting UI so they never
// appear in card_display_log — the only way to surface them for accuracy
// tracking is to query card_results directly joined on game_results.status='final'.
export const PROJECTION_TRACKING_CARD_TYPES: readonly string[] = [
  'mlb-pitcher-k',
  'nhl-pace-1p',
  'nhl-player-shots',
  'nhl-player-shots-1p',
  'nhl-player-blk',
] as const;

const RESULTS_EXCLUDED_CARD_TYPES = new Set(['potd-call']);

export function shouldTrackInResults(cardType: string | null | undefined): boolean {
  const normalized = String(cardType || '').trim().toLowerCase();
  if (!normalized) return true;
  return !RESULTS_EXCLUDED_CARD_TYPES.has(normalized);
}

const PROJECTION_LINE_SOURCES = new Set([
  'projection_floor',
  'synthetic',
  'synthetic_fallback',
]);

type ProjectionAnalyticsContract = {
  materialized: boolean;
  preferredNumericField: 'projection_raw' | 'projection_value';
  numericSemantics: 'projected_stat_value' | 'selected_side_win_probability';
};

const { PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY } = cheddarData as {
  PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY?: Record<
    string,
    ProjectionAnalyticsContract | undefined
  >;
};

function toUpperToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function toLowerToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundNumber(value: number): number {
  return Number(value.toFixed(4));
}

function getProjectionAnalyticsContract(
  cardFamily: string,
): ProjectionAnalyticsContract | null {
  const contractMap =
    (PROJECTION_ANALYTICS_CONTRACT_BY_MARKET_FAMILY || {}) as Record<
      string,
      ProjectionAnalyticsContract | undefined
    >;
  return contractMap[cardFamily] ?? null;
}

function getPayloadValue(
  payload: Record<string, unknown> | null,
  path: string[],
): unknown {
  let current: unknown = payload;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? null : current;
}

function normalizePlayerName(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePeriodToken(
  payload: Record<string, unknown> | null,
  cardType: string | null,
): '1P' | 'FULL_GAME' | 'F5' {
  const token = toUpperToken(
    getPayloadValue(payload, ['play', 'period']) ||
      payload?.period ||
      payload?.time_period,
  );
  if (token === 'FIRST_PERIOD' || token === '1ST_PERIOD' || token === '1P') {
    return '1P';
  }
  if (token === 'F5' || token === 'FIRST_5') return 'F5';

  const normalizedCardType = String(cardType || '').toLowerCase();
  if (normalizedCardType.includes('1p')) return '1P';
  if (normalizedCardType === 'mlb-f5' || normalizedCardType === 'mlb-f5-ml') {
    return 'F5';
  }
  return 'FULL_GAME';
}

function resolvePeriodToken(
  row: ProjectionMetricInputRow,
): '1P' | 'FULL_GAME' | 'F5' {
  const explicit = toUpperToken(row.periodToken);
  if (explicit === 'FIRST_PERIOD' || explicit === '1ST_PERIOD' || explicit === '1P') {
    return '1P';
  }
  if (explicit === 'F5' || explicit === 'FIRST_5') return 'F5';
  return normalizePeriodToken(row.payload, row.cardType);
}

function resolveRowPlayerId(row: ProjectionMetricInputRow): string {
  return String(
    row.playerId ??
      getPayloadValue(row.payload, ['play', 'player_id']) ??
      row.payload?.player_id ??
      '',
  ).trim();
}

function resolveRowPlayerName(row: ProjectionMetricInputRow): string {
  return normalizePlayerName(
    row.playerName ??
      getPayloadValue(row.payload, ['play', 'player_name']) ??
      row.payload?.player_name,
  );
}

function resolveRowCanonicalMarketKey(row: ProjectionMetricInputRow): string | null {
  return toLowerToken(
    row.canonicalMarketKey ??
      getPayloadValue(row.payload, ['play', 'canonical_market_key']) ??
      row.payload?.canonical_market_key,
  );
}

function resolveRowPropType(row: ProjectionMetricInputRow): string | null {
  return toLowerToken(
    row.propType ??
      getPayloadValue(row.payload, ['play', 'prop_type']) ??
      row.payload?.prop_type,
  );
}

// F5 card types are always projection-only: no live odds are fetched,
// no locked price exists, so P&L cannot be tracked. Any card_type that
// starts with 'mlb-f5' belongs to this family.
const F5_CARD_TYPE_PREFIX = 'mlb-f5';

/**
 * Returns PROJECTION_ONLY or ODDS_BACKED for a settled card result.
 *
 * @param payload - parsed card_payloads.payload_data
 * @param cardType - optional raw card_type from card_results (takes priority
 *   over any card_type embedded inside the payload)
 */
export function deriveResultCardMode(
  payload: Record<string, unknown> | null,
  cardType?: string | null,
): ResultCardMode {
  // F5 market cards never have quoted odds — always projection-only.
  const ct = String(
    cardType || toLowerToken(payload?.card_type) || '',
  ).toLowerCase();
  if (ct.startsWith(F5_CARD_TYPE_PREFIX)) return 'PROJECTION_ONLY';

  const explicitBasis = toUpperToken(
    getPayloadValue(payload, ['decision_basis_meta', 'decision_basis']) ||
      payload?.basis ||
      payload?.decision_basis,
  );
  if (explicitBasis === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';
  if (explicitBasis === 'ODDS_BACKED') return 'ODDS_BACKED';

  const executionStatus = toUpperToken(
    payload?.execution_status ||
      getPayloadValue(payload, ['play', 'execution_status']) ||
      payload?.prop_display_state,
  );
  if (executionStatus === 'PROJECTION_ONLY') return 'PROJECTION_ONLY';

  const lineSource = toLowerToken(
    getPayloadValue(payload, ['decision_basis_meta', 'market_line_source']) ||
      getPayloadValue(payload, ['market_context', 'wager', 'line_source']) ||
      payload?.line_source,
  );
  if (lineSource && PROJECTION_LINE_SOURCES.has(lineSource)) {
    return 'PROJECTION_ONLY';
  }

  return 'ODDS_BACKED';
}

function deriveProjectionCardFamily(row: ProjectionMetricInputRow): string {
  const payload = row.payload || {};
  const sport = toUpperToken(payload.sport || row.sport) || 'UNKNOWN';
  const cardType = toLowerToken(row.cardType || payload.card_type) || '';
  const period = resolvePeriodToken(row);
  const canonicalMarketKey = resolveRowCanonicalMarketKey(row);
  const propType = resolveRowPropType(row);

  if (sport === 'NHL') {
    if (propType === 'shots_on_goal' || cardType.includes('player-shots')) {
      return period === '1P'
        ? 'NHL_PLAYER_SHOTS_1P'
        : 'NHL_PLAYER_SHOTS';
    }
    if (propType === 'blocked_shots' || cardType === 'nhl-player-blk') {
      return 'NHL_PLAYER_BLOCKS';
    }
    if (period === '1P' || cardType === 'nhl-pace-1p') return 'NHL_1P_TOTAL';
    return 'NHL_TOTAL';
  }

  if (sport === 'MLB') {
    if (canonicalMarketKey === 'pitcher_strikeouts' || cardType === 'mlb-pitcher-k') {
      return 'MLB_PITCHER_K';
    }
  }

  return `${sport}_${cardType || 'UNKNOWN'}`.toUpperCase();
}

function resolveProjectionValue(row: ProjectionMetricInputRow): number | null {
  const cardFamily = deriveProjectionCardFamily(row);
  const contract = getProjectionAnalyticsContract(cardFamily);
  if (contract) {
    const canonicalCandidates =
      contract.preferredNumericField === 'projection_raw'
        ? [row.canonicalProjectionRaw, row.canonicalProjectionValue]
        : [
            row.canonicalProjectionValue,
            row.canonicalProjectionRaw,
            row.canonicalWinProbability,
          ];
    for (const candidate of canonicalCandidates) {
      const parsed = toNumber(candidate);
      if (parsed !== null) return parsed;
    }
  }

  const payload = row.payload;
  const candidates = [
    payload?.numeric_projection,
    getPayloadValue(payload, ['projection', 'k_mean']),
    getPayloadValue(payload, ['projection', 'total']),
    getPayloadValue(payload, ['projection', 'projected_total']),
    getPayloadValue(payload, ['decision', 'model_projection']),
    getPayloadValue(payload, ['decision', 'projection']),
    getPayloadValue(payload, ['model', 'expected1pTotal']),
    getPayloadValue(payload, ['model', 'expectedTotal']),
    getPayloadValue(payload, ['first_period_model', 'projection_final']),
  ];

  for (const candidate of candidates) {
    const parsed = toNumber(candidate);
    if (parsed !== null) return parsed;
  }

  return null;
}

function resolveProjectionDirection(
  row: ProjectionMetricInputRow,
): 'OVER' | 'UNDER' | null {
  const payload = row.payload;
  const token = toUpperToken(
    row.directionToken ||
      payload?.recommended_direction ||
      getPayloadValue(payload, ['play', 'selection', 'side']) ||
      getPayloadValue(payload, ['selection', 'side']) ||
      getPayloadValue(payload, ['play', 'decision_v2', 'direction']) ||
      getPayloadValue(payload, ['decision_v2', 'direction']) ||
      getPayloadValue(payload, ['decision', 'direction']) ||
      payload?.prediction,
  );
  if (token === 'OVER' || token === 'UNDER') return token;
  return null;
}

function hasActionableProjectionCallForRow(
  row: ProjectionMetricInputRow,
): boolean {
  const officialStatus = toUpperToken(
    row.officialStatus ??
      getPayloadValue(row.payload, ['play', 'decision_v2', 'official_status']) ??
      getPayloadValue(row.payload, ['decision_v2', 'official_status']),
  );
  if (officialStatus === 'PASS') return false;
  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') return true;

  const fallback = toUpperToken(
    row.fallbackStatus ??
      getPayloadValue(row.payload, ['decision', 'status']) ??
      getPayloadValue(row.payload, ['status']) ??
      getPayloadValue(row.payload, ['play', 'status']) ??
      getPayloadValue(row.payload, ['action']) ??
      getPayloadValue(row.payload, ['play', 'action']) ??
      getPayloadValue(row.payload, ['decision', 'action']),
  );

  if (fallback === 'PASS' || fallback === 'HOLD' || fallback === 'WATCH') {
    return false;
  }
  if (fallback === 'PLAY' || fallback === 'LEAN' || fallback === 'FIRE') {
    return true;
  }

  return true;
}

export function hasActionableProjectionCall(
  payload: Record<string, unknown> | null,
): boolean {
  const officialStatus = toUpperToken(
    getPayloadValue(payload, ['play', 'decision_v2', 'official_status']) ||
      getPayloadValue(payload, ['decision_v2', 'official_status']),
  );
  if (officialStatus === 'PASS') return false;
  if (officialStatus === 'PLAY' || officialStatus === 'LEAN') return true;

  const fallback = toUpperToken(
    getPayloadValue(payload, ['decision', 'status']) ||
      getPayloadValue(payload, ['status']) ||
      getPayloadValue(payload, ['play', 'status']) ||
      getPayloadValue(payload, ['action']) ||
      getPayloadValue(payload, ['play', 'action']) ||
      getPayloadValue(payload, ['decision', 'action']),
  );

  if (fallback === 'PASS' || fallback === 'HOLD' || fallback === 'WATCH') {
    return false;
  }
  if (fallback === 'PLAY' || fallback === 'LEAN' || fallback === 'FIRE') {
    return true;
  }

  // Legacy payloads may not include explicit status/action fields.
  // In that case, keep prior behavior and infer actionability from direction.
  return true;
}

function resolveFirstPeriodTotal(
  gameResultMetadata: Record<string, unknown> | null,
): number | null {
  if (!gameResultMetadata) return null;
  const verification = gameResultMetadata.firstPeriodVerification;
  if (
    verification &&
    typeof verification === 'object' &&
    (verification as Record<string, unknown>).isComplete === false
  ) {
    return null;
  }

  for (const scoreObject of [
    gameResultMetadata.firstPeriodScores,
    gameResultMetadata.first_period_scores,
  ]) {
    if (!scoreObject || typeof scoreObject !== 'object') continue;
    const home = toNumber((scoreObject as Record<string, unknown>).home);
    const away = toNumber((scoreObject as Record<string, unknown>).away);
    if (home !== null && away !== null) return home + away;
  }

  return null;
}

function resolvePlayerShotsActualValue(row: ProjectionMetricInputRow): number | null {
  const playerShots =
    row.gameResultMetadata?.playerShots &&
    typeof row.gameResultMetadata.playerShots === 'object'
      ? (row.gameResultMetadata.playerShots as Record<string, unknown>)
      : null;
  if (!playerShots) return null;

  const period = resolvePeriodToken(row);
  const valuesByPlayer =
    period === '1P'
      ? playerShots.firstPeriodByPlayerId
      : playerShots.fullGameByPlayerId;
  if (!valuesByPlayer || typeof valuesByPlayer !== 'object') return null;

  const playerId = resolveRowPlayerId(row);
  if (playerId) {
    const direct = toNumber((valuesByPlayer as Record<string, unknown>)[playerId]);
    if (direct !== null) return direct;
  }

  const playerName = resolveRowPlayerName(row);
  if (!playerName) return null;

  const playerIdByNormalizedName =
    playerShots.playerIdByNormalizedName &&
    typeof playerShots.playerIdByNormalizedName === 'object'
      ? (playerShots.playerIdByNormalizedName as Record<string, unknown>)
      : null;
  const mappedPlayerId = playerIdByNormalizedName
    ? String(playerIdByNormalizedName[playerName] || '').trim()
    : '';
  if (!mappedPlayerId) return null;

  return toNumber((valuesByPlayer as Record<string, unknown>)[mappedPlayerId]);
}

function parseActualResultObject(
  actualResult: string | null | undefined,
): Record<string, unknown> | null {
  if (!actualResult) return null;
  try {
    const parsed = JSON.parse(actualResult);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveProjectionActualValue(row: ProjectionMetricInputRow): number | null {
  const cardFamily = deriveProjectionCardFamily(row);
  const actualResult = parseActualResultObject(row.actualResult);

  if (cardFamily === 'NHL_1P_TOTAL') {
    return (
      resolveFirstPeriodTotal(row.gameResultMetadata) ??
      toNumber(actualResult?.goals_1p)
    );
  }
  if (
    cardFamily === 'NHL_PLAYER_SHOTS' ||
    cardFamily === 'NHL_PLAYER_SHOTS_1P'
  ) {
    return resolvePlayerShotsActualValue(row) ?? toNumber(actualResult?.shots_1p ?? actualResult?.shots);
  }
  if (cardFamily === 'NHL_PLAYER_BLOCKS') {
    const playerBlocks =
      row.gameResultMetadata?.playerBlocks &&
      typeof row.gameResultMetadata.playerBlocks === 'object'
        ? (row.gameResultMetadata.playerBlocks as Record<string, unknown>)
        : null;
    if (!playerBlocks) return null;

    const valuesByPlayer = playerBlocks.fullGameByPlayerId;
    if (!valuesByPlayer || typeof valuesByPlayer !== 'object') return null;

    const playerId = resolveRowPlayerId(row);
    if (playerId) {
      const direct = toNumber((valuesByPlayer as Record<string, unknown>)[playerId]);
      if (direct !== null) return direct;
    }

    const playerName = resolveRowPlayerName(row);
    if (!playerName) return null;

    const playerIdByNormalizedName =
      playerBlocks.playerIdByNormalizedName &&
      typeof playerBlocks.playerIdByNormalizedName === 'object'
        ? (playerBlocks.playerIdByNormalizedName as Record<string, unknown>)
        : null;
    const mappedPlayerId = playerIdByNormalizedName
      ? String(playerIdByNormalizedName[playerName] || '').trim()
      : '';
    if (mappedPlayerId) {
      const mapped = toNumber((valuesByPlayer as Record<string, unknown>)[mappedPlayerId]);
      if (mapped !== null) return mapped;
    }

    return toNumber(actualResult?.blocks);
  }
  if (cardFamily === 'MLB_PITCHER_K') {
    return toNumber(actualResult?.pitcher_ks);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canonical reporting identity helpers (WI-0749)
// ---------------------------------------------------------------------------

// Maps raw card_type strings to canonical card family keys.
// Both driver types (nhl-pace-totals) and call types (nhl-totals-call) collapse
// to the same family so results grouping never shows duplicate rows.
//
// IMPORTANT: Only ODDS_BACKED families belong here. This map feeds the betting
// ledger grouping in /api/results (route.ts lines ~741, ~982) which is gated by
// deriveResultCardMode === 'ODDS_BACKED' before it ever calls deriveCardFamily.
//
// NHL 1P totals (nhl-pace-1p, nhl-1p-call) are intentionally OMITTED:
//   - pull_nhl_1p_odds.js is gated behind NHL_1P_ODDS_ENABLED=true (never set)
//     and is not registered in the scheduler (WI-0736 / WI-0727).
//   - run_nhl_model.js always sets execution_status=PROJECTION_ONLY when
//     total_1p_price_over/under are null (which they always are today).
//   - They appear in PROJECTION_FAMILY_LABELS above for the projection accuracy path.
//   Re-add here only if NHL_1P_ODDS_ENABLED is activated in production.
const CARD_FAMILY_MAP: Record<string, string> = {
  // NHL full-game totals
  'nhl-pace-totals': 'NHL_TOTAL',
  'nhl-totals-call': 'NHL_TOTAL',
  // NHL spread / puckline
  'nhl-spread-call': 'NHL_SPREAD',
  'nhl-puckline': 'NHL_SPREAD',
  // NHL moneyline
  'nhl-ml-call': 'NHL_ML',
  'nhl-moneyline-call': 'NHL_ML',
  'nhl-moneyline': 'NHL_ML',
  // NHL player shots
  'nhl-player-shots': 'NHL_PLAYER_SHOTS',
  'nhl-player-shots-call': 'NHL_PLAYER_SHOTS',
  // NHL player blocks
  'nhl-player-blk': 'NHL_PLAYER_BLOCKS',
  // NHL blowout risk / synergy / matchup info cards
  'nhl-blowout-risk': 'NHL_INFO',
  'nhl-synergy': 'NHL_INFO',
  'nhl-matchup-style': 'NHL_INFO',
  // NBA totals
  'nba-pace-totals': 'NBA_TOTAL',
  'nba-totals-call': 'NBA_TOTAL',
  // NBA spread
  'nba-spread-call': 'NBA_SPREAD',
  // MLB pitcher strikeouts
  'mlb-pitcher-k': 'MLB_PITCHER_K',
  // MLB full-game totals
  'mlb-totals-call': 'MLB_TOTAL',
  'mlb-full-game': 'MLB_TOTAL',
  // MLB spread
  'mlb-spread-call': 'MLB_SPREAD',
  // MLB moneyline
  'mlb-ml-call': 'MLB_ML',
  'mlb-full-game-ml': 'MLB_ML',
};

const MODEL_FAMILY_LABELS: Record<string, string> = {
  NHL_TOTAL: 'NHL Full-Game Totals',
  NHL_1P_TOTAL: 'NHL 1P Totals',
  NHL_SPREAD: 'NHL Spread / Puckline',
  NHL_ML: 'NHL Moneyline',
  NHL_PLAYER_BLOCKS: 'NHL Player Blocks',
  NHL_PLAYER_SHOTS: 'NHL Player Shots',
  NHL_INFO: 'NHL Context',
  NBA_TOTAL: 'NBA Cross-Market Totals',
  NBA_SPREAD: 'NBA Spread',
  MLB_PITCHER_K: 'MLB Pitcher Strikeouts',
  MLB_TOTAL: 'MLB Full-Game Totals',
  MLB_SPREAD: 'MLB Spread',
  MLB_ML: 'MLB Moneyline',
};

const MODEL_VERSION_MAP: Record<string, string> = {
  NHL_TOTAL: 'nhl-totals-v1',
  NHL_1P_TOTAL: 'nhl-1p-v1',
  NHL_SPREAD: 'nhl-spread-v1',
  NHL_ML: 'nhl-ml-v1',
  NHL_PLAYER_BLOCKS: 'nhl-player-blk-v1',
  NHL_PLAYER_SHOTS: 'nhl-player-shots-v1',
  NBA_TOTAL: 'nba-totals-v1',
  NBA_SPREAD: 'nba-spread-v1',
  MLB_PITCHER_K: 'mlb-pitcher-k-v1',
  MLB_TOTAL: 'mlb-totals-v1',
  MLB_SPREAD: 'mlb-spread-v1',
  MLB_ML: 'mlb-ml-v1',
};

/**
 * Derive the canonical card family key from sport + card_type.
 * This is the stable grouping key for results aggregation — both driver types
 * (nhl-pace-totals) and call types (nhl-totals-call) resolve to the same family
 * (NHL_TOTAL) so the results table never shows duplicate rows for the same market.
 */
export function deriveCardFamily(
  sport: string | null,
  cardType: string | null,
): string {
  const normalized = String(cardType || '').trim().toLowerCase();
  const mapped = CARD_FAMILY_MAP[normalized];
  if (mapped) return mapped;
  // Fallback: build an uppercase token from sport + card_type
  const sportToken = String(sport || 'UNKNOWN').trim().toUpperCase();
  return `${sportToken}_${normalized.replace(/-/g, '_').toUpperCase() || 'UNKNOWN'}`;
}

/**
 * Derive the human-readable model engine label for a sport + card_type.
 */
export function deriveModelFamily(
  sport: string | null,
  cardType: string | null,
): string {
  const family = deriveCardFamily(sport, cardType);
  return MODEL_FAMILY_LABELS[family] || family;
}

/**
 * Derive the short model version slug for a sport + card_type.
 */
export function deriveModelVersion(
  sport: string | null,
  cardType: string | null,
): string {
  const family = deriveCardFamily(sport, cardType);
  return MODEL_VERSION_MAP[family] || 'v1';
}

export function buildProjectionSummaries(
  rows: Iterable<ProjectionMetricInputRow>,
): ProjectionSummaryWithSegments[] {
  const materializedRows = Array.from(rows);
  const grouped = new Map<string, ProjectionAccumulator>();

  for (const row of materializedRows) {
    const cardFamily = deriveProjectionCardFamily(row);

    // Use PROJECTION_FAMILY_LABELS as a strict allowlist.
    // This has two effects:
    //   1. Blocks odds-backed families (NBA_TOTAL, NHL_TOTAL, etc.) from leaking
    //      into this section when they happen to carry execution_status=PROJECTION_ONLY
    //      (e.g., blocked model runs or cards with synthetic line source).
    //   2. Includes all rows for model-projection families (NHL_PLAYER_SHOTS,
    //      NHL_1P_TOTAL, MLB_F5_TOTAL, MLB_PITCHER_K, etc.) regardless of whether
    //      the individual card was odds-backed in that era — the model always
    //      emits a projection even when a real line is available, so tracking
    //      them all gives a more complete accuracy picture.
    if (!PROJECTION_FAMILY_LABELS[cardFamily]) continue;

    const accumulator =
      grouped.get(cardFamily) ??
      {
        absErrorSum: 0,
        biasSum: 0,
        cardFamily,
        directionCorrectCount: 0,
        directionSampleCount: 0,
        directionLossCount: 0,
        overWins: 0,
        overLosses: 0,
        underWins: 0,
        underLosses: 0,
        rowsSeen: 0,
        sampleSize: 0,
      };
    accumulator.rowsSeen += 1;

    const projection = resolveProjectionValue(row);
    const actual = resolveProjectionActualValue(row);
    if (projection === null || actual === null) {
      grouped.set(cardFamily, accumulator);
      continue;
    }

    accumulator.sampleSize += 1;
    accumulator.absErrorSum += Math.abs(actual - projection);
    accumulator.biasSum += projection - actual;

    const direction = resolveProjectionDirection(row);
    if (
      hasActionableProjectionCallForRow(row) &&
      (direction === 'OVER' || direction === 'UNDER')
    ) {
      accumulator.directionSampleCount += 1;
      const isCorrect =
        (direction === 'OVER' && actual >= projection) ||
        (direction === 'UNDER' && actual <= projection);
      if (isCorrect) {
        accumulator.directionCorrectCount += 1;
        if (direction === 'OVER') accumulator.overWins += 1;
        else accumulator.underWins += 1;
      } else {
        accumulator.directionLossCount += 1;
        if (direction === 'OVER') accumulator.overLosses += 1;
        else accumulator.underLosses += 1;
      }
    }

    grouped.set(cardFamily, accumulator);
  }

  // Return summaries sorted so families with actuals come first, then by label.
  const segmentsByFamily = new Map(
    buildProjectionValueSegments(materializedRows).map((summary) => [
      summary.cardFamily,
      summary.segments,
    ]),
  );

  return Array.from(grouped.values())
    .map((summary) => ({
      actualsAvailable: summary.sampleSize > 0,
      bias:
        summary.sampleSize > 0
          ? roundNumber(summary.biasSum / summary.sampleSize)
          : null,
      cardFamily: summary.cardFamily,
      directionalAccuracy:
        summary.directionSampleCount > 0
          ? roundNumber(
              summary.directionCorrectCount / summary.directionSampleCount,
            )
          : null,
      directionalWins: summary.directionCorrectCount,
      directionalLosses: summary.directionLossCount,
      overWins: summary.overWins,
      overLosses: summary.overLosses,
      underWins: summary.underWins,
      underLosses: summary.underLosses,
      familyLabel:
        PROJECTION_FAMILY_LABELS[summary.cardFamily] || summary.cardFamily,
      mae:
        summary.sampleSize > 0
          ? roundNumber(summary.absErrorSum / summary.sampleSize)
          : null,
      rowsSeen: summary.rowsSeen,
      sampleSize: summary.sampleSize,
      segments: segmentsByFamily.get(summary.cardFamily),
    }))
    .sort((left, right) => {
      if (left.actualsAvailable !== right.actualsAvailable) {
        return left.actualsAvailable ? -1 : 1;
      }
      return left.familyLabel.localeCompare(right.familyLabel);
    });
}

/**
 * Determine which range bucket a projection value falls into.
 * For 1P totals: [2.0, 2.2) → "2.0-2.19", [2.2, ∞) → "2.20+", others by 0.5 increments
 * For full-game totals: 0.5 increments
 * For prop markets (shots, blocks, K): buckets based on typical ranges.
 */
function getProjectionBucket(
  value: number,
  cardFamily: string,
): { min: number; max: number; label: string } {
  // For 1P totals: use fixed reporting buckets.
  if (cardFamily === 'NHL_1P_TOTAL') {
    if (value < 1.5) {
      return {
        min: 1.0,
        max: 1.5,
        label: '1.0-1.4',
      };
    }
    if (value < 2.0) {
      return {
        min: 1.5,
        max: 2.0,
        label: '1.5-1.9',
      };
    }
    if (value >= 2.2) {
      return {
        min: 2.2,
        max: 10,
        label: '2.20+',
      };
    }
    return {
      min: 2.0,
      max: 2.2,
      label: '2.0-2.19',
    };
  }

  // For full-game totals: use 0.5-sized buckets
  if (cardFamily === 'NHL_TOTAL') {
    const floor = Math.floor(value * 2) / 2; // Round down to nearest 0.5
    const ceiling = floor + 0.5;
    return {
      min: floor,
      max: ceiling,
      label: `${floor.toFixed(1)}-${ceiling.toFixed(1)}`,
    };
  }

  // For NHL shots/blocks: buckets of width 2
  if (
    cardFamily === 'NHL_PLAYER_SHOTS' ||
    cardFamily === 'NHL_PLAYER_SHOTS_1P' ||
    cardFamily === 'NHL_PLAYER_BLOCKS'
  ) {
    const floor = Math.floor(value / 2) * 2;
    const ceiling = floor + 2;
    return {
      min: floor,
      max: ceiling,
      label: `${floor}-${ceiling}`,
    };
  }

  // For MLB pitcher K: buckets of width 1.5
  if (cardFamily === 'MLB_PITCHER_K') {
    const floor = Math.floor(value / 1.5) * 1.5;
    const ceiling = floor + 1.5;
    return {
      min: floor,
      max: ceiling,
      label: `${floor.toFixed(1)}-${ceiling.toFixed(1)}`,
    };
  }

  // Default: single bucket
  return { min: value, max: value, label: `${value.toFixed(1)}` };
}

type ProjectionSegmentAccumulator = {
  bucketKey: string; // min-max as string for grouping
  bucketMin: number;
  bucketMax: number;
  bucketLabel: string;
  absErrorSum: number;
  biasSum: number;
  sampleSize: number;
  rowsSeen: number;
  directionCorrectCount: number;
  directionLossCount: number;
  directionSampleCount: number;
  overWins: number;
  overLosses: number;
  underWins: number;
  underLosses: number;
};

const NHL_1P_FIXED_SEGMENTS: Array<{ min: number; max: number; label: string }> = [
  { min: 1.0, max: 1.5, label: '1.0-1.4' },
  { min: 1.5, max: 2.0, label: '1.5-1.9' },
  { min: 2.0, max: 2.2, label: '2.0-2.19' },
  { min: 2.2, max: 10, label: '2.20+' },
];

/**
 * Build projection accuracy summaries segmented by projection value ranges.
 * Groups rows by cardFamily and projection value bucket to identify if certain
 * ranges have systematically better/worse accuracy.
 */
export function buildProjectionValueSegments(
  rows: Iterable<ProjectionMetricInputRow>,
): ProjectionSummaryWithSegments[] {
  const groupedByFamily = new Map<string, Map<string, ProjectionSegmentAccumulator>>();

  for (const row of rows) {
    const cardFamily = deriveProjectionCardFamily(row);

    // Only include projection-only families
    if (!PROJECTION_FAMILY_LABELS[cardFamily]) continue;

    const projection = resolveProjectionValue(row);
    const actual = resolveProjectionActualValue(row);

    const bucket = projection !== null ? getProjectionBucket(projection, cardFamily) : null;
    const bucketKey = bucket ? `${bucket.min}-${bucket.max}` : 'null';

    if (!groupedByFamily.has(cardFamily)) {
      groupedByFamily.set(cardFamily, new Map());
    }
    const familySegments = groupedByFamily.get(cardFamily)!;

    if (!familySegments.has(bucketKey)) {
      familySegments.set(bucketKey, {
        bucketKey,
        bucketMin: bucket?.min ?? 0,
        bucketMax: bucket?.max ?? 0,
        bucketLabel: bucket?.label ?? 'null',
        absErrorSum: 0,
        biasSum: 0,
        sampleSize: 0,
        rowsSeen: 0,
        directionCorrectCount: 0,
        directionLossCount: 0,
        directionSampleCount: 0,
        overWins: 0,
        overLosses: 0,
        underWins: 0,
        underLosses: 0,
      });
    }
    const accumulator = familySegments.get(bucketKey)!;
    accumulator.rowsSeen += 1;

    if (projection === null || actual === null) continue;

    accumulator.sampleSize += 1;
    accumulator.absErrorSum += Math.abs(actual - projection);
    accumulator.biasSum += projection - actual;

    const direction = resolveProjectionDirection(row);
    if (
      hasActionableProjectionCallForRow(row) &&
      (direction === 'OVER' || direction === 'UNDER')
    ) {
      accumulator.directionSampleCount += 1;
      const isCorrect =
        (direction === 'OVER' && actual >= projection) ||
        (direction === 'UNDER' && actual <= projection);
      if (isCorrect) {
        accumulator.directionCorrectCount += 1;
        if (direction === 'OVER') accumulator.overWins += 1;
        else accumulator.underWins += 1;
      } else {
        accumulator.directionLossCount += 1;
        if (direction === 'OVER') accumulator.overLosses += 1;
        else accumulator.underLosses += 1;
      }
    }
  }

  // Convert to summary rows with segment breakdowns
  const results: ProjectionSummaryWithSegments[] = [];

  for (const [cardFamily, familySegments] of groupedByFamily.entries()) {
    // First compute family-level aggregates
    let familyAbsErrorSum = 0;
    let familyBiasSum = 0;
    let familySampleSize = 0;
    let familyRowsSeen = 0;
    let familyDirCorrectCount = 0;
    let familyDirLossCount = 0;
    let familyDirSampleCount = 0;
    let familyOverWins = 0;
    let familyOverLosses = 0;
    let familyUnderWins = 0;
    let familyUnderLosses = 0;

    const segments: ProjectionValueSegment[] = [];
    const segmentsToRender =
      cardFamily === 'NHL_1P_TOTAL'
        ? NHL_1P_FIXED_SEGMENTS.map(({ min, max, label }) => {
            const key = `${min}-${max}`;
            const existing = familySegments.get(key);
            if (existing) return existing;
            return {
              bucketKey: key,
              bucketMin: min,
              bucketMax: max,
              bucketLabel: label,
              absErrorSum: 0,
              biasSum: 0,
              sampleSize: 0,
              rowsSeen: 0,
              directionCorrectCount: 0,
              directionLossCount: 0,
              directionSampleCount: 0,
              overWins: 0,
              overLosses: 0,
              underWins: 0,
              underLosses: 0,
            } as ProjectionSegmentAccumulator;
          })
        : Array.from(familySegments.values());

    for (const segment of segmentsToRender) {
      familyAbsErrorSum += segment.absErrorSum;
      familyBiasSum += segment.biasSum;
      familySampleSize += segment.sampleSize;
      familyRowsSeen += segment.rowsSeen;
      familyDirCorrectCount += segment.directionCorrectCount;
      familyDirLossCount += segment.directionLossCount;
      familyDirSampleCount += segment.directionSampleCount;
      familyOverWins += segment.overWins;
      familyOverLosses += segment.overLosses;
      familyUnderWins += segment.underWins;
      familyUnderLosses += segment.underLosses;

      segments.push({
        bucketRangeLabel: segment.bucketLabel,
        projectionMin: segment.bucketMin,
        projectionMax: segment.bucketMax,
        actualsAvailable: segment.sampleSize > 0,
        bias:
          segment.sampleSize > 0
            ? roundNumber(segment.biasSum / segment.sampleSize)
            : null,
        mae:
          segment.sampleSize > 0
            ? roundNumber(segment.absErrorSum / segment.sampleSize)
            : null,
        directionalAccuracy:
          segment.directionSampleCount > 0
            ? roundNumber(
                segment.directionCorrectCount / segment.directionSampleCount,
              )
            : null,
        directionalWins: segment.directionCorrectCount,
        directionalLosses: segment.directionLossCount,
        overWins: segment.overWins,
        overLosses: segment.overLosses,
        underWins: segment.underWins,
        underLosses: segment.underLosses,
        sampleSize: segment.sampleSize,
        rowsSeen: segment.rowsSeen,
      });
    }

    // Sort segments by projection min value
    segments.sort((a, b) => a.projectionMin - b.projectionMin);

    results.push({
      actualsAvailable: familySampleSize > 0,
      bias:
        familySampleSize > 0
          ? roundNumber(familyBiasSum / familySampleSize)
          : null,
      cardFamily,
      directionalAccuracy:
        familyDirSampleCount > 0
          ? roundNumber(familyDirCorrectCount / familyDirSampleCount)
          : null,
      directionalWins: familyDirCorrectCount,
      directionalLosses: familyDirLossCount,
      overWins: familyOverWins,
      overLosses: familyOverLosses,
      underWins: familyUnderWins,
      underLosses: familyUnderLosses,
      familyLabel: PROJECTION_FAMILY_LABELS[cardFamily] || cardFamily,
      mae:
        familySampleSize > 0
          ? roundNumber(familyAbsErrorSum / familySampleSize)
          : null,
      rowsSeen: familyRowsSeen,
      sampleSize: familySampleSize,
      segments: segments.length > 0 ? segments : undefined,
    });
  }

  return results.sort((left, right) => {
    if (left.actualsAvailable !== right.actualsAvailable) {
      return left.actualsAvailable ? -1 : 1;
    }
    return left.familyLabel.localeCompare(right.familyLabel);
  });
}
