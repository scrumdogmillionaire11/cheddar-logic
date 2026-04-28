require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  upsertPlayerShotLog,
  upsertPlayerAvailability,
  listTrackedPlayers,
} = require('@cheddar-logic/data');

const { deriveNhlSeasonKey } = require('./utils/nhl-season');

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
 * Confirmed-out keywords (skip=true, tier='INJURED'):
 *   "injur", "ir", "ltir", "scratch", "suspend", "inactive"
 *
 * Day-to-day keywords (skip=false, tier='DTD'):
 *   "day-to-day", "dtd", "questionable", "doubtful"
 *
 * Fail-open: if neither field exists, returns { skip: false, tier: 'ACTIVE' }.
 *
 * @param {object} payload — NHL API /player/{id}/landing response
 * @returns {{ skip: boolean, tier: 'INJURED' | 'DTD' | 'ACTIVE', reason?: string }}
 */
function checkInjuryStatus(payload) {
  const INJURY_KEYWORDS = ['injur', 'ltir', 'scratch', 'suspend', 'inactive'];
  const DTD_KEYWORDS = ['day-to-day', 'dtd', 'questionable', 'doubtful'];

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

  function isDtdStatus(raw) {
    if (!raw || typeof raw !== 'string') return false;
    const lower = raw.toLowerCase().trim();
    return DTD_KEYWORDS.some((kw) => lower.includes(kw));
  }

  // Check payload.status first (most direct)
  const directStatus = payload?.status;
  if (directStatus !== undefined && directStatus !== null) {
    const raw = String(directStatus);
    if (isInjuryStatus(raw)) {
      return { skip: true, tier: 'INJURED', reason: raw };
    }
    if (isDtdStatus(raw)) {
      return { skip: false, tier: 'DTD', reason: raw };
    }
    // Status field was present but not an injury or DTD → player is active
    return { skip: false, tier: 'ACTIVE' };
  }

  // Fall back to currentTeamRoster.statusCode
  const rosterStatusCode = payload?.currentTeamRoster?.statusCode;
  if (rosterStatusCode !== undefined && rosterStatusCode !== null) {
    const raw = String(rosterStatusCode);
    if (isInjuryStatus(raw)) {
      return { skip: true, tier: 'INJURED', reason: raw };
    }
    if (isDtdStatus(raw)) {
      return { skip: false, tier: 'DTD', reason: raw };
    }
    return { skip: false, tier: 'ACTIVE' };
  }

  // Neither field present — fail open
  return { skip: false, tier: 'ACTIVE' };
}

/**
 * Compute shots-per-60 from season totals and average TOI.
 * Uses featuredStats.regularSeason.subSeason when available.
 * Fallback: shots / gamesPlayed * 60 / avgToiMinutes (estimating ~18 min if avgToi missing).
 *
 * @param {object} payload — NHL API /player/{id}/landing response
 * @returns {number|null}
 */
function computeSeasonShotsPer60(payload) {
  const sub = payload?.featuredStats?.regularSeason?.subSeason;
  if (!sub) return null;

  const totalShots = Number(sub.shots);
  const gamesPlayed = Number(sub.gamesPlayed);
  if (!Number.isFinite(totalShots) || !Number.isFinite(gamesPlayed) || gamesPlayed === 0) {
    return null;
  }

  // Prefer avgToi from payload if present ("MM:SS" format)
  let avgToiMinutes = null;
  if (sub.avgToi && typeof sub.avgToi === 'string' && sub.avgToi.includes(':')) {
    const avgToiParsed = parseToiMinutes(sub.avgToi);
    if (Number.isFinite(avgToiParsed) && avgToiParsed > 0) {
      avgToiMinutes = avgToiParsed;
    }
  }

  if (avgToiMinutes === null) {
    // Fall back to shots-per-game (league-average TOI ~18 min for forwards/D)
    // This gives a coarser but non-null prior for the model
    return Math.round((totalShots / gamesPlayed) * 10) / 10; // shots/game as proxy
  }

  return Math.round((totalShots / gamesPlayed / avgToiMinutes) * 60 * 100) / 100;
}

function computeSeasonPpToi(payload) {
  const sub = payload?.featuredStats?.regularSeason?.subSeason;
  if (!sub) return null;
  if (!sub.avgPpToi || typeof sub.avgPpToi !== 'string' || !sub.avgPpToi.includes(':')) {
    return null;
  }
  const parsed = parseToiMinutes(sub.avgPpToi);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildLogRows(playerId, payload, fetchedAt, ppRatePer60 = null, ppRateL10Per60 = null, ppRateL5Per60 = null) {
  const last5 = Array.isArray(payload?.last5Games) ? payload.last5Games : [];
  const playerName = resolvePlayerName(payload);

  const seasonShotsPer60 = computeSeasonShotsPer60(payload);

  return last5.map((game) => {
    const gameId = game?.gameId ? String(game.gameId) : null;
    const gameDate = game?.gameDate || null;
    const isHome = game?.homeRoadFlag === 'H';
    const toiMinutes = parseToiMinutes(game?.toi);

    // Enrich per-game raw_data with season-level stats so the model runner
    // has access to shotsPer60 and toiMinutes without a second API call.
    const enrichedRawData = {
      ...game,
      shotsPer60: seasonShotsPer60,
      // projToi: use the season average TOI computed from featuredStats,
      // or fall back to this specific game's TOI as a proxy.
      projToi: (() => {
        const sub = payload?.featuredStats?.regularSeason?.subSeason;
        if (sub?.avgToi && typeof sub.avgToi === 'string') {
          const parsed = parseToiMinutes(sub.avgToi);
          if (Number.isFinite(parsed) && parsed > 0) return parsed;
        }
        return Number.isFinite(toiMinutes) ? toiMinutes : null;
      })(),
      ppToi: computeSeasonPpToi(payload),  // WI-0528: real PP TOI from featuredStats.subSeason.avgPpToi
      // WI-0530: season PP shot rate from NST player_pp_rates table (null if player absent)
      ppRatePer60,
      // WI-0531: L10/L5 rolling PP shot rates (null if absent from player_pp_rates)
      ppRateL10Per60,
      ppRateL5Per60,
    };

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
      rawData: enrichedRawData,
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
      console.error(
        '[NHLPlayerShots] PREREQ FAILURE: no player IDs available. Run sync_nhl_sog_player_ids or set NHL_SOG_PLAYER_IDS.',
      );
      insertJobRun('pull_nhl_player_shots', jobRunId, jobKey);
      markJobRunFailure(jobRunId, { error: 'no_player_ids', prereqFailure: true });
      return {
        success: false,
        prereqFailure: true,
        reason: 'no_player_ids',
        jobRunId,
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

          // DTD players proceed through shot log processing (fail-open)
          // but are recorded with 'DTD' status so downstream consumers can
          // surface a "key player questionable" flag.
          const availabilityStatus = injuryCheck.tier === 'DTD' ? 'DTD' : 'ACTIVE';
          upsertPlayerAvailability({
            playerId,
            sport: 'NHL',
            status: availabilityStatus,
            statusReason: injuryCheck.reason || null,
            checkedAt: fetchedAt,
          });

          // WI-0530: Look up season PP shot rate from player_pp_rates table.
          // Null if player is not in the NST table (non-PP or not yet ingested).
          let ppRatePer60 = null;
          try {
            const db = getDatabase();
            const currentSeason = process.env.NHL_CURRENT_SEASON || deriveNhlSeasonKey();
            const ppRateRow = db
              .prepare(
                'SELECT pp_shots_per60, pp_l10_shots_per60, pp_l5_shots_per60 FROM player_pp_rates WHERE nhl_player_id = ? AND season = ? LIMIT 1',
              )
              .get(String(playerId), currentSeason);
            ppRatePer60 = ppRateRow ? ppRateRow.pp_shots_per60 : null;
          } catch {
            ppRatePer60 = null;
          }

          // WI-0531: extract L10/L5 rolling rates from the same ppRateRow
          let ppRateL10Per60 = null;
          let ppRateL5Per60 = null;
          try {
            const db2 = getDatabase();
            const currentSeason2 = process.env.NHL_CURRENT_SEASON || deriveNhlSeasonKey();
            const ppRateRow2 = db2
              .prepare(
                'SELECT pp_l10_shots_per60, pp_l5_shots_per60 FROM player_pp_rates WHERE nhl_player_id = ? AND season = ? LIMIT 1',
              )
              .get(String(playerId), currentSeason2);
            ppRateL10Per60 = (ppRateRow2 && ppRateRow2.pp_l10_shots_per60 != null)
              ? ppRateRow2.pp_l10_shots_per60 : null;
            ppRateL5Per60 = (ppRateRow2 && ppRateRow2.pp_l5_shots_per60 != null)
              ? ppRateRow2.pp_l5_shots_per60 : null;
          } catch {
            ppRateL10Per60 = null;
            ppRateL5Per60 = null;
          }

          const rows = buildLogRows(playerId, payload, fetchedAt, ppRatePer60, ppRateL10Per60, ppRateL5Per60);

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
