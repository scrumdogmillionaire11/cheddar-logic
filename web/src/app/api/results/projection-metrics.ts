export type ProjectionMetricInputRow = {
  sport: string | null;
  cardType: string | null;
  payload: Record<string, unknown> | null;
  gameResultMetadata: Record<string, unknown> | null;
};

export type ResultCardMode = 'ODDS_BACKED' | 'PROJECTION_ONLY';

export type ProjectionSummaryRow = {
  actualsAvailable: boolean;
  bias: number | null;
  cardFamily: string;
  directionalAccuracy: number | null;
  familyLabel: string;
  mae: number | null;
  rowsSeen: number;
  sampleSize: number;
};

type ProjectionAccumulator = {
  absErrorSum: number;
  biasSum: number;
  cardFamily: string;
  directionCorrectCount: number;
  directionSampleCount: number;
  rowsSeen: number;
  sampleSize: number;
};

// PROJECTION_FAMILY_LABELS drives projection accuracy summaries (buildProjectionSummaries).
// It intentionally covers families that are ALWAYS PROJECTION_ONLY — sub-period and
// prop markets that never fetch live odds (per WI-0727).
// Full-game odds-backed families (NHL_TOTAL, NHL_ML, NHL_SPREAD, NBA_*, MLB_*) live only
// in CARD_FAMILY_MAP below, which feeds the betting ledger path in /api/results.
// Note: NHL_1P_TOTAL is PROJECTION_ONLY only — it appears here but NOT in CARD_FAMILY_MAP.
const PROJECTION_FAMILY_LABELS: Record<string, string> = {
  MLB_F5_TOTAL: 'MLB F5 Total',
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
  'mlb-f5',
  'mlb-pitcher-k',
  'nhl-pace-1p',
  'nhl-player-shots',
  'nhl-player-shots-1p',
  'nhl-player-blk',
] as const;

const PROJECTION_LINE_SOURCES = new Set([
  'projection_floor',
  'synthetic',
  'synthetic_fallback',
]);

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

export function deriveResultCardMode(
  payload: Record<string, unknown> | null,
): ResultCardMode {
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
  const period = normalizePeriodToken(row.payload, row.cardType);
  const canonicalMarketKey = toLowerToken(
    getPayloadValue(row.payload, ['play', 'canonical_market_key']) ||
      payload.canonical_market_key,
  );
  const propType = toLowerToken(
    getPayloadValue(row.payload, ['play', 'prop_type']) || payload.prop_type,
  );

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
    if (cardType === 'mlb-f5') return 'MLB_F5_TOTAL';
    if (cardType === 'mlb-f5-ml') return 'MLB_F5_ML';
  }

  return `${sport}_${cardType || 'UNKNOWN'}`.toUpperCase();
}

function resolveProjectionValue(payload: Record<string, unknown> | null): number | null {
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
  payload: Record<string, unknown> | null,
): 'OVER' | 'UNDER' | null {
  const token = toUpperToken(
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

  const period = normalizePeriodToken(row.payload, row.cardType);
  const valuesByPlayer =
    period === '1P'
      ? playerShots.firstPeriodByPlayerId
      : playerShots.fullGameByPlayerId;
  if (!valuesByPlayer || typeof valuesByPlayer !== 'object') return null;

  const playerId = String(
    getPayloadValue(row.payload, ['play', 'player_id']) ||
      row.payload?.player_id ||
      '',
  ).trim();
  if (playerId) {
    const direct = toNumber((valuesByPlayer as Record<string, unknown>)[playerId]);
    if (direct !== null) return direct;
  }

  const playerName = normalizePlayerName(
    getPayloadValue(row.payload, ['play', 'player_name']) ||
      row.payload?.player_name,
  );
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

function resolveProjectionActualValue(row: ProjectionMetricInputRow): number | null {
  const cardFamily = deriveProjectionCardFamily(row);
  if (cardFamily === 'NHL_1P_TOTAL') {
    return resolveFirstPeriodTotal(row.gameResultMetadata);
  }
  if (
    cardFamily === 'NHL_PLAYER_SHOTS' ||
    cardFamily === 'NHL_PLAYER_SHOTS_1P'
  ) {
    return resolvePlayerShotsActualValue(row);
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

    const playerId = String(
      getPayloadValue(row.payload, ['play', 'player_id']) ||
        row.payload?.player_id ||
        '',
    ).trim();
    if (playerId) {
      const direct = toNumber((valuesByPlayer as Record<string, unknown>)[playerId]);
      if (direct !== null) return direct;
    }

    const playerName = normalizePlayerName(
      getPayloadValue(row.payload, ['play', 'player_name']) ||
        row.payload?.player_name,
    );
    if (!playerName) return null;

    const playerIdByNormalizedName =
      playerBlocks.playerIdByNormalizedName &&
      typeof playerBlocks.playerIdByNormalizedName === 'object'
        ? (playerBlocks.playerIdByNormalizedName as Record<string, unknown>)
        : null;
    const mappedPlayerId = playerIdByNormalizedName
      ? String(playerIdByNormalizedName[playerName] || '').trim()
      : '';
    if (!mappedPlayerId) return null;

    return toNumber((valuesByPlayer as Record<string, unknown>)[mappedPlayerId]);
  }
  if (cardFamily === 'MLB_F5_TOTAL') {
    return toNumber(row.gameResultMetadata?.f5_total);
  }
  if (cardFamily === 'MLB_PITCHER_K') {
    return null;
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
  // MLB F5
  'mlb-f5': 'MLB_F5_TOTAL',
  'mlb-f5-call': 'MLB_F5_TOTAL',
  'mlb-f5-ml': 'MLB_F5_ML',
  // MLB full-game totals
  'mlb-totals-call': 'MLB_TOTAL',
  // MLB spread
  'mlb-spread-call': 'MLB_SPREAD',
  // MLB moneyline
  'mlb-ml-call': 'MLB_ML',
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
  MLB_F5_TOTAL: 'MLB F5 Totals',
  MLB_F5_ML: 'MLB F5 Moneyline',
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
  MLB_F5_TOTAL: 'mlb-f5-v1',
  MLB_F5_ML: 'mlb-f5-v1',
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
  rows: ProjectionMetricInputRow[],
): ProjectionSummaryRow[] {
  const grouped = new Map<string, ProjectionAccumulator>();

  for (const row of rows) {
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
        rowsSeen: 0,
        sampleSize: 0,
      };
    accumulator.rowsSeen += 1;

    const projection = resolveProjectionValue(row.payload);
    const actual = resolveProjectionActualValue(row);
    if (projection === null || actual === null) {
      grouped.set(cardFamily, accumulator);
      continue;
    }

    accumulator.sampleSize += 1;
    accumulator.absErrorSum += Math.abs(actual - projection);
    accumulator.biasSum += projection - actual;

    const direction = resolveProjectionDirection(row.payload);
    if (direction === 'OVER' || direction === 'UNDER') {
      accumulator.directionSampleCount += 1;
      if (
        (direction === 'OVER' && actual >= projection) ||
        (direction === 'UNDER' && actual <= projection)
      ) {
        accumulator.directionCorrectCount += 1;
      }
    }

    grouped.set(cardFamily, accumulator);
  }

  // Return summaries sorted so families with actuals come first, then by label.
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
      familyLabel:
        PROJECTION_FAMILY_LABELS[summary.cardFamily] || summary.cardFamily,
      mae:
        summary.sampleSize > 0
          ? roundNumber(summary.absErrorSum / summary.sampleSize)
          : null,
      rowsSeen: summary.rowsSeen,
      sampleSize: summary.sampleSize,
    }))
    .sort((left, right) => {
      if (left.actualsAvailable !== right.actualsAvailable) {
        return left.actualsAvailable ? -1 : 1;
      }
      return left.familyLabel.localeCompare(right.familyLabel);
    });
}
