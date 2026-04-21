'use strict';

/**
 * settlement-annotation.js
 *
 * Pure, deterministic settlement interpretation layer.
 * Extracted from settle_pending_cards.js (WI-1108).
 *
 * CONTRACT:
 *   - No DB access
 *   - No logging side effects
 *   - No environment reads
 *   - No mutation of upstream inputs
 *   - Same input always produces same output
 *
 * Responsibilities:
 *   - Map raw game results → settlement outcomes (win/loss/push/void/no_contest)
 *   - Apply annotation fields and reason codes
 *   - Produce deterministic settlement output or patch object
 */

const {
  buildMarketKey,
  createMarketError,
  normalizeMarketType,
  normalizeSelectionForMarket,
  parseLine,
} = require('@cheddar-logic/data');

// ─────────────────────────────────────────────────────────────────────────────
// Primitive utilities
// ─────────────────────────────────────────────────────────────────────────────

function parseLockedPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Period resolution
// ─────────────────────────────────────────────────────────────────────────────

function normalizePeriodToken(value) {
  const token = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_');
  if (!token) return null;
  if (
    token === '1P' ||
    token === 'P1' ||
    token === 'FIRST_PERIOD' ||
    token === 'FIRST_5_INNINGS' ||
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

function normalizeSettlementPeriod(value, cardType = null) {
  const normalized = normalizePeriodToken(value);
  if (normalized) return normalized;

  const cardTypeToken = String(cardType || '').toUpperCase();
  if (
    cardTypeToken.includes('1P') ||
    cardTypeToken.includes('FIRST_PERIOD') ||
    cardTypeToken.includes('FIRST_5_INNINGS')
  ) {
    return '1P';
  }

  return 'FULL_GAME';
}

function extractSettlementPeriod({ row, payloadData, cardResultMetadata }) {
  return normalizeSettlementPeriod(
    payloadData?.period ??
      payloadData?.time_period ??
      payloadData?.market?.period ??
      payloadData?.market_context?.period ??
      payloadData?.market_context?.wager?.period ??
      cardResultMetadata?.lockedMarket?.period ??
      cardResultMetadata?.period ??
      null,
    row?.card_type,
  );
}

/**
 * Merge a derived market_period_token into an existing metadata object without
 * overwriting any other fields. Returns a new plain object — does not mutate input.
 */
function deriveAndMergePeriodToken({ existingMeta, token }) {
  const base = existingMeta && typeof existingMeta === 'object' ? existingMeta : {};
  return { ...base, market_period_token: token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Score reading
// ─────────────────────────────────────────────────────────────────────────────

function readFirstPeriodScores(gameResultMetadata) {
  if (!gameResultMetadata || typeof gameResultMetadata !== 'object') {
    return { home: null, away: null };
  }

  const verification =
    gameResultMetadata.firstPeriodVerification &&
    typeof gameResultMetadata.firstPeriodVerification === 'object'
      ? gameResultMetadata.firstPeriodVerification
      : null;
  if (verification && verification.isComplete === false) {
    return { home: null, away: null };
  }

  const fromFirstPeriodScores = gameResultMetadata.firstPeriodScores;
  if (fromFirstPeriodScores && typeof fromFirstPeriodScores === 'object') {
    const home = Number(fromFirstPeriodScores.home);
    const away = Number(fromFirstPeriodScores.away);
    if (Number.isFinite(home) && Number.isFinite(away)) {
      return { home, away };
    }
  }

  const fromSnakeCase = gameResultMetadata.first_period_scores;
  if (fromSnakeCase && typeof fromSnakeCase === 'object') {
    const home = Number(fromSnakeCase.home);
    const away = Number(fromSnakeCase.away);
    if (Number.isFinite(home) && Number.isFinite(away)) {
      return { home, away };
    }
  }

  return { home: null, away: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decision basis resolution
// ─────────────────────────────────────────────────────────────────────────────

function resolveDecisionBasisForSettlement(payloadData) {
  const explicit = toUpperToken(
    payloadData?.decision_basis_meta?.decision_basis ??
      payloadData?.basis ??
      payloadData?.decision_basis,
  );
  if (explicit === 'PROJECTION_ONLY' || explicit === 'ODDS_BACKED') {
    return explicit;
  }

  const lineSource = toUpperToken(
    payloadData?.decision_basis_meta?.market_line_source ||
      payloadData?.market_context?.wager?.line_source ||
      payloadData?.line_source,
  );
  if (lineSource === 'PROJECTION_FLOOR' || lineSource === 'SYNTHETIC') {
    return 'PROJECTION_ONLY';
  }

  return 'ODDS_BACKED';
}

// ─────────────────────────────────────────────────────────────────────────────
// Player identity helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalizePlayerName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolvePlayerShotsActualValue({ gameResultMetadata, playerId, playerName, period }) {
  const playerShots =
    gameResultMetadata?.playerShots && typeof gameResultMetadata.playerShots === 'object'
      ? gameResultMetadata.playerShots
      : null;

  if (!playerShots) {
    throw createMarketError(
      'MISSING_PLAYER_SHOTS_DATA',
      'Missing player-shots metadata required for NHL prop settlement',
      { period },
    );
  }

  const normalizedPeriod = normalizeSettlementPeriod(period);
  const usingFirstPeriod = normalizedPeriod === '1P';

  if (usingFirstPeriod) {
    const verification =
      gameResultMetadata.firstPeriodVerification &&
      typeof gameResultMetadata.firstPeriodVerification === 'object'
        ? gameResultMetadata.firstPeriodVerification
        : null;
    if (verification && verification.isComplete === false) {
      throw createMarketError(
        'PERIOD_NOT_COMPLETE',
        'First period not yet complete — cannot grade 1P player shots',
        { period: normalizedPeriod, gameState: verification.gameState ?? null },
      );
    }
  }

  const byPlayerId = usingFirstPeriod
    ? playerShots.firstPeriodByPlayerId
    : playerShots.fullGameByPlayerId;
  if (!byPlayerId || typeof byPlayerId !== 'object') {
    throw createMarketError(
      usingFirstPeriod
        ? 'MISSING_PERIOD_PLAYER_SHOTS_DATA'
        : 'MISSING_PLAYER_SHOTS_DATA',
      usingFirstPeriod
        ? 'Missing first-period player shots required for NHL 1P prop settlement'
        : 'Missing full-game player shots required for NHL prop settlement',
      { period: normalizedPeriod },
    );
  }

  const resolvedAttempts = [];

  const directById = playerId ? Number(byPlayerId[String(playerId)]) : null;
  if (Number.isFinite(directById)) {
    return directById;
  }
  if (playerId) resolvedAttempts.push('id');

  const normalizedName = normalizePlayerName(playerName);
  if (!normalizedName) {
    throw createMarketError(
      'MISSING_PLAYER_IDENTITY',
      'Unable to resolve player identity for NHL shots settlement',
      { playerId, playerName, resolvedAttempts },
    );
  }
  resolvedAttempts.push('name');

  const playerIdByNormalizedName =
    playerShots.playerIdByNormalizedName &&
    typeof playerShots.playerIdByNormalizedName === 'object'
      ? playerShots.playerIdByNormalizedName
      : {};
  const mappedPlayerId = playerIdByNormalizedName[normalizedName];
  if (mappedPlayerId && Number.isFinite(Number(byPlayerId[String(mappedPlayerId)]))) {
    return Number(byPlayerId[String(mappedPlayerId)]);
  }

  throw createMarketError(
    usingFirstPeriod
      ? 'MISSING_PERIOD_PLAYER_SHOTS_VALUE'
      : 'MISSING_PLAYER_SHOTS_VALUE',
    usingFirstPeriod
      ? 'Missing first-period shots value for player'
      : 'Missing full-game shots value for player',
    {
      playerId,
      playerName,
      period: normalizedPeriod,
      resolvedAttempts,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Core grading functions
// ─────────────────────────────────────────────────────────────────────────────

function gradeMlbPitcherKMarket({ selection, line, actualStrikeouts }) {
  if (!Number.isFinite(actualStrikeouts)) {
    throw createMarketError(
      'MISSING_PITCHER_KS_VALUE',
      'Missing pitcher strikeout total required for settlement',
      { actualStrikeouts },
    );
  }
  if (!Number.isFinite(line)) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      'Pitcher-K settlement requires a finite line',
      { line },
    );
  }

  if (actualStrikeouts > line) return selection === 'OVER' ? 'win' : 'loss';
  if (actualStrikeouts < line) return selection === 'UNDER' ? 'win' : 'loss';
  return 'push';
}

function gradeNhlPlayerShotsMarket({ selection, line, actualShots }) {
  if (!Number.isFinite(actualShots)) {
    throw createMarketError(
      'MISSING_PLAYER_SHOTS_VALUE',
      'Missing player shots value required for settlement',
      { actualShots },
    );
  }
  if (!Number.isFinite(line)) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      'Player shots settlement requires a finite line',
      { line },
    );
  }

  if (actualShots > line) return selection === 'OVER' ? 'win' : 'loss';
  if (actualShots < line) return selection === 'UNDER' ? 'win' : 'loss';
  return 'push';
}

function gradeLockedMarket({
  marketType,
  selection,
  line,
  homeScore,
  awayScore,
  period = 'FULL_GAME',
  firstPeriodScores = null,
}) {
  const toFiniteScore = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const normalizedPeriod = normalizeSettlementPeriod(period);
  const usingFirstPeriod = normalizedPeriod === '1P';
  const settledHomeScore = usingFirstPeriod
    ? toFiniteScore(firstPeriodScores?.home)
    : toFiniteScore(homeScore);
  const settledAwayScore = usingFirstPeriod
    ? toFiniteScore(firstPeriodScores?.away)
    : toFiniteScore(awayScore);

  if (!Number.isFinite(settledHomeScore) || !Number.isFinite(settledAwayScore)) {
    throw createMarketError(
      usingFirstPeriod ? 'MISSING_PERIOD_SCORE' : 'MISSING_FINAL_SCORE',
      usingFirstPeriod
        ? 'Missing first-period scores required for 1P settlement'
        : 'Missing final scores required for settlement',
      {
        marketType,
        period: normalizedPeriod,
        homeScore,
        awayScore,
        firstPeriodScores,
      },
    );
  }

  if (marketType === 'MONEYLINE') {
    if (selection === 'HOME') {
      if (settledHomeScore > settledAwayScore) return 'win';
      if (settledHomeScore < settledAwayScore) return 'loss';
      return 'push';
    }

    if (settledAwayScore > settledHomeScore) return 'win';
    if (settledAwayScore < settledHomeScore) return 'loss';
    return 'push';
  }

  if (marketType === 'SPREAD') {
    if (!Number.isFinite(line)) {
      throw createMarketError(
        'MISSING_MARKET_LINE',
        'Spread settlement requires finite line',
        { marketType, selection, line },
      );
    }

    const diff =
      selection === 'HOME'
        ? settledHomeScore + line - settledAwayScore
        : settledAwayScore + line - settledHomeScore;

    if (diff > 0) return 'win';
    if (diff < 0) return 'loss';
    return 'push';
  }

  if (!Number.isFinite(line)) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      'Total settlement requires finite line',
      { marketType, selection, line },
    );
  }

  const actualTotal = settledHomeScore + settledAwayScore;
  if (actualTotal > line) return selection === 'OVER' ? 'win' : 'loss';
  if (actualTotal < line) return selection === 'UNDER' ? 'win' : 'loss';
  return 'push';
}

// ─────────────────────────────────────────────────────────────────────────────
// Market classification
// ─────────────────────────────────────────────────────────────────────────────

function resolveSettlementMarketBucket({ sport, marketType, period }) {
  const normalizedSport = String(sport || '').toUpperCase();
  const normalizedMarketType = String(marketType || '').toUpperCase();
  const normalizedPeriod = normalizeSettlementPeriod(period);
  if (
    (normalizedSport === 'MLB' || normalizedSport === 'BASEBALL_MLB') &&
    normalizedMarketType === 'MONEYLINE' &&
    normalizedPeriod !== '1P'
  ) {
    return 'MLB_MONEYLINE';
  }
  if (
    (normalizedSport === 'MLB' || normalizedSport === 'BASEBALL_MLB') &&
    normalizedMarketType === 'TOTAL' &&
    normalizedPeriod !== '1P'
  ) {
    return 'MLB_TOTAL';
  }
  if (normalizedSport === 'NHL' && normalizedMarketType === 'MONEYLINE') {
    return 'NHL_MONEYLINE';
  }
  if (normalizedMarketType !== 'TOTAL') return null;

  if (normalizedSport === 'NBA' && normalizedPeriod !== '1P') {
    return 'NBA_TOTAL';
  }
  if (normalizedSport === 'NHL' && normalizedPeriod === '1P') {
    return 'NHL_1P_TOTAL';
  }
  if (normalizedSport === 'NHL' && normalizedPeriod !== '1P') {
    return 'NHL_TOTAL';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// P&L computation
// ─────────────────────────────────────────────────────────────────────────────

function computePnlUnits(result, odds) {
  if (result === 'push') return 0.0;
  if (result === 'loss') return -1.0;
  if (result !== 'win') return null;
  if (!Number.isFinite(odds) || odds === 0) return null;

  if (odds > 0) {
    return odds / 100;
  }

  return 100 / Math.abs(odds);
}

function computePnlOutcome(result, odds) {
  const pnlUnits = computePnlUnits(result, odds);
  if (result === 'win' && pnlUnits === null) {
    return {
      pnlUnits: null,
      anomalyCode: 'PNL_ODDS_INVALID',
      anomalyMessage:
        'Win settlement had null/invalid/zero American odds; pnl_units left NULL',
    };
  }

  return {
    pnlUnits,
    anomalyCode: null,
    anomalyMessage: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement context preparation (pure — no DB access)
// ─────────────────────────────────────────────────────────────────────────────

function assertLockedMarketContext(
  row,
  payloadData,
  { period = 'FULL_GAME' } = {},
) {
  if (!row.market_key) {
    throw createMarketError(
      'SETTLEMENT_REQUIRES_MARKET_KEY',
      `Card ${row.card_id} cannot settle without market_key`,
      { cardId: row.card_id, gameId: row.game_id },
    );
  }

  const marketType = normalizeMarketType(row.market_type);
  if (!marketType) {
    throw createMarketError(
      'INVALID_MARKET_TYPE',
      `Card ${row.card_id} has invalid stored market_type "${row.market_type}"`,
      { cardId: row.card_id, marketType: row.market_type },
    );
  }

  const selection = normalizeSelectionForMarket({
    marketType,
    selection: row.selection,
    homeTeam: payloadData?.home_team ?? null,
    awayTeam: payloadData?.away_team ?? null,
  });

  const line = parseLine(row.line);
  if ((marketType === 'SPREAD' || marketType === 'TOTAL') && line === null) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      `Card ${row.card_id} missing line for ${marketType} settlement`,
      { cardId: row.card_id, marketType, line: row.line },
    );
  }

  const lockedPrice = parseLockedPrice(row.locked_price);

  const expectedMarketKey = buildMarketKey({
    gameId: row.game_id,
    marketType,
    selection,
    line,
    period,
  });

  if (expectedMarketKey !== row.market_key) {
    throw createMarketError(
      'MARKET_KEY_MISMATCH',
      `Card ${row.card_id} market_key mismatch`,
      {
        cardId: row.card_id,
        marketKey: row.market_key,
        expectedMarketKey,
      },
    );
  }

  return {
    marketKey: row.market_key,
    marketType,
    selection,
    line,
    lockedPrice,
    period,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NHL shots settlement context
// ─────────────────────────────────────────────────────────────────────────────

function resolveNhlShotsSettlementContext(row, payloadData, cardResultMetadata) {
  const period = normalizeSettlementPeriod(
    payloadData?.play?.period ??
      payloadData?.period ??
      cardResultMetadata?.lockedMarket?.period ??
      'FULL_GAME',
    row?.card_type,
  );

  const rawSelection =
    payloadData?.play?.selection?.side ??
    payloadData?.selection?.side ??
    payloadData?.selection ??
    null;
  const selection = String(rawSelection || '').trim().toUpperCase();
  if (selection !== 'OVER' && selection !== 'UNDER') {
    throw createMarketError(
      'INVALID_PROP_SELECTION',
      `Card ${row.card_id} missing valid player-prop selection`,
      { cardId: row.card_id, selection: rawSelection },
    );
  }

  const lineRaw =
    payloadData?.play?.selection?.line ??
    payloadData?.line ??
    payloadData?.threshold ??
    null;
  const line = parseLine(lineRaw);
  if (!Number.isFinite(line)) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      `Card ${row.card_id} missing player-prop line`,
      { cardId: row.card_id, line: lineRaw },
    );
  }

  const playerId = String(
    payloadData?.play?.player_id || payloadData?.player_id || '',
  ).trim();
  const playerName = String(
    payloadData?.play?.player_name || payloadData?.player_name || '',
  ).trim();
  if (!playerId && !playerName) {
    throw createMarketError(
      'MISSING_PLAYER_IDENTITY',
      `Card ${row.card_id} missing player id/name for shots settlement`,
      { cardId: row.card_id },
    );
  }

  const lockedPrice = parseLockedPrice(
    row?.locked_price ?? payloadData?.play?.selection?.price ?? payloadData?.price,
  );

  return {
    marketKey:
      row?.market_key ||
      `${row?.game_id || 'unknown'}:PROP_SHOTS_ON_GOAL:${period}:${selection}:${line}`,
    marketType: 'TOTAL',
    period,
    selection,
    line,
    playerId,
    playerName,
    lockedPrice,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MLB pitcher-K settlement context
// ─────────────────────────────────────────────────────────────────────────────

function resolvePitcherKProjectionSettlement(cardResultMetadata) {
  const projectionSettlement =
    cardResultMetadata?.projection_settlement &&
    typeof cardResultMetadata.projection_settlement === 'object'
      ? cardResultMetadata.projection_settlement
      : null;
  if (!projectionSettlement) return null;

  const code = String(projectionSettlement.code || '').trim();
  if (!code) return null;
  return {
    code,
    message:
      String(projectionSettlement.message || '').trim() ||
      'Pitcher-K projection settlement ended in a terminal capture failure',
    final: projectionSettlement.final === true,
  };
}

function resolveMlbPitcherKActualValue(actualResultData) {
  const actualStrikeouts = Number(actualResultData?.pitcher_ks);
  return Number.isFinite(actualStrikeouts) ? actualStrikeouts : null;
}

function resolveMlbPitcherKSettlementContext(
  row,
  payloadData,
  cardResultMetadata,
  actualResultData,
) {
  const projectionSettlement = resolvePitcherKProjectionSettlement(cardResultMetadata);
  if (
    projectionSettlement &&
    (projectionSettlement.code === 'PROJECTION_SETTLEMENT_NO_GAME_PK' ||
      projectionSettlement.code === 'PROJECTION_SETTLEMENT_NO_PLAYER_MATCH')
  ) {
    throw createMarketError(projectionSettlement.code, projectionSettlement.message, {
      cardId: row?.card_id,
      gameId: row?.game_id,
    });
  }

  const decisionBasis = resolveDecisionBasisForSettlement(payloadData);
  const actualStrikeouts = resolveMlbPitcherKActualValue(actualResultData);

  if (decisionBasis === 'PROJECTION_ONLY') {
    if (Number.isFinite(actualStrikeouts)) {
      throw createMarketError(
        'PROJECTION_ONLY_NOT_GRADEABLE',
        'Projection-only pitcher-K rows are factual-tracking only and cannot be graded',
        {
          cardId: row?.card_id,
          gameId: row?.game_id,
          actualStrikeouts,
        },
      );
    }
    return null;
  }

  if (!Number.isFinite(actualStrikeouts)) {
    return null;
  }

  const rawSelection =
    payloadData?.selection?.side ??
    payloadData?.prop_decision?.lean_side ??
    payloadData?.direction ??
    null;
  const selection = toUpperToken(rawSelection);
  if (selection !== 'OVER' && selection !== 'UNDER') {
    throw createMarketError(
      'INVALID_PROP_SELECTION',
      `Card ${row?.card_id} missing valid pitcher-K selection`,
      { cardId: row?.card_id, selection: rawSelection },
    );
  }

  const rawLine =
    payloadData?.line ??
    payloadData?.prop_decision?.line ??
    payloadData?.pitcher_k_line_contract?.line ??
    null;
  const line = parseLine(rawLine);
  if (!Number.isFinite(line)) {
    throw createMarketError(
      'MISSING_MARKET_LINE',
      `Card ${row?.card_id} missing pitcher-K line`,
      { cardId: row?.card_id, line: rawLine },
    );
  }

  const playerId = String(payloadData?.player_id || '').trim();
  const playerName = String(payloadData?.player_name || '').trim();
  if (!playerId && !playerName) {
    throw createMarketError(
      'MISSING_PLAYER_IDENTITY',
      `Card ${row?.card_id} missing pitcher id/name for settlement`,
      { cardId: row?.card_id, gameId: row?.game_id },
    );
  }

  const lockedPrice = parseLockedPrice(
    row?.locked_price ??
      payloadData?.price ??
      (selection === 'OVER' ? payloadData?.over_price : payloadData?.under_price),
  );

  return {
    actualStrikeouts,
    lockedMarket: {
      marketKey:
        row?.market_key ||
        `${row?.game_id || 'unknown'}:PROP_STRIKEOUTS:FULL_GAME:${selection}:${line}`,
      marketType: 'PROP',
      propType: 'strikeouts',
      period: 'FULL_GAME',
      selection,
      line,
      lockedPrice,
      playerId,
      playerName,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  parseLockedPrice,
  toUpperToken,
  normalizePeriodToken,
  normalizeSettlementPeriod,
  extractSettlementPeriod,
  deriveAndMergePeriodToken,
  readFirstPeriodScores,
  resolveDecisionBasisForSettlement,
  normalizePlayerName,
  resolvePlayerShotsActualValue,
  gradeMlbPitcherKMarket,
  gradeNhlPlayerShotsMarket,
  gradeLockedMarket,
  resolveSettlementMarketBucket,
  computePnlUnits,
  computePnlOutcome,
  assertLockedMarketContext,
  resolveNhlShotsSettlementContext,
  resolvePitcherKProjectionSettlement,
  resolveMlbPitcherKActualValue,
  resolveMlbPitcherKSettlementContext,
};
