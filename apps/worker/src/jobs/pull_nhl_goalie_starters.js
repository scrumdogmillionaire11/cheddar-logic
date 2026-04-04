'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'pull_nhl_goalie_starters';
const NHL_SCHEDULE_BASE = 'https://api-web.nhle.com/v1/schedule';

/**
 * Fetch today's NHL schedule from the NHL API.
 * @param {string} [dateStr] - YYYY-MM-DD override; defaults to today UTC
 * @returns {Promise<object>}
 */
async function fetchTodaySchedule(dateStr) {
  const today = dateStr || new Date().toISOString().slice(0, 10);
  const url = `${NHL_SCHEDULE_BASE}/${today}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    throw new Error(`NHL schedule API ${response.status} for ${url}`);
  }
  return response.json();
}

/**
 * Extract goalie starter rows from NHL schedule JSON.
 * Produces two rows per game (home + away).
 *
 * @param {object} scheduleJson - Raw NHL API schedule response
 * @returns {Array<object>}
 */
function extractStarterRows(scheduleJson) {
  const rows = [];
  const gameWeek = Array.isArray(scheduleJson?.gameWeek) ? scheduleJson.gameWeek : [];

  for (const day of gameWeek) {
    const games = Array.isArray(day?.games) ? day.games : [];
    for (const game of games) {
      const gameId = String(game.id);

      for (const side of ['homeTeam', 'awayTeam']) {
        const team = game[side];
        if (!team) continue;
        const teamId = team.abbrev || String(team.id);
        const sg = team.startingGoalie;

        let confirmed = 0;
        let goalieId = null;
        let goalieName = null;

        if (sg && sg.id) {
          confirmed = 1;
          goalieId = String(sg.id);
          const firstName = sg.firstName?.default || '';
          const lastName = sg.lastName?.default || '';
          goalieName = `${firstName} ${lastName}`.trim() || null;
        }

        rows.push({
          game_id: gameId,
          team_id: teamId,
          goalie_id: goalieId,
          goalie_name: goalieName,
          confirmed,
          source: 'NHL_API',
          fetched_at: new Date().toISOString(),
        });
      }
    }
  }

  return rows;
}

/**
 * Upsert goalie starter rows into nhl_goalie_starters table.
 *
 * @param {object} db - better-sqlite3 Database instance
 * @param {Array<object>} rows
 * @returns {number} count of rows upserted
 */
function upsertGoalieStarterRows(db, rows) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO nhl_goalie_starters
      (game_id, team_id, goalie_id, goalie_name, confirmed, source, fetched_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?)
  `);

  let upserted = 0;
  for (const row of rows) {
    stmt.run(
      row.game_id,
      row.team_id,
      row.goalie_id,
      row.goalie_name,
      row.confirmed,
      row.source,
      row.fetched_at,
    );
    upserted += 1;
  }
  return upserted;
}

/**
 * Main job function: fetch today's NHL starters and upsert into DB.
 *
 * @param {object} opts
 * @param {string|null} opts.jobKey
 * @param {boolean} opts.dryRun
 * @param {string} [opts.dateStr] - YYYY-MM-DD override for testing
 */
async function pullNhlGoalieStarters({ jobKey = null, dryRun = false, dateStr } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
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

      const scheduleJson = await fetchTodaySchedule(dateStr);
      const rows = extractStarterRows(scheduleJson);

      if (rows.length === 0) {
        const today = dateStr || new Date().toISOString().slice(0, 10);
        console.log(`[${JOB_NAME}] 0 games today (${today})`);
      }

      if (dryRun) {
        return { success: true, dryRun: true, rows: rows.length };
      }

      const db = getDatabase();
      const upserted = upsertGoalieStarterRows(db, rows);

      markJobRunSuccess(jobRunId, { rows: upserted });
      console.log(`[${JOB_NAME}] upserted=${upserted}`);

      return { success: true, rows: upserted };
    } catch (error) {
      if (!dryRun && jobInserted) {
        try {
          markJobRunFailure(jobRunId, error.message);
        } catch (markError) {
          console.error(`[${JOB_NAME}] Failed to record failure: ${markError.message}`);
        }
      }
      console.error(`[${JOB_NAME}] Error:`, error.message);
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  withDb(() => pullNhlGoalieStarters({ jobKey: 'smoke', dryRun: false }))
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  fetchTodaySchedule,
  extractStarterRows,
  upsertGoalieStarterRows,
  pullNhlGoalieStarters,
};
