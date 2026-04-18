const { getDatabase } = require('./connection');

/**
 * Upsert tracking stat
 * @param {object} stat - Tracking stat data
 * @param {string} stat.id - Unique ID
 * @param {string} stat.statKey - Composite key (sport|market|direction|confidence|driver|period)
 * @param {string} stat.sport - Sport filter
 * @param {string} stat.marketType - Market type filter
 * @param {string} stat.direction - Direction filter
 * @param {string} stat.confidenceTier - Confidence tier filter
 * @param {string} stat.driverKey - Driver filter
 * @param {string} stat.timePeriod - Time period filter
 * @param {number} stat.totalCards - Total cards count
 * @param {number} stat.settledCards - Settled cards count
 * @param {number} stat.wins - Win count
 * @param {number} stat.losses - Loss count
 * @param {number} stat.pushes - Push count
 * @param {number} stat.totalPnlUnits - Total P&L in units
 * @param {number} stat.winRate - Win rate (computed)
 * @param {number} stat.avgPnlPerCard - Avg P&L per card (computed)
 * @param {number} stat.confidenceCalibration - Confidence calibration score
 * @param {object|null} stat.metadata - Optional metadata
 */
function upsertTrackingStat(stat) {
  const db = getDatabase();
  
  const stmt = db.prepare(`
    INSERT INTO tracking_stats (
      id, stat_key, sport, market_type, direction, confidence_tier, driver_key, time_period,
      total_cards, settled_cards, wins, losses, pushes, total_pnl_units,
      win_rate, avg_pnl_per_card, confidence_calibration, metadata, computed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(stat_key) DO UPDATE SET
      total_cards = excluded.total_cards,
      settled_cards = excluded.settled_cards,
      wins = excluded.wins,
      losses = excluded.losses,
      pushes = excluded.pushes,
      total_pnl_units = excluded.total_pnl_units,
      win_rate = excluded.win_rate,
      avg_pnl_per_card = excluded.avg_pnl_per_card,
      confidence_calibration = excluded.confidence_calibration,
      metadata = excluded.metadata,
      computed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  stmt.run(
    stat.id,
    stat.statKey,
    stat.sport || null,
    stat.marketType || null,
    stat.direction || null,
    stat.confidenceTier || null,
    stat.driverKey || null,
    stat.timePeriod || null,
    stat.totalCards,
    stat.settledCards,
    stat.wins,
    stat.losses,
    stat.pushes,
    stat.totalPnlUnits,
    stat.winRate,
    stat.avgPnlPerCard,
    stat.confidenceCalibration || null,
    stat.metadata ? JSON.stringify(stat.metadata) : null
  );
}

/**
 * Atomically increment tracking stat counters by delta values.
 * Race-safe for concurrent settlement processes.
 * 
 * @param {object} params - Increment parameters
 * @param {string} params.statKey - Unique stat key (e.g., "NHL|moneyline|all|all|all|alltime")
 * @param {string} params.id - Stat ID (used only on first insert)
 * @param {string} params.sport - Sport name
 * @param {string} params.marketType - Market type
 * @param {string} params.direction - Direction (HOME/AWAY/OVER/UNDER/all)
 * @param {string} params.confidenceTier - Confidence tier
 * @param {string} params.driverKey - Driver key
 * @param {string} params.timePeriod - Time period
 * @param {number} params.deltaWins - Wins to add (default 0)
 * @param {number} params.deltaLosses - Losses to add (default 0)
 * @param {number} params.deltaPushes - Pushes to add (default 0)
 * @param {number} params.deltaPnl - PnL units to add (default 0)
 * @param {object|null} params.metadata - Optional metadata
 */
function incrementTrackingStat(params) {
  const db = getDatabase();
  
  const {
    statKey,
    id,
    sport,
    marketType,
    direction,
    confidenceTier,
    driverKey,
    timePeriod,
    deltaWins = 0,
    deltaLosses = 0,
    deltaPushes = 0,
    deltaPnl = 0,
    metadata = null
  } = params;
  
  const deltaTotal = deltaWins + deltaLosses + deltaPushes;
  const deltaDecided = deltaWins + deltaLosses;
  const winRate = deltaDecided > 0 ? deltaWins / deltaDecided : 0;
  const avgPnlPerCard = deltaTotal > 0 ? deltaPnl / deltaTotal : 0;
  
  // Insert new row or increment existing counters atomically
  const stmt = db.prepare(`
    INSERT INTO tracking_stats (
      id, stat_key, sport, market_type, direction, confidence_tier, driver_key, time_period,
      total_cards, settled_cards, wins, losses, pushes, total_pnl_units,
      win_rate, avg_pnl_per_card, confidence_calibration, metadata, computed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(stat_key) DO UPDATE SET
      total_cards = total_cards + ?,
      settled_cards = settled_cards + ?,
      wins = wins + ?,
      losses = losses + ?,
      pushes = pushes + ?,
      total_pnl_units = total_pnl_units + ?,
      win_rate = CASE 
        WHEN (wins + ? + losses + ?) > 0 
        THEN CAST(wins + ? AS REAL) / (wins + ? + losses + ?)
        ELSE 0 
      END,
      avg_pnl_per_card = CASE
        WHEN (wins + ? + losses + ? + pushes + ?) > 0
        THEN (total_pnl_units + ?) / (wins + ? + losses + ? + pushes + ?)
        ELSE 0
      END,
      metadata = CASE WHEN ? IS NOT NULL THEN ? ELSE metadata END,
      computed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `);
  
  const metadataJson = metadata ? JSON.stringify(metadata) : null;
  
  stmt.run(
    // INSERT values (used only on first creation)
    id,
    statKey,
    sport || null,
    marketType || null,
    direction || null,
    confidenceTier || null,
    driverKey || null,
    timePeriod || null,
    deltaTotal,
    deltaTotal,
    deltaWins,
    deltaLosses,
    deltaPushes,
    deltaPnl,
    winRate,
    avgPnlPerCard,
    metadataJson,
    // UPDATE deltas
    deltaTotal,
    deltaTotal,
    deltaWins,
    deltaLosses,
    deltaPushes,
    deltaPnl,
    // win_rate calculation
    deltaWins, deltaLosses, deltaWins, deltaWins, deltaLosses,
    // avg_pnl_per_card calculation (denominator = wins+losses+pushes, excludes no_contest)
    deltaWins, deltaLosses, deltaPushes, deltaPnl, deltaWins, deltaLosses, deltaPushes,
    // metadata
    metadataJson, metadataJson
  );
}

/**
 * Get tracking stats by filters
 * @param {object} filters - Filter object
 * @param {string} filters.sport - Sport filter (optional)
 * @param {string} filters.marketType - Market type filter (optional)
 * @param {string} filters.timePeriod - Time period filter (optional)
 * @returns {array} Tracking stats
 */
function getTrackingStats(filters = {}) {
  const db = getDatabase();
  
  const where = [];
  const params = [];
  
  if (filters.sport) {
    where.push('sport = ?');
    params.push(filters.sport);
  }
  
  if (filters.marketType) {
    where.push('market_type = ?');
    params.push(filters.marketType);
  }
  
  if (filters.timePeriod) {
    where.push('time_period = ?');
    params.push(filters.timePeriod);
  }
  
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  
  const stmt = db.prepare(`
    SELECT * FROM tracking_stats
    ${whereSql}
    ORDER BY computed_at DESC
  `);
  
  return stmt.all(...params);
}

/**
 * Get cached team metrics for a specific sport/team/date
 * @param {string} sport - Sport (e.g., 'NBA', 'NHL')
 * @param {string} teamName - Team name (as normalized by team-metrics.js)
 * @param {string} cacheDate - Cache date in ET (YYYY-MM-DD format)
 * @returns {object|null} Cached metrics object or null if not found/expired
 */
function getTeamMetricsCache(sport, teamName, cacheDate) {
  const db = getDatabase();
  // Keep sport uppercase for CHECK constraint
  const normalizedSport = String(sport || '').trim().toUpperCase();
  
  const stmt = db.prepare(`
    SELECT 
      id, sport, team_name, cache_date, status,
      metrics, team_info, recent_games, resolution,
      fetched_at, created_at
    FROM team_metrics_cache
    WHERE sport = ? AND team_name = ? AND cache_date = ?
  `);
  
  const row = stmt.get(normalizedSport, teamName, cacheDate);
  
  if (!row) return null;
  
  // Parse JSON columns
  return {
    id: row.id,
    sport: row.sport,
    teamName: row.team_name,
    cacheDate: row.cache_date,
    status: row.status,
    metrics: row.metrics ? JSON.parse(row.metrics) : null,
    teamInfo: row.team_info ? JSON.parse(row.team_info) : null,
    recentGames: row.recent_games ? JSON.parse(row.recent_games) : null,
    resolution: row.resolution ? JSON.parse(row.resolution) : null,
    fetchedAt: row.fetched_at,
    createdAt: row.created_at
  };
}

/**
 * Upsert team metrics cache entry
 * @param {object} cacheEntry - Cache entry object
 * @param {string} cacheEntry.sport - Sport
 * @param {string} cacheEntry.teamName - Team name
 * @param {string} cacheEntry.cacheDate - Cache date (ET, YYYY-MM-DD)
 * @param {string} cacheEntry.status - Status ('ok', 'missing', 'failed', 'partial')
 * @param {object} cacheEntry.metrics - Metrics object (optional)
 * @param {object} cacheEntry.teamInfo - Team info object (optional)
 * @param {array} cacheEntry.recentGames - Recent games array (optional)
 * @param {object} cacheEntry.resolution - Resolution metadata (optional)
 * @returns {number} Row ID
 */
function upsertTeamMetricsCache(cacheEntry) {
  const db = getDatabase();
  // Keep sport uppercase for CHECK constraint
  const normalizedSport = String(cacheEntry.sport || '').trim().toUpperCase();
  
  const metricsJson = cacheEntry.metrics ? JSON.stringify(cacheEntry.metrics) : null;
  const teamInfoJson = cacheEntry.teamInfo ? JSON.stringify(cacheEntry.teamInfo) : null;
  const recentGamesJson = cacheEntry.recentGames ? JSON.stringify(cacheEntry.recentGames) : null;
  const resolutionJson = cacheEntry.resolution ? JSON.stringify(cacheEntry.resolution) : null;
  
  const stmt = db.prepare(`
    INSERT INTO team_metrics_cache (
      sport, team_name, cache_date, status,
      metrics, team_info, recent_games, resolution,
      fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(sport, team_name, cache_date) DO UPDATE SET
      status = excluded.status,
      metrics = excluded.metrics,
      team_info = excluded.team_info,
      recent_games = excluded.recent_games,
      resolution = excluded.resolution,
      fetched_at = CURRENT_TIMESTAMP
  `);
  
  const info = stmt.run(
    normalizedSport,
    cacheEntry.teamName,
    cacheEntry.cacheDate,
    cacheEntry.status,
    metricsJson,
    teamInfoJson,
    recentGamesJson,
    resolutionJson
  );
  
  return info.lastInsertRowid;
}

/**
 * Delete team metrics cache entries older than a given date
 * @param {string} beforeDate - Delete entries before this date (YYYY-MM-DD)
 * @returns {number} Number of rows deleted
 */
function deleteStaleTeamMetricsCache(beforeDate) {
  const db = getDatabase();

  const stmt = db.prepare(`
    DELETE FROM team_metrics_cache
    WHERE cache_date < ?
  `);

  const info = stmt.run(beforeDate);
  return info.changes;
}

/**
 * Derive confidence_band label from a raw confidence score (0-1).
 * @param {number|null} score
 * @returns {string}
 */
function deriveConfidenceBand(score) {
  if (score === null || score === undefined || isNaN(Number(score))) return 'unknown';
  const s = Number(score);
  if (s < 0.40) return '<40';
  if (s < 0.50) return '40-50';
  if (s < 0.60) return '50-60';
  return '60+';
}

/**
 * Insert a single row into projection_audit for a settled projection.
 * Uses INSERT OR IGNORE so settlement re-runs are idempotent.
 *
 * @param {object} row
 * @param {string} row.cardResultId          - card_results.id (used as PK)
 * @param {string} row.sport                  - e.g. 'NBA', 'NHL'
 * @param {string} row.marketType             - e.g. 'total', 'moneyline'
 * @param {string|null} row.period            - '1P', '2P', or null for full-game
 * @param {number|null} row.playerCount       - number of players in card
 * @param {number|null} row.confidenceScore   - raw model confidence (0-1)
 * @param {number|null} row.oddsAmerican      - locked_price integer
 * @param {string|null} row.sharpPriceStatus  - 'CONFIRMED'|'ESTIMATED'|'UNTAGGED'
 * @param {string|null} row.direction         - selection direction
 * @param {string} row.result                 - 'win'|'loss'|'push'
 * @param {number} row.pnlUnits
 * @param {string} row.settledAt              - ISO8601
 * @param {string|null} row.jobRunId
 * @param {object|null} row.metadata          - extra context blob
 */
function insertProjectionAudit(row) {
  const db = getDatabase();

  const confidenceBand = deriveConfidenceBand(row.confidenceScore);

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO projection_audit (
      id, card_result_id, sport, market_type, period,
      player_count, confidence_score, confidence_band,
      odds_american, sharp_price_status, direction,
      result, pnl_units, settled_at, job_run_id, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    row.cardResultId,
    row.cardResultId,
    row.sport || null,
    row.marketType || null,
    row.period || null,
    row.playerCount !== undefined ? row.playerCount : null,
    row.confidenceScore !== undefined ? row.confidenceScore : null,
    confidenceBand,
    row.oddsAmerican !== undefined ? row.oddsAmerican : null,
    row.sharpPriceStatus || null,
    row.direction || null,
    row.result,
    typeof row.pnlUnits === 'number' ? row.pnlUnits : 0,
    row.settledAt,
    row.jobRunId || null,
    row.metadata ? JSON.stringify(row.metadata) : null
  );
}

/**
 * Recompute tracking_stats aggregates from projection_audit rows.
 * Replaces the live-increment pattern with a recompute-from-source pattern,
 * making tracking_stats a fully regenerable cache.
 *
 * @param {object} [opts]
 * @param {string} [opts.sport]          - Limit to one sport (optional)
 * @param {string} [opts.sinceSettledAt] - ISO8601 lower bound (optional, default: all time)
 * @param {boolean} [opts.fullReplace]   - If true, DELETE existing rows for scope before upsert
 * @returns {{ rows: number }}
 */
function recomputeTrackingStats(opts = {}) {
  const db = getDatabase();
  const { sport, sinceSettledAt, fullReplace = false } = opts;

  const whereClauses = ['(period IS NULL OR period != \'1P\')'];
  const params = [];

  if (sport) {
    whereClauses.push('sport = ?');
    params.push(sport);
  }
  if (sinceSettledAt) {
    whereClauses.push('settled_at >= ?');
    params.push(sinceSettledAt);
  }

  const where = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return db.transaction(() => {
    // Optionally wipe existing rows for the scope before recomputing
    if (fullReplace) {
      if (sport) {
        db.prepare(
          `DELETE FROM tracking_stats WHERE sport = ? AND (stat_key LIKE '%|alltime' OR stat_key LIKE '%edge_verification:%')`
        ).run(sport);
      } else {
        db.prepare(
          `DELETE FROM tracking_stats WHERE stat_key LIKE '%|alltime' OR stat_key LIKE '%edge_verification:%'`
        ).run();
      }
    }

    let rowsUpserted = 0;

    // Query A: market-level aggregates (sport + market_type)
    const marketRows = db.prepare(`
      SELECT
        sport,
        market_type,
        COUNT(CASE WHEN result = 'win'  THEN 1 END) AS wins,
        COUNT(CASE WHEN result = 'loss' THEN 1 END) AS losses,
        COUNT(CASE WHEN result = 'push' THEN 1 END) AS pushes,
        SUM(pnl_units) AS total_pnl,
        COUNT(*) AS total
      FROM projection_audit
      ${where}
      GROUP BY sport, market_type
    `).all(...params);

    const recomputedAt = new Date().toISOString();

    for (const row of marketRows) {
      const s = row.sport;
      const mt = row.market_type;
      const wins = Number(row.wins) || 0;
      const losses = Number(row.losses) || 0;
      const pushes = Number(row.pushes) || 0;
      const total = Number(row.total) || 0;
      const totalPnl = Number(row.total_pnl) || 0;
      const decided = wins + losses;
      const winRate = decided > 0 ? wins / decided : 0;
      const pnlDecided = wins + losses + pushes;
      const avgPnl = pnlDecided > 0 ? totalPnl / pnlDecided : 0;

      upsertTrackingStat({
        id: `stat-${s}-${mt}-alltime`,
        statKey: `${s}|${mt}|all|all|all|alltime`,
        sport: s,
        marketType: mt,
        direction: 'all',
        confidenceTier: 'all',
        driverKey: 'all',
        timePeriod: 'alltime',
        totalCards: total,
        settledCards: total,
        wins,
        losses,
        pushes,
        totalPnlUnits: totalPnl,
        winRate,
        avgPnlPerCard: avgPnl,
        confidenceCalibration: null,
        metadata: { recomputedAt },
      });
      rowsUpserted++;
    }

    // Query B: verification-segmented (sport + market_type + sharp_price_status)
    const verifyRows = db.prepare(`
      SELECT
        sport,
        market_type,
        COALESCE(sharp_price_status, 'UNTAGGED') AS sharp_status,
        COUNT(CASE WHEN result = 'win'  THEN 1 END) AS wins,
        COUNT(CASE WHEN result = 'loss' THEN 1 END) AS losses,
        COUNT(CASE WHEN result = 'push' THEN 1 END) AS pushes,
        SUM(pnl_units) AS total_pnl,
        COUNT(*) AS total
      FROM projection_audit
      ${where}
      GROUP BY sport, market_type, COALESCE(sharp_price_status, 'UNTAGGED')
    `).all(...params);

    for (const row of verifyRows) {
      const s = row.sport;
      const mt = row.market_type;
      const ss = row.sharp_status;
      const wins = Number(row.wins) || 0;
      const losses = Number(row.losses) || 0;
      const pushes = Number(row.pushes) || 0;
      const total = Number(row.total) || 0;
      const totalPnl = Number(row.total_pnl) || 0;
      const decided = wins + losses;
      const winRate = decided > 0 ? wins / decided : 0;
      const pnlDecided = wins + losses + pushes;
      const avgPnl = pnlDecided > 0 ? totalPnl / pnlDecided : 0;
      const driverKey = `edge_verification:${ss}`;

      upsertTrackingStat({
        id: `stat-${s}-${mt}-${ss}-alltime`,
        statKey: `${s}|${mt}|all|all|${driverKey}|alltime`,
        sport: s,
        marketType: mt,
        direction: 'all',
        confidenceTier: 'all',
        driverKey,
        timePeriod: 'alltime',
        totalCards: total,
        settledCards: total,
        wins,
        losses,
        pushes,
        totalPnlUnits: totalPnl,
        winRate,
        avgPnlPerCard: avgPnl,
        confidenceCalibration: null,
        metadata: { recomputedAt },
      });
      rowsUpserted++;
    }

    return { rows: rowsUpserted };
  })();
}

module.exports = {
  upsertTrackingStat,
  incrementTrackingStat,
  getTrackingStats,
  insertProjectionAudit,
  recomputeTrackingStats,
  getTeamMetricsCache,
  upsertTeamMetricsCache,
  deleteStaleTeamMetricsCache,
};
