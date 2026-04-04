'use strict';

/**
 * NBA Player Availability Sync Job
 *
 * Fetches the ESPN NBA injury report and upserts each player's status into
 * player_availability (sport='nba'). Runs hourly to keep availability fresh
 * before the NBA model runs.
 *
 * ESPN endpoint: https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries
 *
 * Response shape (simplified):
 *   { injuries: [{ displayName: "Atlanta Hawks", injuries: [{ id, status, shortComment, athlete: { displayName, links, team: { abbreviation } } }] }] }
 *
 * Statuses normalised:
 *   "Out"               → OUT
 *   "Day-To-Day"        → DTD
 *   "Questionable"      → GTD
 *   "Probable"          → GTD
 *   "Doubtful"          → DTD
 *   anything else       → ACTIVE
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  upsertPlayerAvailability,
} = require('@cheddar-logic/data');

const JOB_NAME = 'sync_nba_player_availability';
const ESPN_NBA_INJURIES_URL =
  'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries';
const MAX_RETRIES = Number(process.env.NBA_AVAILABILITY_FETCH_RETRIES || 3);
const SLEEP_MS = Number(process.env.NBA_AVAILABILITY_SLEEP_MS || 0);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalise ESPN status string to our canonical status value.
 * @param {string} rawStatus  e.g. "Out", "Day-To-Day", "Questionable"
 * @returns {'OUT'|'DTD'|'GTD'|'ACTIVE'}
 */
function normalizeEspnStatus(rawStatus) {
  const s = String(rawStatus || '').trim().toLowerCase();
  if (s === 'out') return 'OUT';
  if (s === 'day-to-day' || s === 'doubtful') return 'DTD';
  if (s === 'questionable' || s === 'probable') return 'GTD';
  return 'ACTIVE';
}

/**
 * Extract numeric ESPN player ID from athlete links array.
 * Falls back to using the injury entry id if links unavailable.
 *
 * @param {object} athlete
 * @param {string} injuryId
 * @returns {number|null}
 */
function extractPlayerId(athlete, injuryId) {
  const href = (athlete?.links ?? [])[0]?.href ?? '';
  const match = href.match(/\/id\/(\d+)\//);
  if (match) return Number(match[1]);
  const fallback = Number(injuryId);
  return Number.isFinite(fallback) ? fallback : null;
}

/**
 * Fetch ESPN NBA injuries endpoint with retry logic.
 * @returns {Promise<object>}
 */
async function fetchEspnNbaInjuries() {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(ESPN_NBA_INJURIES_URL, {
        headers: { 'user-agent': 'cheddar-logic-worker' },
      });
      if (response.ok) {
        return response.json();
      }
      if (response.status === 429 || response.status >= 500) {
        const waitMs = attempt * 1500;
        console.log(`[${JOB_NAME}] HTTP ${response.status} attempt ${attempt}/${MAX_RETRIES} — waiting ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      throw new Error(`ESPN NBA injuries API ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const waitMs = attempt * 1500;
        await sleep(waitMs);
      }
    }
  }
  throw new Error(
    `ESPN NBA injuries fetch failed after ${MAX_RETRIES} attempts: ${lastError?.message || 'unknown error'}`,
  );
}

/**
 * Hourly NBA player availability sync job.
 *
 * Fetches ESPN NBA injury report and upserts into player_availability with
 * sport='nba'. Non-injured players (ACTIVE) are NOT stored — only players who
 * appear on the ESPN injury report are written. The model treats missing rows
 * as "availability unresolved" when no sync has run today.
 *
 * @param {{ jobKey?: string|null, dryRun?: boolean }} [options]
 */
async function syncNbaPlayerAvailability({ jobKey = null, dryRun = false } = {}) {
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
      console.log(`[${JOB_NAME}] DRY_RUN=true — would sync NBA player availability`);
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      console.log(`[${JOB_NAME}] Fetching ESPN NBA injuries from ${ESPN_NBA_INJURIES_URL}`);
      const payload = await fetchEspnNbaInjuries();

      const teamGroups = Array.isArray(payload?.injuries) ? payload.injuries : [];
      if (teamGroups.length === 0) {
        console.log(`[${JOB_NAME}] ESPN returned no injury data; marking success with 0 rows`);
        markJobRunSuccess(jobRunId, { playersUpserted: 0, outCount: 0, dtdCount: 0, gtdCount: 0 });
        return { success: true, jobRunId, playersUpserted: 0 };
      }

      let playersUpserted = 0;
      let outCount = 0;
      let dtdCount = 0;
      let gtdCount = 0;
      const checkedAt = new Date().toISOString();

      for (const teamGroup of teamGroups) {
        const teamInjuries = Array.isArray(teamGroup.injuries) ? teamGroup.injuries : [];
        for (const entry of teamInjuries) {
          try {
            const athlete = entry.athlete || {};
            const teamAbbr = athlete.team?.abbreviation || null;
            const playerName = athlete.displayName || null;
            const playerId = extractPlayerId(athlete, entry.id);

            if (!playerId) {
              console.log(`[${JOB_NAME}] WARN: could not resolve player_id for ${playerName || 'unknown'} — skipping`);
              continue;
            }

            const status = normalizeEspnStatus(entry.status);
            const statusReason = entry.shortComment || entry.longComment || null;

            upsertPlayerAvailability({
              playerId,
              playerName,
              teamId: teamAbbr,
              sport: 'nba',
              status,
              statusReason,
              checkedAt,
            });

            if (status === 'OUT') outCount += 1;
            else if (status === 'DTD') dtdCount += 1;
            else if (status === 'GTD') gtdCount += 1;

            playersUpserted += 1;

            if (SLEEP_MS > 0) await sleep(SLEEP_MS);
          } catch (entryError) {
            console.error(`[${JOB_NAME}] Error processing entry:`, entryError.message);
          }
        }
      }

      markJobRunSuccess(jobRunId, { playersUpserted, outCount, dtdCount, gtdCount });
      console.log(
        `[${JOB_NAME}] Job complete: ${playersUpserted} players upserted (${outCount} OUT, ${dtdCount} DTD, ${gtdCount} GTD)`,
      );
      return { success: true, jobRunId, playersUpserted, outCount, dtdCount, gtdCount };
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
  syncNbaPlayerAvailability({ dryRun })
    .then((result) => {
      if (result?.success === false) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = { syncNbaPlayerAvailability };
