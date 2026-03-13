/**
 * Settle Pending Cards Job
 *
 * Resolves pending card_results rows by joining with final game_results,
 * applying win/loss/push logic, and computing tracking_stats aggregates.
 * Closes Gap 2 and Gap 3 from SETTLEMENT_AUDIT.md.
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/settle_pending_cards.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:settle-cards)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const dbBackup = require('../utils/db-backup.js');

const {
  buildMarketKey,
  createMarketError,
  incrementTrackingStat,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  normalizeMarketType,
  normalizeSelectionForMarket,
  parseLine,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

function parseLockedPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function toBackfillUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function toBackfillFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeBackfillMarketType(value) {
  const token = toBackfillUpperToken(value);
  if (!token) return '';
  if (token === 'FIRST_PERIOD' || token === '1P' || token === 'P1') {
    return 'TOTAL';
  }
  if (token === 'TOTAL' || token === 'TOTALS' || token === 'OVER_UNDER' || token === 'OU') {
    return 'TOTAL';
  }
  if (token === 'MONEYLINE' || token === 'ML' || token === 'H2H') {
    return 'MONEYLINE';
  }
  if (token === 'SPREAD' || token === 'PUCKLINE' || token === 'PUCK_LINE') {
    return 'SPREAD';
  }
  return token;
}

function resolveBackfillOfficialStatus(payloadData) {
  const explicit = toBackfillUpperToken(payloadData?.decision_v2?.official_status);
  if (explicit === 'PLAY' || explicit === 'LEAN' || explicit === 'PASS') {
    return explicit;
  }
  const fallbackStatus = toBackfillUpperToken(payloadData?.status);
  if (fallbackStatus === 'FIRE') return 'PLAY';
  if (fallbackStatus === 'WATCH') return 'LEAN';
  if (fallbackStatus === 'PASS') return 'PASS';
  return '';
}

function resolveBackfillSelection(payloadData, fallbackSelection) {
  return toBackfillUpperToken(
    fallbackSelection ??
      payloadData?.selection?.side ??
      payloadData?.selection ??
      null,
  );
}

function resolveBackfillKind(payloadData) {
  return toBackfillUpperToken(payloadData?.kind || 'PLAY');
}

function toBackfillConfidencePct(payloadData, fallbackValue = null) {
  const confidencePct = toBackfillFiniteNumberOrNull(payloadData?.confidence_pct);
  if (confidencePct !== null) return confidencePct;
  const confidence = toBackfillFiniteNumberOrNull(payloadData?.confidence);
  if (confidence !== null) return confidence * 100;
  return toBackfillFiniteNumberOrNull(fallbackValue) ?? 0;
}

function rankBackfillOfficialStatus(officialStatus) {
  if (officialStatus === 'PLAY') return 2;
  if (officialStatus === 'LEAN') return 1;
  return 0;
}

function toBackfillSortableNumber(value, fallback = -Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function safeBackfillTimestampMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function getBackfillPerformanceFactor(db, params, cache) {
  const sport = toBackfillUpperToken(params?.sport);
  const marketType = toBackfillUpperToken(params?.marketType);
  const anchorIso = params?.anchorIso || new Date().toISOString();
  const cacheKey = `${sport}|${marketType}|${String(anchorIso).slice(0, 10)}`;

  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!sport || !marketType) {
    const fallback = { factor: 1, sampleSize: 0 };
    cache.set(cacheKey, fallback);
    return fallback;
  }

  const row = db
    .prepare(
      `
      SELECT
        SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) AS losses
      FROM card_results
      WHERE status = 'settled'
        AND UPPER(COALESCE(sport, '')) = ?
        AND UPPER(COALESCE(market_type, '')) = ?
        AND datetime(COALESCE(settled_at, CURRENT_TIMESTAMP)) >= datetime(?, '-30 days')
    `,
    )
    .get(sport, marketType, anchorIso);

  const wins = Number(row?.wins || 0);
  const losses = Number(row?.losses || 0);
  const sampleSize = wins + losses;
  const factor = sampleSize >= 25 && sampleSize > 0 ? wins / sampleSize : 1;
  const result = { factor, sampleSize };
  cache.set(cacheKey, result);
  return result;
}

function buildBackfillRankContext(db, candidate, cache) {
  const payloadData =
    candidate?.payloadData && typeof candidate.payloadData === 'object'
      ? candidate.payloadData
      : {};
  const officialStatus = resolveBackfillOfficialStatus(payloadData);
  const statusRank = rankBackfillOfficialStatus(officialStatus);
  const confidencePct = toBackfillConfidencePct(
    payloadData,
    candidate?.confidencePct,
  );
  const perf = getBackfillPerformanceFactor(
    db,
    {
      sport: candidate?.sport,
      marketType: candidate?.marketType,
      anchorIso: candidate?.displayedAt || new Date().toISOString(),
    },
    cache,
  );

  return {
    statusRank,
    weightedConfidence: confidencePct * perf.factor,
    edgePct: toBackfillSortableNumber(payloadData?.decision_v2?.edge_pct),
    supportScore: toBackfillSortableNumber(payloadData?.decision_v2?.support_score),
    displayedAtMs: safeBackfillTimestampMs(candidate?.displayedAt),
    pickId: String(candidate?.pickId || ''),
  };
}

function compareBackfillRank(a, b) {
  if (a.statusRank !== b.statusRank) return a.statusRank - b.statusRank;
  if (a.weightedConfidence !== b.weightedConfidence) {
    return a.weightedConfidence - b.weightedConfidence;
  }
  if (a.edgePct !== b.edgePct) return a.edgePct - b.edgePct;
  if (a.supportScore !== b.supportScore) return a.supportScore - b.supportScore;
  if (a.displayedAtMs !== b.displayedAtMs) return a.displayedAtMs - b.displayedAtMs;
  if (a.pickId === b.pickId) return 0;
  return a.pickId > b.pickId ? 1 : -1;
}

function isBackfillCandidateEligible(candidate) {
  if (toBackfillUpperToken(candidate?.kind) !== 'PLAY') return false;
  const officialStatus = toBackfillUpperToken(candidate?.officialStatus);
  if (officialStatus !== 'PLAY' && officialStatus !== 'LEAN') return false;

  const sport = toBackfillUpperToken(candidate?.sport);
  const marketType = toBackfillUpperToken(candidate?.marketType);
  const selection = toBackfillUpperToken(candidate?.selection);
  const line = toBackfillFiniteNumberOrNull(candidate?.line);
  const odds = toBackfillFiniteNumberOrNull(candidate?.odds);
  if (!sport || !marketType) return false;

  if (marketType === 'MONEYLINE') {
    return (selection === 'HOME' || selection === 'AWAY') && odds !== null;
  }
  if (marketType === 'SPREAD') {
    return (
      (selection === 'HOME' || selection === 'AWAY') &&
      line !== null &&
      odds !== null
    );
  }
  if (marketType === 'TOTAL') {
    return (
      (selection === 'OVER' || selection === 'UNDER') &&
      line !== null &&
      odds !== null
    );
  }
  return false;
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

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
  if (cardTypeToken.includes('1P') || cardTypeToken.includes('FIRST_PERIOD')) {
    return '1P';
  }

  return 'FULL_GAME';
}

function extractSettlementPeriod({
  row,
  payloadData,
  cardResultMetadata,
}) {
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

function readFirstPeriodScores(gameResultMetadata) {
  if (!gameResultMetadata || typeof gameResultMetadata !== 'object') {
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

function resolveSettlementMarketBucket({
  sport,
  marketType,
  period,
}) {
  const normalizedSport = String(sport || '').toUpperCase();
  const normalizedMarketType = String(marketType || '').toUpperCase();
  const normalizedPeriod = normalizeSettlementPeriod(period);
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

function assertLockedMarketContext(
  row,
  payloadData,
  {
    period = 'FULL_GAME',
  } = {},
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

function backfillDisplayedPlaysFromPayloads(db) {
  const candidateRows = db
    .prepare(
      `
      SELECT
        cp.id AS pick_id,
        cp.run_id AS run_id,
        cp.game_id AS game_id,
        UPPER(COALESCE(cdl.sport, cp.sport, cr.sport)) AS sport,
        UPPER(COALESCE(cr.market_type, json_extract(cp.payload_data, '$.market_type'))) AS market_type_token,
        UPPER(COALESCE(cr.selection, json_extract(cp.payload_data, '$.selection.side'), json_extract(cp.payload_data, '$.selection'))) AS selection,
        COALESCE(cr.line, CAST(json_extract(cp.payload_data, '$.line') AS REAL)) AS line,
        COALESCE(cr.locked_price, CAST(json_extract(cp.payload_data, '$.price') AS REAL)) AS odds,
        COALESCE(
          CAST(json_extract(cp.payload_data, '$.confidence_pct') AS REAL),
          CAST(json_extract(cp.payload_data, '$.confidence') AS REAL) * 100.0
        ) AS confidence_pct,
        cp.payload_data AS payload_data,
        COALESCE(cdl.displayed_at, cp.created_at, CURRENT_TIMESTAMP) AS displayed_at
      FROM card_payloads cp
      INNER JOIN card_results cr ON cr.card_id = cp.id
      LEFT JOIN card_display_log cdl ON cdl.pick_id = cp.id
      WHERE COALESCE(cr.market_key, json_extract(cp.payload_data, '$.market_key')) IS NOT NULL
    `,
    )
    .all();

  const rankCache = new Map();
  const bestByPartition = new Map();

  for (const row of candidateRows) {
    const payloadData = parseJsonObject(row.payload_data) || {};
    const pickId = row.pick_id == null ? '' : String(row.pick_id).trim();
    const gameId = row.game_id == null ? '' : String(row.game_id).trim();
    if (!pickId || !gameId) continue;
    const marketType = normalizeBackfillMarketType(
      row.market_type_token || payloadData?.market_type,
    );
    const candidate = {
      pickId,
      runId: row.run_id == null || row.run_id === '' ? null : String(row.run_id),
      gameId,
      sport: toBackfillUpperToken(row.sport),
      marketType,
      selection: resolveBackfillSelection(payloadData, row.selection),
      line: toBackfillFiniteNumberOrNull(row.line),
      odds: toBackfillFiniteNumberOrNull(row.odds),
      confidencePct: toBackfillFiniteNumberOrNull(row.confidence_pct),
      displayedAt: row.displayed_at || new Date().toISOString(),
      payloadData,
      kind: resolveBackfillKind(payloadData),
      officialStatus: resolveBackfillOfficialStatus(payloadData),
    };

    if (!isBackfillCandidateEligible(candidate)) continue;
    const rankContext = buildBackfillRankContext(db, candidate, rankCache);
    const partitionKey = `${candidate.runId || ''}|${candidate.gameId}`;
    const existing = bestByPartition.get(partitionKey);
    if (!existing || compareBackfillRank(rankContext, existing.rankContext) > 0) {
      bestByPartition.set(partitionKey, { candidate, rankContext });
    }
  }

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO card_display_log (
      pick_id,
      run_id,
      game_id,
      sport,
      market_type,
      selection,
      line,
      odds,
      odds_book,
      confidence_pct,
      displayed_at,
      api_endpoint
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, '/api/games')
  `);
  const updateStmt = db.prepare(`
    UPDATE card_display_log
    SET
      pick_id = ?,
      sport = ?,
      market_type = ?,
      selection = ?,
      line = ?,
      odds = ?,
      confidence_pct = ?,
      displayed_at = ?,
      api_endpoint = '/api/games'
    WHERE id = ?
  `);
  const existingByPartitionWithRunStmt = db.prepare(`
    SELECT
      id,
      pick_id,
      sport,
      market_type,
      selection,
      line,
      odds,
      confidence_pct,
      displayed_at
    FROM card_display_log
    WHERE game_id = ?
      AND run_id = ?
    ORDER BY datetime(displayed_at) DESC, id DESC
    LIMIT 1
  `);
  const existingByPartitionNoRunStmt = db.prepare(`
    SELECT
      id,
      pick_id,
      sport,
      market_type,
      selection,
      line,
      odds,
      confidence_pct,
      displayed_at
    FROM card_display_log
    WHERE game_id = ?
      AND run_id IS NULL
    ORDER BY datetime(displayed_at) DESC, id DESC
    LIMIT 1
  `);
  const payloadByPickStmt = db.prepare(`
    SELECT payload_data
    FROM card_payloads
    WHERE id = ?
    LIMIT 1
  `);

  let changes = 0;
  for (const { candidate, rankContext } of bestByPartition.values()) {
    const partitionRunId =
      candidate.runId == null ? null : String(candidate.runId);
    const lookupArgs =
      partitionRunId === null
        ? [candidate.gameId]
        : [candidate.gameId, partitionRunId];
    if (lookupArgs.some((value) => value === undefined)) {
      continue;
    }

    let incumbent = null;
    try {
      incumbent =
        partitionRunId === null
          ? existingByPartitionNoRunStmt.get(candidate.gameId)
          : existingByPartitionWithRunStmt.get(candidate.gameId, partitionRunId);
    } catch (lookupError) {
      console.warn(
        `[SettleCards] Display backfill partition lookup failed for ${candidate.pickId}; proceeding without incumbent comparison (${lookupError.message})`,
      );
      incumbent = null;
    }

    if (!incumbent) {
      const insertArgs = [
        candidate.pickId,
        candidate.runId ?? null,
        candidate.gameId,
        candidate.sport,
        candidate.marketType,
        candidate.selection,
        candidate.line ?? null,
        candidate.odds ?? null,
        toBackfillConfidencePct(candidate.payloadData, candidate.confidencePct),
        candidate.displayedAt ?? new Date().toISOString(),
      ];
      if (insertArgs.some((value) => value === undefined)) {
        continue;
      }
      const inserted = insertStmt.run(...insertArgs);
      changes += Number(inserted?.changes || 0);
      continue;
    }

    if (String(incumbent.pick_id) === candidate.pickId) {
      continue;
    }

    const incumbentPayloadRow = payloadByPickStmt.get(String(incumbent.pick_id));
    const incumbentPayloadData = parseJsonObject(incumbentPayloadRow?.payload_data) || {};
    const incumbentRankContext = buildBackfillRankContext(
      db,
      {
        pickId: String(incumbent.pick_id),
        sport: toBackfillUpperToken(incumbent.sport),
        marketType: normalizeBackfillMarketType(
          incumbent.market_type || incumbentPayloadData?.market_type,
        ),
        confidencePct: toBackfillFiniteNumberOrNull(incumbent.confidence_pct),
        displayedAt: incumbent.displayed_at,
        payloadData: incumbentPayloadData,
      },
      rankCache,
    );

    if (compareBackfillRank(rankContext, incumbentRankContext) <= 0) {
      continue;
    }

    const updateArgs = [
      candidate.pickId,
      candidate.sport,
      candidate.marketType,
      candidate.selection,
      candidate.line ?? null,
      candidate.odds ?? null,
      toBackfillConfidencePct(candidate.payloadData, candidate.confidencePct),
      candidate.displayedAt ?? new Date().toISOString(),
      incumbent.id,
    ];
    if (updateArgs.some((value) => value === undefined)) {
      continue;
    }
    const updated = updateStmt.run(...updateArgs);
    changes += Number(updated?.changes || 0);
  }

  return changes;
}

function toCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function getSettlementCoverageDiagnostics(db, sport = null, dateRange = null) {
  const whereClauses = [];
  const params = [];

  if (sport) {
    whereClauses.push('UPPER(cdl.sport) = ?');
    params.push(String(sport).toUpperCase());
  }
  if (dateRange?.start) {
    whereClauses.push('cdl.displayed_at >= ?');
    params.push(dateRange.start);
  }
  if (dateRange?.end) {
    whereClauses.push('cdl.displayed_at <= ?');
    params.push(dateRange.end);
  }

  const whereSql = whereClauses.length
    ? ` AND ${whereClauses.join(' AND ')}`
    : '';

  const totalPendingRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_results cr
      LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE cr.status = 'pending'
      ${whereSql}
    `,
    )
    .get(...params);

  const eligiblePendingFinalDisplayedRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_results cr
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      WHERE cr.status = 'pending'
        AND cr.market_key IS NOT NULL
        AND gr.status = 'final'
      ${whereSql}
    `,
    )
    .get(...params);

  const settledDisplayedFinalRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_results cr
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      WHERE cr.status = 'settled'
        AND gr.status = 'final'
      ${whereSql}
    `,
    )
    .get(...params);

  const displayedFinalRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_display_log cdl
      INNER JOIN game_results gr ON gr.game_id = cdl.game_id
      WHERE gr.status = 'final'
      ${whereSql}
    `,
    )
    .get(...params);

  const finalDisplayedMissingResultsRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_display_log cdl
      LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id
      INNER JOIN game_results gr ON gr.game_id = cdl.game_id
      WHERE cr.id IS NULL
        AND gr.status = 'final'
      ${whereSql}
    `,
    )
    .get(...params);

  const finalDisplayedUnsettledRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_display_log cdl
      LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id
      INNER JOIN game_results gr ON gr.game_id = cdl.game_id
      WHERE gr.status = 'final'
        AND (cr.id IS NULL OR cr.status != 'settled')
      ${whereSql}
    `,
    )
    .get(...params);

  const pendingWithFinalNoDisplayRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_results cr
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE cr.status = 'pending'
        AND cr.market_key IS NOT NULL
        AND gr.status = 'final'
        AND cdl.pick_id IS NULL
      ${whereSql}
    `,
    )
    .get(...params);

  const pendingWithFinalMissingMarketKeyRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_results cr
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE cr.status = 'pending'
        AND cr.market_key IS NULL
        AND gr.status = 'final'
      ${whereSql}
    `,
    )
    .get(...params);

  const pendingDisplayedWithoutFinalRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM card_results cr
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      LEFT JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
      WHERE cr.status = 'pending'
        AND gr.game_id IS NULL
      ${whereSql}
    `,
    )
    .get(...params);

  return {
    totalPending: toCount(totalPendingRow?.count),
    eligiblePendingFinalDisplayed: toCount(
      eligiblePendingFinalDisplayedRow?.count,
    ),
    settledDisplayedFinal: toCount(settledDisplayedFinalRow?.count),
    displayedFinal: toCount(displayedFinalRow?.count),
    finalDisplayedMissingResults: toCount(
      finalDisplayedMissingResultsRow?.count,
    ),
    finalDisplayedUnsettled: toCount(finalDisplayedUnsettledRow?.count),
    pendingWithFinalNoDisplay: toCount(pendingWithFinalNoDisplayRow?.count),
    pendingWithFinalButNotDisplayed: toCount(
      pendingWithFinalNoDisplayRow?.count,
    ),
    pendingWithFinalMissingMarketKey: toCount(
      pendingWithFinalMissingMarketKeyRow?.count,
    ),
    pendingDisplayedWithoutFinal: toCount(pendingDisplayedWithoutFinalRow?.count),
  };
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, log only, no DB writes
 */
async function settlePendingCards({
  jobKey = null,
  dryRun = false,
  allowDisplayBackfill = null,
} = {}) {
  const jobRunId = `job-settle-cards-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[SettleCards] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[SettleCards] Job key: ${jobKey}`);
  }
  console.log(`[SettleCards] Time: ${new Date().toISOString()}`);

  // Backup database before settlement
  dbBackup.backupDatabase('before-settle-cards');

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[SettleCards] Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[SettleCards] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      const jobStartTime = new Date().toISOString();
      console.log('[SettleCards] Recording job start...');
      insertJobRun('settle_pending_cards', jobRunId, jobKey);

      const db = getDatabase();
      const emergencyBackfillEnabled =
        process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL === 'true';
      const enableDisplayBackfill =
        allowDisplayBackfill === null
          ? emergencyBackfillEnabled
          : Boolean(allowDisplayBackfill);
      let backfilledDisplayed = 0;
      if (enableDisplayBackfill) {
        backfilledDisplayed = backfillDisplayedPlaysFromPayloads(db);
      } else {
        console.log(
          '[SettleCards] Strict display-log mode enabled; payload backfill is disabled',
        );
      }
      if (backfilledDisplayed > 0) {
        console.warn(
          `[SettleCards] Backfilled ${backfilledDisplayed} display-log play rows from payloads (override active)`,
        );
      }
      const coverageBefore = getSettlementCoverageDiagnostics(db);
      console.log(
        `[SettleCards] Coverage before — pending: ${coverageBefore.totalPending}, eligible: ${coverageBefore.eligiblePendingFinalDisplayed}, settledFinalDisplayed: ${coverageBefore.settledDisplayedFinal}, missingResults: ${coverageBefore.finalDisplayedMissingResults}, blockedNoDisplay: ${coverageBefore.pendingWithFinalButNotDisplayed}, blockedMissingMarketKey: ${coverageBefore.pendingWithFinalMissingMarketKey}, blockedNoFinal: ${coverageBefore.pendingDisplayedWithoutFinal}`,
      );

      // --- Step 1: Settle pending card_results ---

      // Join pending card_results with final game_results and display ledger
      const pendingStmt = db.prepare(`
        SELECT
          cr.id AS result_id,
          cr.card_id,
          cr.game_id,
          cr.sport,
          cr.card_type,
          cr.market_key,
          cr.market_type,
          cr.selection,
          cr.line,
          cr.locked_price,
          cr.metadata,
          cdl.pick_id,
          cdl.displayed_at,
          cdl.api_endpoint,
          cp.payload_data,
          gr.final_score_home,
          gr.final_score_away,
          gr.metadata AS game_result_metadata
        FROM card_results cr
        INNER JOIN card_display_log cdl ON cr.card_id = cdl.pick_id
        INNER JOIN game_results gr ON cr.game_id = gr.game_id
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'pending'
          AND cr.market_key IS NOT NULL
          AND gr.status = 'final'
      `);

      const pendingRows = pendingStmt.all();
      console.log(
        `[SettleCards] Found ${pendingRows.length} pending card_results with final game scores`,
      );

      let cardsSettled = 0;
      let cardsErrored = 0;
      let cardsRaced = 0;
      let cardsSkipped = 0;
      const settledAt = new Date().toISOString();
      const marketDailyCounts = {
        NBA_TOTAL: { pending: 0, settled: 0, failed: 0 },
        NHL_TOTAL: { pending: 0, settled: 0, failed: 0 },
        NHL_1P_TOTAL: { pending: 0, settled: 0, failed: 0 },
        NHL_MONEYLINE: { pending: 0, settled: 0, failed: 0 },
      };

      for (const pendingCard of pendingRows) {
        // Parse payload data
        let payloadData;
        try {
          payloadData =
            typeof pendingCard.payload_data === 'string'
              ? JSON.parse(pendingCard.payload_data)
              : pendingCard.payload_data;
        } catch (parseErr) {
          console.warn(
            `[SettleCards] Failed to parse payload_data for card ${pendingCard.card_id}: ${parseErr.message}`,
          );
          cardsSkipped++;
          continue;
        }
        const cardResultMetadata =
          parseJsonObject(pendingCard.metadata) || {};
        const gameResultMetadata =
          parseJsonObject(pendingCard.game_result_metadata) || {};
        const period = extractSettlementPeriod({
          row: pendingCard,
          payloadData,
          cardResultMetadata,
        });
        const marketBucket = resolveSettlementMarketBucket({
          sport: pendingCard.sport,
          marketType: pendingCard.market_type,
          period,
        });
        if (marketBucket) {
          marketDailyCounts[marketBucket].pending += 1;
        }

        const homeScore = Number(pendingCard.final_score_home);
        const awayScore = Number(pendingCard.final_score_away);
        const firstPeriodScores = readFirstPeriodScores(gameResultMetadata);

        try {
          const lockedMarket = assertLockedMarketContext(
            pendingCard,
            payloadData,
            { period },
          );
          const result = gradeLockedMarket({
            marketType: lockedMarket.marketType,
            selection: lockedMarket.selection,
            line: lockedMarket.line,
            homeScore,
            awayScore,
            period: lockedMarket.period,
            firstPeriodScores,
          });
          const pnlOutcome = computePnlOutcome(result, lockedMarket.lockedPrice);
          if (pnlOutcome.anomalyCode) {
            console.warn(
              `[SettleCards] P/L anomaly for card ${pendingCard.card_id}: ${pnlOutcome.anomalyCode} (${pnlOutcome.anomalyMessage})`,
            );
          }

          db.prepare(
            `
            UPDATE card_results
            SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?
            WHERE id = ? AND status = 'pending'
          `,
          ).run(result, settledAt, pnlOutcome.pnlUnits, pendingCard.result_id);
          const state = db
            .prepare(
              `
            SELECT status, result, settled_at
            FROM card_results
            WHERE id = ?
          `,
            )
            .get(pendingCard.result_id);
          const didSettleNow =
            state &&
            state.status === 'settled' &&
            state.result === result &&
            state.settled_at === settledAt;
          if (didSettleNow) {
            cardsSettled++;
            if (marketBucket) {
              marketDailyCounts[marketBucket].settled += 1;
            }
            console.log(
              `[SettleCards] Settled card ${pendingCard.card_id}: ${lockedMarket.marketType}/${lockedMarket.selection} ` +
                `(${lockedMarket.marketKey}) -> ${result} (period=${lockedMarket.period}, pnl: ${pnlOutcome.pnlUnits})`,
            );
          } else if (
            state &&
            (state.status === 'settled' || state.status === 'error')
          ) {
            cardsRaced++;
            console.log(
              `[SettleCards] Race detected for card ${pendingCard.card_id}; row now ${state.status}`,
            );
          } else {
            cardsSkipped++;
            console.warn(
              `[SettleCards] Could not classify settlement outcome for card ${pendingCard.card_id}; row state: ${JSON.stringify(
                state || null,
              )}`,
            );
          }
        } catch (settlementErr) {
          const errorCode = settlementErr?.code || 'SETTLEMENT_CONTRACT_ERROR';
          console.warn(
            `[SettleCards] Contract error for card ${pendingCard.card_id}: ${errorCode} ${settlementErr.message}`,
          );

          let metadata = {};
          if (
            typeof pendingCard.metadata === 'string' &&
            pendingCard.metadata
          ) {
            try {
              metadata = JSON.parse(pendingCard.metadata);
            } catch {
              metadata = {};
            }
          }
          metadata.settlement_error = {
            code: errorCode,
            message: settlementErr.message,
            at: settledAt,
          };

          db.prepare(
            `
            UPDATE card_results
            SET status = 'error', result = 'void', settled_at = ?, metadata = ?
            WHERE id = ? AND status = 'pending'
          `,
          ).run(settledAt, JSON.stringify(metadata), pendingCard.result_id);
          const state = db
            .prepare(
              `
            SELECT status, result, settled_at
            FROM card_results
            WHERE id = ?
          `,
            )
            .get(pendingCard.result_id);
          const didErrorNow =
            state &&
            state.status === 'error' &&
            state.result === 'void' &&
            state.settled_at === settledAt;
          if (didErrorNow) {
            cardsErrored++;
            if (marketBucket) {
              marketDailyCounts[marketBucket].failed += 1;
            }
          } else if (
            state &&
            (state.status === 'settled' || state.status === 'error')
          ) {
            cardsRaced++;
            console.log(
              `[SettleCards] Race detected while writing error for card ${pendingCard.card_id}; row now ${state.status}`,
            );
          } else {
            cardsSkipped++;
            console.warn(
              `[SettleCards] Could not classify error outcome for card ${pendingCard.card_id}; row state: ${JSON.stringify(
                state || null,
              )}`,
            );
          }
        }
      }

      const eligibleCount = pendingRows.length;
      const accountedCount =
        cardsSettled + cardsErrored + cardsRaced + cardsSkipped;
      if (accountedCount < eligibleCount) {
        const residual = eligibleCount - accountedCount;
        cardsSkipped += residual;
        console.warn(
          `[SettleCards] Added ${residual} residual eligible rows to skipped to keep telemetry balanced`,
        );
      } else if (accountedCount > eligibleCount) {
        console.warn(
          `[SettleCards] Accounted rows exceed eligible rows (${accountedCount}/${eligibleCount}); inspect settlement telemetry`,
        );
      }
      const totalSkipped = cardsSkipped;
      console.log(
        `[SettleCards] Step 1 complete — pending: ${coverageBefore.totalPending}, eligible: ${eligibleCount}, settled: ${cardsSettled}, errored: ${cardsErrored}, raced: ${cardsRaced}, skipped: ${totalSkipped}`,
      );
      console.log(
        `[SettleCards] Market daily counts — NBA_TOTAL: ${JSON.stringify(marketDailyCounts.NBA_TOTAL)}, NHL_TOTAL: ${JSON.stringify(marketDailyCounts.NHL_TOTAL)}, NHL_1P_TOTAL: ${JSON.stringify(marketDailyCounts.NHL_1P_TOTAL)}, NHL_MONEYLINE: ${JSON.stringify(marketDailyCounts.NHL_MONEYLINE)}`,
      );

      // --- Step 2: Increment tracking_stats (race-safe) ---

      // Aggregate only cards settled in THIS run (delta-based), split by market.
      const aggregateRows = db
        .prepare(
          `
        SELECT sport, market_type, card_type, metadata, result, pnl_units
        FROM card_results
        WHERE status = 'settled'
          AND settled_at >= ?
      `,
        )
        .all(jobStartTime);

      const marketDeltas = {};
      for (const row of aggregateRows) {
        const sport = String(row.sport || '').toUpperCase();
        const cardResultMetadata = parseJsonObject(row.metadata) || {};
        const period = extractSettlementPeriod({
          row,
          payloadData: null,
          cardResultMetadata,
        });
        const rawMarketType = String(row.market_type || 'UNKNOWN').toUpperCase();
        const trackingMarketType =
          rawMarketType === 'TOTAL' && period === '1P'
            ? 'total_1p'
            : rawMarketType.toLowerCase();
        const key = `${sport}|${trackingMarketType}`;

        if (!marketDeltas[key]) {
          marketDeltas[key] = {
            sport,
            marketType: trackingMarketType,
            period,
            deltaWins: 0,
            deltaLosses: 0,
            deltaPushes: 0,
            deltaPnl: 0,
          };
        }

        const pnl = Number(row.pnl_units) || 0;
        if (row.result === 'win') {
          marketDeltas[key].deltaWins += 1;
          marketDeltas[key].deltaPnl += pnl;
        } else if (row.result === 'loss') {
          marketDeltas[key].deltaLosses += 1;
          marketDeltas[key].deltaPnl += pnl;
        } else if (row.result === 'push') {
          marketDeltas[key].deltaPushes += 1;
          marketDeltas[key].deltaPnl += pnl;
        }
      }

      let statsIncremented = 0;
      for (const deltas of Object.values(marketDeltas)) {
        const {
          sport,
          marketType,
          period,
          deltaWins,
          deltaLosses,
          deltaPushes,
          deltaPnl,
        } = deltas;

        incrementTrackingStat({
          id: `stat-${sport}-${marketType}-alltime`,
          statKey: `${sport}|${marketType}|all|all|all|alltime`,
          sport,
          marketType,
          direction: 'all',
          confidenceTier: 'all',
          driverKey: period === '1P' ? 'period_1p' : 'all',
          timePeriod: 'alltime',
          deltaWins,
          deltaLosses,
          deltaPushes,
          deltaPnl,
          metadata: {
            lastIncrementAt: new Date().toISOString(),
            jobRunId,
            period,
          },
        });

        console.log(
          `[SettleCards] Incremented tracking_stat for ${sport}/${marketType}: +${deltaWins}W / +${deltaLosses}L / +${deltaPushes}P (pnl: ${deltaPnl >= 0 ? '+' : ''}${deltaPnl.toFixed(3)})`,
        );
        statsIncremented++;
      }

      console.log(
        `[SettleCards] Step 2 complete — ${statsIncremented} tracking_stats incremented`,
      );

      const cardsArchived = 0;

      markJobRunSuccess(jobRunId);
      const coverageAfter = getSettlementCoverageDiagnostics(db);
      console.log(
        `[SettleCards] Coverage after — pending: ${coverageAfter.totalPending}, settledFinalDisplayed: ${coverageAfter.settledDisplayedFinal}, missingResults: ${coverageAfter.finalDisplayedMissingResults}, unsettledFinalDisplayed: ${coverageAfter.finalDisplayedUnsettled}, blockedNoDisplay: ${coverageAfter.pendingWithFinalNoDisplay}, blockedMissingMarketKey: ${coverageAfter.pendingWithFinalMissingMarketKey}, blockedNoFinal: ${coverageAfter.pendingDisplayedWithoutFinal}`,
      );
      console.log(
        `[SettleCards] Job complete — cardsSettled: ${cardsSettled}, cardsErrored: ${cardsErrored}, cardsRaced: ${cardsRaced}, cardsSkipped: ${totalSkipped}, cardsArchived: ${cardsArchived}, statsIncremented: ${statsIncremented}`,
      );

      return {
        success: true,
        jobRunId,
        jobKey,
        cardsSettled,
        cardsErrored,
        cardsRaced,
        cardsSkipped: totalSkipped,
        cardsArchived,
        statsIncremented,
        coverage: {
          pending: coverageBefore.totalPending,
          eligible: eligibleCount,
          settled: cardsSettled,
          raced: cardsRaced,
          skipped: totalSkipped,
          marketDailyCounts,
          displayBackfilled: backfilledDisplayed,
          displayBackfillEnabled: enableDisplayBackfill,
          before: coverageBefore,
          after: coverageAfter,
          blockedReasons: {
            noDisplayLog: coverageBefore.pendingWithFinalNoDisplay,
            missingMarketKey: coverageBefore.pendingWithFinalMissingMarketKey,
            noFinalGameResult: coverageBefore.pendingDisplayedWithoutFinal,
          },
        },
        errors: [],
      };
    } catch (error) {
      if (error.code === 'JOB_RUN_ALREADY_CLAIMED') {
        console.log(
          `[RaceGuard] Skipping settle_pending_cards (job already claimed): ${jobKey || 'none'}`,
        );
        return { success: true, jobRunId: null, skipped: true, jobKey };
      }
      console.error(`[SettleCards] Job failed:`, error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[SettleCards] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

// CLI execution
if (require.main === module) {
  settlePendingCards()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = {
  settlePendingCards,
  __private: {
    assertLockedMarketContext,
    backfillDisplayedPlaysFromPayloads,
    computePnlOutcome,
    computePnlUnits,
    extractSettlementPeriod,
    getSettlementCoverageDiagnostics,
    gradeLockedMarket,
    readFirstPeriodScores,
    resolveSettlementMarketBucket,
  },
};
