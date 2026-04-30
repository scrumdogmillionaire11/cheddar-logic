/**
 * Pull NHL Gamecenter IDs Job (WI-1110)
 *
 * Fetches the NHL schedule from the NHL public API for a ±dateRange day window,
 * matches each game to a canonical game_id by cross-referencing ESPN game_id_map
 * entries already in the DB, then upserts NHL gamecenter IDs so that
 * resolveNhlGamecenterId (settle_projections, settle_game_results) can find them.
 *
 * Usage:
 *   node src/jobs/pull_nhl_game_ids.js
 *   node src/jobs/pull_nhl_game_ids.js --dry-run
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertGameIdMap,
  withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'pull_nhl_game_ids';
const NHL_SCHEDULE_BASE = 'https://api-web.nhle.com/v1/schedule';
// same sport token used by pull_schedule_nhl / settle_projections
const SPORT = 'nhl';

// Maps 3-letter NHL abbreviations to a unique fragment of the canonical full
// team name stored in our games table (upper-cased full city or nickname).
const NHL_ABBREV_TO_NAME_FRAGMENT = {
  ANA: 'ANAHEIM', ARI: 'ARIZONA', BOS: 'BOSTON', BUF: 'BUFFALO',
  CAR: 'CAROLINA', CBJ: 'COLUMBUS', CGY: 'CALGARY', CHI: 'CHICAGO',
  COL: 'COLORADO', DAL: 'DALLAS', DET: 'DETROIT', EDM: 'EDMONTON',
  FLA: 'FLORIDA', LAK: 'KINGS', MIN: 'MINNESOTA', MTL: 'MONTREAL',
  NJD: 'NEW JERSEY', NSH: 'NASHVILLE', NYI: 'ISLANDERS', NYR: 'RANGERS',
  OTT: 'OTTAWA', PHI: 'PHILADELPHIA', PIT: 'PITTSBURGH', SEA: 'KRAKEN',
  SJS: 'SAN JOSE', STL: 'LOUIS', TBL: 'TAMPA', TOR: 'TORONTO',
  UTA: 'UTAH', VAN: 'VANCOUVER', VGK: 'GOLDEN KNIGHTS', WSH: 'WASHINGTON',
  WPG: 'WINNIPEG',
};

/**
 * Fetch the NHL API schedule for a single date.
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {Promise<object>}
 */
async function fetchNhlScheduleForDate(dateStr) {
  const url = `${NHL_SCHEDULE_BASE}/${dateStr}`;
  const res = await fetch(url, { headers: { 'user-agent': 'cheddar-logic-worker' } });
  if (!res.ok) throw new Error(`NHL schedule API ${res.status} for ${url}`);
  return res.json();
}

/**
 * Extract game records from the NHL schedule response.
 * @param {object} scheduleJson
 * @returns {Array<{nhlGameId: string, gameDate: string, homeAbbrev: string, awayAbbrev: string}>}
 */
function extractGamesFromSchedule(scheduleJson) {
  const games = [];
  const gameWeek = Array.isArray(scheduleJson?.gameWeek) ? scheduleJson.gameWeek : [];
  for (const day of gameWeek) {
    const dayGames = Array.isArray(day?.games) ? day.games : [];
    for (const game of dayGames) {
      if (!game.id) continue;
      games.push({
        nhlGameId: String(game.id),
        gameDate: String(game.gameDate || day.date || ''),
        homeAbbrev: String(game.homeTeam?.abbrev || ''),
        awayAbbrev: String(game.awayTeam?.abbrev || ''),
      });
    }
  }
  return games;
}

/**
 * Resolve a canonical game_id from the DB by cross-referencing ESPN game_id_map
 * entries for the same date and teams (abbrev partial-match).
 *
 * @param {object} db
 * @param {{gameDate: string, homeAbbrev: string, awayAbbrev: string}} game
 * @returns {string|null}
 */
function resolveCanonicalGameId(db, { gameDate, homeAbbrev, awayAbbrev }) {
  if (!gameDate || !homeAbbrev || !awayAbbrev) return null;

  // Map 3-letter NHL abbreviations to full-name fragments for LIKE matching
  // against full team names stored in the games table (e.g. "TBL" → "TAMPA").
  const homeFragment =
    NHL_ABBREV_TO_NAME_FRAGMENT[homeAbbrev.toUpperCase()] || homeAbbrev.toUpperCase();
  const awayFragment =
    NHL_ABBREV_TO_NAME_FRAGMENT[awayAbbrev.toUpperCase()] || awayAbbrev.toUpperCase();

  // NHL API returns local game dates; evening NA games often have a game_time_utc
  // that falls on the next UTC calendar day, so we check both the given date and
  // date+1 to avoid false misses.
  const dateClause = `(DATE(g.game_time_utc) = ? OR DATE(g.game_time_utc) = DATE(?, '+1 day'))`;
  const teamClause = `UPPER(g.home_team) LIKE '%' || ? || '%' AND UPPER(g.away_team) LIKE '%' || ? || '%'`;

  // Prefer ESPN-mapped entry (most reliable cross-reference).
  const espnRow = db
    .prepare(
      `SELECT gim.game_id
       FROM game_id_map gim
       JOIN games g ON g.game_id = gim.game_id
       WHERE LOWER(gim.sport) = 'nhl'
         AND gim.provider = 'espn'
         AND ${dateClause}
         AND ${teamClause}
       LIMIT 1`,
    )
    .get(gameDate, gameDate, homeFragment, awayFragment);
  if (espnRow?.game_id) return espnRow.game_id;

  // Fallback: match directly in the games table when no ESPN mapping exists yet.
  const directRow = db
    .prepare(
      `SELECT g.game_id
       FROM games g
       WHERE LOWER(g.sport) = 'nhl'
         AND ${dateClause}
         AND ${teamClause}
       LIMIT 1`,
    )
    .get(gameDate, gameDate, homeFragment, awayFragment);

  return directRow?.game_id ?? null;
}

/**
 * Build the date range (YYYY-MM-DD strings) centered on today.
 * @param {number} rangedays - days before and after today
 * @returns {string[]}
 */
function buildDateRange(rangeDays) {
  const dates = [];
  const now = new Date();
  for (let offset = -rangeDays; offset <= rangeDays; offset++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset),
    );
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * Main job entry point.
 *
 * @param {object} opts
 * @param {string|null} opts.jobKey
 * @param {boolean} opts.dryRun
 * @param {number} opts.dateRange - days ± today to fetch (default 7)
 */
async function pullNhlGameIds({ jobKey = null, dryRun = false, dateRange = 7 } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[${JOB_NAME}] Starting: jobRunId=${jobRunId} dateRange=±${dateRange} dryRun=${dryRun}`);
  if (jobKey) console.log(`[${JOB_NAME}] jobKey=${jobKey}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, skipped: true, jobRunId: null, jobKey };
    }

    if (dryRun) {
      console.log(`[${JOB_NAME}] DRY_RUN=true — would fetch NHL schedule for ±${dateRange} days`);
      return { success: true, dryRun: true, jobRunId: null, jobKey };
    }

    let jobInserted = false;
    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);
      jobInserted = true;

      const db = getDatabase();
      const dates = buildDateRange(dateRange);

      let fetched = 0;
      let matched = 0;
      let unmatched = 0;
      let inserted = 0;
      let updated = 0;
      // Track which canonical game_ids we've already written so a game that
      // appears on two fetched dates is only counted once.
      const seen = new Set();

      for (const dateStr of dates) {
        let scheduleJson;
        try {
          scheduleJson = await fetchNhlScheduleForDate(dateStr);
        } catch (err) {
          console.warn(`[${JOB_NAME}] fetch failed for ${dateStr}: ${err.message}`);
          continue;
        }

        const games = extractGamesFromSchedule(scheduleJson);
        fetched += games.length;

        for (const game of games) {
          const canonicalGameId = resolveCanonicalGameId(db, game);

          if (!canonicalGameId) {
            unmatched += 1;
            console.debug(
              `[${JOB_NAME}] unmatched nhlId=${game.nhlGameId} date=${game.gameDate} home=${game.homeAbbrev} away=${game.awayAbbrev}`,
            );
            continue;
          }

          matched += 1;

          const isNew = !seen.has(canonicalGameId);
          if (isNew) seen.add(canonicalGameId);

          // Check whether an nhl_gamecenter row already exists for this game_id
          const existing = db
            .prepare(
              `SELECT external_game_id FROM game_id_map
               WHERE sport = ? AND provider = 'nhl_gamecenter' AND game_id = ?
               LIMIT 1`,
            )
            .get(SPORT, canonicalGameId);

          upsertGameIdMap({
            sport: SPORT,
            provider: 'nhl_gamecenter',
            externalGameId: game.nhlGameId,
            gameId: canonicalGameId,
            matchMethod: 'schedule_date_teams',
            matchConfidence: 1.0,
            matchedAt: new Date().toISOString(),
          });

          if (existing) {
            updated += 1;
          } else {
            inserted += 1;
          }
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(
        `[${JOB_NAME}] fetched=${fetched} matched=${matched} unmatched=${unmatched} inserted=${inserted} updated=${updated}`,
      );

      return {
        success: true,
        jobRunId,
        jobKey,
        fetched,
        matched,
        unmatched,
        inserted,
        updated,
      };
    } catch (error) {
      if (jobInserted) {
        try {
          markJobRunFailure(jobRunId, error.message);
        } catch (markErr) {
          console.error(`[${JOB_NAME}] Failed to record failure: ${markErr.message}`);
        }
      }
      console.error(`[${JOB_NAME}] Error:`, error.message);
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  const dateRangeArg = process.argv.find((a) => a.startsWith('--date-range='));
  const dateRange = dateRangeArg ? Math.max(1, parseInt(dateRangeArg.split('=')[1], 10)) : 7;
  pullNhlGameIds({ dryRun, dateRange }).then((r) => {
    if (r.success === false) process.exitCode = 1;
  });
}

module.exports = {
  JOB_NAME,
  fetchNhlScheduleForDate,
  extractGamesFromSchedule,
  resolveCanonicalGameId,
  buildDateRange,
  pullNhlGameIds,
};
