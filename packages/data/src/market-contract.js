'use strict';

const CANONICAL_MARKET_TYPES = Object.freeze(['SPREAD', 'TOTAL', 'MONEYLINE']);
const LOCKABLE_SELECTIONS = Object.freeze(['HOME', 'AWAY', 'OVER', 'UNDER']);

function createMarketError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeToken(value) {
  return normalizeText(value).toUpperCase().replace(/[\s-]+/g, '_');
}

function normalizeMarketType(rawValue) {
  const token = normalizeToken(rawValue);
  if (!token) return null;

  if (token === 'MONEYLINE' || token === 'ML' || token === 'H2H') return 'MONEYLINE';
  if (token === 'SPREAD' || token === 'PUCK_LINE' || token === 'PUCKLINE') return 'SPREAD';
  if (token === 'TOTAL' || token === 'TOTALS' || token === 'OVER_UNDER' || token === 'OU') return 'TOTAL';
  return null;
}

function normalizeRecommendationType(recType) {
  const token = normalizeToken(recType);
  if (!token) return null;

  if (token === 'ML_HOME' || token === 'ML_AWAY') return 'MONEYLINE';
  if (token === 'SPREAD_HOME' || token === 'SPREAD_AWAY') return 'SPREAD';
  if (token === 'TOTAL_OVER' || token === 'TOTAL_UNDER') return 'TOTAL';
  if (token === 'PASS') return 'PASS';
  return null;
}

function parseLine(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;
  const line = Number(rawValue);
  if (!Number.isFinite(line)) return null;
  return Number(line.toString());
}

function normalizeMarketPeriod(rawValue) {
  const token = normalizeToken(rawValue);
  if (!token) return null;

  if (
    token === '1P' ||
    token === 'P1' ||
    token === 'FIRST_PERIOD' ||
    token === '1ST_PERIOD'
  ) {
    return '1P';
  }

  if (
    token === 'FULL_GAME' ||
    token === 'FULL' ||
    token === 'GAME' ||
    token === 'REGULATION'
  ) {
    return 'FULL_GAME';
  }

  return null;
}

function parseAmericanOdds(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return Math.trunc(rawValue);
  if (typeof rawValue !== 'string') return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function namesEqual(a, b) {
  if (!a || !b) return false;
  return String(a).trim().toUpperCase() === String(b).trim().toUpperCase();
}

function normalizeSelectionForMarket({ marketType, selection, homeTeam, awayTeam }) {
  const token = normalizeToken(selection);

  if (marketType === 'SPREAD') {
    if (token === 'OVER' || token === 'UNDER') {
      throw createMarketError(
        'INVALID_SPREAD_SELECTION',
        `Spread selection cannot be ${token}`,
        { marketType, selection }
      );
    }
    if (token === 'HOME' || token === 'HOME_TEAM' || namesEqual(selection, homeTeam)) return 'HOME';
    if (token === 'AWAY' || token === 'AWAY_TEAM' || namesEqual(selection, awayTeam)) return 'AWAY';
    throw createMarketError(
      'INVALID_SPREAD_SELECTION',
      `Invalid spread selection "${selection}"`,
      { marketType, selection, homeTeam, awayTeam }
    );
  }

  if (marketType === 'TOTAL') {
    if (token === 'OVER') return 'OVER';
    if (token === 'UNDER') return 'UNDER';
    if (
      token === 'HOME' ||
      token === 'AWAY' ||
      namesEqual(selection, homeTeam) ||
      namesEqual(selection, awayTeam)
    ) {
      throw createMarketError(
        'INVALID_TOTAL_SELECTION',
        `Total selection cannot be team side "${selection}"`,
        { marketType, selection }
      );
    }
    throw createMarketError(
      'INVALID_TOTAL_SELECTION',
      `Invalid total selection "${selection}"`,
      { marketType, selection }
    );
  }

  if (marketType === 'MONEYLINE') {
    if (token === 'OVER' || token === 'UNDER') {
      throw createMarketError(
        'INVALID_MONEYLINE_SELECTION',
        `Moneyline selection cannot be ${token}`,
        { marketType, selection }
      );
    }
    if (token === 'HOME' || token === 'HOME_TEAM' || namesEqual(selection, homeTeam)) return 'HOME';
    if (token === 'AWAY' || token === 'AWAY_TEAM' || namesEqual(selection, awayTeam)) return 'AWAY';
    throw createMarketError(
      'INVALID_MONEYLINE_SELECTION',
      `Invalid moneyline selection "${selection}"`,
      { marketType, selection, homeTeam, awayTeam }
    );
  }

  throw createMarketError(
    'INVALID_MARKET_TYPE',
    `Unsupported market type "${marketType}"`,
    { marketType, selection }
  );
}

function resolveMarketType(payload) {
  const rawMarketType = payload?.market_type;
  if (normalizeToken(rawMarketType) === 'INFO') return null;

  const fromMarket = normalizeMarketType(rawMarketType);
  if (fromMarket) return fromMarket;

  const fromBetType = normalizeMarketType(payload?.recommended_bet_type);
  if (fromBetType) return fromBetType;

  const fromRecommendationType = normalizeRecommendationType(payload?.recommendation?.type);
  if (fromRecommendationType === 'PASS') return null;
  if (fromRecommendationType) return fromRecommendationType;

  return null;
}

function resolveMarketPeriod(payload) {
  const candidates = [
    payload?.period,
    payload?.time_period,
    payload?.market?.period,
    payload?.market_context?.period,
    payload?.market_context?.wager?.period,
    payload?.pricing_trace?.period,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeMarketPeriod(candidate);
    if (normalized) return normalized;
  }

  return null;
}

function resolveSelectionRaw(payload) {
  if (payload?.selection && typeof payload.selection === 'object' && payload.selection !== null) {
    const side = payload.selection.side;
    if (side !== undefined && side !== null && side !== '') return side;

    const team = payload.selection.team;
    if (team !== undefined && team !== null && team !== '') return team;
  }

  if (payload?.prediction !== undefined && payload?.prediction !== null) return payload.prediction;
  return null;
}

function resolveLockedPrice(payload, marketType, selection, period = null) {
  const directPrice = parseAmericanOdds(payload?.price);
  if (directPrice !== null) return directPrice;

  const oddsContext = payload?.odds_context && typeof payload.odds_context === 'object'
    ? payload.odds_context
    : null;
  if (!oddsContext) return null;

  if (marketType === 'MONEYLINE') {
    if (selection === 'HOME') {
      return parseAmericanOdds(oddsContext.h2h_home ?? oddsContext.moneyline_home ?? null);
    }
    if (selection === 'AWAY') {
      return parseAmericanOdds(oddsContext.h2h_away ?? oddsContext.moneyline_away ?? null);
    }
  }

  if (marketType === 'SPREAD') {
    if (selection === 'HOME') {
      return parseAmericanOdds(oddsContext.spread_price_home ?? oddsContext.spread_home_odds ?? null);
    }
    if (selection === 'AWAY') {
      return parseAmericanOdds(oddsContext.spread_price_away ?? oddsContext.spread_away_odds ?? null);
    }
  }

  if (marketType === 'TOTAL') {
    const canonicalPeriod = normalizeMarketPeriod(period);
    if (canonicalPeriod === '1P') {
      if (selection === 'OVER') {
        return parseAmericanOdds(
          oddsContext.total_price_over_1p ??
            oddsContext.total_1p_price_over ??
            oddsContext.total_price_over ??
            null
        );
      }
      if (selection === 'UNDER') {
        return parseAmericanOdds(
          oddsContext.total_price_under_1p ??
            oddsContext.total_1p_price_under ??
            oddsContext.total_price_under ??
            null
        );
      }
      return null;
    }
    if (selection === 'OVER') return parseAmericanOdds(oddsContext.total_price_over ?? null);
    if (selection === 'UNDER') return parseAmericanOdds(oddsContext.total_price_under ?? null);
  }

  return null;
}

function formatLineForMarketKey(marketType, line) {
  if (marketType === 'MONEYLINE') return 'NA';
  const parsed = parseLine(line);
  if (parsed === null) return 'NA';
  return parsed.toString();
}

function buildMarketKey({ gameId, marketType, selection, line, period = null }) {
  if (!gameId) {
    throw createMarketError('MISSING_GAME_ID', 'Cannot build market key without gameId');
  }

  const canonicalMarketType = normalizeMarketType(marketType);
  if (!canonicalMarketType) {
    throw createMarketError('INVALID_MARKET_TYPE', `Cannot build market key for market "${marketType}"`);
  }

  if (!LOCKABLE_SELECTIONS.includes(selection)) {
    throw createMarketError('INVALID_SELECTION', `Cannot build market key for selection "${selection}"`);
  }

  const lineToken = formatLineForMarketKey(canonicalMarketType, line);
  const canonicalPeriod = normalizeMarketPeriod(period);
  if (canonicalPeriod === '1P') {
    return `${gameId}:${canonicalMarketType}:1P:${selection}:${lineToken}`;
  }
  return `${gameId}:${canonicalMarketType}:${selection}:${lineToken}`;
}

function toRecommendedBetType(canonicalMarketType) {
  if (canonicalMarketType === 'MONEYLINE') return 'moneyline';
  if (canonicalMarketType === 'SPREAD') return 'spread';
  if (canonicalMarketType === 'TOTAL') return 'total';
  return 'unknown';
}

function deriveLockedMarketContext(payload, options = {}) {
  const gameId = options.gameId ?? payload?.game_id ?? null;
  const homeTeam = options.homeTeam ?? payload?.home_team ?? null;
  const awayTeam = options.awayTeam ?? payload?.away_team ?? null;
  const requirePrice = options.requirePrice !== false;
  const requireLineForMarket = options.requireLineForMarket !== false;
  const kind = normalizeToken(payload?.kind || 'PLAY');
  const recType = normalizeRecommendationType(payload?.recommendation?.type);
  const marketType = resolveMarketType(payload);
  const period = resolveMarketPeriod(payload);
  const hasExplicitPlayableMarket = kind === 'PLAY' && Boolean(marketType);

  if (kind === 'EVIDENCE') return null;
  if (recType === 'PASS' && !hasExplicitPlayableMarket) return null;
  if (!marketType) return null;

  const rawSelection = resolveSelectionRaw(payload);
  const selection = normalizeSelectionForMarket({
    marketType,
    selection: rawSelection,
    homeTeam,
    awayTeam
  });

  const line = parseLine(payload?.line);
  if ((marketType === 'SPREAD' || marketType === 'TOTAL') && requireLineForMarket && line === null) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      `${marketType} requires line at lock time`,
      { marketType, selection, line: payload?.line }
    );
  }

  const lockedPrice = resolveLockedPrice(payload, marketType, selection, period);
  if (requirePrice && lockedPrice === null) {
    throw createMarketError(
      'MISSING_LOCKED_PRICE',
      `Locked play missing price for ${marketType}/${selection}`,
      { marketType, selection }
    );
  }

  const marketKey = buildMarketKey({
    gameId,
    marketType,
    selection,
    line,
    period,
  });

  return {
    marketType,
    selection,
    line,
    lockedPrice,
    marketKey,
    period,
  };
}

function formatMarketSelectionLabel(marketType, selection) {
  const canonicalMarketType = normalizeMarketType(marketType);
  if (!canonicalMarketType) {
    throw createMarketError('INVALID_MARKET_TYPE', `Cannot label unknown market type "${marketType}"`);
  }

  if (canonicalMarketType === 'SPREAD') {
    const side = normalizeSelectionForMarket({ marketType: 'SPREAD', selection, homeTeam: null, awayTeam: null });
    return side === 'HOME' ? 'Spread/Home' : 'Spread/Away';
  }

  if (canonicalMarketType === 'TOTAL') {
    const side = normalizeSelectionForMarket({ marketType: 'TOTAL', selection, homeTeam: null, awayTeam: null });
    return side === 'OVER' ? 'Total/Over' : 'Total/Under';
  }

  const side = normalizeSelectionForMarket({ marketType: 'MONEYLINE', selection, homeTeam: null, awayTeam: null });
  return side === 'HOME' ? 'ML/Home' : 'ML/Away';
}

module.exports = {
  CANONICAL_MARKET_TYPES,
  LOCKABLE_SELECTIONS,
  buildMarketKey,
  createMarketError,
  deriveLockedMarketContext,
  formatMarketSelectionLabel,
  normalizeMarketType,
  normalizeMarketPeriod,
  normalizeSelectionForMarket,
  parseAmericanOdds,
  parseLine,
  resolveMarketPeriod,
  resolveLockedPrice,
  toRecommendedBetType,
};
