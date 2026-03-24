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

const JOB_NAME = 'pull_mlb_pitcher_stats';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_SEASON = 2026;

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    throw new Error(`MLB API ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchProbablePitcherIds(date) {
  const url = `${MLB_API_BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note),team`;
  const payload = await fetchJson(url);

  const ids = new Set();
  const dates = Array.isArray(payload.dates) ? payload.dates : [];
  for (const d of dates) {
    const games = Array.isArray(d.games) ? d.games : [];
    for (const game of games) {
      const homePitcher = game?.teams?.home?.probablePitcher;
      const awayPitcher = game?.teams?.away?.probablePitcher;
      if (homePitcher?.id) ids.add(Number(homePitcher.id));
      if (awayPitcher?.id) ids.add(Number(awayPitcher.id));
    }
  }
  return [...ids];
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeDiv(numerator, denominator, multiplier = 1) {
  const n = toFinite(numerator);
  const d = toFinite(denominator);
  if (n === null || d === null || d === 0) return null;
  return (n / d) * multiplier;
}

async function fetchPitcherSeasonStats(pitcherId) {
  const url = `${MLB_API_BASE}/people/${pitcherId}/stats?stats=season&season=${MLB_SEASON}&group=pitching`;
  const payload = await fetchJson(url);

  const stats = payload?.stats?.[0]?.splits?.[0]?.stat;
  if (!stats) {
    return { era: null, whip: null, k_per_9: null, innings_pitched: null };
  }

  const ip = toFinite(stats.inningsPitched);
  const strikeOuts = toFinite(stats.strikeOuts);
  return {
    era: toFinite(stats.era),
    whip: toFinite(stats.whip),
    k_per_9: safeDiv(strikeOuts, ip, 9),
    innings_pitched: ip,
  };
}

async function fetchPitcherRecentStats(pitcherId) {
  const url = `${MLB_API_BASE}/people/${pitcherId}/stats?stats=gameLog&season=${MLB_SEASON}&group=pitching`;
  const payload = await fetchJson(url);

  const splits = Array.isArray(payload?.stats?.[0]?.splits)
    ? payload.stats[0].splits
    : [];

  const last5 = splits.slice(-5);
  if (last5.length === 0) {
    return { recent_k_per_9: null, recent_ip: null, allSplits: splits };
  }

  let totalK = 0;
  let totalIp = 0;
  let validStarts = 0;

  for (const entry of last5) {
    const ip = toFinite(entry?.stat?.inningsPitched);
    const k = toFinite(entry?.stat?.strikeOuts);
    if (ip !== null && k !== null) {
      totalK += k;
      totalIp += ip;
      validStarts += 1;
    }
  }

  if (validStarts === 0 || totalIp === 0) {
    return { recent_k_per_9: null, recent_ip: null, allSplits: splits };
  }

  return {
    recent_k_per_9: (totalK / totalIp) * 9,
    recent_ip: totalIp / validStarts,
    allSplits: splits,
  };
}

function ensureGameLogsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_pitcher_game_logs (
      id              TEXT PRIMARY KEY,
      mlb_pitcher_id  INTEGER NOT NULL,
      game_pk         INTEGER NOT NULL,
      game_date       TEXT NOT NULL,
      season          INTEGER NOT NULL,
      innings_pitched REAL,
      strikeouts      INTEGER,
      walks           INTEGER,
      hits            INTEGER,
      earned_runs     INTEGER,
      opponent        TEXT,
      home_away       TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (mlb_pitcher_id, game_pk)
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_pitcher_date
      ON mlb_pitcher_game_logs (mlb_pitcher_id, game_date);
  `);
}

function upsertGameLogs(db, mlbPitcherId, splits, season) {
  ensureGameLogsTable(db);
  const stmt = db.prepare(`
    INSERT INTO mlb_pitcher_game_logs
      (id, mlb_pitcher_id, game_pk, game_date, season,
       innings_pitched, strikeouts, walks, hits, earned_runs, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mlb_pitcher_id, game_pk) DO UPDATE SET
      innings_pitched = excluded.innings_pitched,
      strikeouts = excluded.strikeouts,
      walks = excluded.walks,
      hits = excluded.hits,
      earned_runs = excluded.earned_runs,
      updated_at = datetime('now')
  `);
  let count = 0;
  for (const split of splits) {
    const gamePk = split?.game?.gamePk;
    const gameDate = split?.date;
    if (!gamePk || !gameDate) continue;
    const stat = split?.stat ?? {};
    stmt.run(
      uuidV4(),
      mlbPitcherId,
      gamePk,
      gameDate,
      season,
      parseFloat(stat.inningsPitched) || null,
      parseInt(stat.strikeOuts, 10) || null,
      parseInt(stat.baseOnBalls, 10) || null,
      parseInt(stat.hits, 10) || null,
      parseInt(stat.earnedRuns, 10) || null,
    );
    count += 1;
  }
  return count;
}

async function fetchPitcherInfo(pitcherId) {
  const url = `${MLB_API_BASE}/people/${pitcherId}`;
  const payload = await fetchJson(url);
  const person = payload?.people?.[0];
  return {
    full_name: person?.fullName || null,
    team: person?.currentTeam?.name || null,
  };
}

async function fetchAllPitcherData(pitcherId) {
  const [info, seasonStats, recentStats] = await Promise.all([
    fetchPitcherInfo(pitcherId),
    fetchPitcherSeasonStats(pitcherId),
    fetchPitcherRecentStats(pitcherId),
  ]);

  return {
    mlb_id: pitcherId,
    full_name: info.full_name,
    team: info.team,
    season: MLB_SEASON,
    era: seasonStats.era,
    whip: seasonStats.whip,
    k_per_9: seasonStats.k_per_9,
    innings_pitched: seasonStats.innings_pitched,
    recent_k_per_9: recentStats.recent_k_per_9,
    recent_ip: recentStats.recent_ip,
    allSplits: recentStats.allSplits ?? [],
  };
}

function ensurePitcherStatsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_pitcher_stats (
      id            TEXT PRIMARY KEY,
      mlb_id        INTEGER NOT NULL UNIQUE,
      full_name     TEXT,
      team          TEXT,
      season        INTEGER,
      era           REAL,
      whip          REAL,
      k_per_9       REAL,
      innings_pitched REAL,
      recent_k_per_9  REAL,
      recent_ip       REAL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_stats_mlb_id
    ON mlb_pitcher_stats (mlb_id);
  `);
}

function upsertPitcherRows(db, rows) {
  ensurePitcherStatsTable(db);
  const upsert = db.prepare(`
    INSERT INTO mlb_pitcher_stats (
      id,
      mlb_id,
      full_name,
      team,
      season,
      era,
      whip,
      k_per_9,
      innings_pitched,
      recent_k_per_9,
      recent_ip,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(mlb_id) DO UPDATE SET
      full_name = excluded.full_name,
      team = excluded.team,
      season = excluded.season,
      era = excluded.era,
      whip = excluded.whip,
      k_per_9 = excluded.k_per_9,
      innings_pitched = excluded.innings_pitched,
      recent_k_per_9 = excluded.recent_k_per_9,
      recent_ip = excluded.recent_ip,
      updated_at = datetime('now')
  `);

  let upserted = 0;
  for (const row of rows) {
    upsert.run(
      uuidV4(),
      row.mlb_id,
      row.full_name,
      row.team,
      row.season,
      row.era,
      row.whip,
      row.k_per_9,
      row.innings_pitched,
      row.recent_k_per_9,
      row.recent_ip,
    );
    upserted += 1;
  }
  return upserted;
}

async function pullMlbPitcherStats({
  jobKey = null,
  dryRun = false,
  date = todayDateString(),
} = {}) {
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

      const pitcherIds = await fetchProbablePitcherIds(date);
      console.log(`[${JOB_NAME}] date=${date} probable_pitchers=${pitcherIds.length}`);

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          date,
          pitcherCount: pitcherIds.length,
          pitcherIds,
        };
      }

      const rows = await Promise.all(
        pitcherIds.map((id) =>
          fetchAllPitcherData(id).catch((err) => {
            console.warn(`[${JOB_NAME}] Failed to fetch data for pitcher ${id}: ${err.message}`);
            return null;
          }),
        ),
      );

      const validRows = rows.filter(Boolean);

      const db = getDatabase();
      const upserted = upsertPitcherRows(db, validRows);

      // Also store raw per-start game logs for walk-forward backtesting
      let gameLogsCount = 0;
      for (const row of validRows) {
        if (row.allSplits && row.allSplits.length > 0) {
          gameLogsCount += upsertGameLogs(db, row.mlb_id, row.allSplits, row.season);
        }
      }

      markJobRunSuccess(jobRunId, {
        date,
        pitcherCount: pitcherIds.length,
        upserted,
        gameLogsCount,
      });

      console.log(
        `[${JOB_NAME}] date=${date} pitcherCount=${pitcherIds.length} upserted=${upserted} gameLogs=${gameLogsCount}`,
      );

      return {
        success: true,
        date,
        pitcherCount: pitcherIds.length,
        upserted,
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
  const args = { dryRun: false, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--date' && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs();
  pullMlbPitcherStats({
    dryRun: args.dryRun,
    date: args.date || todayDateString(),
  })
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  todayDateString,
  fetchProbablePitcherIds,
  fetchPitcherSeasonStats,
  fetchPitcherRecentStats,
  fetchAllPitcherData,
  ensurePitcherStatsTable,
  upsertPitcherRows,
  ensureGameLogsTable,
  upsertGameLogs,
  parseCliArgs,
  pullMlbPitcherStats,
};
