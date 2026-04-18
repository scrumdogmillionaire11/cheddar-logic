const {
  createMarketError,
  deriveLockedMarketContext,
  normalizeMarketPeriod,
  toRecommendedBetType,
} = require('../market-contract');
const {
  normalizeOfficialDecisionStatus,
  resolveNormalizedDecisionStatus,
} = require('../decision-status');
const { normalizeCardTitle } = require('../normalize');
const {
  getDatabase,
  getOddsContextReferenceRegistry,
} = require('./connection');
const { deleteModelOutputsByGame } = require('./models');
const { insertCardResult } = require('./results');
const {
  captureProjectionAccuracyForCard,
  gradeProjectionAccuracyEval,
} = require('./projection-accuracy');

function ensureCardPayloadRunIdColumn(db) {
  const columns = db.prepare(`PRAGMA table_info(card_payloads)`).all();
  const hasRunId = columns.some(
    (column) => String(column.name || '').toLowerCase() === 'run_id',
  );
  if (!hasRunId) {
    db.exec(`ALTER TABLE card_payloads ADD COLUMN run_id TEXT`);
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_card_payloads_run_id ON card_payloads(run_id)`,
  );
}

function ensureActualResultColumn(db) {
  const columns = db.prepare(`PRAGMA table_info(card_payloads)`).all();
  const has = columns.some(c => String(c.name).toLowerCase() === 'actual_result');
  if (!has) {
    db.exec(`ALTER TABLE card_payloads ADD COLUMN actual_result TEXT`);
  }
}

function setProjectionActualResult(cardId, actualResult) {
  const db = getDatabase();
  ensureActualResultColumn(db);
  db.prepare(`
    UPDATE card_payloads SET actual_result = ? WHERE id = ?
  `).run(JSON.stringify(actualResult), cardId);

  try {
    gradeProjectionAccuracyEval(db, { cardId, actualResult });
  } catch (error) {
    console.warn(
      `[DB] projection_accuracy grade skipped for ${cardId}: ${error.message}`,
    );
  }
}

function getUnsettledProjectionCards() {
  const db = getDatabase();
  ensureActualResultColumn(db);
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT
      cp.id as card_id,
      cp.game_id,
      cp.sport,
      cp.card_type,
      cp.payload_data,
      g.game_time_utc,
      g.home_team,
      g.away_team
    FROM card_payloads cp
    JOIN games g ON cp.game_id = g.game_id
    WHERE cp.card_type IN ('nhl-pace-1p', 'mlb-f5', 'nhl-player-shots', 'nhl-player-shots-1p', 'nhl-player-blk', 'mlb-pitcher-k')
      AND cp.actual_result IS NULL
      AND g.game_time_utc < ?
    ORDER BY g.game_time_utc DESC
    LIMIT 100
  `).all(cutoff);
}

function deleteCardPayloadsByGameAndType(gameId, cardType, options = {}) {
  return deleteCardPayloadsForGame(gameId, cardType, options);
}

/**
 * Prepare idempotent writes for model outputs and card payloads
 * @param {string} gameId - Game ID
 * @param {string} modelName - Model name
 * @param {string} cardType - Card type
 * @param {{runId?: string}} options - Run scope for payload cleanup (required)
 * @returns {{deletedOutputs: number, deletedCards: number}}
 */
function normalizeRunScopeId(options = {}) {
  if (typeof options.runId !== 'string') return null;
  const normalized = options.runId.trim();
  return normalized.length > 0 ? normalized : null;
}

function prepareModelAndCardWrite(gameId, modelName, cardType, options = {}) {
  const runId = normalizeRunScopeId(options);
  if (!runId) {
    const error = new Error(
      '[DB] prepareModelAndCardWrite requires a non-empty options.runId for run-scoped writes.',
    );
    error.code = 'RUN_ID_REQUIRED';
    throw error;
  }

  // WI-0817: wrap both deletes atomically — if process crashes mid-delete,
  // SQLite rolls back and old cards survive intact.
  const db = getDatabase();
  return db.transaction(() => {
    const deletedOutputs = deleteModelOutputsByGame(gameId, modelName);
    const deletedCards = deleteCardPayloadsByGameAndType(
      gameId,
      cardType,
      { ...options, runId },
    );
    return { deletedOutputs, deletedCards };
  })();
}

/**
 * Run a synchronous per-game write phase (deletes + inserts) atomically.
 * All DB operations inside fn() share a single SQLite transaction.
 * If fn() throws, SQLite rolls back and old cards remain intact — no card blackout.
 * @param {function} fn - Synchronous function containing only DB writes (no async).
 * WI-0817: used by NBA/NHL/MLB model runners to wrap prepareModelAndCardWrite + insertCardPayload.
 */
function runPerGameWriteTransaction(fn) {
  const db = getDatabase();
  return db.transaction(fn)();
}

/**
 * Delete card payloads for a game + card type combo (for idempotency)
 * @param {string} gameId - Game ID
 * @param {string} cardType - Card type
 * @param {{runId?: string}} options - Optional run scope for payload cleanup
 * @returns {number} Count of deleted rows
 */
function deleteCardPayloadsForGame(gameId, cardType, options = {}) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const runId = normalizeRunScopeId(options);

  // Run-scoped cleanup allows workers to stage new run rows without removing
  // currently published run rows, preventing transient empty API reads.
  const runScopeClause = runId ? ' AND run_id = ?' : '';
  const runScopeParams = runId ? [runId] : [];

  // Rewrites are only allowed for unsettled rows. Remove pending result links first,
  // then delete unreferenced payloads. Settled payloads are retained for audit integrity.
  const deletePendingResultsStmt = db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (
        SELECT id
        FROM card_payloads
        WHERE game_id = ? AND card_type = ?${runScopeClause}
      )
  `);
  deletePendingResultsStmt.run(gameId, cardType, ...runScopeParams);

  const deleteUnreferencedPayloadsStmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE game_id = ? AND card_type = ?
      ${runScopeClause}
      AND id NOT IN (
        SELECT card_id
        FROM card_results
      )
  `);
  const deleted = deleteUnreferencedPayloadsStmt.run(
    gameId,
    cardType,
    ...runScopeParams,
  ).changes;

  // Keep referenced payloads immutable but stale so current-card reads ignore them.
  const expireReferencedPayloadsStmt = db.prepare(`
    UPDATE card_payloads
    SET expires_at = COALESCE(expires_at, ?), updated_at = ?
    WHERE game_id = ? AND card_type = ?
      ${runScopeClause}
      AND id IN (
        SELECT card_id
        FROM card_results
      )
      AND expires_at IS NULL
  `);
  expireReferencedPayloadsStmt.run(now, now, gameId, cardType, ...runScopeParams);

  return deleted;
}

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function isOfficialStatusActionable(value) {
  const status = normalizeOfficialDecisionStatus(value);
  return status === 'PLAY' || status === 'LEAN';
}

function rankOfficialStatus(value) {
  const status = normalizeOfficialDecisionStatus(value);
  if (status === 'PLAY') return 2;
  if (status === 'LEAN') return 1;
  return 0;
}

function toFiniteNumberOrNull(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function recordCalibrationPredictionForCard({ db, card, payloadData, lockedMarket }) {
  const { recordPrediction, resolveCalibrationMarketKey } = require('../calibration-utils');
  const modelStatus = toUpperToken(payloadData?.model_status || 'MODEL_OK');
  if (modelStatus !== 'MODEL_OK') return;

  const fairProb = toFiniteNumberOrNull(
    payloadData?.fair_prob ??
      payloadData?.p_fair ??
      payloadData?.model_prob,
  );
  if (fairProb === null || fairProb < 0 || fairProb > 1) return;

  const impliedProb = toFiniteNumberOrNull(
    payloadData?.implied_prob ??
      payloadData?.p_implied,
  );
  const market = resolveCalibrationMarketKey(payloadData?.market_key ?? null, {
    sport: card?.sport,
    recommendedBetType:
      payloadData?.recommended_bet_type ??
      lockedMarket?.marketType ??
      payloadData?.market_type,
    marketType: payloadData?.market_type,
    period: payloadData?.period ?? lockedMarket?.period ?? payloadData?.market?.period,
    cardType: card?.cardType,
  });
  const side = toUpperToken(
    lockedMarket?.selection ??
      payloadData?.selection?.side ??
      payloadData?.selection,
  );

  if (!market || !side) return;

  try {
    recordPrediction({
      db,
      gameId: card.gameId,
      market,
      side,
      fairProb,
      impliedProb,
      modelStatus,
      createdAt: card.createdAt || new Date().toISOString(),
    });
  } catch (error) {
    console.warn(
      `[DB] calibration_predictions write skipped for ${card.id}: ${error.message}`,
    );
  }
}

function resolveOfficialPlayStatus(payloadData) {
  return resolveNormalizedDecisionStatus(payloadData);
}

function normalizeMarketTypeForTracking(rawValue) {
  const token = toUpperToken(rawValue).replace(/[\s-]+/g, '_');
  if (!token) return '';

  if (token === 'MONEYLINE' || token === 'ML' || token === 'H2H') return 'MONEYLINE';
  if (token === 'SPREAD' || token === 'PUCKLINE' || token === 'PUCK_LINE') return 'SPREAD';
  if (
    token === 'TOTAL' ||
    token === 'TOTALS' ||
    token === 'OVER_UNDER' ||
    token === 'OU' ||
    token === 'FIRST_PERIOD' ||
    token === '1P' ||
    token === 'P1'
  ) {
    return 'TOTAL';
  }

  return token;
}

function resolveTrackingPeriod(payloadData, context = {}) {
  const explicitPeriod = normalizeMarketPeriod(
    context.period ??
      payloadData?.period ??
      payloadData?.time_period ??
      payloadData?.market?.period ??
      payloadData?.market_context?.period ??
      payloadData?.market_context?.wager?.period ??
      payloadData?.pricing_trace?.period ??
      null
  );
  if (explicitPeriod) return explicitPeriod;

  const marketToken = toUpperToken(
    context.marketType ??
      payloadData?.market_type ??
      payloadData?.market_context?.market_type ??
      payloadData?.recommended_bet_type
  ).replace(/[\s-]+/g, '_');

  if (marketToken === 'FIRST_PERIOD' || marketToken === '1P' || marketToken === 'P1') {
    return '1P';
  }

  return 'FULL_GAME';
}

function shouldTrackDisplayedPlay(payloadData, context = {}) {
  const kind = toUpperToken(payloadData?.kind || 'PLAY');
  if (kind !== 'PLAY') return false;

  const sport = toUpperToken(context.sport ?? payloadData?.sport);
  const marketType = normalizeMarketTypeForTracking(
    context.marketType ??
      payloadData?.market_type ??
      payloadData?.market_context?.market_type ??
      payloadData?.recommended_bet_type
  );
  const selection = toUpperToken(
    context.selection ??
      payloadData?.selection?.side ??
      payloadData?.selection
  );
  const line =
    context.line !== undefined
      ? toFiniteNumberOrNull(context.line)
      : toFiniteNumberOrNull(payloadData?.line);
  const price =
    context.price !== undefined
      ? toFiniteNumberOrNull(context.price)
      : toFiniteNumberOrNull(payloadData?.price);
  const officialStatus = resolveOfficialPlayStatus(payloadData);
  const isActionable = isOfficialStatusActionable(officialStatus);
  if (!isActionable) return false;

  if (!sport || !marketType) return false;

  if (marketType === 'MONEYLINE') {
    return (selection === 'HOME' || selection === 'AWAY') && price !== null;
  }
  if (marketType === 'SPREAD') {
    return (
      (selection === 'HOME' || selection === 'AWAY') &&
      line !== null &&
      price !== null
    );
  }
  if (marketType === 'TOTAL') {
    const period = resolveTrackingPeriod(payloadData, context);
    return (
      (selection === 'OVER' || selection === 'UNDER') &&
      line !== null &&
      (price !== null || period === '1P')
    );
  }

  return false;
}

function hasCardDisplayLogTable(db) {
  const row = db
    .prepare(
      `
      SELECT 1 AS exists_flag
      FROM sqlite_master
      WHERE type = 'table'
        AND name = 'card_display_log'
      LIMIT 1
    `,
    )
    .get();
  return Boolean(row);
}

function safeTimestampMs(value) {
  if (!value) return 0;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function toSortableNumber(value, fallback = -Infinity) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function toConfidencePct(payloadData, fallbackValue = null) {
  const confidencePct = toFiniteNumberOrNull(payloadData?.confidence_pct);
  if (confidencePct !== null) return confidencePct;
  const confidence = toFiniteNumberOrNull(payloadData?.confidence);
  if (confidence !== null) return confidence * 100;
  return toFiniteNumberOrNull(fallbackValue) ?? 0;
}

function get30DayPerformanceFactor(db, params, cache) {
  const sport = toUpperToken(params?.sport);
  const marketType = toUpperToken(params?.marketType);
  const anchorIso = params?.anchorIso || new Date().toISOString();
  const cacheKey = `${sport}|${marketType}|${String(anchorIso).slice(0, 10)}`;

  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!sport || !marketType) {
    const fallback = { factor: 1, sampleSize: 0 };
    if (cache) cache.set(cacheKey, fallback);
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
  if (cache) cache.set(cacheKey, result);
  return result;
}

function buildDisplayedPlayRankContext(db, candidate, cache) {
  const payloadData =
    candidate?.payloadData && typeof candidate.payloadData === 'object'
      ? candidate.payloadData
      : {};
  const officialStatus = resolveOfficialPlayStatus(payloadData);
  const statusRank = rankOfficialStatus(officialStatus);
  const confidencePct = toConfidencePct(payloadData, candidate?.confidencePct);
  const perf = get30DayPerformanceFactor(
    db,
    {
      sport: candidate?.sport,
      marketType: candidate?.marketType,
      anchorIso: candidate?.displayedAt || new Date().toISOString(),
    },
    cache,
  );
  const weightedConfidence = confidencePct * perf.factor;
  const edgePct = toSortableNumber(
    payloadData?.decision_v2?.edge_delta_pct ?? payloadData?.decision_v2?.edge_pct,
  );
  const supportScore = toSortableNumber(payloadData?.decision_v2?.support_score);
  const displayedAtMs = safeTimestampMs(candidate?.displayedAt);
  const pickId = String(candidate?.pickId || '');

  return {
    statusRank,
    weightedConfidence,
    edgePct,
    supportScore,
    displayedAtMs,
    pickId,
  };
}

function compareDisplayedPlayRank(a, b) {
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

function upsertBestDisplayedPlayLog(db, entry) {
  if (!hasCardDisplayLogTable(db)) return false;

  const existing = db
    .prepare(
      `
      SELECT
        id,
        pick_id,
        sport,
        market_type,
        line,
        odds,
        confidence_pct,
        displayed_at
      FROM card_display_log
      WHERE game_id = ?
        AND ((? IS NULL AND run_id IS NULL) OR run_id = ?)
      ORDER BY datetime(displayed_at) DESC, id DESC
      LIMIT 1
    `,
    )
    .get(
      entry.gameId,
      entry.runId,
      entry.runId,
    );

  if (!existing) {
    db.prepare(
      `
      INSERT OR IGNORE INTO card_display_log (
        pick_id, run_id, game_id, sport, market_type, selection, line,
        odds, odds_book, confidence_pct, displayed_at, api_endpoint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      entry.pickId,
      entry.runId || null,
      entry.gameId || null,
      entry.sport || null,
      entry.marketType || null,
      entry.selection || null,
      entry.line !== undefined ? entry.line : null,
      entry.odds !== undefined ? entry.odds : null,
      entry.oddsBook || null,
      entry.confidencePct !== undefined ? entry.confidencePct : null,
      entry.displayedAt || new Date().toISOString(),
      entry.apiEndpoint || '/api/games',
    );
    return true;
  }

  if (existing.pick_id !== entry.pickId) {
    const cache = new Map();
    const existingPayloadRow = db
      .prepare(
        `
        SELECT payload_data
        FROM card_payloads
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(existing.pick_id);

    let existingPayloadData = {};
    if (existingPayloadRow?.payload_data) {
      try {
        existingPayloadData = JSON.parse(existingPayloadRow.payload_data);
      } catch {
        existingPayloadData = {};
      }
    }

    const candidateRank = buildDisplayedPlayRankContext(
      db,
      {
        pickId: entry.pickId,
        sport: entry.sport,
        marketType: entry.marketType,
        confidencePct: entry.confidencePct,
        displayedAt: entry.displayedAt,
        payloadData: entry.payloadData,
      },
      cache,
    );
    const existingRank = buildDisplayedPlayRankContext(
      db,
      {
        pickId: existing.pick_id,
        sport: existing.sport,
        marketType: existing.market_type,
        confidencePct: existing.confidence_pct,
        displayedAt: existing.displayed_at,
        payloadData: existingPayloadData,
      },
      cache,
    );

    if (compareDisplayedPlayRank(candidateRank, existingRank) <= 0) {
      return false;
    }
  }

  db.prepare(
    `DELETE FROM card_display_log WHERE pick_id = ? AND id != ?`,
  ).run(entry.pickId, existing.id);

  db.prepare(
    `
      UPDATE card_display_log
      SET
        pick_id = ?,
        run_id = ?,
        game_id = ?,
        sport = ?,
        market_type = ?,
        selection = ?,
        line = ?,
        odds = ?,
        odds_book = ?,
        confidence_pct = ?,
        displayed_at = ?,
        api_endpoint = ?
      WHERE id = ?
    `,
  ).run(
    entry.pickId,
    entry.runId || null,
    entry.gameId || null,
    entry.sport || null,
    entry.marketType || null,
    entry.selection || null,
    entry.line !== undefined ? entry.line : null,
    entry.odds !== undefined ? entry.odds : null,
    entry.oddsBook || null,
    entry.confidencePct !== undefined ? entry.confidencePct : null,
    entry.displayedAt || new Date().toISOString(),
    entry.apiEndpoint || '/api/games',
    existing.id,
  );
  return true;
}

/**
 * Insert a card payload (web-ready data)
 * @param {object} card - Card payload data
 * @param {string} card.id - Unique ID
 * @param {string} card.gameId - Game ID
 * @param {string} card.sport - Sport name
 * @param {string} card.cardType - Card type (e.g., 'clv-analysis', 'pick', 'line-movement')
 * @param {string} card.cardTitle - Display title
 * @param {string} card.createdAt - ISO 8601 timestamp
 * @param {string} card.expiresAt - Optional ISO 8601 timestamp (when card becomes stale)
 * @param {object} card.payloadData - The actual card data (will be stringified)
 * @param {string} card.modelOutputIds - Optional comma-separated IDs of related model outputs
 * @param {object} card.metadata - Optional metadata object
 * @param {string} card.runId - Optional snapshot run ID
 */
function insertCardPayload(card) {
  const db = getDatabase();
  const oddsContextReferenceRegistry = getOddsContextReferenceRegistry();
  const normalizedCardTitle = normalizeCardTitle(card.cardTitle, 'insertCardPayload');
  const payloadData = card.payloadData && typeof card.payloadData === 'object'
    ? card.payloadData
    : {};
  const runId = card.runId ?? payloadData.run_id ?? null;
  const normalizedRunId = runId ? String(runId) : null;
  if (normalizedRunId && !payloadData.run_id) {
    payloadData.run_id = normalizedRunId;
  }

  // 1P driver projections (nhl-pace-1p) have no priced odds — PASS calls (selection.side=NONE)
  // are not actionable and skip market locking entirely; OVER/UNDER calls lock without a price.
  const is1pDriver = String(card.cardType || '').includes('-pace-1p');
  const is1pPassCall = is1pDriver && toUpperToken(payloadData?.selection?.side) === 'NONE';
  // Without Odds Mode: LEAN cards have no market price — skip price requirement at lock time.
  const isNoOddsModeLean = Array.isArray(payloadData?.tags) && payloadData.tags.includes('no_odds_mode');

  let lockedMarket = null;
  if (!is1pPassCall) {
    try {
      lockedMarket = deriveLockedMarketContext(payloadData, {
        gameId: card.gameId,
        homeTeam: payloadData.home_team ?? null,
        awayTeam: payloadData.away_team ?? null,
        requirePrice: !is1pDriver && !isNoOddsModeLean,
        requireLineForMarket: !isNoOddsModeLean,
      });
    } catch (error) {
      const code = error?.code || 'INVALID_MARKET_CONTRACT';
      throw createMarketError(
        code,
        `[DB] Refusing to lock invalid market payload for card ${card.id}: ${error.message}`,
        { cardId: card.id, gameId: card.gameId, cause: error?.details || null }
      );
    }
  }

  if (lockedMarket) {
    payloadData.market_type = lockedMarket.marketType;
    payloadData.recommended_bet_type = toRecommendedBetType(lockedMarket.marketType);
    payloadData.selection = {
      ...(payloadData.selection && typeof payloadData.selection === 'object' ? payloadData.selection : {}),
      side: lockedMarket.selection,
    };
    if (lockedMarket.line !== null) payloadData.line = lockedMarket.line;
    if (lockedMarket.lockedPrice !== null) payloadData.price = lockedMarket.lockedPrice;
    if (lockedMarket.period) {
      payloadData.period = lockedMarket.period;
      payloadData.market = {
        ...(payloadData.market && typeof payloadData.market === 'object'
          ? payloadData.market
          : {}),
        period: lockedMarket.period,
      };
    }
    payloadData.market_key = lockedMarket.marketKey;
  }

  const oddsContext = payloadData?.odds_context;
  if (lockedMarket && oddsContext && typeof oddsContext === 'object') {
    const existing = oddsContextReferenceRegistry.get(oddsContext);
    if (
      existing &&
      existing.gameId === card.gameId &&
      existing.marketKey !== lockedMarket.marketKey
    ) {
      throw createMarketError(
        'SHARED_ODDS_CONTEXT_REFERENCE',
        `[DB] Two market rows share the same odds_context object reference for game ${card.gameId}`,
        {
          gameId: card.gameId,
          firstCardId: existing.cardId,
          firstMarketKey: existing.marketKey,
          secondCardId: card.id,
          secondMarketKey: lockedMarket.marketKey,
        }
      );
    }

    oddsContextReferenceRegistry.set(oddsContext, {
      cardId: card.id,
      gameId: card.gameId,
      marketKey: lockedMarket.marketKey,
    });
  }
  
  ensureCardPayloadRunIdColumn(db);

    // Normalize sport to lowercase for consistency with odds_snapshots and games table
    const normalizedSport = card.sport ? card.sport.toLowerCase() : card.sport;

  const stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO card_payloads (
      id, game_id, sport, card_type, card_title, created_at,
      expires_at, payload_data, model_output_ids, metadata, run_id,
      first_seen_price
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // For call cards: if INSERT was ignored (row already exists) and it is not settled,
  // update payload with the latest model output.
  // This implements the upsert contract for deterministic call-card IDs (WI-0812).
  // The partial UNIQUE INDEX (uq_card_payloads_call_per_game on game_id, card_type WHERE
  // card_type LIKE '%-call') prevents new duplicate rows from accumulating; this UPDATE
  // refreshes the surviving canonical row when re-running for an in-progress game.
  const stmtUpdate = db.prepare(`
    UPDATE card_payloads
    SET
      payload_data = ?,
      run_id       = ?,
      created_at   = ?,
      expires_at   = ?
    WHERE game_id   = ?
      AND card_type = ?
      AND card_type LIKE '%-call'
      AND NOT EXISTS (
        SELECT 1 FROM card_results
        WHERE card_id = card_payloads.id
          AND status = 'settled'
      )
  `);
  
  const insertInfo = stmtInsert.run(
    card.id,
    card.gameId,
    normalizedSport,
    card.cardType,
    normalizedCardTitle,
    card.createdAt,
    card.expiresAt || null,
    JSON.stringify(payloadData),
    card.modelOutputIds || null,
    card.metadata ? JSON.stringify(card.metadata) : null,
    normalizedRunId,
    // first_seen_price: written once at creation, never overwritten (WI-0838)
    lockedMarket?.lockedPrice ?? null
  );

  // If INSERT OR IGNORE fired (0 changes) and the card's own ID is not in card_payloads,
  // the insert was suppressed by the partial UNIQUE index (uq_card_payloads_call_per_game)
  // rather than a PK collision. The canonical row for this (game_id, card_type) is a
  // different card (typically settled). card.id does not exist in the DB so we must not
  // write a card_results row that references it — that would fail the FK constraint.
  // Log and return; the HARD_LOCKED gate already handled the decision layer.
  if (insertInfo.changes === 0) {
    const exists = db.prepare('SELECT 1 FROM card_payloads WHERE id = ?').get(card.id);
    if (!exists) {
      console.log(
        `[DB] insertCardPayload: ${card.id} suppressed by UNIQUE index ` +
        `(${card.cardType} for game ${card.gameId} already has a settled canonical row). ` +
        `Skipping card_results insert.`,
      );
      return;
    }
  }

  if (String(card.cardType || '').endsWith('-call')) {
    stmtUpdate.run(
      JSON.stringify(payloadData),
      normalizedRunId,
      card.createdAt,
      card.expiresAt || null,
      card.gameId,
      card.cardType,
    );
  }

  if (insertInfo.changes > 0) {
    try {
      captureProjectionAccuracyForCard(db, {
        ...card,
        payloadData,
      });
    } catch (error) {
      console.warn(
        `[DB] projection_accuracy capture skipped for ${card.id}: ${error.message}`,
      );
    }
  }

  const recommendedBetType = lockedMarket
    ? toRecommendedBetType(lockedMarket.marketType)
    : (payloadData?.recommended_bet_type || 'unknown');

  insertCardResult({
    id: `card-result-${card.id}`,
    cardId: card.id,
    gameId: card.gameId,
    sport: card.sport,
    cardType: card.cardType,
    recommendedBetType,
    marketKey: lockedMarket?.marketKey || null,
    marketType: lockedMarket?.marketType || null,
    selection: lockedMarket?.selection || null,
    line: lockedMarket?.line ?? null,
    lockedPrice: lockedMarket?.lockedPrice ?? null,
    status: 'pending',
    result: null,
    settledAt: null,
    pnlUnits: null,
    metadata: lockedMarket
      ? {
          lockedAt: card.createdAt || new Date().toISOString(),
          marketKey: lockedMarket.marketKey,
          lockedMarket: {
            marketType: lockedMarket.marketType,
            selection: lockedMarket.selection,
            line: lockedMarket.line,
            lockedPrice: lockedMarket.lockedPrice,
            period: lockedMarket.period || 'FULL_GAME',
          },
        }
      : null
  });

  if (
    lockedMarket &&
    shouldTrackDisplayedPlay(payloadData, {
      sport: card.sport,
      marketType: lockedMarket.marketType,
      period: lockedMarket.period,
      selection: lockedMarket.selection,
      line: lockedMarket.line,
      price: lockedMarket.lockedPrice,
    })
  ) {
    const confidencePct = toFiniteNumberOrNull(payloadData?.confidence_pct);
    const fallbackConfidence = toFiniteNumberOrNull(payloadData?.confidence);
    const normalizedConfidence =
      confidencePct !== null
        ? confidencePct
        : fallbackConfidence !== null
          ? fallbackConfidence * 100
          : null;

    upsertBestDisplayedPlayLog(db, {
      pickId: card.id,
      runId: normalizedRunId,
      gameId: card.gameId,
      sport: card.sport ? String(card.sport).toUpperCase() : null,
      marketType: lockedMarket.marketType,
      selection: lockedMarket.selection,
      line: lockedMarket.line,
      odds: lockedMarket.lockedPrice,
      oddsBook: payloadData?.odds_context?.bookmaker || null,
      confidencePct: normalizedConfidence,
      displayedAt: card.createdAt || new Date().toISOString(),
      apiEndpoint: '/api/games',
      payloadData,
    });
  }

  recordCalibrationPredictionForCard({
    db,
    card,
    payloadData,
    lockedMarket,
  });
}

/**
 * Get card payload by ID
 * @param {string} cardId - Card ID
 * @returns {object|null} Card payload or null
 */
function getCardPayload(cardId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE id = ?
  `);
  
  return stmt.get(cardId) || null;
}

/**
 * Get all cards for a game
 * @param {string} gameId - Game ID
 * @returns {array} Card payloads
 */
function getCardPayloads(gameId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE game_id = ?
    ORDER BY created_at DESC
  `);
  
  return stmt.all(gameId);
}

/**
 * Get cards by type (e.g., all 'clv-analysis' cards)
 * @param {string} cardType - Card type
 * @param {number} limitDays - Return cards from last N days (default 7)
 * @returns {array} Card payloads
 */
function getCardPayloadsByType(cardType, limitDays = 7) {
  const db = getDatabase();
  const threshold = new Date(Date.now() - limitDays * 86400000).toISOString();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE card_type = ? AND created_at >= ?
    ORDER BY created_at DESC
  `);
  
  return stmt.all(cardType, threshold);
}

/**
 * Get cards for a sport
 * @param {string} sport - Sport name
 * @param {number} limitCards - Max cards per game (default 10)
 * @returns {array} Card payloads
 */
function getCardPayloadsBySport(sport, limitCards = 10) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM card_payloads
    WHERE sport = ?
    ORDER BY game_id, created_at DESC
    LIMIT ?
  `);
  
  return stmt.all(sport, limitCards);
}

/**
 * Mark a card as expired
 * @param {string} cardId - Card ID
 */
function expireCardPayload(cardId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    UPDATE card_payloads
    SET expires_at = datetime('now'), updated_at = ?
    WHERE id = ?
  `);
  
  stmt.run(new Date().toISOString(), cardId);
}

/**
 * Delete old expired cards (cleanup)
 * @param {number} daysOld - Delete cards older than N days (default 30)
 * @returns {number} Count of deleted cards
 */
function deleteExpiredCards(daysOld = 30) {
  const db = getDatabase();
  const threshold = new Date(Date.now() - daysOld * 86400000).toISOString();

  // Drop pending settlement rows for payloads that are already expired and being pruned.
  const deletePendingResultsStmt = db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (
        SELECT id
        FROM card_payloads
        WHERE expires_at IS NOT NULL AND expires_at < ?
      )
  `);
  deletePendingResultsStmt.run(threshold);

  // Never delete payloads still referenced by card_results; preserve audit integrity.
  const stmt = db.prepare(`
    DELETE FROM card_payloads
    WHERE expires_at IS NOT NULL
      AND expires_at < ?
      AND id NOT IN (
        SELECT card_id
        FROM card_results
      )
  `);

  const result = stmt.run(threshold);
  return result.changes;
}

/**
 * Get the current published decision record
 * @param {string} decisionKey
 * @returns {object|null}
 */
function getDecisionRecord(decisionKey) {
  const db = getDatabase();

  const stmt = db.prepare(`
    SELECT * FROM decision_records
    WHERE decision_key = ?
  `);

  return stmt.get(decisionKey) || null;
}

/**
 * Upsert a decision record (published decision)
 * @param {object} record
 */
function upsertDecisionRecord(record) {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO decision_records (
      decision_key, sport, game_id, market, period, side_family,
      recommended_side, recommended_line, recommended_price, book,
      edge, confidence, locked_status, locked_at, last_seen_at,
      result_version, inputs_hash, odds_snapshot_id,
      flip_count, last_flip_at, last_reason_code, last_reason_detail,
      last_candidate_hash, candidate_seen_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(decision_key) DO UPDATE SET
      sport = excluded.sport,
      game_id = excluded.game_id,
      market = excluded.market,
      period = excluded.period,
      side_family = excluded.side_family,
      recommended_side = excluded.recommended_side,
      recommended_line = excluded.recommended_line,
      recommended_price = excluded.recommended_price,
      book = excluded.book,
      edge = excluded.edge,
      confidence = excluded.confidence,
      locked_status = CASE
        WHEN decision_records.locked_status = 'HARD' THEN 'HARD'
        ELSE excluded.locked_status
      END,
      locked_at = CASE
        WHEN decision_records.locked_status = 'HARD' THEN decision_records.locked_at
        WHEN excluded.locked_status = 'HARD' THEN excluded.locked_at
        ELSE decision_records.locked_at
      END,
      last_seen_at = excluded.last_seen_at,
      result_version = excluded.result_version,
      inputs_hash = excluded.inputs_hash,
      odds_snapshot_id = excluded.odds_snapshot_id,
      flip_count = CASE
        WHEN excluded.recommended_side != decision_records.recommended_side THEN decision_records.flip_count + 1
        ELSE decision_records.flip_count
      END,
      last_flip_at = CASE
        WHEN excluded.recommended_side != decision_records.recommended_side THEN excluded.last_seen_at
        ELSE decision_records.last_flip_at
      END,
      last_reason_code = excluded.last_reason_code,
      last_reason_detail = excluded.last_reason_detail,
      last_candidate_hash = excluded.last_candidate_hash,
      candidate_seen_count = excluded.candidate_seen_count
  `);

  stmt.run(
    record.decisionKey,
    record.sport,
    record.gameId,
    record.market,
    record.period,
    record.sideFamily,
    record.recommendedSide,
    record.recommendedLine,
    record.recommendedPrice,
    record.book || null,
    record.edge,
    record.confidence ?? null,
    record.lockedStatus,
    record.lockedAt || null,
    record.lastSeenAt,
    record.resultVersion || null,
    record.inputsHash || null,
    record.oddsSnapshotId || null,
    record.flipCount ?? 0,
    record.lastFlipAt || null,
    record.lastReasonCode || null,
    record.lastReasonDetail || null,
    record.lastCandidateHash || null,
    record.candidateSeenCount ?? 0
  );
}

/**
 * Update candidate tracking without changing published decision
 * @param {object} update
 */
function updateDecisionCandidateTracking(update) {
  const db = getDatabase();

  const stmt = db.prepare(`
    UPDATE decision_records
    SET last_seen_at = ?,
        last_candidate_hash = ?,
        candidate_seen_count = ?,
        last_reason_code = ?,
        last_reason_detail = ?,
        locked_status = CASE
          WHEN ? IS NULL THEN locked_status
          WHEN locked_status = 'HARD' THEN locked_status
          ELSE ?
        END,
        locked_at = CASE
          WHEN ? IS NULL THEN locked_at
          WHEN locked_status = 'HARD' THEN locked_at
          WHEN ? = 'HARD' THEN ?
          ELSE locked_at
        END
    WHERE decision_key = ?
  `);

  stmt.run(
    update.lastSeenAt,
    update.lastCandidateHash || null,
    update.candidateSeenCount ?? 0,
    update.lastReasonCode || null,
    update.lastReasonDetail || null,
    update.lockedStatus || null,
    update.lockedStatus || null,
    update.lockedStatus || null,
    update.lockedStatus || null,
    update.lockedAt || null,
    update.decisionKey
  );
}

/**
 * Insert a decision event audit record
 * @param {object} event
 */
function insertDecisionEvent(event) {
  const db = getDatabase();

  const stmt = db.prepare(`
    INSERT INTO decision_events (
      ts, decision_key, action, reason_code, reason_detail,
      prev_side, prev_line, prev_price, prev_edge,
      cand_side, cand_line, cand_price, cand_edge,
      edge_delta, line_delta, price_delta,
      inputs_hash, result_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    event.ts,
    event.decisionKey,
    event.action,
    event.reasonCode,
    event.reasonDetail || null,
    event.prevSide || null,
    event.prevLine ?? null,
    event.prevPrice ?? null,
    event.prevEdge ?? null,
    event.candSide,
    event.candLine ?? null,
    event.candPrice ?? null,
    event.candEdge,
    event.edgeDelta ?? null,
    event.lineDelta ?? null,
    event.priceDelta ?? null,
    event.inputsHash || null,
    event.resultVersion || null
  );
}

/**
 * Get upcoming games for scheduler window detection
 * @param {object} params
 * @param {string} params.startUtcIso - Start time (ISO 8601 UTC)
 * @param {string} params.endUtcIso - End time (ISO 8601 UTC)
 * @param {string[]} params.sports - Optional array of sports to filter (e.g., ['nhl', 'nba'])
 * @returns {array} Games [{game_id, sport, game_time_utc}, ...]
 */

/**
 * Retrieve the latest NHL goalie model inputs from card_payloads for a given game.
 * Returns { homeGoalie: { savePct, gsax }, awayGoalie: { savePct, gsax } } or null.
 * Supports both primary flat keys (goalie_home_save_pct) and legacy nested keys (goalie.home.save_pct).
 */
function getLatestNhlModelOutput(gameId) {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT payload_data FROM card_payloads
    WHERE game_id = ? AND sport = 'icehockey_nhl'
    ORDER BY created_at DESC LIMIT 1
  `).get(gameId);
  if (!row) return null;
  const rd = JSON.parse(row.payload_data);
  return {
    homeGoalie: {
      savePct: rd.goalie_home_save_pct ?? rd.goalie?.home?.save_pct ?? null,
      gsax:    rd.goalie_home_gsax    ?? rd.goalie?.home?.gsax    ?? null,
    },
    awayGoalie: {
      savePct: rd.goalie_away_save_pct ?? rd.goalie?.away?.save_pct ?? null,
      gsax:    rd.goalie_away_gsax    ?? rd.goalie?.away?.gsax    ?? null,
    },
  };
}

module.exports = {
  deleteCardPayloadsByGameAndType,
  deleteCardPayloadsForGame,
  prepareModelAndCardWrite,
  runPerGameWriteTransaction,
  insertCardPayload,
  getCardPayload,
  getCardPayloads,
  getCardPayloadsByType,
  getCardPayloadsBySport,
  expireCardPayload,
  deleteExpiredCards,
  getDecisionRecord,
  upsertDecisionRecord,
  updateDecisionCandidateTracking,
  insertDecisionEvent,
  setProjectionActualResult,
  getUnsettledProjectionCards,
  getLatestNhlModelOutput,
};
