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
  recomputeTrackingStats,
  insertProjectionAudit,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  normalizeMarketType,
  normalizeSelectionForMarket,
  parseLine,
  recordClvEntry,
  settleClvEntry,
  hasSuccessfulJobRun,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

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

function resolveDecisionBasisForSettlement(payloadData) {
  const explicit = toUpperToken(payloadData?.decision_basis_meta?.decision_basis);
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

function isClvEligiblePayload(payloadData) {
  return resolveDecisionBasisForSettlement(payloadData) === 'ODDS_BACKED';
}

function buildClvEntryFromPendingCard({ pendingCard, payloadData, lockedMarket }) {
  if (!pendingCard || !lockedMarket) return null;
  if (!isClvEligiblePayload(payloadData)) return null;

  // Prefer first_seen_price (written once at card creation, never overwritten on
  // upsert) over lockedMarket.lockedPrice, which reflects the last model run and
  // may have drifted away from the original opening-line price (WI-0838).
  const rawOddsAtPick =
    pendingCard.first_seen_price !== null && pendingCard.first_seen_price !== undefined
      ? Number(pendingCard.first_seen_price)
      : Number(lockedMarket.lockedPrice);
  const oddsAtPick = rawOddsAtPick;
  if (!Number.isFinite(oddsAtPick)) return null;

  const cardId = pendingCard.card_id ? String(pendingCard.card_id).trim() : '';
  const gameId = pendingCard.game_id ? String(pendingCard.game_id).trim() : '';
  if (!cardId || !gameId) return null;

  const decisionBasis = resolveDecisionBasisForSettlement(payloadData);
  if (decisionBasis !== 'ODDS_BACKED') return null;

  return {
    id: `clv-${cardId}`,
    cardId,
    gameId,
    sport: pendingCard.sport || null,
    marketType: lockedMarket.marketType || null,
    propType:
      payloadData?.prop_type || payloadData?.recommended_bet_type || null,
    selection: lockedMarket.selection || null,
    line: Number.isFinite(lockedMarket.line) ? lockedMarket.line : null,
    oddsAtPick,
    volatilityBand: payloadData?.decision_basis_meta?.volatility_band || null,
    decisionBasis,
  };
}

function getFirstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function americanOddsToImpliedProbability(odds) {
  const parsed = Number(odds);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  if (parsed > 0) return 100 / (parsed + 100);
  const absoluteOdds = Math.abs(parsed);
  return absoluteOdds / (absoluteOdds + 100);
}

function normalizeClvSettlementPeriod(period) {
  const token = toUpperToken(period);
  if (
    token === '1P' ||
    token === 'P1' ||
    token === 'FIRST_PERIOD' ||
    token === 'FIRST_5_INNINGS' ||
    token === '1ST_PERIOD'
  ) {
    return '1P';
  }
  return 'FULL_GAME';
}

function resolveClosingOddsFromSnapshot({
  snapshot,
  marketType,
  selection,
  period = null,
}) {
  if (!snapshot) return null;

  const rawData = parseJsonObject(snapshot.raw_data) || {};
  const rawOdds =
    rawData && typeof rawData.odds === 'object' && rawData.odds !== null
      ? rawData.odds
      : rawData;
  const normalizedMarketType = toUpperToken(marketType);
  const normalizedSelection = toUpperToken(selection);
  const normalizedPeriod = normalizeClvSettlementPeriod(period);

  if (normalizedMarketType === 'MONEYLINE') {
    if (normalizedSelection === 'HOME') {
      return getFirstFiniteNumber(
        snapshot.h2h_home,
        snapshot.moneyline_home,
        rawOdds.h2h_home,
        rawOdds.moneyline_home,
      );
    }
    if (normalizedSelection === 'AWAY') {
      return getFirstFiniteNumber(
        snapshot.h2h_away,
        snapshot.moneyline_away,
        rawOdds.h2h_away,
        rawOdds.moneyline_away,
      );
    }
  }

  if (normalizedMarketType === 'SPREAD' || normalizedMarketType === 'PUCKLINE') {
    if (normalizedSelection === 'HOME') {
      return getFirstFiniteNumber(
        snapshot.spread_price_home,
        rawOdds.spread_price_home,
        rawOdds.spread_home_odds,
      );
    }
    if (normalizedSelection === 'AWAY') {
      return getFirstFiniteNumber(
        snapshot.spread_price_away,
        rawOdds.spread_price_away,
        rawOdds.spread_away_odds,
      );
    }
  }

  if (normalizedMarketType === 'TOTAL') {
    if (normalizedSelection === 'OVER') {
      if (normalizedPeriod === '1P') {
        return getFirstFiniteNumber(
          snapshot.total_price_over_1p,
          rawOdds.total_price_over_1p,
          rawOdds.total_1p_price_over,
          snapshot.total_price_over,
          rawOdds.total_price_over,
        );
      }
      return getFirstFiniteNumber(
        snapshot.total_price_over,
        rawOdds.total_price_over,
      );
    }
    if (normalizedSelection === 'UNDER') {
      if (normalizedPeriod === '1P') {
        return getFirstFiniteNumber(
          snapshot.total_price_under_1p,
          rawOdds.total_price_under_1p,
          rawOdds.total_1p_price_under,
          snapshot.total_price_under,
          rawOdds.total_price_under,
        );
      }
      return getFirstFiniteNumber(
        snapshot.total_price_under,
        rawOdds.total_price_under,
      );
    }
  }

  return null;
}

function getLatestClosingOddsSnapshot(db, gameId, cache = new Map()) {
  const normalizedGameId = gameId ? String(gameId).trim() : '';
  if (!normalizedGameId) return null;
  if (cache.has(normalizedGameId)) return cache.get(normalizedGameId);

  const snapshot =
    db
      .prepare(
        `
        SELECT *
        FROM odds_snapshots
        WHERE game_id = ?
        ORDER BY datetime(COALESCE(captured_at, '1970-01-01T00:00:00Z')) DESC, id DESC
        LIMIT 1
      `,
      )
      .get(normalizedGameId) || null;

  cache.set(normalizedGameId, snapshot);
  return snapshot;
}

function buildClvSettlementPayload({
  db,
  gameId,
  marketType,
  selection,
  period = null,
  oddsAtPick,
  snapshotCache = new Map(),
}) {
  const pickOdds = Number(oddsAtPick);
  if (!Number.isFinite(pickOdds)) return null;

  const snapshot = getLatestClosingOddsSnapshot(db, gameId, snapshotCache);
  const closingOdds = resolveClosingOddsFromSnapshot({
    snapshot,
    marketType,
    selection,
    period,
  });
  if (!Number.isFinite(closingOdds)) return null;

  const closingProbability = americanOddsToImpliedProbability(closingOdds);
  const pickProbability = americanOddsToImpliedProbability(pickOdds);
  if (!Number.isFinite(closingProbability) || !Number.isFinite(pickProbability)) {
    return null;
  }

  return {
    closingOdds,
    clvPct: Number((closingProbability - pickProbability).toFixed(6)),
  };
}

function reconcileOpenClvEntries(db, settledAt = new Date().toISOString()) {
  const hasClvLedger = Boolean(
    db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'clv_ledger'`,
      )
      .get(),
  );
  if (!hasClvLedger) {
    return {
      openRows: 0,
      reconciled: 0,
      unresolved: 0,
    };
  }

  const rows = db
    .prepare(
      `
      SELECT
        clv.card_id,
        clv.game_id,
        clv.market_type,
        clv.selection,
        clv.odds_at_pick,
        cr.market_key,
        cr.metadata,
        cp.payload_data
      FROM clv_ledger clv
      INNER JOIN card_results cr ON cr.card_id = clv.card_id
      LEFT JOIN card_payloads cp ON cp.id = clv.card_id
      WHERE clv.closed_at IS NULL
        AND cr.status IN ('settled', 'error')
        AND cr.settled_at IS NOT NULL
    `,
    )
    .all();

  const snapshotCache = new Map();
  let reconciled = 0;
  let unresolved = 0;

  for (const row of rows) {
    const payloadData = parseJsonObject(row.payload_data) || {};
    const cardResultMetadata = parseJsonObject(row.metadata) || {};
    const period = extractSettlementPeriod({
      row,
      payloadData,
      cardResultMetadata,
    });
    const clvSettlement = buildClvSettlementPayload({
      db,
      gameId: row.game_id,
      marketType: row.market_type,
      selection: row.selection,
      period,
      oddsAtPick: row.odds_at_pick,
      snapshotCache,
    });

    if (!clvSettlement) {
      unresolved += 1;
      continue;
    }

    settleClvEntry(
      row.card_id,
      clvSettlement.closingOdds,
      clvSettlement.clvPct,
      settledAt,
    );
    reconciled += 1;
  }

  return {
    openRows: rows.length,
    reconciled,
    unresolved,
  };
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
  if (token === 'FIRST_PERIOD' || token === 'FIRST_5_INNINGS' || token === '1P' || token === 'P1') {
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
    edgePct: toBackfillSortableNumber(
      payloadData?.decision_v2?.edge_delta_pct ?? payloadData?.decision_v2?.edge_pct,
    ),
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

// F5 card types are projection-only: they grade against F5 innings totals,
// not full-game scores. settle_pending_cards must not touch them.
const F5_CARD_TYPE_PREFIX = 'mlb-f5';

function resolveNonActionableFinalReason(payloadData, row) {
  // F5 market cards are projection-only — P&L is not tracked for them.
  const cardTypeLower = String(row?.card_type || '').toLowerCase();
  if (cardTypeLower.startsWith(F5_CARD_TYPE_PREFIX)) {
    return {
      code: 'PROJECTION_ONLY_F5',
      message: 'F5 card type is projection-only — settled separately by settle_mlb_f5',
      details: { cardType: row.card_type },
    };
  }

  // Rows with no market_key cannot be settled — auto-close with explicit reason
  if (!row?.market_key) {
    return {
      code: 'MISSING_MARKET_KEY',
      message: 'Card has no market_key — cannot settle',
      details: {},
    };
  }

  const kind = toBackfillUpperToken(payloadData?.kind);
  if (kind && kind !== 'PLAY') {
    return {
      code: 'NON_ACTIONABLE_FINAL_KIND',
      message: `Card payload kind ${kind} is non-actionable`,
      details: { kind },
    };
  }

  const officialStatus = toBackfillUpperToken(
    payloadData?.decision_v2?.official_status,
  );
  if (officialStatus === 'PASS') {
    return {
      code: 'NON_ACTIONABLE_FINAL_PASS',
      message: 'Card decision_v2 official_status=PASS is non-actionable',
      details: { officialStatus },
    };
  }

  const legacyStatus = toBackfillUpperToken(payloadData?.status);
  if (!officialStatus && legacyStatus === 'PASS') {
    return {
      code: 'NON_ACTIONABLE_FINAL_PASS',
      message: 'Card status=PASS is non-actionable',
      details: { legacyStatus },
    };
  }

  return null;
}

function buildNonActionableAutoCloseMetadata(existingMetadata, reason, settledAt) {
  const metadata = parseJsonObject(existingMetadata) || {};
  metadata.settlement_error = {
    code: reason.code,
    message: reason.message,
    at: settledAt,
    classification: 'NON_ACTIONABLE_AUTO_CLOSE',
    details: reason.details || {},
  };
  return JSON.stringify(metadata);
}

function autoCloseNonActionableFinalPendingRows(db, settledAt) {
  const candidateRows = db
    .prepare(
      `
      SELECT
        cr.id AS result_id,
        cr.card_id,
        cr.game_id,
        cr.card_type,
        cr.market_key,
        cr.metadata,
        cp.payload_data
      FROM card_results cr
      INNER JOIN game_results gr ON gr.game_id = cr.game_id
      LEFT JOIN card_payloads cp ON cp.id = cr.card_id
      WHERE cr.status = 'pending'
        AND gr.status = 'final'
    `,
    )
    .all();

  const candidates = [];
  const reasonCounts = {};

  for (const row of candidateRows) {
    const resultId =
      row.result_id === null || row.result_id === undefined
        ? ''
        : String(row.result_id).trim();
    if (!resultId) continue;

    const payloadData = parseJsonObject(row.payload_data) || {};
    const reason = resolveNonActionableFinalReason(payloadData, row);
    if (!reason) continue;
    if (reason.code === 'MISSING_MARKET_KEY') {
      console.log(
        `[SettleCards] Auto-closing MISSING_MARKET_KEY: resultId=${resultId} cardId=${row.card_id} gameId=${row.game_id}`,
      );
    }
    candidates.push({
      resultId,
      cardId: row.card_id,
      reasonCode: reason.code,
      metadataJson: buildNonActionableAutoCloseMetadata(
        row.metadata,
        reason,
        settledAt,
      ),
    });
    reasonCounts[reason.code] = (reasonCounts[reason.code] || 0) + 1;
  }

  if (candidates.length === 0) {
    return { closed: 0, failures: 0, fallbackCloses: 0, reasonCounts, closedResultIds: new Set() };
  }

  const ids = candidates.map((entry) => entry.resultId);
  const placeholders = ids.map(() => '?').join(', ');
  const countClosedSql = `
      SELECT COUNT(*) AS count
      FROM card_results
      WHERE status = 'error'
        AND result = 'void'
        AND settled_at = ?
        AND id IN (${placeholders})
    `;
  const countClosed = () =>
    Number(
      db
        .prepare(countClosedSql)
        .get(settledAt, ...ids)?.count || 0,
    );
  const updateSql = `
      UPDATE card_results
      SET status = 'error', result = 'void', settled_at = ?, metadata = ?
      WHERE id = ? AND status = 'pending'
    `;
  let updateStmt = db.prepare(updateSql);

  for (const entry of candidates) {
    try {
      updateStmt.run(settledAt, entry.metadataJson, entry.resultId);
    } catch (updateError) {
      const errMsg = updateError?.message ?? String(updateError);
      console.warn(
        `[SettleCards] Failed to auto-close non-actionable card ${entry.cardId} (resultId=${entry.resultId}, reason=${entry.reasonCode}): ${errMsg}`,
      );
      updateStmt = db.prepare(updateSql);
    }
  }

  const closed = countClosed();
  const failures = Math.max(0, candidates.length - closed);
  const fallbackCloses = 0;

  // Build closedResultIds by querying which candidate IDs ended up as error+void+settledAt
  const closedResultIds = new Set();
  const closedRows = db
    .prepare(
      `SELECT id FROM card_results WHERE status = 'error' AND result = 'void' AND settled_at = ? AND id IN (${placeholders})`,
    )
    .all(settledAt, ...ids);
  for (const r of closedRows) {
    closedResultIds.add(String(r.id));
  }

  return { closed, failures, fallbackCloses, reasonCounts, closedResultIds };
}

function parsePayloadJsonSafely(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toConfidenceScore(payloadData) {
  const confidencePct = Number(payloadData?.confidence_pct);
  if (Number.isFinite(confidencePct)) return confidencePct;
  const confidence = Number(payloadData?.confidence);
  if (Number.isFinite(confidence)) return confidence * 100;
  return -1;
}

function resolveDuplicateGroupKey(row) {
  if (row.market_key) {
    return `market_key:${row.market_key}`;
  }

  const payloadData = parsePayloadJsonSafely(row.payload_data);
  const sport = String(row.sport || payloadData.sport || '').toUpperCase();
  const propType = String(
    payloadData?.play?.prop_type || payloadData?.prop_type || '',
  )
    .trim()
    .toLowerCase();

  if (sport === 'NHL' && propType === 'shots_on_goal') {
    const period = normalizeSettlementPeriod(
      payloadData?.play?.period ?? payloadData?.period ?? null,
      row.card_type,
    );
    const playerId = String(
      payloadData?.play?.player_id || payloadData?.player_id || '',
    ).trim();
    const playerName = normalizePlayerName(
      payloadData?.play?.player_name || payloadData?.player_name || '',
    );
    const selection = String(
      payloadData?.play?.selection?.side ?? payloadData?.selection?.side ?? '',
    )
      .trim()
      .toUpperCase();
    const line = parseLine(
      payloadData?.play?.selection?.line ??
        payloadData?.line ??
        payloadData?.threshold ??
        null,
    );

    if ((playerId || playerName) && (selection === 'OVER' || selection === 'UNDER')) {
      return `nhl_shots:${row.game_id}:${period}:${playerId || playerName}:${selection}:${line}`;
    }
  }

  return null;
}

function closeSupersededDuplicatePendingRows(db, settledAt) {
  const rows = db
    .prepare(
      `
      SELECT
        cr.id AS result_id,
        cr.card_id,
        cr.game_id,
        cr.sport,
        cr.card_type,
        cr.metadata,
        cr.market_key,
        cp.payload_data,
        cdl.displayed_at,
        cp.created_at
      FROM card_results cr
      INNER JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      LEFT JOIN card_payloads cp ON cp.id = cr.card_id
      WHERE cr.status = 'pending'
      ORDER BY cdl.displayed_at DESC, cp.created_at DESC, cr.card_id DESC
    `,
    )
    .all();

  const grouped = new Map();
  for (const row of rows) {
    const groupKey = resolveDuplicateGroupKey(row);
    if (!groupKey) continue;
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(row);
  }

  const superseded = [];
  for (const [, groupRows] of grouped.entries()) {
    if (groupRows.length <= 1) continue;

    const ranked = groupRows
      .map((row) => {
        const payloadData = parsePayloadJsonSafely(row.payload_data);
        return {
          ...row,
          confidenceScore: toConfidenceScore(payloadData),
          displayedAtMs: safeBackfillTimestampMs(row.displayed_at),
          createdAtMs: safeBackfillTimestampMs(row.created_at),
        };
      })
      .sort((a, b) => {
        if (a.displayedAtMs !== b.displayedAtMs) {
          return b.displayedAtMs - a.displayedAtMs;
        }
        if (a.createdAtMs !== b.createdAtMs) {
          return b.createdAtMs - a.createdAtMs;
        }
        if (a.confidenceScore !== b.confidenceScore) {
          return b.confidenceScore - a.confidenceScore;
        }
        if (a.card_id === b.card_id) return 0;
        return a.card_id > b.card_id ? -1 : 1;
      });

    const winner = ranked[0];
    for (const loser of ranked.slice(1)) {
      superseded.push({
        ...loser,
        winnerCardId: winner.card_id,
      });
    }
  }

  if (superseded.length === 0) {
    return {
      closed: 0,
      reasonCounts: {},
      closedResultIds: new Set(),
    };
  }

  const updateStmt = db.prepare(
    `
      UPDATE card_results
      SET status = 'error', result = 'void', settled_at = ?, metadata = ?
      WHERE id = ? AND status = 'pending'
    `,
  );

  const closedResultIds = new Set();
  const reasonCounts = { DUPLICATE_MARKET_SUPERSEDED: 0 };
  for (const row of superseded) {
    const metadata = parseJsonObject(row.metadata) || {};
    metadata.settlement_error = {
      code: 'DUPLICATE_MARKET_SUPERSEDED',
      message:
        'Duplicate pending market superseded by newer displayed pick; auto-voided before settlement',
      at: settledAt,
      classification: 'DEDUPE_AUTO_CLOSE',
      details: {
        supersededByCardId: row.winnerCardId,
        duplicateGroup: resolveDuplicateGroupKey(row),
      },
    };

    const result = updateStmt.run(settledAt, JSON.stringify(metadata), row.result_id);
    if (Number(result?.changes || 0) > 0) {
      reasonCounts.DUPLICATE_MARKET_SUPERSEDED += 1;
      closedResultIds.add(String(row.result_id));
    }
  }

  return {
    closed: closedResultIds.size,
    reasonCounts,
    closedResultIds,
  };
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
  if (cardTypeToken.includes('1P') || cardTypeToken.includes('FIRST_PERIOD') || cardTypeToken.includes('FIRST_5_INNINGS')) {
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

/**
 * Merge a derived market_period_token into an existing metadata object without
 * overwriting any other fields. Returns a new plain object — does not mutate input.
 *
 * @param {object} opts
 * @param {object|null} opts.existingMeta - Current metadata object (may be null/undefined)
 * @param {string} opts.token - '1P' or 'FULL_GAME'
 * @returns {object}
 */
function deriveAndMergePeriodToken({ existingMeta, token }) {
  const base = existingMeta && typeof existingMeta === 'object' ? existingMeta : {};
  return { ...base, market_period_token: token };
}

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

function normalizePlayerName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNhlShotsOnGoalCard(row, payloadData) {
  const sport = String(row?.sport || payloadData?.sport || '').toUpperCase();
  if (sport !== 'NHL') return false;

  const propType = String(
    payloadData?.play?.prop_type || payloadData?.prop_type || '',
  )
    .trim()
    .toLowerCase();
  return propType === 'shots_on_goal';
}

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

  const directById = playerId ? Number(byPlayerId[String(playerId)]) : null;
  if (Number.isFinite(directById)) {
    return directById;
  }

  const normalizedName = normalizePlayerName(playerName);
  if (!normalizedName) {
    throw createMarketError(
      'MISSING_PLAYER_IDENTITY',
      'Unable to resolve player identity for NHL shots settlement',
      { playerId, playerName },
    );
  }

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
    },
  );
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

    // Sequential ordering guard: card settlement must not run before projection settlement completes.
    // Job key format: settle|hourly|YYYY-MM-DD|HH|pending-cards (or settle|nightly|YYYY-MM-DD|pending-cards).
    // Replace the |pending-cards suffix with |projections to derive the expected projections key.
    if (jobKey) {
      const projectionsJobKey = jobKey.replace(/\|pending-cards$/, '|projections');
      if (!hasSuccessfulJobRun(projectionsJobKey)) {
        console.log(
          `SKIP: settle_projections not yet SUCCESS for this window — skipping card settlement (expected key: ${projectionsJobKey})`,
        );
        return { success: true, jobRunId: null, skipped: true, guardedBy: 'settle_projections', jobKey };
      }
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
      const globalBackfillEnabled =
        process.env.CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL === 'true';
      const requestedDisplayBackfill = Boolean(allowDisplayBackfill);
      const enableDisplayBackfill =
        requestedDisplayBackfill && globalBackfillEnabled;
      let backfilledDisplayed = 0;
      if (requestedDisplayBackfill && !globalBackfillEnabled) {
        console.warn(
          '[SettleCards] Display backfill was requested but CHEDDAR_SETTLEMENT_ENABLE_DISPLAY_BACKFILL is not true; staying strict',
        );
      }
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
          cp.first_seen_price,
          gr.final_score_home,
          gr.final_score_away,
          gr.metadata AS game_result_metadata
        FROM card_results cr
        INNER JOIN card_display_log cdl ON cr.card_id = cdl.pick_id
        INNER JOIN game_results gr ON cr.game_id = gr.game_id
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cr.status = 'pending'
          AND (
            cr.market_key IS NOT NULL
            OR (
              UPPER(COALESCE(cr.sport, cp.sport, '')) = 'NHL'
              AND LOWER(
                COALESCE(
                  json_extract(cp.payload_data, '$.play.prop_type'),
                  json_extract(cp.payload_data, '$.prop_type'),
                  ''
                )
              ) = 'shots_on_goal'
            )
          )
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
      let clvResolvedAtSettlement = 0;
      let clvOpenAfterSettlement = 0;
      const settledAt = new Date().toISOString();
      const clvSnapshotCache = new Map();
      let nonActionableAutoClosed = 0;
      let nonActionableAutoClosedReasons = {};
      let duplicateAutoClosed = 0;
      let duplicateAutoClosedReasons = {};
      const nonActionableClose = autoCloseNonActionableFinalPendingRows(
        db,
        settledAt,
      );
      nonActionableAutoClosed = nonActionableClose.closed;
      nonActionableAutoClosedReasons = nonActionableClose.reasonCounts;
      const autoClosedResultIdSet = nonActionableClose.closedResultIds ?? new Set();
      if (nonActionableAutoClosed > 0) {
        console.log(
          `[SettleCards] Auto-closed ${nonActionableAutoClosed} non-actionable final pending card_results as void (${JSON.stringify(nonActionableAutoClosedReasons)})`,
        );
      }
      if (nonActionableClose.failures > 0) {
        console.warn(
          `[SettleCards] Failed to auto-close ${nonActionableClose.failures} non-actionable final rows`,
        );
      }
      if (nonActionableClose.fallbackCloses > 0) {
        console.warn(
          `[SettleCards] Auto-closed ${nonActionableClose.fallbackCloses} non-actionable final rows using fallback update`,
        );
      }
      const duplicateClose = closeSupersededDuplicatePendingRows(db, settledAt);
      duplicateAutoClosed = duplicateClose.closed;
      duplicateAutoClosedReasons = duplicateClose.reasonCounts;
      if (duplicateAutoClosed > 0) {
        console.log(
          `[SettleCards] Auto-closed ${duplicateAutoClosed} superseded duplicate pending rows (${JSON.stringify(duplicateAutoClosedReasons)})`,
        );
      }
      const autoClosedResultIdUnion = new Set([
        ...autoClosedResultIdSet,
        ...(duplicateClose.closedResultIds || new Set()),
      ]);
      const eligibleCount = pendingRows.filter((row) => {
        const resultId = String(row.result_id ?? '').trim();
        return resultId ? !autoClosedResultIdUnion.has(resultId) : true;
      }).length;
      const marketDailyCounts = {
        NBA_TOTAL: { pending: 0, settled: 0, failed: 0 },
        NHL_TOTAL: { pending: 0, settled: 0, failed: 0 },
        NHL_1P_TOTAL: { pending: 0, settled: 0, failed: 0 },
        NHL_MONEYLINE: { pending: 0, settled: 0, failed: 0 },
      };

      for (const pendingCard of pendingRows) {
        // Skip rows already auto-closed this run — prevents double-counting in cardsRaced/cardsErrored
        const rowResultId = String(pendingCard.result_id ?? '').trim();
        if (
          rowResultId &&
          autoClosedResultIdUnion.has(rowResultId)
        ) {
          continue;
        }

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
        const isNhlShotsCard = isNhlShotsOnGoalCard(pendingCard, payloadData);
        let clvTracked = false;
        let lockedMarket = null;

        try {
          let result;

          const isContradiction =
            toBackfillUpperToken(payloadData?.action) === 'PASS' &&
            toBackfillUpperToken(payloadData?.decision_v2?.official_status) === 'PLAY';
          if (isContradiction) {
            console.error(
              `[INVARIANT_BREACH] card ${pendingCard.card_id} has action=PASS but decision_v2.official_status=PLAY — skipping settlement`,
            );
            cardsSkipped++;
            continue;
          }

          if (isNhlShotsCard) {
            lockedMarket = resolveNhlShotsSettlementContext(
              pendingCard,
              payloadData,
              cardResultMetadata,
            );
            const actualShots = resolvePlayerShotsActualValue({
              gameResultMetadata,
              playerId: lockedMarket.playerId,
              playerName: lockedMarket.playerName,
              period: lockedMarket.period,
            });
            result = gradeNhlPlayerShotsMarket({
              selection: lockedMarket.selection,
              line: lockedMarket.line,
              actualShots,
            });
          } else {
            lockedMarket = assertLockedMarketContext(
              pendingCard,
              payloadData,
              { period },
            );
            const clvEntry = buildClvEntryFromPendingCard({
              pendingCard,
              payloadData,
              lockedMarket,
            });
            if (clvEntry) {
              recordClvEntry(clvEntry);
              clvTracked = true;
            }
            result = gradeLockedMarket({
              marketType: lockedMarket.marketType,
              selection: lockedMarket.selection,
              line: lockedMarket.line,
              homeScore,
              awayScore,
              period: lockedMarket.period,
              firstPeriodScores,
            });
          }

          const effectivePrice = lockedMarket.lockedPrice ?? -110;
          const pnlOutcome = computePnlOutcome(result, effectivePrice);
          if (pnlOutcome.anomalyCode) {
            console.warn(
              `[SettleCards] P/L anomaly for card ${pendingCard.card_id}: ${pnlOutcome.anomalyCode} (${pnlOutcome.anomalyMessage})`,
            );
          }

          const d2 = payloadData?.decision_v2 ?? {};
          const sharpPriceStatus = typeof d2.sharp_price_status === 'string' ? d2.sharp_price_status : null;
          const primaryReasonCode = typeof d2.primary_reason_code === 'string' ? d2.primary_reason_code : null;
          const edgePct =
            typeof d2.edge_delta_pct === 'number' && Number.isFinite(d2.edge_delta_pct)
              ? d2.edge_delta_pct
              : typeof d2.edge_pct === 'number' && Number.isFinite(d2.edge_pct)
                ? d2.edge_pct
                : null;

          // Merge market_period_token into existing metadata so the classification
          // is durable and survives future rule changes (WI-0607).
          const settledMetadata = deriveAndMergePeriodToken({
            existingMeta: cardResultMetadata,
            token: period,
          });

          db.prepare(
            `
            UPDATE card_results
            SET status = 'settled', result = ?, settled_at = ?, pnl_units = ?,
                sharp_price_status = ?, primary_reason_code = ?, edge_pct = ?, metadata = ?
            WHERE id = ? AND status = 'pending'
          `,
          ).run(result, settledAt, pnlOutcome.pnlUnits, sharpPriceStatus, primaryReasonCode, edgePct, JSON.stringify(settledMetadata), pendingCard.result_id);
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
            if (clvTracked && lockedMarket) {
              const clvSettlement = buildClvSettlementPayload({
                db,
                gameId: pendingCard.game_id,
                marketType: lockedMarket.marketType,
                selection: lockedMarket.selection,
                period: lockedMarket.period,
                oddsAtPick: lockedMarket.lockedPrice,
                snapshotCache: clvSnapshotCache,
              });
              if (clvSettlement) {
                settleClvEntry(
                  pendingCard.card_id,
                  clvSettlement.closingOdds,
                  clvSettlement.clvPct,
                  settledAt,
                );
                clvResolvedAtSettlement += 1;
              } else {
                clvOpenAfterSettlement += 1;
              }
            }
            if (marketBucket) {
              marketDailyCounts[marketBucket].settled += 1;
            }
            console.log(
              `[SettleCards] Settled card ${pendingCard.card_id}: ${isNhlShotsCard ? 'PROP_SHOTS_ON_GOAL' : lockedMarket.marketType}/${lockedMarket.selection} ` +
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
            if (clvTracked && lockedMarket) {
              const clvSettlement = buildClvSettlementPayload({
                db,
                gameId: pendingCard.game_id,
                marketType: lockedMarket.marketType,
                selection: lockedMarket.selection,
                period: lockedMarket.period,
                oddsAtPick: lockedMarket.lockedPrice,
                snapshotCache: clvSnapshotCache,
              });
              if (clvSettlement) {
                settleClvEntry(
                  pendingCard.card_id,
                  clvSettlement.closingOdds,
                  clvSettlement.clvPct,
                  settledAt,
                );
                clvResolvedAtSettlement += 1;
              } else {
                clvOpenAfterSettlement += 1;
              }
            }
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
      const clvReconciliation = reconcileOpenClvEntries(db, settledAt);
      console.log(
        `[SettleCards] Step 1 complete — pending: ${coverageBefore.totalPending}, eligible: ${eligibleCount}, settled: ${cardsSettled}, errored: ${cardsErrored}, raced: ${cardsRaced}, skipped: ${totalSkipped}, autoClosedNonActionable: ${nonActionableAutoClosed}, autoClosedDuplicates: ${duplicateAutoClosed}`,
      );
      console.log(
        `[SettleCards] Market daily counts — NBA_TOTAL: ${JSON.stringify(marketDailyCounts.NBA_TOTAL)}, NHL_TOTAL: ${JSON.stringify(marketDailyCounts.NHL_TOTAL)}, NHL_1P_TOTAL: ${JSON.stringify(marketDailyCounts.NHL_1P_TOTAL)}, NHL_MONEYLINE: ${JSON.stringify(marketDailyCounts.NHL_MONEYLINE)}`,
      );
      console.log(
        `[SettleCards] CLV telemetry — resolvedAtSettlement: ${clvResolvedAtSettlement}, leftOpenAfterSettlement: ${clvOpenAfterSettlement}, reconciledOpenRows: ${clvReconciliation.reconciled}, stillOpen: ${clvReconciliation.unresolved}`,
      );

      // --- Step 2: Write projection_audit rows + recompute tracking_stats ---

      // Write one projection_audit row per settled card in this run
      const aggregateRows = db
        .prepare(
          `
        SELECT id, sport, market_type, card_type, metadata, result, pnl_units,
               sharp_price_status, selection, locked_price, settled_at
        FROM card_results
        WHERE status = 'settled'
          AND settled_at >= ?
      `,
        )
        .all(jobStartTime);

      for (const row of aggregateRows) {
        const sport = String(row.sport || '').toUpperCase();
        const cardResultMetadata = parseJsonObject(row.metadata) || {};
        const period = extractSettlementPeriod({
          row,
          payloadData: null,
          cardResultMetadata,
        });
        const rawMarketType = String(row.market_type || 'UNKNOWN').toUpperCase();

        // --- projection_audit: write one row per settled projection (all markets, including 1P) ---
        try {
          const auditPlayerCount =
            typeof cardResultMetadata.player_count === 'number'
              ? cardResultMetadata.player_count
              : null;
          const auditConfidenceScore =
            typeof cardResultMetadata.confidence_score === 'number'
              ? cardResultMetadata.confidence_score
              : null;

          insertProjectionAudit({
            cardResultId: row.id,
            sport,
            marketType: rawMarketType.toLowerCase(),
            period: period || null,
            playerCount: auditPlayerCount,
            confidenceScore: auditConfidenceScore,
            oddsAmerican: typeof row.locked_price === 'number' ? row.locked_price : null,
            sharpPriceStatus: row.sharp_price_status || null,
            direction: row.selection || null,
            result: row.result,
            pnlUnits: Number(row.pnl_units) || 0,
            settledAt: row.settled_at,
            jobRunId: jobRunId || null,
            metadata: null,
          });
        } catch (auditErr) {
          console.warn(
            `[SettleCards] insertProjectionAudit skipped for card_result ${row.id}: ${auditErr.message}`,
          );
        }
      }

      // --- Step 2b: Recompute tracking_stats from projection_audit (excludes 1P rows) ---
      const recomputeResult = recomputeTrackingStats({ fullReplace: false });
      console.log(
        `[SettleCards] Step 2 complete — tracking_stats recomputed (${recomputeResult.rows} rows upserted)`,
      );

      const cardsArchived = 0;

      markJobRunSuccess(jobRunId);
      const coverageAfter = getSettlementCoverageDiagnostics(db);
      console.log(
        `[SettleCards] Coverage after — pending: ${coverageAfter.totalPending}, settledFinalDisplayed: ${coverageAfter.settledDisplayedFinal}, missingResults: ${coverageAfter.finalDisplayedMissingResults}, unsettledFinalDisplayed: ${coverageAfter.finalDisplayedUnsettled}, blockedNoDisplay: ${coverageAfter.pendingWithFinalNoDisplay}, blockedMissingMarketKey: ${coverageAfter.pendingWithFinalMissingMarketKey}, blockedNoFinal: ${coverageAfter.pendingDisplayedWithoutFinal}`,
      );
      console.log(
        `[SettleCards] Job complete — cardsSettled: ${cardsSettled}, cardsErrored: ${cardsErrored}, cardsRaced: ${cardsRaced}, cardsSkipped: ${totalSkipped}, cardsArchived: ${cardsArchived}, trackingStatsRows: ${recomputeResult.rows}`,
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
        trackingStatsRows: recomputeResult.rows,
        coverage: {
          pending: coverageBefore.totalPending,
          eligible: eligibleCount,
          settled: cardsSettled,
          raced: cardsRaced,
          skipped: totalSkipped,
          nonActionableAutoClosedFinal: nonActionableAutoClosed,
          nonActionableAutoCloseFailures: Number(nonActionableClose.failures || 0),
          nonActionableAutoCloseFallbacks: Number(
            nonActionableClose.fallbackCloses || 0,
          ),
          nonActionableAutoClosedReasons,
          duplicateAutoClosedFinal: duplicateAutoClosed,
          duplicateAutoClosedReasons,
          clvResolvedAtSettlement,
          clvOpenAfterSettlement,
          clvReconciledAfterSettlementSweep: clvReconciliation.reconciled,
          clvStillOpen: clvReconciliation.unresolved,
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
    autoCloseNonActionableFinalPendingRows,
    closeSupersededDuplicatePendingRows,
    assertLockedMarketContext,
    backfillDisplayedPlaysFromPayloads,
    computePnlOutcome,
    computePnlUnits,
    americanOddsToImpliedProbability,
    deriveAndMergePeriodToken,
    extractSettlementPeriod,
    normalizeSettlementPeriod,
    getSettlementCoverageDiagnostics,
    getLatestClosingOddsSnapshot,
    gradeNhlPlayerShotsMarket,
    gradeLockedMarket,
    buildClvEntryFromPendingCard,
    buildClvSettlementPayload,
    isClvEligiblePayload,
    isNhlShotsOnGoalCard,
    readFirstPeriodScores,
    reconcileOpenClvEntries,
    resolveNhlShotsSettlementContext,
    resolveClosingOddsFromSnapshot,
    resolvePlayerShotsActualValue,
    resolveDecisionBasisForSettlement,
    resolveSettlementMarketBucket,
  },
};
