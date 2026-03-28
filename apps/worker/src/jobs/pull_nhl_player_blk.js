'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  upsertPlayerBlkLog,
  upsertPlayerAvailability,
  listTrackedPlayers,
} = require('@cheddar-logic/data');

const JOB_NAME = 'pull_nhl_player_blk';
const NHL_API_BASE = 'https://api-web.nhle.com/v1/player';
const DEFAULT_SLEEP_MS = Number(process.env.NHL_BLK_SLEEP_MS || 500);
const MAX_RETRIES = Number(process.env.NHL_BLK_FETCH_RETRIES || 4);

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

async function fetchPlayerLanding(playerId) {
  const url = `${NHL_API_BASE}/${playerId}/landing`;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'cheddar-logic-worker' },
      });

      if (response.ok) {
        return response.json();
      }

      if (response.status === 429 || response.status >= 500) {
        await sleep(attempt * 1000);
        continue;
      }

      throw new Error(`NHL API ${response.status} for player ${playerId}`);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        await sleep(attempt * 1000);
      }
    }
  }

  throw new Error(
    `NHL API fetch failed for player ${playerId}: ${lastError?.message || 'unknown error'}`,
  );
}

function extractLocalizedText(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (typeof value.default === 'string') return value.default;
    if (typeof value.en === 'string') return value.en;
  }
  return null;
}

function resolvePlayerName(payload) {
  const fullName = extractLocalizedText(payload?.fullName);
  if (fullName && fullName.trim()) return fullName.trim();

  const first = extractLocalizedText(payload?.firstName);
  const last = extractLocalizedText(payload?.lastName);
  const joined = [first, last].filter(Boolean).join(' ').trim();
  return joined || null;
}

function checkInjuryStatus(payload) {
  const INJURY_KEYWORDS = ['injur', 'ltir', 'scratch', 'suspend', 'inactive'];
  const DTD_KEYWORDS = ['day-to-day', 'dtd', 'questionable', 'doubtful'];

  function isInjuryStatus(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const lower = raw.toLowerCase().trim();
    if (lower === 'ir' || lower === 'ltir') return true;
    return INJURY_KEYWORDS.some((kw) => lower.includes(kw));
  }

  function isDtdStatus(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const lower = raw.toLowerCase().trim();
    return DTD_KEYWORDS.some((kw) => lower.includes(kw));
  }

  const directStatus = payload?.status;
  if (directStatus !== undefined && directStatus !== null) {
    const raw = String(directStatus);
    if (isInjuryStatus(raw)) return { skip: true, tier: 'INJURED', reason: raw };
    if (isDtdStatus(raw)) return { skip: false, tier: 'DTD', reason: raw };
    return { skip: false, tier: 'ACTIVE' };
  }

  const rosterStatusCode = payload?.currentTeamRoster?.statusCode;
  if (rosterStatusCode !== undefined && rosterStatusCode !== null) {
    const raw = String(rosterStatusCode);
    if (isInjuryStatus(raw)) return { skip: true, tier: 'INJURED', reason: raw };
    if (isDtdStatus(raw)) return { skip: false, tier: 'DTD', reason: raw };
    return { skip: false, tier: 'ACTIVE' };
  }

  return { skip: false, tier: 'ACTIVE' };
}

function resolveBlockedShots(game) {
  const candidates = [
    game?.blockedShots,
    game?.blocked_shots,
    game?.blocks,
    game?.blocked,
  ];
  for (const value of candidates) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function computeSeasonAvgToi(payload) {
  const sub = payload?.featuredStats?.regularSeason?.subSeason;
  if (!sub?.avgToi || typeof sub.avgToi !== 'string') return null;
  const parsed = parseToiMinutes(sub.avgToi);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildLogRows(player, payload, fetchedAt) {
  const last5 = Array.isArray(payload?.last5Games) ? payload.last5Games : [];
  const playerName = resolvePlayerName(payload) || player.player_name || null;
  const seasonAvgToi = computeSeasonAvgToi(payload);
  const teamAbbrev =
    player.team_abbrev || payload?.currentTeamAbbrev || payload?.currentTeam?.abbrev || null;

  return last5.map((game) => {
    const gameId = game?.gameId ? String(game.gameId) : null;
    const gameDate = game?.gameDate || null;
    const isHome = game?.homeRoadFlag === 'H';
    const toiMinutes = parseToiMinutes(game?.toi);
    const blockedShots = resolveBlockedShots(game);

    return {
      id: `nhl-blk-${player.player_id}-${gameId || uuidV4().slice(0, 8)}`,
      sport: 'NHL',
      playerId: Number(player.player_id),
      playerName,
      gameId: gameId || `nhl-unknown-${uuidV4().slice(0, 6)}`,
      gameDate,
      opponent: game?.opponentAbbrev || null,
      isHome,
      blockedShots,
      toiMinutes,
      rawData: {
        ...game,
        blockedShots,
        projToi: seasonAvgToi ?? toiMinutes,
        teamAbbrev,
      },
      fetchedAt,
    };
  });
}

async function pullNhlPlayerBlk({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
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
      trackedPlayers = allPlayerIds.map((playerId) => ({ player_id: playerId }));
    }

    if (allPlayerIds.length === 0) {
      return { success: true, skipped: true, reason: 'no_player_ids' };
    }

    const trackedById = new Map(
      trackedPlayers.map((row) => [Number(row.player_id), row]),
    );

    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      let logsInserted = 0;
      let playersProcessed = 0;

      for (const playerId of allPlayerIds) {
        try {
          const fetchedAt = new Date().toISOString();
          const payload = await fetchPlayerLanding(playerId);
          const injuryCheck = checkInjuryStatus(payload);

          if (injuryCheck.skip) {
            upsertPlayerAvailability({
              playerId,
              sport: 'NHL',
              status: 'INJURED',
              statusReason: injuryCheck.reason,
              checkedAt: fetchedAt,
            });
            continue;
          }

          upsertPlayerAvailability({
            playerId,
            sport: 'NHL',
            status: injuryCheck.tier === 'DTD' ? 'DTD' : 'ACTIVE',
            statusReason: injuryCheck.reason || null,
            checkedAt: fetchedAt,
          });

          const player = trackedById.get(playerId) || { player_id: playerId };
          const rows = buildLogRows(player, payload, fetchedAt);
          for (const row of rows) {
            upsertPlayerBlkLog(row);
            logsInserted += 1;
          }
          playersProcessed += 1;
        } catch (error) {
          console.error(`[${JOB_NAME}] ${playerId}: ${error.message}`);
        }

        if (DEFAULT_SLEEP_MS > 0) {
          await sleep(DEFAULT_SLEEP_MS);
        }
      }

      markJobRunSuccess(jobRunId);
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
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  pullNhlPlayerBlk,
  parsePlayerIds,
  parseToiMinutes,
  fetchPlayerLanding,
  resolvePlayerName,
  checkInjuryStatus,
  resolveBlockedShots,
  buildLogRows,
};
