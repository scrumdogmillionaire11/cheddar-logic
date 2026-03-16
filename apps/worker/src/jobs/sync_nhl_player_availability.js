'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  listTrackedPlayers,
  upsertPlayerAvailability,
} = require('@cheddar-logic/data');

const { checkInjuryStatus } = require('./pull_nhl_player_shots');

const JOB_NAME = 'sync_nhl_player_availability';
const NHL_API_BASE = 'https://api-web.nhle.com/v1/player';
const DEFAULT_SLEEP_MS = Number(process.env.NHL_SOG_SLEEP_MS || 500);
const MAX_RETRIES = Number(process.env.NHL_SOG_FETCH_RETRIES || 4);

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
      if (Array.isArray(parsed))
        return parsed.map((value) => Number(value)).filter(Number.isFinite);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
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
        const waitMs = attempt * 1000;
        await sleep(waitMs);
        continue;
      }

      throw new Error(`NHL API ${response.status} for player ${playerId}`);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const waitMs = attempt * 1000;
        await sleep(waitMs);
      }
    }
  }

  throw new Error(
    `NHL API fetch failed for player ${playerId}: ${lastError?.message || 'unknown error'}`,
  );
}

/**
 * Hourly injury sync job.
 *
 * Polls NHL API /player/{id}/landing for all configured player IDs and
 * upserts their availability status WITHOUT writing shot logs. Intended
 * to run every hour so player_availability rows stay fresh between
 * pull_nhl_player_shots runs.
 */
async function syncNhlPlayerAvailability({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[${JOB_NAME}] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[${JOB_NAME}] Job key: ${jobKey}`);
  console.log(`[${JOB_NAME}] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[${JOB_NAME}] Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[${JOB_NAME}] DRY_RUN=true — would sync player availability`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    // Resolve player IDs: tracked_players first, fallback to env var
    let allPlayerIds = [];
    try {
      const trackedPlayers = listTrackedPlayers({
        sport: 'NHL',
        market: 'shots_on_goal',
        activeOnly: true,
      });
      if (Array.isArray(trackedPlayers) && trackedPlayers.length > 0) {
        allPlayerIds = trackedPlayers
          .map((row) => Number(row.player_id))
          .filter(Number.isFinite);
        console.log(
          `[${JOB_NAME}] Using ${allPlayerIds.length} player IDs from tracked_players`,
        );
      }
    } catch (error) {
      console.log(
        `[${JOB_NAME}] WARN: tracked_players unavailable (${error.message}); falling back to NHL_SOG_PLAYER_IDS`,
      );
    }

    if (allPlayerIds.length === 0) {
      allPlayerIds = parsePlayerIds(process.env.NHL_SOG_PLAYER_IDS);
      if (allPlayerIds.length > 0) {
        console.log(
          `[${JOB_NAME}] Using ${allPlayerIds.length} player IDs from NHL_SOG_PLAYER_IDS fallback`,
        );
      }
    }

    if (allPlayerIds.length === 0) {
      console.log(
        `[${JOB_NAME}] No player IDs configured. Run sync_nhl_sog_player_ids or set NHL_SOG_PLAYER_IDS.`,
      );
      return {
        success: true,
        jobRunId: null,
        skipped: true,
        reason: 'no_player_ids',
      };
    }

    const excludeIds = new Set(parsePlayerIds(process.env.NHL_SOG_EXCLUDE_PLAYER_IDS));
    const playerIds = allPlayerIds.filter((id) => !excludeIds.has(id));
    if (excludeIds.size > 0) {
      console.log(
        `[${JOB_NAME}] Excluding ${excludeIds.size} player(s) via NHL_SOG_EXCLUDE_PLAYER_IDS`,
      );
    }

    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      let playersChecked = 0;
      let injuredCount = 0;
      let dtdCount = 0;

      for (const playerId of playerIds) {
        try {
          const fetchedAt = new Date().toISOString();
          const payload = await fetchPlayerLanding(playerId);
          const injuryCheck = checkInjuryStatus(payload);

          let status;
          if (injuryCheck.skip) {
            status = 'INJURED';
            injuredCount += 1;
            console.log(
              `[${JOB_NAME}] ${playerId}: INJURED (${injuryCheck.reason})`,
            );
          } else if (injuryCheck.tier === 'DTD') {
            status = 'DTD';
            dtdCount += 1;
            console.log(
              `[${JOB_NAME}] ${playerId}: DTD (${injuryCheck.reason})`,
            );
          } else {
            status = 'ACTIVE';
          }

          upsertPlayerAvailability({
            playerId,
            sport: 'NHL',
            status,
            statusReason: injuryCheck.reason || null,
            checkedAt: fetchedAt,
          });

          playersChecked += 1;
        } catch (error) {
          console.error(`[${JOB_NAME}] ${playerId}: ${error.message}`);
        }

        if (DEFAULT_SLEEP_MS > 0) {
          await sleep(DEFAULT_SLEEP_MS);
        }
      }

      markJobRunSuccess(jobRunId, { playersChecked, injuredCount, dtdCount });
      console.log(
        `[${JOB_NAME}] Job complete: ${playersChecked} players checked (${injuredCount} injured, ${dtdCount} DTD)`,
      );
      return { success: true, jobRunId, playersChecked, injuredCount, dtdCount };
    } catch (error) {
      console.error(`[${JOB_NAME}] Job failed:`, error.message);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(`[${JOB_NAME}] Failed to record error to DB: ${dbError.message}`);
      }
      return { success: false, jobRunId, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  syncNhlPlayerAvailability({ dryRun })
    .then((result) => {
      if (result?.success === false) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = { syncNhlPlayerAvailability };
