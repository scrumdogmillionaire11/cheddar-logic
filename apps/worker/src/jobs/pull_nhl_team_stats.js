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

const JOB_NAME = 'pull_nhl_team_stats';
const NHL_TEAM_STATS_BASE = 'https://api.nhle.com/stats/rest/en/team';
const SPLITS = ['ALL', 'H', 'R'];

function deriveSeasonId(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  return Number(`${startYear}${startYear + 1}`);
}

function resolveSeasonId() {
  const envSeason = String(
    process.env.NHL_CURRENT_SEASON ||
    process.env.NHL_SOG_SEASON_ID ||
    '',
  ).trim();

  if (/^\d{8}$/.test(envSeason)) {
    return Number(envSeason);
  }

  return deriveSeasonId();
}

function buildCayenneExp({ seasonId, homeRoad = 'ALL' }) {
  const clauses = [`seasonId=${Number(seasonId)}`, 'gameTypeId=2'];
  if (homeRoad === 'H' || homeRoad === 'R') {
    clauses.push(`homeRoad="${homeRoad}"`);
  }
  return clauses.join(' and ');
}

async function fetchTeamReport(report, { seasonId, homeRoad = 'ALL', limit = 100 } = {}) {
  const params = new URLSearchParams({
    isAggregate: 'false',
    isGame: 'false',
    start: '0',
    limit: String(limit),
    sort: JSON.stringify([{ property: 'teamId', direction: 'ASC' }]),
    cayenneExp: buildCayenneExp({ seasonId, homeRoad }),
  });
  const url = `${NHL_TEAM_STATS_BASE}/${report}?${params.toString()}`;
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    throw new Error(`NHL stats API ${response.status} for ${url}`);
  }
  return response.json();
}

function toFinitePositive(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function mergeTeamStatsRows(pkPayload, penaltiesPayload, { seasonId, homeRoad = 'ALL' } = {}) {
  const pkRows = Array.isArray(pkPayload?.data) ? pkPayload.data : [];
  const penaltyRows = Array.isArray(penaltiesPayload?.data) ? penaltiesPayload.data : [];

  const merged = new Map();

  for (const row of pkRows) {
    const teamId = Number(row?.teamId);
    if (!Number.isFinite(teamId)) continue;
    merged.set(teamId, {
      team_id: teamId,
      team_name: row?.teamFullName || null,
      season: String(seasonId),
      home_road: homeRoad,
      pk_pct: toFinitePositive(row?.penaltyKillPct),
      penalties_against_per60: null,
      source: 'nhl_stats_api',
    });
  }

  for (const row of penaltyRows) {
    const teamId = Number(row?.teamId);
    if (!Number.isFinite(teamId)) continue;
    const existing = merged.get(teamId) || {
      team_id: teamId,
      team_name: row?.teamFullName || null,
      season: String(seasonId),
      home_road: homeRoad,
      pk_pct: null,
      penalties_against_per60: null,
      source: 'nhl_stats_api',
    };
    existing.team_name = existing.team_name || row?.teamFullName || null;
    // "Penalties against" from offensive perspective is opponent penalties taken.
    existing.penalties_against_per60 = toFinitePositive(row?.penaltiesTakenPer60);
    merged.set(teamId, existing);
  }

  return [...merged.values()].filter(
    (row) => row.pk_pct !== null || row.penalties_against_per60 !== null,
  );
}

function ensureTeamStatsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_stats (
      team_id INTEGER NOT NULL,
      team_name TEXT NOT NULL,
      season TEXT NOT NULL,
      home_road TEXT NOT NULL DEFAULT 'ALL',
      pk_pct REAL,
      penalties_against_per60 REAL,
      source TEXT NOT NULL DEFAULT 'nhl_stats_api',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (team_id, season, home_road)
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_team_stats_season_name
    ON team_stats (season, team_name, home_road);
  `);
}

function upsertTeamStatsRows(db, rows) {
  ensureTeamStatsTable(db);
  const upsert = db.prepare(`
    INSERT INTO team_stats (
      team_id,
      team_name,
      season,
      home_road,
      pk_pct,
      penalties_against_per60,
      source,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(team_id, season, home_road) DO UPDATE SET
      team_name = excluded.team_name,
      pk_pct = excluded.pk_pct,
      penalties_against_per60 = excluded.penalties_against_per60,
      source = excluded.source,
      updated_at = datetime('now')
  `);

  let upserted = 0;
  for (const row of rows) {
    upsert.run(
      row.team_id,
      row.team_name,
      row.season,
      row.home_road,
      row.pk_pct,
      row.penalties_against_per60,
      row.source || 'nhl_stats_api',
    );
    upserted += 1;
  }
  return upserted;
}

async function pullNhlTeamStats({
  jobKey = null,
  dryRun = false,
  seasonId = resolveSeasonId(),
} = {}) {
  const resolvedSeasonId = Number(seasonId);
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

      const allRows = [];
      for (const split of SPLITS) {
        const [pkPayload, penaltiesPayload] = await Promise.all([
          fetchTeamReport('penaltykill', { seasonId: resolvedSeasonId, homeRoad: split }),
          fetchTeamReport('penalties', { seasonId: resolvedSeasonId, homeRoad: split }),
        ]);

        const mergedRows = mergeTeamStatsRows(pkPayload, penaltiesPayload, {
          seasonId: resolvedSeasonId,
          homeRoad: split,
        });
        allRows.push(...mergedRows);
      }

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          seasonId: resolvedSeasonId,
          splitCount: SPLITS.length,
          rows: allRows.length,
        };
      }

      const db = getDatabase();
      const upserted = upsertTeamStatsRows(db, allRows);

      markJobRunSuccess(jobRunId, {
        seasonId: resolvedSeasonId,
        splitCount: SPLITS.length,
        rows: upserted,
      });

      console.log(
        `[${JOB_NAME}] season=${resolvedSeasonId} splitCount=${SPLITS.length} upserted=${upserted}`,
      );

      return {
        success: true,
        seasonId: resolvedSeasonId,
        splitCount: SPLITS.length,
        rows: upserted,
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

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, seasonId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--season' && argv[i + 1]) {
      args.seasonId = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs();
  pullNhlTeamStats({
    dryRun: args.dryRun,
    seasonId: args.seasonId || resolveSeasonId(),
  })
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  SPLITS,
  deriveSeasonId,
  resolveSeasonId,
  buildCayenneExp,
  fetchTeamReport,
  mergeTeamStatsRows,
  ensureTeamStatsTable,
  upsertTeamStatsRows,
  parseCliArgs,
  pullNhlTeamStats,
};
