require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  upsertPlayerShotLog,
  upsertPlayerAvailability,
  listTrackedPlayers,
} = require('@cheddar-logic/data');

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
        headers: {
          'user-agent': 'cheddar-logic-worker',
        },
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

/**
 * Inspect the NHL API landing payload for injury/unavailability signals.
 *
 * Fields checked (in priority order):
 *   1. payload.status       — direct status string
 *   2. payload.currentTeamRoster.statusCode — roster-level status code
 *
 * Injury keywords (case-insensitive substring match):
 *   "injur", "ir", "ltir", "scratch", "suspend", "inactive"
 *
 * Fail-open: if neither field exists, returns { skip: false }.
 *
 * @param {object} payload — NHL API /player/{id}/landing response
 * @returns {{ skip: boolean, reason?: string }}
 */
function checkInjuryStatus(payload) {
  const INJURY_KEYWORDS = ['injur', 'ltir', 'scratch', 'suspend', 'inactive'];
  // "ir" must be a whole-word-like check to avoid false positives (e.g. "first")
  // We check after lowercasing: "ir" as an exact value OR preceded/followed by non-alpha.
  function isInjuryStatus(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const lower = raw.toLowerCase().trim();
    // Exact match for common short codes
    if (lower === 'ir' || lower === 'ltir') return true;
    // Substring match for longer keywords
    return INJURY_KEYWORDS.some((kw) => lower.includes(kw));
  }

  // Check payload.status first (most direct)
  const directStatus = payload?.status;
  if (directStatus !== undefined && directStatus !== null) {
    if (isInjuryStatus(String(directStatus))) {
      return { skip: true, reason: String(directStatus) };
    }
    // Status field was present but not an injury → player is active
    return { skip: false };
  }

  // Fall back to currentTeamRoster.statusCode
  const rosterStatusCode = payload?.currentTeamRoster?.statusCode;
  if (rosterStatusCode !== undefined && rosterStatusCode !== null) {
    if (isInjuryStatus(String(rosterStatusCode))) {
      return { skip: true, reason: String(rosterStatusCode) };
    }
    return { skip: false };
  }

  // Neither field present — fail open
  return { skip: false };
}

function buildLogRows(playerId, payload, fetchedAt) {
  const last5 = Array.isArray(payload?.last5Games) ? payload.last5Games : [];
  const playerName = resolvePlayerName(payload);

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
      shots: Number.isFinite(game?.shots)
        ? game.shots
        : Number(game?.shots) || null,
      toiMinutes,
      rawData: game,
      fetchedAt,
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
      console.log(
        `[NHLPlayerShots] ⏭️  Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(`[NHLPlayerShots] 🔍 DRY_RUN=true — would fetch player logs`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

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
          `[NHLPlayerShots] Using ${allPlayerIds.length} player IDs from tracked_players`,
        );
      }
    } catch (error) {
      console.log(
        `[NHLPlayerShots] WARN: tracked_players unavailable (${error.message}); falling back to NHL_SOG_PLAYER_IDS`,
      );
    }

    if (allPlayerIds.length === 0) {
      allPlayerIds = parsePlayerIds(process.env.NHL_SOG_PLAYER_IDS);
      if (allPlayerIds.length > 0) {
        console.log(
          `[NHLPlayerShots] Using ${allPlayerIds.length} player IDs from NHL_SOG_PLAYER_IDS fallback`,
        );
      }
    }

    if (allPlayerIds.length === 0) {
      console.log(
        '[NHLPlayerShots] No player IDs configured. Run sync_nhl_sog_player_ids or set NHL_SOG_PLAYER_IDS.',
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
      console.log(`[NHLPlayerShots] Excluding ${excludeIds.size} player(s) via NHL_SOG_EXCLUDE_PLAYER_IDS`);
    }

    try {
      insertJobRun('pull_nhl_player_shots', jobRunId, jobKey);

      let logsInserted = 0;
      let playersProcessed = 0;

      for (const playerId of playerIds) {
        try {
          const fetchedAt = new Date().toISOString();
          const payload = await fetchPlayerLanding(playerId);

          // Check injury/availability status before processing shot logs
          const injuryCheck = checkInjuryStatus(payload);
          if (injuryCheck.skip) {
            const playerName = resolvePlayerName(payload) || String(playerId);
            console.log(
              `[NHLPlayerShots] Skipping ${playerName} (${playerId}): status=${injuryCheck.reason}`,
            );
            upsertPlayerAvailability({
              playerId,
              sport: 'NHL',
              status: 'INJURED',
              statusReason: injuryCheck.reason,
              checkedAt: fetchedAt,
            });
            if (DEFAULT_SLEEP_MS > 0) {
              await sleep(DEFAULT_SLEEP_MS);
            }
            continue;
          }

          upsertPlayerAvailability({
            playerId,
            sport: 'NHL',
            status: 'ACTIVE',
            statusReason: null,
            checkedAt: fetchedAt,
          });

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
      console.log(
        `[NHLPlayerShots] ✅ Job complete: ${playersProcessed} players, ${logsInserted} logs`,
      );
      return { success: true, jobRunId, playersProcessed, logsInserted };
    } catch (error) {
      console.error('[NHLPlayerShots] ❌ Job failed:', error.message);
      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          '[NHLPlayerShots] Failed to record error to DB:',
          dbError.message,
        );
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

module.exports = { pullNhlPlayerShots, checkInjuryStatus };
