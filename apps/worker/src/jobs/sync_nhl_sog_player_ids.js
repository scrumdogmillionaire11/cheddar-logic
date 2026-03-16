'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  upsertTrackedPlayer,
  deactivateTrackedPlayersNotInSet,
} = require('@cheddar-logic/data');

const JOB_NAME = 'sync_nhl_sog_player_ids';
const SPORT = 'NHL';
const MARKET = 'shots_on_goal';
const SOURCE = 'nhl_stats_api_skater_summary';
const NHL_STATS_BASE = 'https://api.nhle.com/stats/rest/en/skater/summary';
const DEFAULT_TOP_COUNT = Number(process.env.NHL_SOG_TOP_SHOOTERS_COUNT || 50);
const DEFAULT_MIN_GAMES = Number(process.env.NHL_SOG_MIN_GAMES_PLAYED || 20);
const DEFAULT_FETCH_LIMIT = Number(process.env.NHL_SOG_SYNC_FETCH_LIMIT || 300);

function deriveSeasonId(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  return Number(`${startYear}${startYear + 1}`);
}

function resolveSeasonId() {
  const envSeason = Number(process.env.NHL_SOG_SEASON_ID);
  if (Number.isFinite(envSeason)) return envSeason;
  return deriveSeasonId();
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function parseTopShooters(payload, { topCount, minGamesPlayed }) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const eligible = [];

  for (const row of rows) {
    const playerId = Number(row?.playerId);
    const shots = Number(row?.shots);
    const gamesPlayed = Number(row?.gamesPlayed);
    if (!Number.isFinite(playerId)) continue;
    if (!Number.isFinite(shots) || !Number.isFinite(gamesPlayed)) continue;
    if (gamesPlayed < minGamesPlayed || gamesPlayed <= 0) continue;

    const shotsPerGame = round3(shots / gamesPlayed);
    eligible.push({
      playerId,
      playerName: row?.skaterFullName || null,
      teamAbbrev: row?.teamAbbrevs || null,
      shots,
      gamesPlayed,
      shotsPerGame,
      seasonId: Number(row?.seasonId) || null,
    });
  }

  eligible.sort((a, b) => {
    if (b.shotsPerGame !== a.shotsPerGame) return b.shotsPerGame - a.shotsPerGame;
    if (b.shots !== a.shots) return b.shots - a.shots;
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
    sort: JSON.stringify([{ property: 'shots', direction: 'DESC' }]),
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

async function syncNhlSogPlayerIds({
  jobKey = null,
  dryRun = false,
  topCount = DEFAULT_TOP_COUNT,
  minGamesPlayed = DEFAULT_MIN_GAMES,
  fetchLimit = DEFAULT_FETCH_LIMIT,
} = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  const seasonId = resolveSeasonId();

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, skipped: true, jobRunId: null, jobKey };
    }

    let jobInserted = false;
    try {
      if (!dryRun) {
        insertJobRun(JOB_NAME, jobRunId, jobKey);
        jobInserted = true;
      }

      const payload = await fetchSkaterSummary({ seasonId, limit: fetchLimit });
      const topShooters = parseTopShooters(payload, { topCount, minGamesPlayed });
      const fetchedAt = new Date().toISOString();

      console.log(
        `[${JOB_NAME}] season=${seasonId} rows=${Array.isArray(payload?.data) ? payload.data.length : 0} eligible=${topShooters.length}`,
      );

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          seasonId,
          topCount,
          minGamesPlayed,
          selected: topShooters.length,
          playerIds: topShooters.map((row) => row.playerId),
        };
      }

      for (const player of topShooters) {
        upsertTrackedPlayer({
          playerId: player.playerId,
          sport: SPORT,
          market: MARKET,
          playerName: player.playerName,
          teamAbbrev: player.teamAbbrev,
          shots: player.shots,
          gamesPlayed: player.gamesPlayed,
          shotsPerGame: player.shotsPerGame,
          seasonId: player.seasonId || seasonId,
          source: SOURCE,
          isActive: true,
          lastSyncedAt: fetchedAt,
        });
      }

      const deactivated = deactivateTrackedPlayersNotInSet({
        sport: SPORT,
        market: MARKET,
        activePlayerIds: topShooters.map((row) => row.playerId),
        lastSyncedAt: fetchedAt,
      });

      markJobRunSuccess(jobRunId, {
        seasonId,
        selected: topShooters.length,
        deactivated,
      });

      return {
        success: true,
        seasonId,
        selected: topShooters.length,
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
  syncNhlSogPlayerIds({ dryRun })
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  syncNhlSogPlayerIds,
  deriveSeasonId,
  parseTopShooters,
  fetchSkaterSummary,
};
