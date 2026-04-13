'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertTrackedPlayer,
  deactivateTrackedPlayersNotInSet,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const JOB_NAME = 'sync_nhl_blk_player_ids';
const SPORT = 'NHL';
const MARKET = 'blocked_shots';
const SOURCE = 'nhl_stats_api_skater_summary';
const NHL_STATS_BASE = 'https://api.nhle.com/stats/rest/en/skater/realtime';
const DEFAULT_TOP_COUNT = Number(process.env.NHL_BLK_TOP_BLOCKERS_COUNT || 60);
const DEFAULT_MIN_GAMES = Number(process.env.NHL_BLK_MIN_GAMES_PLAYED || 20);
const DEFAULT_FETCH_LIMIT = Number(process.env.NHL_BLK_SYNC_FETCH_LIMIT || 300);

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

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function parseTopBlockers(payload, { topCount, minGamesPlayed }) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const eligible = [];

  for (const row of rows) {
    const playerId = Number(row?.playerId);
    const blockedShots = Number(
      row?.blockedShots ?? row?.blocked_shots ?? row?.blocks ?? row?.blocked,
    );
    const gamesPlayed = Number(row?.gamesPlayed);
    if (!Number.isFinite(playerId)) continue;
    if (!Number.isFinite(blockedShots) || !Number.isFinite(gamesPlayed)) continue;
    if (gamesPlayed < minGamesPlayed || gamesPlayed <= 0) continue;

    eligible.push({
      playerId,
      playerName: row?.skaterFullName || null,
      teamAbbrev: row?.teamAbbrevs || null,
      blockedShots,
      gamesPlayed,
      blocksPerGame: round3(blockedShots / gamesPlayed),
      seasonId: Number(row?.seasonId) || null,
    });
  }

  eligible.sort((a, b) => {
    if (b.blocksPerGame !== a.blocksPerGame) return b.blocksPerGame - a.blocksPerGame;
    if (b.blockedShots !== a.blockedShots) return b.blockedShots - a.blockedShots;
    if (b.gamesPlayed !== a.gamesPlayed) return b.gamesPlayed - a.gamesPlayed;
    return a.playerId - b.playerId;
  });

  return eligible.slice(0, topCount);
}

async function fetchSkaterSummary({ seasonId, limit }) {
  const params = new URLSearchParams({
    isAggregate: 'false',
    isGame: 'false',
    start: '0',
    limit: String(limit),
    sort: JSON.stringify([{ property: 'blockedShots', direction: 'DESC' }]),
    cayenneExp: `seasonId=${seasonId} and gameTypeId=2`,
  });

  const url = `${NHL_STATS_BASE}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });

  if (!response.ok) {
    throw new Error(`NHL stats API ${response.status} for ${url}`);
  }

  return response.json();
}

async function syncNhlBlkPlayerIds({
  jobKey = null,
  dryRun = false,
  topCount = DEFAULT_TOP_COUNT,
  minGamesPlayed = DEFAULT_MIN_GAMES,
  fetchLimit = DEFAULT_FETCH_LIMIT,
} = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  const seasonId = resolveSeasonId();

  return withDbSafe(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, skipped: true, jobRunId: null, jobKey };
    }

    let jobInserted = false;
    try {
      if (!dryRun) {
        insertJobRun(JOB_NAME, jobRunId, jobKey);
        jobInserted = true;
      }

      const payload = await fetchSkaterSummary({ seasonId, limit: fetchLimit });
      const topBlockers = parseTopBlockers(payload, { topCount, minGamesPlayed });
      const fetchedAt = new Date().toISOString();

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          seasonId,
          topCount,
          minGamesPlayed,
          selected: topBlockers.length,
          playerIds: topBlockers.map((row) => row.playerId),
        };
      }

      for (const player of topBlockers) {
        upsertTrackedPlayer({
          playerId: player.playerId,
          sport: SPORT,
          market: MARKET,
          playerName: player.playerName,
          teamAbbrev: player.teamAbbrev,
          shots: player.blockedShots,
          gamesPlayed: player.gamesPlayed,
          shotsPerGame: player.blocksPerGame,
          seasonId: player.seasonId || seasonId,
          source: SOURCE,
          isActive: true,
          lastSyncedAt: fetchedAt,
        });
      }

      const deactivated = deactivateTrackedPlayersNotInSet({
        sport: SPORT,
        market: MARKET,
        activePlayerIds: topBlockers.map((row) => row.playerId),
        lastSyncedAt: fetchedAt,
      });

      markJobRunSuccess(jobRunId, {
        seasonId,
        selected: topBlockers.length,
        deactivated,
      });

      return {
        success: true,
        seasonId,
        selected: topBlockers.length,
        deactivated,
      };
    } catch (error) {
      if (!dryRun && jobInserted) {
        try {
          markJobRunFailure(jobRunId, error.message);
        } catch (markError) {
          console.error(`[${JOB_NAME}] Failed to record failure: ${markError.message}`);
        }
      }
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  syncNhlBlkPlayerIds({ dryRun })
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  syncNhlBlkPlayerIds,
  deriveSeasonId,
  parseTopBlockers,
  fetchSkaterSummary,
};
