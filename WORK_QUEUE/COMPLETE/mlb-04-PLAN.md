---
phase: mlb-model-port
plan: 04
type: execute
wave: 4
depends_on: [mlb-03]
files_modified:
  - packages/data/db/migrations/041_create_mlb_game_weather.sql
  - apps/worker/src/jobs/pull_mlb_weather.js
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/schedulers/main.js
autonomous: true
must_haves:
  truths:
    - "mlb_game_weather table stores temp_f and wind_mph per game_id per date."
    - "pull_mlb_weather.js fetches from api.weather.gov (free, no key) using 30 hardcoded stadium coords."
    - "wind_speed string '15 mph' is parsed to integer 15 before storing."
    - "enrichMlbPitcherData in run_mlb_model.js reads weather from mlb_game_weather and attaches wind_mph/temp_f to raw_data.mlb."
    - "pull_mlb_weather queued in scheduler between pull_mlb_pitcher_stats and run_mlb_model."
    - "Missing stadium (dome, indoor) stored as null — model defaults remain neutral."
  artifacts:
    - path: "packages/data/db/migrations/041_create_mlb_game_weather.sql"
      provides: "mlb_game_weather table DDL"
    - path: "apps/worker/src/jobs/pull_mlb_weather.js"
      provides: "Weather fetch job — venue → lat/lon → api.weather.gov → temp/wind per game"
---

<objective>
Close Gap 1: wire real weather overlays into the MLB model.

Purpose: api.weather.gov is free and public. Fetch temp (°F) and wind (mph) for each today's MLB game stadium, store per game_id, and inject into raw_data.mlb before model runs so the 5 weather-driven overlays in projectStrikeouts actually fire.
Output: pull_mlb_weather.js job + migration + enricher update.
</objective>

<context>
@apps/worker/src/jobs/pull_mlb_pitcher_stats.js
@apps/worker/src/jobs/run_mlb_model.js
@apps/worker/src/schedulers/main.js
@packages/data/db/migrations/040_create_mlb_pitcher_stats.sql
</context>

<tasks>

<task type="auto">
  <name>Task 1: Migration 041_create_mlb_game_weather.sql</name>
  <files>packages/data/db/migrations/041_create_mlb_game_weather.sql</files>
  <action>Create migration:

```sql
CREATE TABLE IF NOT EXISTS mlb_game_weather (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL,
  game_date   TEXT NOT NULL,
  venue_name  TEXT,
  temp_f      REAL,
  wind_mph    REAL,
  wind_dir    TEXT,
  conditions  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_id, game_date)
);

CREATE INDEX IF NOT EXISTS idx_mlb_game_weather_game_id
  ON mlb_game_weather (game_id, game_date);
```
</action>
  <verify>echo "Migration file created"</verify>
  <done>File exists and is valid SQL.</done>
</task>

<task type="auto">
  <name>Task 2: Implement pull_mlb_weather.js</name>
  <files>apps/worker/src/jobs/pull_mlb_weather.js</files>
  <action>Create job following pull_mlb_pitcher_stats.js pattern. Key implementation:

**Stadium coords** (port directly from Python STADIUM_COORDS dict):
```js
const STADIUM_COORDS = {
  'Yankee Stadium':          [40.8296, -73.9262],
  'Fenway Park':             [42.3467, -71.0972],
  'Dodger Stadium':          [34.0739, -118.2400],
  'Wrigley Field':           [41.9484, -87.6553],
  'Oracle Park':             [37.7786, -122.3893],
  'Citi Field':              [40.7571, -73.8458],
  'Citizens Bank Park':      [39.9061, -75.1665],
  'Camden Yards':            [39.2839, -76.6217],
  'Nationals Park':          [38.8730, -77.0074],
  'Truist Park':             [33.8907, -84.4677],
  'loanDepot park':          [25.7781, -80.2197],
  'Busch Stadium':           [38.6226, -90.1928],
  'Great American Ball Park':[39.0974, -84.5067],
  'PNC Park':                [40.4468, -80.0057],
  'American Family Field':   [43.0280, -87.9712],
  'Guaranteed Rate Field':   [41.8299, -87.6338],
  'Progressive Field':       [41.4962, -81.6852],
  'Comerica Park':           [42.3390, -83.0485],
  'Target Field':            [44.9817, -93.2776],
  'Kauffman Stadium':        [39.0517, -94.4803],
  'Minute Maid Park':        [29.7573, -95.3555],
  'Globe Life Field':        [32.7473, -97.0832],
  'Angel Stadium':           [33.8003, -117.8827],
  'T-Mobile Park':           [47.5914, -122.3325],
  'Oakland Coliseum':        [37.7516, -122.2005],
  'Petco Park':              [32.7073, -117.1566],
  'Chase Field':             [33.4453, -112.0667],
  'Coors Field':             [39.7559, -104.9942],
  'Rogers Centre':           [43.6414, -79.3894],
  'Tropicana Field':         [27.7683, -82.6534],
};
```

**Indoor/dome stadiums** (return null — no weather effect):
```js
const INDOOR_STADIUMS = new Set([
  'Chase Field',        // retractable
  'Tropicana Field',    // fixed dome
  'Rogers Centre',      // retractable
  'Minute Maid Park',   // retractable
  'American Family Field', // retractable
  'Globe Life Field',   // retractable
]);
```

**Weather fetch flow** (two-step per api.weather.gov):
```js
async function fetchStadiumWeather(venueName, gameTimeUtc) {
  if (INDOOR_STADIUMS.has(venueName)) return null; // dome/retractable
  const coords = STADIUM_COORDS[venueName];
  if (!coords) return null; // unknown venue

  const [lat, lon] = coords;
  // Step 1: get grid point
  const pointRes = await fetch(
    `https://api.weather.gov/points/${lat},${lon}`,
    { headers: { 'User-Agent': 'cheddar-logic-worker' } }
  );
  if (!pointRes.ok) return null;
  const pointData = await pointRes.json();
  const forecastHourlyUrl = pointData?.properties?.forecastHourly;
  if (!forecastHourlyUrl) return null;

  // Step 2: get hourly forecast
  const forecastRes = await fetch(forecastHourlyUrl,
    { headers: { 'User-Agent': 'cheddar-logic-worker' } }
  );
  if (!forecastRes.ok) return null;
  const forecastData = await forecastRes.json();

  // Find the period matching game time
  const gameTime = new Date(gameTimeUtc);
  const periods = forecastData?.properties?.periods ?? [];
  const period = periods.find(p => {
    const start = new Date(p.startTime);
    const end = new Date(p.endTime);
    return start <= gameTime && gameTime <= end;
  }) ?? periods[0]; // fallback to first period if no match

  if (!period) return null;

  // Parse wind speed: "15 mph" → 15
  const windRaw = period.windSpeed ?? '';
  const windMph = parseInt(windRaw, 10); // parseInt handles "15 mph" → 15

  return {
    temp_f: period.temperature ?? null,       // already °F
    wind_mph: Number.isFinite(windMph) ? windMph : null,
    wind_dir: period.windDirection ?? null,
    conditions: period.shortForecast ?? null,
  };
}
```

**Main job function** `pullMlbWeather`:
1. Fetch today's schedule (same endpoint as pull_mlb_pitcher_stats): `GET /schedule?sportId=1&date=TODAY&hydrate=venue,team`
2. For each game: extract `gamePk`, `venue.name`, `gameDate`, `game_id` (construct as `mlb_${date}_${awayAbbr}_${homeAbbr}` matching the odds ingestion format — OR just use gamePk as a lookup key)
3. Actually: game_id in our DB comes from the odds provider, NOT the MLB API. Use `venue.name` + `game_time_utc` as keys. Store with a `game_id` derived from the schedule: `mlb_${date}_${away_abbr}_${home_abbr}` — follow whatever pattern the pull_schedule_mlb.js or odds ingestion uses.
   - Check `apps/worker/src/jobs/pull_schedule_mlb.js` for game_id format before implementing
   - If unsure, store by `game_date + venue_name` and let the enricher look up by date + team names
4. Fetch weather per venue (in parallel with Promise.allSettled — don't let one failure block others)
5. Upsert into mlb_game_weather with id=uuid

**ensureWeatherTable(db)** inline (CREATE TABLE IF NOT EXISTS, same as pitcher stats pattern).

**Export**: `{ JOB_NAME, pullMlbWeather, parseCliArgs }` + `require.main === module` block with `--dry-run`.

**Rate limiting**: add 500ms delay between weather.gov calls (two requests per stadium: /points + /forecastHourly). Process stadiums sequentially with the delay to be polite.
</action>
  <verify>node apps/worker/src/jobs/pull_mlb_weather.js --dry-run</verify>
  <done>Dry run exits 0. Live run fetches weather for today's games and logs temp/wind per venue.</done>
</task>

<task type="auto">
  <name>Task 3: Update enrichMlbPitcherData to attach weather</name>
  <files>apps/worker/src/jobs/run_mlb_model.js</files>
  <action>In `enrichMlbPitcherData`, after attaching pitcher data, add weather lookup:

```js
// Look up weather for this game
try {
  const today = new Date().toISOString().slice(0, 10);
  // Try by game_id first, then fall back to team/date match
  const weatherRow = db.prepare(
    "SELECT temp_f, wind_mph, wind_dir, conditions FROM mlb_game_weather WHERE game_id = ? AND game_date = ? LIMIT 1"
  ).get(oddsSnapshot.game_id, today);

  if (weatherRow) {
    mlb.temp_f = weatherRow.temp_f ?? mlb.temp_f ?? null;
    mlb.wind_mph = weatherRow.wind_mph ?? mlb.wind_mph ?? null;
  }
} catch (weatherErr) {
  // Non-fatal — model uses neutral defaults
}
```

Also thread `temp_f` and `wind_mph` through to the overlays object in `computeMLBDriverCards`. Currently `projectStrikeouts` reads from `overlays.wind_mph` and `overlays.temp_f` — these need to be passed in from `raw_data.mlb`.

Update `computeMLBDriverCards` in `mlb-model.js` to extract and pass weather from the mlb object:
```js
// In computeMLBDriverCards, before calling projectStrikeouts:
const overlays = {
  wind_mph: mlb.wind_mph ?? null,
  temp_f: mlb.temp_f ?? null,
};
// Pass overlays to projectStrikeouts(pitcherStats, line, overlays)
```
</action>
  <verify>node -e "require('./apps/worker/src/jobs/run_mlb_model')" && echo OK</verify>
  <done>File loads without error. Weather fields flow from raw_data.mlb into projectStrikeouts overlays.</done>
</task>

<task type="auto">
  <name>Task 4: Register pull_mlb_weather in scheduler</name>
  <files>apps/worker/src/schedulers/main.js</files>
  <action>Add require for pullMlbWeather near the pullMlbPitcherStats require. Queue weather job immediately after pull_mlb_pitcher_stats and before run_mlb_model:

```js
const { pullMlbWeather } = require('../jobs/pull_mlb_weather');

// In the MLB pre-model section (after pull_mlb_pitcher_stats push):
const weatherJobKey = `pull_mlb_weather|${nowEt.toISODate()}`;
jobs.push({
  jobName: 'pull_mlb_weather',
  jobKey: weatherJobKey,
  execute: pullMlbWeather,
  args: { jobKey: weatherJobKey, dryRun },
  reason: 'pre-model MLB weather overlay fetch',
});
```
</action>
  <verify>node -e "require('./apps/worker/src/schedulers/main')" && echo OK</verify>
  <done>Scheduler loads. pull_mlb_weather appears between pull_mlb_pitcher_stats and run_mlb_model.</done>
</task>

</tasks>

<verification>
- node apps/worker/src/jobs/pull_mlb_weather.js --dry-run exits 0
- Live run logs temp_f and wind_mph for at least one venue
- node -e "const {getInference}=require('./apps/worker/src/models'); ..." with wind_mph=20 → overlays fire (×1.02 multiplier changes edge vs neutral)
- npm --prefix apps/worker test — no new failures
</verification>

<success_criteria>
- Weather fetched per stadium using api.weather.gov (free, no key)
- Dome/retractable stadiums return null gracefully (no overlay applied)
- Unknown venues return null gracefully
- wind_speed string "15 mph" parsed to integer 15
- Weather flows end-to-end: DB → enricher → raw_data.mlb → projectStrikeouts overlays
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-model-port/mlb-04-SUMMARY.md`
</output>
