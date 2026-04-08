const {
  getDatabase,
  getDatabaseReadOnly,
  closeReadOnlyInstance,
  normalizeSportValue,
} = require('./connection');

function ensureOddsIngestFailuresSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS odds_ingest_failures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      failure_key TEXT NOT NULL UNIQUE,
      job_run_id TEXT,
      job_name TEXT,
      sport TEXT,
      provider TEXT,
      game_id TEXT,
      reason_code TEXT NOT NULL,
      reason_detail TEXT,
      home_team TEXT,
      away_team TEXT,
      payload_hash TEXT,
      source_context TEXT,
      first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_last_seen
      ON odds_ingest_failures(last_seen DESC)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_reason
      ON odds_ingest_failures(reason_code, last_seen DESC)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_odds_ingest_failures_sport
      ON odds_ingest_failures(sport, last_seen DESC)`,
  );
}

function buildOddsIngestFailureKey(event) {
  const sport = normalizeSportValue(event.sport, 'buildOddsIngestFailureKey');
  return [
    event.jobName || 'pull_odds_hourly',
    sport || 'unknown',
    event.provider || 'unknown',
    event.gameId || 'no-game',
    event.reasonCode || 'UNKNOWN',
    event.homeTeam || '',
    event.awayTeam || '',
  ].join('|');
}

function recordOddsIngestFailure(event) {
  if (!event || !event.reasonCode) return;
  const db = getDatabase();
  ensureOddsIngestFailuresSchema(db);

  const nowIso = new Date().toISOString();
  const failureKey = event.failureKey || buildOddsIngestFailureKey(event);
  const sport = normalizeSportValue(event.sport, 'recordOddsIngestFailure');
  const sourceContext =
    event.sourceContext && typeof event.sourceContext === 'object'
      ? JSON.stringify(event.sourceContext)
      : null;

  const stmt = db.prepare(`
    INSERT INTO odds_ingest_failures (
      failure_key,
      job_run_id,
      job_name,
      sport,
      provider,
      game_id,
      reason_code,
      reason_detail,
      home_team,
      away_team,
      payload_hash,
      source_context,
      first_seen,
      last_seen,
      occurrence_count,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(failure_key) DO UPDATE SET
      job_run_id = excluded.job_run_id,
      job_name = excluded.job_name,
      reason_detail = excluded.reason_detail,
      payload_hash = COALESCE(excluded.payload_hash, odds_ingest_failures.payload_hash),
      source_context = COALESCE(excluded.source_context, odds_ingest_failures.source_context),
      last_seen = excluded.last_seen,
      occurrence_count = odds_ingest_failures.occurrence_count + 1,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    failureKey,
    event.jobRunId || null,
    event.jobName || null,
    sport,
    event.provider || null,
    event.gameId || null,
    event.reasonCode,
    event.reasonDetail || null,
    event.homeTeam || null,
    event.awayTeam || null,
    event.payloadHash || null,
    sourceContext,
    nowIso,
    nowIso,
    nowIso,
  );
}

function getOddsIngestFailureSummary({
  sinceHours = 24,
  limit = 50,
  reasonLimit = 20,
  readOnly = false,
} = {}) {
  const db = readOnly ? getDatabaseReadOnly() : getDatabase();
  if (!readOnly) {
    ensureOddsIngestFailuresSchema(db);
  }

  const safeSinceHours =
    Number.isFinite(Number(sinceHours)) && Number(sinceHours) > 0
      ? Math.min(Number(sinceHours), 24 * 30)
      : 24;
  const safeLimit =
    Number.isFinite(Number(limit)) && Number(limit) > 0
      ? Math.min(Number(limit), 500)
      : 50;
  const safeReasonLimit =
    Number.isFinite(Number(reasonLimit)) && Number(reasonLimit) > 0
      ? Math.min(Number(reasonLimit), 100)
      : 20;
  const sinceExpr = `-${safeSinceHours} hours`;

  try {
    const totalsStmt = db.prepare(`
      SELECT
        COUNT(*) AS row_count,
        COALESCE(SUM(occurrence_count), 0) AS occurrence_count
      FROM odds_ingest_failures
      WHERE datetime(last_seen) >= datetime('now', ?)
    `);
    const totals = totalsStmt.get(sinceExpr) || {
      row_count: 0,
      occurrence_count: 0,
    };

    const topReasonsStmt = db.prepare(`
      SELECT
        reason_code,
        sport,
        COUNT(*) AS row_count,
        COALESCE(SUM(occurrence_count), 0) AS occurrence_count,
        MAX(last_seen) AS last_seen
      FROM odds_ingest_failures
      WHERE datetime(last_seen) >= datetime('now', ?)
      GROUP BY reason_code, sport
      ORDER BY occurrence_count DESC, row_count DESC, last_seen DESC
      LIMIT ?
    `);
    const topReasons = topReasonsStmt.all(sinceExpr, safeReasonLimit);

    const recentStmt = db.prepare(`
      SELECT
        id,
        job_run_id,
        job_name,
        sport,
        provider,
        game_id,
        reason_code,
        reason_detail,
        home_team,
        away_team,
        payload_hash,
        source_context,
        first_seen,
        last_seen,
        occurrence_count
      FROM odds_ingest_failures
      WHERE datetime(last_seen) >= datetime('now', ?)
      ORDER BY datetime(last_seen) DESC
      LIMIT ?
    `);
    const recentRows = recentStmt.all(sinceExpr, safeLimit);

    return {
      window_hours: safeSinceHours,
      totals,
      top_reasons: topReasons,
      recent_failures: recentRows,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such table: odds_ingest_failures')) {
      return {
        window_hours: safeSinceHours,
        totals: { row_count: 0, occurrence_count: 0 },
        top_reasons: [],
        recent_failures: [],
      };
    }
    throw error;
  } finally {
    if (readOnly) {
      closeReadOnlyInstance(db);
    }
  }
}

/**
 * Insert an odds snapshot
 * @param {object} snapshot - Odds data
 * @param {string} snapshot.id - Unique ID
 * @param {string} snapshot.gameId - Game ID
 * @param {string} snapshot.sport - Sport name
 * @param {string} snapshot.capturedAt - ISO 8601 timestamp
 * @param {number} snapshot.h2hHome - Home moneyline
 * @param {number} snapshot.h2hAway - Away moneyline
 * @param {number} snapshot.total - Total line
 * @param {string} snapshot.jobRunId - Associated job run ID
 * @param {object} snapshot.rawData - Full odds object (stringified)
 */
function insertOddsSnapshot(snapshot) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(snapshot.sport, 'insertOddsSnapshot');
  const toNullableNumber = (value) =>
    Number.isFinite(value) ? value : null;
  
  const stmt = db.prepare(`
    INSERT INTO odds_snapshots (
      id, game_id, sport, captured_at, h2h_home, h2h_away, total,
      spread_home, spread_away, spread_home_book, spread_away_book,
      moneyline_home, moneyline_away,
      spread_price_home, spread_price_away, total_price_over, total_price_under,
      spread_price_home_book, spread_price_away_book,
      h2h_home_book, h2h_away_book,
      total_line_over, total_line_over_book,
      total_line_under, total_line_under_book,
      total_price_over_book, total_price_under_book,
      spread_is_mispriced, spread_misprice_type, spread_misprice_strength,
      spread_outlier_book, spread_outlier_delta, spread_review_flag,
      spread_consensus_line, spread_consensus_confidence,
      spread_dispersion_stddev, spread_source_book_count,
      total_is_mispriced, total_misprice_type, total_misprice_strength,
      total_outlier_book, total_outlier_delta, total_review_flag,
      total_consensus_line, total_consensus_confidence,
      total_dispersion_stddev, total_source_book_count,
      h2h_consensus_home, h2h_consensus_away, h2h_consensus_confidence,
      h2h_book, total_book,
      ml_f5_home, ml_f5_away,
      total_f5, total_f5_price_over, total_f5_price_under,
      total_1p, total_1p_price_over, total_1p_price_under,
      raw_data, job_run_id
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    snapshot.id,
    snapshot.gameId,
    normalizedSport,
    snapshot.capturedAt,
    toNullableNumber(snapshot.h2hHome),
    toNullableNumber(snapshot.h2hAway),
    toNullableNumber(snapshot.total),
    toNullableNumber(snapshot.spreadHome),
    toNullableNumber(snapshot.spreadAway),
    snapshot.spreadHomeBook || null,
    snapshot.spreadAwayBook || null,
    toNullableNumber(snapshot.monelineHome),
    toNullableNumber(snapshot.monelineAway),
    toNullableNumber(snapshot.spreadPriceHome),
    toNullableNumber(snapshot.spreadPriceAway),
    toNullableNumber(snapshot.totalPriceOver),
    toNullableNumber(snapshot.totalPriceUnder),
    snapshot.spreadPriceHomeBook || null,
    snapshot.spreadPriceAwayBook || null,
    snapshot.h2hHomeBook || null,
    snapshot.h2hAwayBook || null,
    toNullableNumber(snapshot.totalLineOver),
    snapshot.totalLineOverBook || null,
    toNullableNumber(snapshot.totalLineUnder),
    snapshot.totalLineUnderBook || null,
    snapshot.totalPriceOverBook || null,
    snapshot.totalPriceUnderBook || null,
    snapshot.spreadIsMispriced === true ? 1 : 0,
    snapshot.spreadMispriceType || null,
    toNullableNumber(snapshot.spreadMispriceStrength),
    snapshot.spreadOutlierBook || null,
    toNullableNumber(snapshot.spreadOutlierDelta),
    snapshot.spreadReviewFlag === true ? 1 : 0,
    toNullableNumber(snapshot.spreadConsensusLine),
    snapshot.spreadConsensusConfidence || null,
    toNullableNumber(snapshot.spreadDispersionStddev),
    Number.isInteger(snapshot.spreadSourceBookCount)
      ? snapshot.spreadSourceBookCount
      : null,
    snapshot.totalIsMispriced === true ? 1 : 0,
    snapshot.totalMispriceType || null,
    toNullableNumber(snapshot.totalMispriceStrength),
    snapshot.totalOutlierBook || null,
    toNullableNumber(snapshot.totalOutlierDelta),
    snapshot.totalReviewFlag === true ? 1 : 0,
    toNullableNumber(snapshot.totalConsensusLine),
    snapshot.totalConsensusConfidence || null,
    toNullableNumber(snapshot.totalDispersionStddev),
    Number.isInteger(snapshot.totalSourceBookCount)
      ? snapshot.totalSourceBookCount
      : null,
    toNullableNumber(snapshot.h2hConsensusHome),
    toNullableNumber(snapshot.h2hConsensusAway),
    snapshot.h2hConsensusConfidence || null,
    snapshot.h2hBook || null,
    snapshot.totalBook || null,
    toNullableNumber(snapshot.mlF5Home),
    toNullableNumber(snapshot.mlF5Away),
    toNullableNumber(snapshot.totalF5Line),
    toNullableNumber(snapshot.totalF5Over),
    toNullableNumber(snapshot.totalF5Under),
    toNullableNumber(snapshot.total1pLine),
    toNullableNumber(snapshot.total1pOver),
    toNullableNumber(snapshot.total1pUnder),
    snapshot.rawData ? JSON.stringify(snapshot.rawData) : null,
    snapshot.jobRunId
  );
}

/**
 * Patch the most-recent odds snapshot for a game with 1st-period total line and prices.
 * Called by pull_nhl_1p_odds after fetching per-event totals_p1 odds.
 * Writes total_1p, total_1p_price_over, total_1p_price_under on the latest row
 * for the given game_id (matched by MAX(captured_at)).
 *
 * @param {string} gameId - Game ID
 * @param {{ line: number, overPrice: number|null, underPrice: number|null }} data
 * @returns {number} Number of rows updated (0 if no snapshot exists yet)
 */
function patchOddsSnapshot1p(gameId, { line, overPrice, underPrice }) {
  const db = getDatabase();
  const toNullableNumber = (v) => (Number.isFinite(v) ? v : null);
  const result = db
    .prepare(
      `UPDATE odds_snapshots
         SET total_1p           = ?,
             total_1p_price_over  = ?,
             total_1p_price_under = ?
       WHERE id = (
         SELECT id FROM odds_snapshots
         WHERE game_id = ?
         ORDER BY captured_at DESC
         LIMIT 1
       )`,
    )
    .run(
      toNullableNumber(line),
      toNullableNumber(overPrice),
      toNullableNumber(underPrice),
      gameId,
    );
  return result.changes;
}

/**
 * Patch the F5 total (1st-5-innings) fields on the latest odds_snapshot for a game.
 * Writes totals_1st_5_innings into odds_snapshots without re-running the full bulk pipeline.
 *
 * @param {string} gameId
 * @param {{ line: number|null, overPrice: number|null, underPrice: number|null }} fields
 * @returns {number} changed rows (0 = no snapshot found)
 */
function patchOddsSnapshotF5(gameId, { line, overPrice, underPrice }) {
  const db = getDatabase();
  const toNullableNumber = (v) => (Number.isFinite(v) ? v : null);
  const result = db
    .prepare(
      `UPDATE odds_snapshots
         SET total_f5           = ?,
             total_f5_price_over  = ?,
             total_f5_price_under = ?
       WHERE id = (
         SELECT id FROM odds_snapshots
         WHERE game_id = ?
         ORDER BY captured_at DESC
         LIMIT 1
       )`,
    )
    .run(
      toNullableNumber(line),
      toNullableNumber(overPrice),
      toNullableNumber(underPrice),
      gameId,
    );
  return result.changes;
}

/**
 * Delete odds snapshots for a game + captured_at timestamp
 * @param {string} gameId - Game ID
 * @param {string} capturedAt - ISO 8601 timestamp
 * @returns {number} Count of deleted rows
 */
function deleteOddsSnapshotsByGameAndCapturedAt(gameId, capturedAt) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    DELETE FROM odds_snapshots
    WHERE game_id = ? AND captured_at = ?
  `);
  
  const result = stmt.run(gameId, capturedAt);
  return result.changes;
}

/**
 * Update the raw_data field of the latest odds snapshot for a game.
 * Used to persist ESPN enrichment after the fact.
 * Optimized to avoid expensive verification on large JSON strings.
 * @param {string} snapshotId - The odds_snapshots.id to update
 * @param {object|string} enrichedRawData - The enriched raw_data (object or JSON string)
 * @returns {boolean} True if update was attempted (row exists), false if not found
 */
function updateOddsSnapshotRawData(snapshotId, enrichedRawData) {
  try {
    const db = getDatabase();
    
    // Handle both object and string inputs (enrichment functions may return either)
    let rawDataJson = null;
    if (enrichedRawData) {
      rawDataJson = typeof enrichedRawData === 'string'
        ? enrichedRawData
        : JSON.stringify(enrichedRawData);
    }
    
    // First verify the row exists (lightweight check, just id)
    const existing = db.prepare('SELECT 1 FROM odds_snapshots WHERE id = ?').get(snapshotId);
    if (!existing) {
      console.warn(`[updateOddsSnapshotRawData] Snapshot ${snapshotId} not found`);
      return false;
    }
    
    // Warn if raw_data is getting very large (suggests bloat from repeated enrichments)
    if (rawDataJson && rawDataJson.length > 1024 * 1024) {
      console.warn(`[updateOddsSnapshotRawData] Large raw_data for ${snapshotId}: ${Math.round(rawDataJson.length / 1024)}KB`);
    }
    
    // Perform the update (trust SQLite to execute correctly)
    // Skip expensive verification step that loads entire JSON back into memory
    db.prepare('UPDATE odds_snapshots SET raw_data = ? WHERE id = ?').run(rawDataJson, snapshotId);
    
    return true;
  } catch (err) {
    console.error(`[updateOddsSnapshotRawData] Error for snapshot ${snapshotId}: ${err.message}`);
    return false;
  }
}

/**
 * Prepare idempotent odds snapshot writes
 * @param {string} gameId - Game ID
 * @param {string} capturedAt - ISO 8601 timestamp
 * @returns {number} Count of deleted rows
 */
function prepareOddsSnapshotWrite(gameId, capturedAt) {
  return deleteOddsSnapshotsByGameAndCapturedAt(gameId, capturedAt);
}

/**
 * Get latest odds snapshot for a game
 * @param {string} gameId - Game ID
 * @returns {object|null} Latest odds snapshot or null
 */
function getLatestOdds(gameId) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE game_id = ?
    ORDER BY captured_at DESC
    LIMIT 1
  `);
  
  return stmt.get(gameId) || null;
}

/**
 * Get all odds snapshots for a sport since a given time
 * @param {string} sport - Sport name
 * @param {string} sinceUtc - ISO 8601 timestamp
 * @returns {array} Odds snapshots
 */
function getOddsSnapshots(sport, sinceUtc) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getOddsSnapshots');
  
  const stmt = db.prepare(`
    SELECT * FROM odds_snapshots
    WHERE sport = ? AND captured_at >= ?
    ORDER BY game_id, captured_at DESC
  `);
  
  return stmt.all(normalizedSport, sinceUtc);
}

function normalizeLineDeltaMarketType(marketType) {
  const raw = String(marketType || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw === 'FIRSTPERIOD') return 'FIRST_PERIOD';
  if (raw === 'PUCK_LINE') return 'PUCKLINE';
  if (raw === 'TEAMTOTAL') return 'TEAM_TOTAL';
  return raw;
}

function normalizeLineDeltaSelectionSide(selectionSide) {
  const raw = String(selectionSide || '').trim().toUpperCase();
  if (raw === 'HOME' || raw === 'AWAY' || raw === 'OVER' || raw === 'UNDER') {
    return raw;
  }
  return null;
}

function getSnapshotLineForMarket(snapshot, marketType, selectionSide) {
  const normalizedMarketType = normalizeLineDeltaMarketType(marketType);
  const normalizedSelectionSide =
    normalizeLineDeltaSelectionSide(selectionSide);

  if (
    normalizedMarketType === 'TOTAL' ||
    normalizedMarketType === 'TEAM_TOTAL' ||
    normalizedMarketType === 'FIRST_PERIOD'
  ) {
    return Number.isFinite(snapshot?.total) ? snapshot.total : null;
  }

  if (
    normalizedMarketType === 'SPREAD' ||
    normalizedMarketType === 'PUCKLINE'
  ) {
    if (normalizedSelectionSide === 'AWAY') {
      return Number.isFinite(snapshot?.spread_away) ? snapshot.spread_away : null;
    }
    return Number.isFinite(snapshot?.spread_home) ? snapshot.spread_home : null;
  }

  if (normalizedMarketType === 'MONEYLINE') {
    if (normalizedSelectionSide === 'AWAY') {
      return Number.isFinite(snapshot?.h2h_away)
        ? snapshot.h2h_away
        : Number.isFinite(snapshot?.moneyline_away)
          ? snapshot.moneyline_away
          : null;
    }
    return Number.isFinite(snapshot?.h2h_home)
      ? snapshot.h2h_home
      : Number.isFinite(snapshot?.moneyline_home)
        ? snapshot.moneyline_home
        : null;
  }

  return null;
}

/**
 * Compute opener vs current line movement for a game/market from odds_snapshots.
 *
 * The returned line values are selection-side aware for spread/puckline when
 * selectionSide is provided (HOME uses spread_home, AWAY uses spread_away).
 *
 * @param {object} params
 * @param {string} params.sport
 * @param {string} params.gameId
 * @param {string} params.marketType
 * @param {string} [params.selectionSide]
 * @param {object} [params.db]
 * @returns {{opener_line:number|null,current_line:number|null,delta:number|null,delta_pct:number|null,snapshot_count:number}}
 */
function computeLineDelta({
  sport,
  gameId,
  marketType,
  selectionSide = null,
  db = null,
}) {
  const database = db || getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'computeLineDelta');
  const normalizedMarketType = normalizeLineDeltaMarketType(marketType);
  const normalizedSelectionSide =
    normalizeLineDeltaSelectionSide(selectionSide);

  if (!normalizedSport || !gameId || !normalizedMarketType) {
    return {
      opener_line: null,
      current_line: null,
      delta: null,
      delta_pct: null,
      snapshot_count: 0,
    };
  }

  const rows = database
    .prepare(`
      SELECT
        captured_at,
        total,
        spread_home,
        spread_away,
        h2h_home,
        h2h_away,
        moneyline_home,
        moneyline_away
      FROM odds_snapshots
      WHERE game_id = ?
        AND LOWER(sport) = ?
      ORDER BY captured_at ASC
    `)
    .all(gameId, normalizedSport);

  const snapshotsWithLine = rows
    .map((row) => ({
      captured_at: row.captured_at,
      line: getSnapshotLineForMarket(
        row,
        normalizedMarketType,
        normalizedSelectionSide,
      ),
    }))
    .filter((row) => Number.isFinite(row.line));

  if (snapshotsWithLine.length === 0) {
    return {
      opener_line: null,
      current_line: null,
      delta: null,
      delta_pct: null,
      snapshot_count: 0,
    };
  }

  const openerLine = snapshotsWithLine[0].line;
  const currentLine = snapshotsWithLine[snapshotsWithLine.length - 1].line;
  const delta = currentLine - openerLine;
  const deltaPct =
    openerLine === 0 ? null : Number((delta / Math.abs(openerLine)).toFixed(4));

  return {
    opener_line: openerLine,
    current_line: currentLine,
    delta: Number(delta.toFixed(4)),
    delta_pct: deltaPct,
    snapshot_count: snapshotsWithLine.length,
  };
}

/**
 * Get latest odds snapshots for upcoming games only (prevents stale data processing)
 * Joins with games table to filter by game_time_utc
 * Deduplicates to one snapshot per game (most recent) to prevent OOM on large datasets
 * @param {string} sport - Sport code (e.g., 'NHL')
 * @param {string} nowUtc - Current time in ISO UTC
 * @param {string} horizonUtc - End of time window in ISO UTC (e.g., now + 36 hours)
 * @returns {array} Latest odds snapshot per game with game_time_utc attached
 */
function getOddsWithUpcomingGames(sport, nowUtc, horizonUtc) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getOddsWithUpcomingGames');
  
  // Deduplicate to latest snapshot per game at SQL level to prevent OOM
  const stmt = db.prepare(`
    SELECT 
      o.*,
      g.game_time_utc,
      g.home_team,
      g.away_team
    FROM odds_snapshots o
    INNER JOIN (
      SELECT game_id, MAX(captured_at) as max_captured_at
      FROM odds_snapshots
      WHERE LOWER(sport) = ?
      GROUP BY game_id
    ) latest ON o.game_id = latest.game_id AND o.captured_at = latest.max_captured_at
    INNER JOIN games g ON o.game_id = g.game_id
    WHERE LOWER(o.sport) = ?
      AND g.game_time_utc IS NOT NULL
      AND g.game_time_utc > ?
      AND g.game_time_utc <= ?
    ORDER BY g.game_time_utc ASC
  `);
  
  return stmt.all(normalizedSport, normalizedSport, nowUtc, horizonUtc);
}

/**
 * Without-Odds-Mode fallback: return upcoming games as minimal synthetic snapshot objects.
 * Used when ENABLE_WITHOUT_ODDS_MODE=true and odds_snapshots is empty.
 * All odds fields are null; models using withoutOddsMode will use projection_floor lines.
 * @param {string} sport - Sport code (e.g., 'NHL')
 * @param {string} nowUtc - Current time in ISO UTC
 * @param {string} horizonUtc - End of time window in ISO UTC
 * @returns {array} Synthetic snapshot-shaped objects, one per upcoming game
 */
function getUpcomingGamesAsSyntheticSnapshots(sport, nowUtc, horizonUtc) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'getUpcomingGamesAsSyntheticSnapshots');
  const now = new Date().toISOString();
  const rows = db.prepare(`
    SELECT game_id, home_team, away_team, game_time_utc
    FROM games
    WHERE LOWER(sport) = ?
      AND game_time_utc IS NOT NULL
      AND game_time_utc > ?
      AND game_time_utc <= ?
    ORDER BY game_time_utc ASC
  `).all(normalizedSport, nowUtc, horizonUtc);
  return rows.map((g) => ({
    id: `synthetic-${g.game_id}`,
    game_id: g.game_id,
    sport: normalizedSport,
    captured_at: now,
    game_time_utc: g.game_time_utc,
    home_team: g.home_team,
    away_team: g.away_team,
    h2h_home: null,
    h2h_away: null,
    total: null,
    spread_home: null,
    spread_away: null,
    moneyline_home: null,
    moneyline_away: null,
    total_price_over: null,
    total_price_under: null,
    raw_data: null,
  }));
}

/**
 * Return games starting within the next 48 hours, limited to the given sports.
 * Used by pull_public_splits to know which games need splits data.
 *
 * @param {string[]} sports - Upper-case sport codes e.g. ['MLB','NBA','NHL']
 * @returns {{ game_id: string, home_team: string, away_team: string, sport: string, game_time_utc: string }[]}
 */
function getActiveGamesForSplits(sports = []) {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const horizonIso = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  if (sports.length === 0) {
    return db
      .prepare(
        `SELECT g.game_id, g.home_team, g.away_team, g.sport, g.game_time_utc
         FROM games g
         WHERE g.game_time_utc IS NOT NULL
           AND g.game_time_utc >= ?
           AND g.game_time_utc <= ?
         ORDER BY g.game_time_utc ASC`,
      )
      .all(nowIso, horizonIso);
  }

  const placeholders = sports.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT g.game_id, g.home_team, g.away_team, g.sport, g.game_time_utc
       FROM games g
       WHERE g.game_time_utc IS NOT NULL
         AND g.game_time_utc >= ?
         AND g.game_time_utc <= ?
         AND UPPER(g.sport) IN (${placeholders})
       ORDER BY g.game_time_utc ASC`,
    )
    .all(nowIso, horizonIso, ...sports.map((s) => s.toUpperCase()));
}

/**
 * Patch public-splits columns on the most-recent odds_snapshot for a game.
 * Called by pull_public_splits after a successful ActionNetwork fetch-and-match.
 * Writes all 8 splits columns atomically.
 *
 * @param {object} opts
 * @param {string} opts.gameId      - Our canonical game ID
 * @param {object} opts.splitsData  - Public splits fields to write
 * @param {string} [opts.jobRunId]  - Optional job run ID (reserved)
 * @param {string} [opts.jobRunId]  - Optional job run ID for audit trail (unused in UPDATE, reserved)
 * @returns {number} rows changed (0 = no snapshot found for this game)
 */
function updateOddsSnapshotSplits({ gameId, splitsData, jobRunId: _jobRunId }) {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const toN = (v) => (Number.isFinite(v) ? v : null);

  const {
    public_bets_pct_home = null,
    public_bets_pct_away = null,
    public_handle_pct_home = null,
    public_handle_pct_away = null,
    public_tickets_pct_home = null,
    public_tickets_pct_away = null,
    splits_source = null,
  } = splitsData || {};

  const result = db
    .prepare(
      `UPDATE odds_snapshots
          SET public_bets_pct_home    = ?,
              public_bets_pct_away    = ?,
              public_handle_pct_home  = ?,
              public_handle_pct_away  = ?,
              public_tickets_pct_home = ?,
              public_tickets_pct_away = ?,
              splits_source           = ?,
              splits_captured_at      = ?
        WHERE id = (
          SELECT id FROM odds_snapshots
           WHERE game_id = ?
           ORDER BY captured_at DESC
           LIMIT 1
        )`,
    )
    .run(
      toN(public_bets_pct_home),
      toN(public_bets_pct_away),
      toN(public_handle_pct_home),
      toN(public_handle_pct_away),
      toN(public_tickets_pct_home),
      toN(public_tickets_pct_away),
      splits_source,
      nowIso,
      gameId,
    );
  return result.changes;
}

/**
 * Patch VSIN/DraftKings splits columns on the most-recent odds_snapshot for a game.
 * Called by pull_vsin_splits after a successful VSIN fetch-and-match.
 * Single-writer contract (ADR-0002): only pull_vsin_splits writes these columns.
 *
 * @param {object} opts
 * @param {string} opts.gameId   - Our canonical game ID
 * @param {object} opts.vsinData - DK split fields to write
 * @returns {number} rows changed (0 = no snapshot found for this game)
 */
function updateOddsSnapshotVsinSplits({ gameId, vsinData }) {
  const db = getDatabase();
  const nowIso = new Date().toISOString();
  const toN = (v) => (Number.isFinite(v) ? v : null);

  const {
    dk_bets_pct_home    = null,
    dk_bets_pct_away    = null,
    dk_handle_pct_home  = null,
    dk_handle_pct_away  = null,
    dk_tickets_pct_home = null,
    dk_tickets_pct_away = null,
  } = vsinData || {};

  const result = db
    .prepare(
      `UPDATE odds_snapshots
          SET dk_bets_pct_home    = ?,
              dk_bets_pct_away    = ?,
              dk_handle_pct_home  = ?,
              dk_handle_pct_away  = ?,
              dk_tickets_pct_home = ?,
              dk_tickets_pct_away = ?,
              vsin_captured_at    = ?
        WHERE id = (
          SELECT id FROM odds_snapshots
           WHERE game_id = ?
           ORDER BY captured_at DESC
           LIMIT 1
        )`,
    )
    .run(
      toN(dk_bets_pct_home),
      toN(dk_bets_pct_away),
      toN(dk_handle_pct_home),
      toN(dk_handle_pct_away),
      toN(dk_tickets_pct_home),
      toN(dk_tickets_pct_away),
      nowIso,
      gameId,
    );
  return result.changes;
}

/**
 * Patch Circa Sports sharp-money splits columns on the most-recent odds_snapshot for a game.
 * Called by pull_vsin_splits after a successful CIRCA fetch-and-match.
 * Single-writer contract (ADR-0002): only pull_vsin_splits writes these columns.
 *
 * @param {object} opts
 * @param {string} opts.gameId     - Our canonical game ID
 * @param {object} opts.circaData  - Circa split fields to write
 * @returns {number} rows changed (0 = no snapshot found for this game)
 */
function updateOddsSnapshotCircaSplits({ gameId, circaData }) {
  const db = getDatabase();
  const toN = (v) => (Number.isFinite(v) ? v : null);

  const {
    circa_handle_pct_home  = null,
    circa_handle_pct_away  = null,
    circa_tickets_pct_home = null,
    circa_tickets_pct_away = null,
  } = circaData || {};

  const result = db
    .prepare(
      `UPDATE odds_snapshots
          SET circa_handle_pct_home  = ?,
              circa_handle_pct_away  = ?,
              circa_tickets_pct_home = ?,
              circa_tickets_pct_away = ?
        WHERE id = (
          SELECT id FROM odds_snapshots
           WHERE game_id = ?
           ORDER BY captured_at DESC
           LIMIT 1
        )`,
    )
    .run(
      toN(circa_handle_pct_home),
      toN(circa_handle_pct_away),
      toN(circa_tickets_pct_home),
      toN(circa_tickets_pct_away),
      gameId,
    );
  return result.changes;
}

module.exports = {
  insertOddsSnapshot,
  patchOddsSnapshot1p,
  patchOddsSnapshotF5,
  updateOddsSnapshotRawData,
  deleteOddsSnapshotsByGameAndCapturedAt,
  prepareOddsSnapshotWrite,
  getLatestOdds,
  getOddsSnapshots,
  computeLineDelta,
  getOddsWithUpcomingGames,
  getUpcomingGamesAsSyntheticSnapshots,
  recordOddsIngestFailure,
  getOddsIngestFailureSummary,
  getActiveGamesForSplits,
  updateOddsSnapshotSplits,
  updateOddsSnapshotVsinSplits,
  updateOddsSnapshotCircaSplits,
};
