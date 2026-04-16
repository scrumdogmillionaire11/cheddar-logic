'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const JOB_NAME = 'pull_mlb_weather';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';

/**
 * Hardcoded stadium coordinates: [lat, lon].
 * Source: well-known venue geo coordinates.
 */
const STADIUM_COORDS = {
  'Yankee Stadium':              [40.8296, -73.9262],
  'Fenway Park':                 [42.3467, -71.0972],
  'Dodger Stadium':              [34.0739, -118.2400],
  'Wrigley Field':               [41.9484, -87.6553],
  'Oracle Park':                 [37.7786, -122.3893],
  'Citi Field':                  [40.7571, -73.8458],
  'Citizens Bank Park':          [39.9061, -75.1665],
  'Camden Yards':                [39.2839, -76.6217],
  'Nationals Park':              [38.8730, -77.0074],
  'Truist Park':                 [33.8907, -84.4677],
  'loanDepot park':              [25.7781, -80.2197],
  'Busch Stadium':               [38.6226, -90.1928],
  'Great American Ball Park':    [39.0974, -84.5067],
  'PNC Park':                    [40.4468, -80.0057],
  'American Family Field':       [43.0280, -87.9712],
  'Guaranteed Rate Field':       [41.8299, -87.6338],
  'Rate Field':                  [41.8299, -87.6338],
  'Progressive Field':           [41.4962, -81.6852],
  'Comerica Park':               [42.3390, -83.0485],
  'Target Field':                [44.9817, -93.2776],
  'Kauffman Stadium':            [39.0517, -94.4803],
  'Minute Maid Park':            [29.7573, -95.3555],
  'Daikin Park':                 [29.7573, -95.3555],
  'Globe Life Field':            [32.7473, -97.0832],
  'Angel Stadium':               [33.8003, -117.8827],
  'T-Mobile Park':               [47.5914, -122.3325],
  'Oakland Coliseum':            [37.7516, -122.2005],
  'Petco Park':                  [32.7073, -117.1566],
  'Chase Field':                 [33.4453, -112.0667],
  'Coors Field':                 [39.7559, -104.9942],
  'Rogers Centre':               [43.6414, -79.3894],
  'Tropicana Field':             [27.7683, -82.6534],
  'Sutter Health Park':          [38.5802, -121.5002],
};

/**
 * Dome / retractable-roof stadiums: weather has no effect — return null.
 */
const INDOOR_STADIUMS = new Set([
  'Chase Field',           // retractable
  'Tropicana Field',       // fixed dome
  'Rogers Centre',         // retractable
  'Minute Maid Park',      // retractable
  'Daikin Park',           // retractable (Houston's renamed Minute Maid Park)
  'American Family Field', // retractable
  'Globe Life Field',      // retractable
]);

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch current weather for a stadium using api.weather.gov two-step flow:
 *  1. GET /points/{lat},{lon} → forecastHourlyUrl
 *  2. GET forecastHourlyUrl   → periods array
 *
 * @param {string} venueName
 * @param {string|null} gameTimeUtc  ISO-8601 string, used to find matching period
 * @returns {object|null} { temp_f, wind_mph, wind_dir, conditions } or null
 */
async function fetchStadiumWeather(venueName, gameTimeUtc) {
  if (INDOOR_STADIUMS.has(venueName)) {
    console.log(`[${JOB_NAME}] ${venueName} is indoor/dome — skipping weather`);
    return null;
  }

  const coords = STADIUM_COORDS[venueName];
  if (!coords) {
    console.log(`[${JOB_NAME}] ${venueName} not in STADIUM_COORDS — skipping`);
    return null;
  }

  const [lat, lon] = coords;

  // Step 1: resolve grid point
  let forecastHourlyUrl;
  try {
    const pointRes = await fetch(
      `https://api.weather.gov/points/${lat},${lon}`,
      { headers: { 'User-Agent': 'cheddar-logic-worker' } },
    );
    if (!pointRes.ok) {
      console.warn(`[${JOB_NAME}] weather.gov /points returned ${pointRes.status} for ${venueName}`);
      return null;
    }
    const pointData = await pointRes.json();
    forecastHourlyUrl = pointData?.properties?.forecastHourly;
    if (!forecastHourlyUrl) {
      console.warn(`[${JOB_NAME}] No forecastHourly URL for ${venueName}`);
      return null;
    }
  } catch (err) {
    console.warn(`[${JOB_NAME}] /points fetch failed for ${venueName}: ${err.message}`);
    return null;
  }

  // Step 2: get hourly forecast
  let periods;
  try {
    const forecastRes = await fetch(forecastHourlyUrl, {
      headers: { 'User-Agent': 'cheddar-logic-worker' },
    });
    if (!forecastRes.ok) {
      console.warn(`[${JOB_NAME}] forecastHourly returned ${forecastRes.status} for ${venueName}`);
      return null;
    }
    const forecastData = await forecastRes.json();
    periods = forecastData?.properties?.periods ?? [];
  } catch (err) {
    console.warn(`[${JOB_NAME}] forecastHourly fetch failed for ${venueName}: ${err.message}`);
    return null;
  }

  if (periods.length === 0) return null;

  // Find period matching game time (fall back to first period)
  let period = periods[0];
  if (gameTimeUtc) {
    const gameTime = new Date(gameTimeUtc);
    const match = periods.find((p) => {
      const start = new Date(p.startTime);
      const end = new Date(p.endTime);
      return start <= gameTime && gameTime <= end;
    });
    if (match) period = match;
  }

  // Parse wind speed: "15 mph" → 15
  const windRaw = period.windSpeed ?? '';
  const windMph = parseInt(windRaw, 10); // handles "15 mph" → 15

  return {
    temp_f: period.temperature ?? null,          // already °F from NWS API
    wind_mph: Number.isFinite(windMph) ? windMph : null,
    wind_dir: period.windDirection ?? null,
    conditions: period.shortForecast ?? null,
  };
}

function ensureWeatherTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_weather (
      id          TEXT PRIMARY KEY,
      game_id     TEXT NOT NULL,
      game_date   TEXT NOT NULL,
      venue_name  TEXT,
      home_team   TEXT,
      temp_f      REAL,
      wind_mph    REAL,
      wind_dir    TEXT,
      conditions  TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (game_date, home_team)
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_game_weather_game_date_home
      ON mlb_game_weather (game_date, home_team);
  `);
}

function upsertWeatherRow(db, row) {
  const upsert = db.prepare(`
    INSERT INTO mlb_game_weather (
      id, game_id, game_date, venue_name, home_team,
      temp_f, wind_mph, wind_dir, conditions, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(game_date, home_team) DO UPDATE SET
      venue_name  = excluded.venue_name,
      temp_f      = excluded.temp_f,
      wind_mph    = excluded.wind_mph,
      wind_dir    = excluded.wind_dir,
      conditions  = excluded.conditions,
      updated_at  = datetime('now')
  `);

  upsert.run(
    uuidV4(),
    row.game_id,
    row.game_date,
    row.venue_name,
    row.home_team,
    row.temp_f,
    row.wind_mph,
    row.wind_dir,
    row.conditions,
  );
}

/**
 * Main job: fetch today's MLB schedule, pull weather per venue, upsert to DB.
 */
async function pullMlbWeather({
  jobKey = null,
  dryRun = false,
  date = todayDateString(),
} = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDbSafe(async () => {
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

      // Fetch today's schedule with venue hydration
      const scheduleUrl = `${MLB_API_BASE}/schedule?sportId=1&date=${date}&hydrate=venue,team`;
      const schedRes = await fetch(scheduleUrl, {
        headers: { 'user-agent': 'cheddar-logic-worker' },
      });
      if (!schedRes.ok) {
        throw new Error(`MLB schedule API ${schedRes.status}`);
      }
      const schedData = await schedRes.json();

      // Extract unique venues (may have multiple games at same park — skip duplicates)
      const dates = Array.isArray(schedData.dates) ? schedData.dates : [];
      const games = [];
      for (const d of dates) {
        for (const g of (d.games ?? [])) {
          games.push(g);
        }
      }

      console.log(`[${JOB_NAME}] date=${date} games=${games.length}`);

      if (dryRun) {
        const venues = [...new Set(games.map((g) => g?.venue?.name).filter(Boolean))];
        return {
          success: true,
          dryRun: true,
          date,
          gameCount: games.length,
          venues,
        };
      }

      // Process venues sequentially with 500ms delay to be polite to weather.gov
      const db = getDatabase();
      ensureWeatherTable(db);

      let upserted = 0;
      let skippedIndoor = 0;
      let skippedUnknown = 0;
      let fetchFailed = 0;

      for (const game of games) {
        const venueName = game?.venue?.name ?? null;
        const homeTeam = game?.teams?.home?.team?.name ?? null;
        const gameId = `mlb_${date}_${game?.gamePk ?? uuidV4().slice(0, 8)}`;
        const gameTimeUtc = game?.gameDate ?? null;

        if (!venueName || !homeTeam) {
          console.warn(`[${JOB_NAME}] Missing venue or home_team for game ${game?.gamePk} — skipping`);
          continue;
        }

        if (INDOOR_STADIUMS.has(venueName)) {
          skippedIndoor++;
          // Store null weather for indoor venues so enricher can skip gracefully
          upsertWeatherRow(db, {
            game_id: gameId,
            game_date: date,
            venue_name: venueName,
            home_team: homeTeam,
            temp_f: null,
            wind_mph: null,
            wind_dir: null,
            conditions: 'INDOOR',
          });
          console.log(`[${JOB_NAME}] ${venueName} (${homeTeam}): indoor — stored null`);
          continue;
        }

        if (!STADIUM_COORDS[venueName]) {
          skippedUnknown++;
          console.warn(`[${JOB_NAME}] ${venueName} not in STADIUM_COORDS — skipping`);
          continue;
        }

        // Add delay between venues to respect weather.gov rate limits
        await delay(500);

        const weather = await fetchStadiumWeather(venueName, gameTimeUtc);

        if (weather) {
          upsertWeatherRow(db, {
            game_id: gameId,
            game_date: date,
            venue_name: venueName,
            home_team: homeTeam,
            temp_f: weather.temp_f,
            wind_mph: weather.wind_mph,
            wind_dir: weather.wind_dir,
            conditions: weather.conditions,
          });
          upserted++;
          console.log(
            `[${JOB_NAME}] ${venueName} (${homeTeam}): temp=${weather.temp_f}°F wind=${weather.wind_mph}mph ${weather.wind_dir} — ${weather.conditions}`,
          );
        } else {
          fetchFailed++;
          console.warn(`[${JOB_NAME}] ${venueName} (${homeTeam}): weather fetch returned null`);
        }
      }

      markJobRunSuccess(jobRunId, {
        date,
        gameCount: games.length,
        upserted,
        skippedIndoor,
        skippedUnknown,
        fetchFailed,
      });

      console.log(
        `[${JOB_NAME}] date=${date} upserted=${upserted} indoor=${skippedIndoor} unknown=${skippedUnknown} failed=${fetchFailed}`,
      );

      return {
        success: true,
        date,
        gameCount: games.length,
        upserted,
        skippedIndoor,
        skippedUnknown,
        fetchFailed,
      };
    } catch (error) {
      if (!dryRun && jobInserted) {
        try {
          markJobRunFailure(jobRunId, error.message);
        } catch (markError) {
          console.error(`[${JOB_NAME}] Failed to record failure: ${markError.message}`);
        }
      }
      console.error(`[${JOB_NAME}] Error: ${error.message}`);
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
  pullMlbWeather({
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
  fetchStadiumWeather,
  ensureWeatherTable,
  upsertWeatherRow,
  parseCliArgs,
  pullMlbWeather,
  STADIUM_COORDS,
  INDOOR_STADIUMS,
};
