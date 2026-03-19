'use strict';
require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const { spawnSync } = require('child_process');
const { DateTime } = require('luxon');
const {
  withDb,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  db,
} = require('@cheddar-logic/data');

const JOB_NAME = 'pull_soccer_xg_stats';
const PYTHON_BIN = process.env.SOCCER_XG_PYTHON_BIN || process.env.PYTHON_BIN || 'python3';

const LEAGUE_CONFIG = [
  { league: 'EPL', fbrefLeague: 'ENG-Premier League' },
  { league: 'MLS', fbrefLeague: 'USA-Major League Soccer' },
  { league: 'UCL', fbrefLeague: 'UEFA Champions League' },
];

function normalizeTeamName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function getCurrentSeasonYear() {
  return DateTime.utc().year;
}

function getCacheDateEt() {
  return DateTime.now()
    .setZone(process.env.TZ || 'America/New_York')
    .toISODate();
}

function runSoccerDataFetch({ fbrefLeague, season }) {
  const script = `
import json
import sys

league = sys.argv[1]
season = int(sys.argv[2])

try:
    import pandas as pd
    import soccerdata as sd
except Exception as exc:
    print(json.dumps({"error": f"IMPORT_ERROR:{exc}"}))
    sys.exit(2)


def pick_column(columns, candidates):
    lowered = {str(c).lower(): c for c in columns}
    for candidate in candidates:
        key = candidate.lower()
        if key in lowered:
            return lowered[key]
    return None


try:
    fbref = sd.FBref(leagues=league, seasons=[season], no_cache=False)
    schedule = fbref.read_schedule()
except Exception as exc:
    print(json.dumps({"error": f"FETCH_ERROR:{exc}"}))
    sys.exit(3)

if schedule is None:
    print("[]")
    sys.exit(0)

if hasattr(schedule, 'reset_index'):
    df = schedule.reset_index()
else:
    print("[]")
    sys.exit(0)

if df.empty:
    print("[]")
    sys.exit(0)

home_team_col = pick_column(df.columns, ['home_team', 'home'])
away_team_col = pick_column(df.columns, ['away_team', 'away'])
home_xg_col = pick_column(df.columns, ['home_xg', 'xg_home'])
away_xg_col = pick_column(df.columns, ['away_xg', 'xg_away'])
date_col = pick_column(df.columns, ['date', 'match_date', 'game_date', 'kickoff'])

if not all([home_team_col, away_team_col, home_xg_col, away_xg_col]):
    print("[]")
    sys.exit(0)

if date_col:
    df[date_col] = pd.to_datetime(df[date_col], errors='coerce')
    df = df.sort_values(date_col, ascending=False)


def weighted_recent(values):
    usable = [v for v in values if v is not None]
    if len(usable) == 0:
        return None
    weights = [2.0] + [1.0] * (len(usable) - 1)
    weighted_sum = sum(v * w for v, w in zip(usable, weights))
    weight_total = sum(weights)
    return weighted_sum / weight_total if weight_total > 0 else None

teams = sorted(set(df[home_team_col].dropna().astype(str).tolist() + df[away_team_col].dropna().astype(str).tolist()))
rows = []
for team in teams:
    home_rows = df[df[home_team_col].astype(str) == str(team)].head(6)
    away_rows = df[df[away_team_col].astype(str) == str(team)].head(6)

    home_values = []
    for value in home_rows[home_xg_col].tolist():
        try:
            numeric = float(value)
            if numeric == numeric:
                home_values.append(numeric)
        except Exception:
            pass

    away_values = []
    for value in away_rows[away_xg_col].tolist():
        try:
            numeric = float(value)
            if numeric == numeric:
                away_values.append(numeric)
        except Exception:
            pass

    home_xg_l6 = weighted_recent(home_values)
    away_xg_l6 = weighted_recent(away_values)

    rows.append({
        'team_name': str(team),
        'home_xg_l6': home_xg_l6,
        'away_xg_l6': away_xg_l6,
    })

print(json.dumps(rows))
`;

  const result = spawnSync(PYTHON_BIN, ['-c', script, fbrefLeague, String(season)], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 10,
  });

  if (result.error) {
    throw new Error(result.error.message);
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || '').trim() || `python exited ${result.status}`);
  }

  const raw = (result.stdout || '').trim();
  if (!raw) return [];

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid soccerdata JSON output: ${error.message}`);
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.error) {
    throw new Error(String(parsed.error));
  }

  return Array.isArray(parsed) ? parsed : [];
}

async function pullSoccerXgStats({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  const enabled = process.env.ENABLE_SOCCER_XG_MODEL === 'true';

  if (dryRun) {
    console.log(`[${JOB_NAME}] DRY_RUN — would fetch and upsert xG cache for EPL/MLS/UCL`);
    return {
      success: true,
      dryRun: true,
      leagues: LEAGUE_CONFIG.map((entry) => entry.league),
    };
  }

  if (!enabled) {
    console.log(`[${JOB_NAME}] Skipped — set ENABLE_SOCCER_XG_MODEL=true to enable`);
    return { success: true, skipped: true, reason: 'disabled_by_flag' };
  }

  return withDb(async () => {
    insertJobRun(JOB_NAME, jobRunId, jobKey);

    const season = Number(process.env.SOCCER_XG_SEASON || getCurrentSeasonYear());
    const fetchedAt = new Date().toISOString();
    const cacheDate = getCacheDateEt();

    let rowsUpserted = 0;
    const leagueSummaries = [];

    try {
      for (const leagueConfig of LEAGUE_CONFIG) {
        let leagueRows = [];

        try {
          leagueRows = runSoccerDataFetch({
            fbrefLeague: leagueConfig.fbrefLeague,
            season,
          });
        } catch (error) {
          console.warn(
            `[${JOB_NAME}] WARNING: FBref unavailable for ${leagueConfig.league} (${error.message}) — fail-open`,
          );
          leagueSummaries.push({
            league: leagueConfig.league,
            fetched: 0,
            upserted: 0,
            warning: error.message,
          });
          continue;
        }

        let leagueUpserts = 0;
        for (const row of leagueRows) {
          const teamName = normalizeTeamName(row?.team_name);
          if (!teamName) continue;

          db.upsertSoccerTeamXgCache({
            sport: 'SOCCER',
            league: leagueConfig.league,
            teamName,
            homeXgL6: Number.isFinite(row?.home_xg_l6) ? Number(row.home_xg_l6) : null,
            awayXgL6: Number.isFinite(row?.away_xg_l6) ? Number(row.away_xg_l6) : null,
            fetchedAt,
            cacheDate,
          });
          leagueUpserts += 1;
          rowsUpserted += 1;
        }

        leagueSummaries.push({
          league: leagueConfig.league,
          fetched: leagueRows.length,
          upserted: leagueUpserts,
        });

        console.log(
          `[${JOB_NAME}] ${leagueConfig.league}: fetched=${leagueRows.length}, upserted=${leagueUpserts}`,
        );
      }

      markJobRunSuccess(jobRunId, {
        rowsUpserted,
        cacheDate,
        fetchedAt,
        season,
        leagueSummaries,
      });

      return {
        success: true,
        rowsUpserted,
        cacheDate,
        fetchedAt,
        season,
        leagueSummaries,
      };
    } catch (error) {
      markJobRunFailure(jobRunId, { error: error.message });
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
  pullSoccerXgStats({ dryRun })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  pullSoccerXgStats,
  runSoccerDataFetch,
  normalizeTeamName,
  getCacheDateEt,
};
