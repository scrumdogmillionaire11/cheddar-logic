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

const PROJECTION_FAMILY_LABELS: Record<string, string> = {
  MLB_F5_TOTAL: 'MLB F5 Total',
  MLB_PITCHER_K: 'MLB Pitcher K',
  NHL_1P_TOTAL: 'NHL 1P Total',
  NHL_PLAYER_SHOTS: 'NHL Player Shots',
  NHL_PLAYER_SHOTS_1P: 'NHL Player Shots 1P',
};

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
  if (cardFamily === 'MLB_F5_TOTAL') {
    return toNumber(row.gameResultMetadata?.f5_total);
  }
  if (cardFamily === 'MLB_PITCHER_K') {
    return null;
  }
  return null;
}

export function buildProjectionSummaries(
  rows: ProjectionMetricInputRow[],
): ProjectionSummaryRow[] {
  const grouped = new Map<string, ProjectionAccumulator>();

  for (const row of rows) {
    if (deriveResultCardMode(row.payload) !== 'PROJECTION_ONLY') continue;

    const cardFamily = deriveProjectionCardFamily(row);
    const accumulator =
      grouped.get(cardFamily) ||
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
