'use strict';

/**
 * pull_nhl_player_blk — fetch per-game blocked shot data for tracked NHL players.
 *
 * Data source: NHL stats REST API (api.nhle.com/stats/rest/en/skater/realtime)
 * with isGame=true to get per-game records. Batch-fetches all tracked players in
 * one API call instead of individual landing-page calls (which do NOT include
 * blocked shots in their last5Games payload — confirmed 2026-04-05).
 *
 * Availability (injury) checks are handled by sync_nhl_player_availability
 * (scheduled hourly) and are NOT duplicated here.
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertPlayerBlkLog,
  listTrackedPlayers,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const JOB_NAME = 'pull_nhl_player_blk';
const NHL_STATS_BASE = 'https://api.nhle.com/stats/rest/en/skater/realtime';
const MAX_RETRIES = Number(process.env.NHL_BLK_FETCH_RETRIES || 4);
const DEFAULT_GAMES_LOOKBACK = Number(process.env.NHL_BLK_GAMES_LOOKBACK || 10);
// Max players per API call — keeps cayenneExp URL under safe length limits.
const BATCH_PLAYER_LIMIT = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePlayerIds(raw) {
  if (!raw) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => Number(value)).filter(Number.isFinite);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
}

/**
 * Parse TOI from seconds (NHL stats REST API format) to decimal minutes.
 * The stats REST API returns `timeOnIcePerGame` as integer seconds (e.g. 1244 = 20:44).
 * @param {number|null} seconds
 * @returns {number|null}
 */
function parseToiSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round((n / 60) * 100) / 100;
}

/**
 * Parse TOI from "MM:SS" string (legacy landing/game-log API format).
 * Kept for backward compatibility.
 * @param {string|null} toi
 * @returns {number|null}
 */
function parseToiMinutes(toi) {
  if (!toi) return null;
  const raw = String(toi);
  const parts = raw.split(':');
  if (parts.length !== 2) return null;
  const minutes = Number(parts[0]);
  const seconds = Number(parts[1]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return Math.round(((minutes * 60 + seconds) / 60) * 100) / 100;
}

function deriveSeasonId(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  return Number(`${startYear}${startYear + 1}`);
}

function resolveSeasonId() {
  const envSeason = Number(process.env.NHL_BLK_SEASON_ID);
  if (Number.isFinite(envSeason)) return envSeason;
  return deriveSeasonId();
}

/**
 * Batch fetch per-game blocked shots for a set of player IDs from the NHL stats REST API.
 *
 * Uses isGame=true to return individual game records (not season aggregates).
 * The `blockedShots` field is only present at the game level via this endpoint.
 * The landing/game-log API does NOT include blocked shots in per-game summaries.
 *
 * Note: the NHL stats REST API hard-caps responses at 100 rows regardless of the
 * requested limit parameter. This function paginates until each player has at
 * least `minGamesPerPlayer` rows (default 10) or we exhaust available data.
 *
 * @param {number[]} playerIds
 * @param {number}   seasonId
 * @param {number}   [minGamesPerPlayer=10]
 * @returns {Promise<object[]>}
 */
async function fetchBatchGameLogs(playerIds, seasonId, minGamesPerPlayer = 10) {
  if (playerIds.length === 0) return [];

  const idList = playerIds.join(',');
  const PAGE_SIZE = 100; // NHL stats API hard-caps at 100 regardless of limit param
  const MAX_PAGES = 20;  // safety ceiling: 20 × 100 = 2000 rows max per batch

  const allRows = [];
  let start = 0;
  let pagesRequested = 0;

  // Paginate until every player has minGamesPerPlayer rows or we exhaust data.
  while (pagesRequested < MAX_PAGES) {
    const params = new URLSearchParams({
      isAggregate: 'false',
      isGame: 'true',
      start: String(start),
      limit: String(PAGE_SIZE),
      sort: JSON.stringify([{ property: 'gameDate', direction: 'DESC' }]),
      cayenneExp: `seasonId=${seasonId} and gameTypeId=2 and playerId in (${idList})`,
    });

    const url = `${NHL_STATS_BASE}?${params.toString()}`;
    let pageRows = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': 'cheddar-logic-worker' },
        });

        if (response.ok) {
          const data = await response.json();
          pageRows = Array.isArray(data.data) ? data.data : [];
          break;
        }

        if (response.status === 429 || response.status >= 500) {
          await sleep(attempt * 1000);
          continue;
        }

        throw new Error(`NHL stats API ${response.status} (page start=${start})`);
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await sleep(attempt * 1000);
        }
      }
    }

    if (pageRows === null) {
      throw new Error(`fetchBatchGameLogs page start=${start} failed: ${lastError?.message || 'unknown'}`);
    }

    if (pageRows.length === 0) break; // No more data

    allRows.push(...pageRows);
    start += PAGE_SIZE;
    pagesRequested += 1;

    if (pageRows.length < PAGE_SIZE) break; // Last page

    // Stop paging once every requested player has enough games
    const countByPlayer = new Map();
    for (const row of allRows) {
      const id = Number(row.playerId);
      if (Number.isFinite(id)) countByPlayer.set(id, (countByPlayer.get(id) || 0) + 1);
    }
    const allCovered = playerIds.every((id) => (countByPlayer.get(id) || 0) >= minGamesPerPlayer);
    if (allCovered) break;
  }

  return allRows;
}

/**
 * Group game log rows by playerId. Each player's games arrive sorted DESC from API.
 * @param {object[]} rows
 * @param {number}   [gamesPerPlayer=10]
 * @returns {Map<number, object[]>}
 */
function groupByPlayer(rows, gamesPerPlayer = 10) {
  const map = new Map();
  for (const row of rows) {
    const id = Number(row.playerId);
    if (!Number.isFinite(id)) continue;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(row);
  }
  for (const [id, games] of map) {
    map.set(id, games.slice(0, gamesPerPlayer));
  }
  return map;
}

async function pullNhlPlayerBlk({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  const seasonId = resolveSeasonId();

  return withDbSafe(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobRunId: null, jobKey };
    }

    if (dryRun) {
      return { success: true, dryRun: true, jobRunId: null };
    }

    let allPlayerIds = [];
    let trackedPlayers = [];

    try {
      trackedPlayers = listTrackedPlayers({
        sport: 'NHL',
        market: 'blocked_shots',
        activeOnly: true,
      });
      if (Array.isArray(trackedPlayers) && trackedPlayers.length > 0) {
        allPlayerIds = trackedPlayers
          .map((row) => Number(row.player_id))
          .filter(Number.isFinite);
      }
    } catch {
      trackedPlayers = [];
    }

    if (allPlayerIds.length === 0) {
      allPlayerIds = parsePlayerIds(process.env.NHL_BLK_PLAYER_IDS);
    }

    if (allPlayerIds.length === 0) {
      console.log(`[${JOB_NAME}] No tracked players and NHL_BLK_PLAYER_IDS unset — run sync_nhl_blk_player_ids first`);
      return { success: true, skipped: true, reason: 'no_player_ids' };
    }

    const trackedById = new Map(
      trackedPlayers.map((row) => [Number(row.player_id), row]),
    );

    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      const fetchedAt = new Date().toISOString();
      let logsInserted = 0;
      let playersProcessed = 0;

      // Batch players to stay under URL length limits
      for (let i = 0; i < allPlayerIds.length; i += BATCH_PLAYER_LIMIT) {
        const batch = allPlayerIds.slice(i, i + BATCH_PLAYER_LIMIT);

        let rows;
        try {
          rows = await fetchBatchGameLogs(batch, seasonId, DEFAULT_GAMES_LOOKBACK);
        } catch (fetchErr) {
          console.error(`[${JOB_NAME}] Batch fetch failed (batch ${i}-${i + batch.length}): ${fetchErr.message}`);
          continue;
        }

        const byPlayer = groupByPlayer(rows, DEFAULT_GAMES_LOOKBACK);

        for (const playerId of batch) {
          const games = byPlayer.get(playerId) || [];
          if (games.length === 0) {
            console.warn(`[${JOB_NAME}] No game logs for player ${playerId} (season ${seasonId})`);
            continue;
          }

          const tracked = trackedById.get(playerId) || {};
          const playerName = games[0]?.skaterFullName || tracked.player_name || null;
          const teamAbbrev = games[0]?.teamAbbrev || tracked.team_abbrev || null;
          // Most-recent game TOI as season proxy for projToi
          const recentToiMinutes = parseToiSeconds(games[0]?.timeOnIcePerGame);

          for (const game of games) {
            const gameId = game?.gameId ? String(game.gameId) : null;
            const gameDate = game?.gameDate || null;
            const isHome = game?.homeRoad === 'H';
            const toiMinutes = parseToiSeconds(game?.timeOnIcePerGame);
            const blockedShots = Number.isFinite(Number(game?.blockedShots))
              ? Number(game.blockedShots)
              : null;

            upsertPlayerBlkLog({
              id: `nhl-blk-${playerId}-${gameId || uuidV4().slice(0, 8)}`,
              sport: 'NHL',
              playerId: Number(playerId),
              playerName,
              gameId: gameId || `nhl-unknown-${uuidV4().slice(0, 6)}`,
              gameDate,
              opponent: game?.opponentTeamAbbrev || null,
              isHome,
              blockedShots,
              toiMinutes,
              rawData: {
                ...game,
                blockedShots,
                projToi: recentToiMinutes ?? toiMinutes,
                teamAbbrev,
              },
              fetchedAt,
            });
            logsInserted += 1;
          }

          playersProcessed += 1;
        }
      }

      markJobRunSuccess(jobRunId, { playersProcessed, logsInserted });
      console.log(`[${JOB_NAME}] Done: ${playersProcessed} players, ${logsInserted} log rows upserted`);
      return { success: true, jobRunId, playersProcessed, logsInserted };
    } catch (error) {
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[${JOB_NAME}] Failed to record error: ${dbError.message}`);
      }
      return { success: false, jobRunId, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullNhlPlayerBlk({ dryRun })
    .then((result) => {
      console.log(`[${JOB_NAME}] Result:`, JSON.stringify(result));
      process.exit(result.success === false ? 1 : 0);
    })
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  pullNhlPlayerBlk,
  parsePlayerIds,
  parseToiMinutes,
  parseToiSeconds,
  deriveSeasonId,
  fetchBatchGameLogs,
  groupByPlayer,
};
