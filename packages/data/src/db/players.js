const {
  getDatabase,
  normalizeSportValue,
} = require('./connection');

/**
 * Upsert a player shot log row
 * @param {object} log
 * @param {string} log.id - Unique ID
 * @param {string} log.sport - Sport code
 * @param {number} log.playerId - Player ID
 * @param {string} [log.playerName]
 * @param {string} log.gameId - Game ID
 * @param {string} [log.gameDate] - ISO date
 * @param {string} [log.opponent]
 * @param {boolean} [log.isHome]
 * @param {number} [log.shots]
 * @param {number} [log.toiMinutes]
 * @param {object} [log.rawData]
 * @param {string} log.fetchedAt - ISO timestamp
 */
function upsertPlayerShotLog(log) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(log.sport, 'upsertPlayerShotLog');

  const stmt = db.prepare(`
    INSERT INTO player_shot_logs (
      id, sport, player_id, player_name, game_id, game_date,
      opponent, is_home, shots, toi_minutes, raw_data, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, player_id, game_id) DO UPDATE SET
      player_name = excluded.player_name,
      game_date = excluded.game_date,
      opponent = excluded.opponent,
      is_home = excluded.is_home,
      shots = excluded.shots,
      toi_minutes = excluded.toi_minutes,
      raw_data = excluded.raw_data,
      fetched_at = excluded.fetched_at
  `);

  stmt.run(
    log.id,
    normalizedSport,
    log.playerId,
    log.playerName || null,
    log.gameId,
    log.gameDate || null,
    log.opponent || null,
    log.isHome ? 1 : 0,
    Number.isFinite(log.shots) ? log.shots : null,
    Number.isFinite(log.toiMinutes) ? log.toiMinutes : null,
    log.rawData ? JSON.stringify(log.rawData) : null,
    log.fetchedAt
  );
}

/**
 * Get latest shot logs for a player
 * @param {number} playerId
 * @param {number} limit
 * @returns {array}
 */
function getPlayerShotLogs(playerId, limit = 5) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM player_shot_logs
    WHERE player_id = ?
    ORDER BY game_date DESC, fetched_at DESC
    LIMIT ?
  `);

  return stmt.all(playerId, limit);
}

/**
 * Upsert a blocked-shot log row.
 * @param {object} log
 */
function upsertPlayerBlkLog(log) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(log.sport, 'upsertPlayerBlkLog');

  const stmt = db.prepare(`
    INSERT INTO player_blk_logs (
      id, sport, player_id, player_name, game_id, game_date,
      opponent, is_home, blocked_shots, toi_minutes, raw_data, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, player_id, game_id) DO UPDATE SET
      player_name = excluded.player_name,
      game_date = excluded.game_date,
      opponent = excluded.opponent,
      is_home = excluded.is_home,
      blocked_shots = excluded.blocked_shots,
      toi_minutes = excluded.toi_minutes,
      raw_data = excluded.raw_data,
      fetched_at = excluded.fetched_at
  `);

  stmt.run(
    log.id,
    normalizedSport,
    log.playerId,
    log.playerName || null,
    log.gameId,
    log.gameDate || null,
    log.opponent || null,
    log.isHome ? 1 : 0,
    Number.isFinite(log.blockedShots) ? log.blockedShots : null,
    Number.isFinite(log.toiMinutes) ? log.toiMinutes : null,
    log.rawData ? JSON.stringify(log.rawData) : null,
    log.fetchedAt,
  );
}

/**
 * Get latest blocked-shot logs for a player.
 * @param {number} playerId
 * @param {number} limit
 * @returns {array}
 */
function getPlayerBlkLogs(playerId, limit = 5) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM player_blk_logs
    WHERE player_id = ?
    ORDER BY game_date DESC, fetched_at DESC
    LIMIT ?
  `);

  return stmt.all(playerId, limit);
}

/**
 * Upsert NST blocked-shot rate row.
 * @param {object} row
 */
function upsertPlayerBlkRates(row) {
  const db = getDatabase();
  const playerId = String(row.nhlPlayerId || row.playerId || '').trim();
  const season = String(row.season || process.env.NHL_CURRENT_SEASON || '20242025').trim();
  if (!playerId) {
    throw new Error('upsertPlayerBlkRates requires nhlPlayerId');
  }
  if (!season) {
    throw new Error('upsertPlayerBlkRates requires season');
  }

  const stmt = db.prepare(`
    INSERT INTO player_blk_rates (
      nhl_player_id, player_name, team, season,
      ev_blocks_season_per60, ev_blocks_l10_per60, ev_blocks_l5_per60,
      pk_blocks_season_per60, pk_blocks_l10_per60, pk_blocks_l5_per60,
      pk_toi_per_game, source, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(nhl_player_id, season) DO UPDATE SET
      player_name = excluded.player_name,
      team = excluded.team,
      ev_blocks_season_per60 = excluded.ev_blocks_season_per60,
      ev_blocks_l10_per60 = excluded.ev_blocks_l10_per60,
      ev_blocks_l5_per60 = excluded.ev_blocks_l5_per60,
      pk_blocks_season_per60 = excluded.pk_blocks_season_per60,
      pk_blocks_l10_per60 = excluded.pk_blocks_l10_per60,
      pk_blocks_l5_per60 = excluded.pk_blocks_l5_per60,
      pk_toi_per_game = excluded.pk_toi_per_game,
      source = excluded.source,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    playerId,
    row.playerName || null,
    row.team || null,
    season,
    Number.isFinite(row.evBlocksSeasonPer60) ? row.evBlocksSeasonPer60 : null,
    Number.isFinite(row.evBlocksL10Per60) ? row.evBlocksL10Per60 : null,
    Number.isFinite(row.evBlocksL5Per60) ? row.evBlocksL5Per60 : null,
    Number.isFinite(row.pkBlocksSeasonPer60) ? row.pkBlocksSeasonPer60 : null,
    Number.isFinite(row.pkBlocksL10Per60) ? row.pkBlocksL10Per60 : null,
    Number.isFinite(row.pkBlocksL5Per60) ? row.pkBlocksL5Per60 : null,
    Number.isFinite(row.pkToiPerGame) ? row.pkToiPerGame : null,
    row.source || 'nst',
  );
}

/**
 * Get NST blocked-shot rate row for a player and season.
 * @param {number|string} playerId
 * @param {string} [season]
 * @returns {object|null}
 */
function getPlayerBlkRates(
  playerId,
  season = process.env.NHL_CURRENT_SEASON || '20242025',
) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT *
    FROM player_blk_rates
    WHERE nhl_player_id = ?
      AND season = ?
    LIMIT 1
  `);

  return stmt.get(String(playerId), season) || null;
}

/**
 * Upsert a tracked player row for a sport+market.
 * Used by automated ID sync jobs (e.g., NHL SOG top-shooter sync).
 *
 * @param {object} row
 * @param {number} row.playerId
 * @param {string} row.sport
 * @param {string} row.market
 * @param {string} [row.playerName]
 * @param {string} [row.teamAbbrev]
 * @param {number} [row.shots]
 * @param {number} [row.gamesPlayed]
 * @param {number} [row.shotsPerGame]
 * @param {number} [row.seasonId]
 * @param {string} [row.source]
 * @param {boolean|number} [row.isActive]
 * @param {string} [row.lastSyncedAt]
 */
function upsertTrackedPlayer(row) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(row.sport, 'upsertTrackedPlayer');
  const normalizedMarket = String(row.market || '').trim().toLowerCase();
  const playerId = Number(row.playerId);
  if (!Number.isFinite(playerId)) {
    throw new Error('upsertTrackedPlayer requires numeric playerId');
  }

  const stmt = db.prepare(`
    INSERT INTO tracked_players (
      player_id, sport, market, player_name, team_abbrev, shots,
      games_played, shots_per_game, season_id, source, is_active, last_synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, sport, market) DO UPDATE SET
      player_name = excluded.player_name,
      team_abbrev = excluded.team_abbrev,
      shots = excluded.shots,
      games_played = excluded.games_played,
      shots_per_game = excluded.shots_per_game,
      season_id = excluded.season_id,
      source = excluded.source,
      is_active = excluded.is_active,
      last_synced_at = excluded.last_synced_at,
      updated_at = CURRENT_TIMESTAMP
  `);

  const shots = Number(row.shots);
  const gamesPlayed = Number(row.gamesPlayed);
  const shotsPerGame = Number(row.shotsPerGame);
  const seasonId = Number(row.seasonId);

  stmt.run(
    playerId,
    normalizedSport,
    normalizedMarket,
    row.playerName || null,
    row.teamAbbrev || null,
    Number.isFinite(shots) ? shots : null,
    Number.isFinite(gamesPlayed) ? gamesPlayed : null,
    Number.isFinite(shotsPerGame) ? shotsPerGame : null,
    Number.isFinite(seasonId) ? seasonId : null,
    row.source || 'unknown',
    row.isActive === undefined ? 1 : row.isActive ? 1 : 0,
    row.lastSyncedAt || new Date().toISOString(),
  );
}

/**
 * List tracked players for a sport+market.
 *
 * @param {object} params
 * @param {string} [params.sport='NHL']
 * @param {string} [params.market='shots_on_goal']
 * @param {boolean} [params.activeOnly=true]
 * @param {number|null} [params.limit=null]
 * @returns {array}
 */
function listTrackedPlayers({
  sport = 'NHL',
  market = 'shots_on_goal',
  activeOnly = true,
  limit = null,
} = {}) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(sport, 'listTrackedPlayers');
  const normalizedMarket = String(market || '').trim().toLowerCase();
  const params = [normalizedSport, normalizedMarket];

  let sql = `
    SELECT
      player_id,
      sport,
      market,
      player_name,
      team_abbrev,
      shots,
      games_played,
      shots_per_game,
      season_id,
      source,
      is_active,
      last_synced_at
    FROM tracked_players
    WHERE sport = ?
      AND market = ?
  `;

  if (activeOnly) {
    sql += ' AND is_active = 1';
  }

  sql += `
    ORDER BY
      shots_per_game DESC,
      shots DESC,
      games_played DESC,
      player_id ASC
  `;

  if (Number.isFinite(limit) && Number(limit) > 0) {
    sql += ' LIMIT ?';
    params.push(Math.floor(Number(limit)));
  }

  return db.prepare(sql).all(...params);
}

/**
 * Deactivate tracked players for sport+market that are not in the active set.
 *
 * @param {object} params
 * @param {string} [params.sport='NHL']
 * @param {string} [params.market='shots_on_goal']
 * @param {number[]} [params.activePlayerIds=[]]
 * @param {string} [params.lastSyncedAt]
 * @returns {number} count of rows changed
 */
function deactivateTrackedPlayersNotInSet({
  sport = 'NHL',
  market = 'shots_on_goal',
  activePlayerIds = [],
  lastSyncedAt = null,
} = {}) {
  const db = getDatabase();
  const normalizedSport = normalizeSportValue(
    sport,
    'deactivateTrackedPlayersNotInSet',
  );
  const normalizedMarket = String(market || '').trim().toLowerCase();
  const safeIds = Array.isArray(activePlayerIds)
    ? activePlayerIds.map((id) => Number(id)).filter(Number.isFinite)
    : [];
  const syncedAt = lastSyncedAt || new Date().toISOString();

  if (safeIds.length === 0) {
    const stmt = db.prepare(`
      UPDATE tracked_players
      SET
        is_active = 0,
        last_synced_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE sport = ?
        AND market = ?
        AND is_active = 1
    `);
    const info = stmt.run(syncedAt, normalizedSport, normalizedMarket);
    return info.changes || 0;
  }

  const placeholders = safeIds.map(() => '?').join(', ');
  const stmt = db.prepare(`
    UPDATE tracked_players
    SET
      is_active = 0,
      last_synced_at = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE sport = ?
      AND market = ?
      AND is_active = 1
      AND player_id NOT IN (${placeholders})
  `);
  const info = stmt.run(syncedAt, normalizedSport, normalizedMarket, ...safeIds);
  return info.changes || 0;
}

/**
 * Upsert a player prop line (fetched from odds provider).
 */
function upsertPlayerPropLine(row) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO player_prop_lines (
      id, sport, game_id, odds_event_id, player_name, prop_type, period,
      line, over_price, under_price, bookmaker, fetched_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sport, game_id, player_name, prop_type, period, bookmaker, line) DO UPDATE SET
      odds_event_id = excluded.odds_event_id,
      over_price = excluded.over_price,
      under_price = excluded.under_price,
      fetched_at = excluded.fetched_at
  `);
  stmt.run(
    row.id,
    row.sport,
    row.gameId,
    row.oddsEventId || null,
    row.playerName,
    row.propType,
    row.period || 'full_game',
    row.line,
    row.overPrice || null,
    row.underPrice || null,
    row.bookmaker || null,
    row.fetchedAt,
  );
}

/**
 * Upsert a player's availability/injury status.
 * Called by pull jobs after checking injury signals from the source API.
 *
 * @param {{ playerId: number, sport: string, status: string, statusReason?: string, checkedAt: string }} row
 */
function upsertPlayerAvailability(row) {
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO player_availability (player_id, sport, status, status_reason, checked_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(player_id, sport) DO UPDATE SET
      status = excluded.status,
      status_reason = excluded.status_reason,
      checked_at = excluded.checked_at
  `);
  stmt.run(
    row.playerId,
    row.sport || 'NHL',
    row.status,
    row.statusReason || null,
    row.checkedAt,
  );
}

/**
 * Get the latest availability record for a player.
 * Returns null if no record exists (fail-open: caller should proceed normally).
 *
 * @param {number} playerId
 * @param {string} sport
 * @returns {{ player_id: number, sport: string, status: string, status_reason: string|null, checked_at: string }|null}
 */
function getPlayerAvailability(playerId, sport) {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT player_id, sport, status, status_reason, checked_at
    FROM player_availability
    WHERE player_id = ? AND sport = ?
    LIMIT 1
  `);
  return stmt.get(playerId, sport || 'NHL') || null;
}

/**
 * Get consensus prop line for a player+game+propType combo.
 * Prefers draftkings, then fanduel, then betmgm, then any available.
 * Returns null if no line found.
 */
function getPlayerPropLine(sport, gameId, playerName, propType, period) {
  const db = getDatabase();
  const resolvedPeriod = period || 'full_game';
  const stmt = db.prepare(`
    SELECT line, over_price, under_price, bookmaker
    FROM player_prop_lines
    WHERE sport = ?
      AND game_id = ?
      AND LOWER(player_name) = LOWER(?)
      AND prop_type = ?
      AND period = ?
    ORDER BY
      CASE bookmaker
        WHEN 'draftkings' THEN 1
        WHEN 'fanduel' THEN 2
        WHEN 'betmgm' THEN 3
        ELSE 4
      END ASC
    LIMIT 1
  `);
  return stmt.get(sport, gameId, playerName, propType, resolvedPeriod) || null;
}

/**
 * Get de-duplicated player prop lines for a game.
 * For each player+prop_type+period, bookmaker priority is applied:
 * draftkings -> fanduel -> betmgm -> any.
 */
function getPlayerPropLinesForGame(sport, gameId, propTypes = null) {
  const db = getDatabase();
  const hasPropTypes = Array.isArray(propTypes) && propTypes.length > 0;
  const placeholders = hasPropTypes ? propTypes.map(() => '?').join(', ') : '';
  const stmt = db.prepare(`
    SELECT player_name, prop_type, period, line, over_price, under_price, bookmaker, fetched_at
    FROM player_prop_lines
    WHERE sport = ?
      AND game_id = ?
      ${hasPropTypes ? `AND prop_type IN (${placeholders})` : ''}
    ORDER BY
      LOWER(player_name) ASC,
      prop_type ASC,
      period ASC,
      CASE bookmaker
        WHEN 'draftkings' THEN 1
        WHEN 'fanduel' THEN 2
        WHEN 'betmgm' THEN 3
        ELSE 4
      END ASC
  `);

  const rows = hasPropTypes
    ? stmt.all(sport, gameId, ...propTypes)
    : stmt.all(sport, gameId);

  const uniqueRows = [];
  const seenKeys = new Set();
  for (const row of rows) {
    const dedupeKey = `${String(row.player_name || '').toLowerCase()}|${row.prop_type}|${row.period}`;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

module.exports = {
  upsertPlayerShotLog,
  getPlayerShotLogs,
  upsertPlayerBlkLog,
  getPlayerBlkLogs,
  upsertPlayerBlkRates,
  getPlayerBlkRates,
  upsertTrackedPlayer,
  listTrackedPlayers,
  deactivateTrackedPlayersNotInSet,
  upsertPlayerAvailability,
  getPlayerAvailability,
  upsertPlayerPropLine,
  getPlayerPropLine,
  getPlayerPropLinesForGame,
};
