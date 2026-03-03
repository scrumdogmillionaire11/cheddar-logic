/* eslint-disable @typescript-eslint/no-require-imports */
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  upsertPlayerShotLog
} = require('@cheddar-logic/data');

const NHL_API_BASE = 'https://api-web.nhle.com/v1/player';
const DEFAULT_SLEEP_MS = Number(process.env.NHL_SOG_SLEEP_MS || 500);

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
      if (Array.isArray(parsed)) return parsed.map((value) => Number(value)).filter(Number.isFinite);
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
  const response = await fetch(url, {
    headers: {
      'user-agent': 'cheddar-logic-worker'
    }
  });

  if (!response.ok) {
    throw new Error(`NHL API ${response.status} for player ${playerId}`);
  }

  return response.json();
}

function buildLogRows(playerId, payload, fetchedAt) {
  const last5 = Array.isArray(payload?.last5Games) ? payload.last5Games : [];
  const playerName = payload?.fullName
    ? payload.fullName
    : (payload?.firstName || payload?.lastName)
      ? `${payload?.firstName || ''} ${payload?.lastName || ''}`.trim()
      : null;

  return last5.map((game) => {
    const gameId = game?.gameId ? String(game.gameId) : null;
    const gameDate = game?.gameDate || null;
    const isHome = game?.homeRoadFlag === 'H';
    const toiMinutes = parseToiMinutes(game?.toi);

    return {
      id: `nhl-sog-${playerId}-${gameId || uuidV4().slice(0, 8)}`,
      sport: 'NHL',
      playerId,
      playerName,
      gameId: gameId || `nhl-unknown-${uuidV4().slice(0, 6)}`,
      gameDate,
      opponent: game?.opponentAbbrev || null,
      isHome,
      shots: Number.isFinite(game?.shots) ? game.shots : Number(game?.shots) || null,
      toiMinutes,
      rawData: game,
      fetchedAt
    };
  });
}

async function pullNhlPlayerShots({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-nhl-player-shots-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[NHLPlayerShots] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[NHLPlayerShots] Job key: ${jobKey}`);
  console.log(`[NHLPlayerShots] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[NHLPlayerShots] ⏭️  Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[NHLPlayerShots] 🔍 DRY_RUN=true — would fetch player logs`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    const playerIds = parsePlayerIds(process.env.NHL_SOG_PLAYER_IDS);
    if (playerIds.length === 0) {
      console.log('[NHLPlayerShots] No player IDs configured. Set NHL_SOG_PLAYER_IDS.');
      return { success: true, jobRunId: null, skipped: true, reason: 'no_player_ids' };
    }

    try {
      insertJobRun('pull_nhl_player_shots', jobRunId, jobKey);

      let logsInserted = 0;
      let playersProcessed = 0;

      for (const playerId of playerIds) {
        try {
          const fetchedAt = new Date().toISOString();
          const payload = await fetchPlayerLanding(playerId);
          const rows = buildLogRows(playerId, payload, fetchedAt);

          rows.forEach((row) => {
            upsertPlayerShotLog(row);
            logsInserted += 1;
          });

          playersProcessed += 1;
          console.log(`[NHLPlayerShots] ✅ ${playerId}: ${rows.length} logs`);
        } catch (error) {
          console.error(`[NHLPlayerShots] ❌ ${playerId}: ${error.message}`);
        }

        if (DEFAULT_SLEEP_MS > 0) {
          await sleep(DEFAULT_SLEEP_MS);
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(`[NHLPlayerShots] ✅ Job complete: ${playersProcessed} players, ${logsInserted} logs`);
      return { success: true, jobRunId, playersProcessed, logsInserted };
    } catch (error) {
      console.error('[NHLPlayerShots] ❌ Job failed:', error.message);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error('[NHLPlayerShots] Failed to record error to DB:', dbError.message);
      }
      return { success: false, jobRunId, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullNhlPlayerShots({ dryRun })
    .then((result) => {
      if (result?.success === false) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error('[NHLPlayerShots] Fatal:', error.message);
      process.exit(1);
    });
}

module.exports = { pullNhlPlayerShots };
