---
phase: mlb-model-port
plan: 04
subsystem: database, worker-jobs, models
tags: [mlb, weather, api.weather.gov, sqlite, scheduler]

# Dependency graph
requires:
  - phase: mlb-model-port
    plan: 03
    provides: "mlb_pitcher_stats table + pull_mlb_pitcher_stats job"
provides:
  - "mlb_game_weather table with temp_f/wind_mph per game keyed by (game_date, home_team)"
  - "pull_mlb_weather.js job — api.weather.gov two-step fetch for 30 MLB stadiums"
  - "enrichMlbPitcherData attaches wind_mph/temp_f to raw_data.mlb from DB"
  - "computeMLBDriverCards passes weatherOverlays to projectStrikeouts"
  - "Scheduler registers weather job between pitcher stats pull and model run"
affects: [mlb-model-port, mlb-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "api.weather.gov two-step flow: /points/{lat},{lon} → forecastHourlyUrl → periods array"
    - "Sequential stadium processing with 500ms delay to respect weather.gov rate limits"
    - "Indoor/dome stadiums stored with conditions='INDOOR' and null weather — enricher skips gracefully"
    - "Weather keyed by (game_date, home_team) for clean enricher lookup without game_id coupling"

key-files:
  created:
    - packages/data/db/migrations/041_create_mlb_game_weather.sql
    - apps/worker/src/jobs/pull_mlb_weather.js
  modified:
    - apps/worker/src/jobs/run_mlb_model.js
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/schedulers/main.js

key-decisions:
  - "UNIQUE constraint on (game_date, home_team) instead of (game_id, game_date) — home_team is available in enrichMlbPitcherData while game_id comes from odds provider (different namespace)"
  - "Indoor stadiums (Chase Field, Tropicana Field, Rogers Centre, Minute Maid Park, American Family Field, Globe Life Field) stored with conditions='INDOOR' + null weather so enricher can identify and skip without firing neutral defaults"
  - "weather.gov windSpeed string '15 mph' parsed with parseInt which correctly returns 15"
  - "Sequential processing with 500ms delay between venues (two requests each: /points + /forecastHourly)"

patterns-established:
  - "pre-model job pattern: queueXxxBeforeModel helper function + call in T-minus section"
  - "Non-fatal weather enrichment: catches DB errors, model continues with neutral defaults"

requirements-completed: []

# Metrics
duration: 8min
completed: 2026-03-24
---

# Phase mlb-model-port Plan 04: MLB Weather Overlay Summary

**api.weather.gov weather fetch for 30 MLB stadiums wired end-to-end into projectStrikeouts overlays via mlb_game_weather table and enricher lookup by (game_date, home_team)**

## Performance

- **Duration:** 8 min
- **Started:** 2026-03-24T19:52:20Z
- **Completed:** 2026-03-24T20:00:21Z
- **Tasks:** 4
- **Files modified:** 5

## Accomplishments

- Created `mlb_game_weather` migration with (game_date, home_team) UNIQUE constraint and index
- Implemented `pull_mlb_weather.js` with 30 hardcoded stadium coords, 6-stadium indoor set, api.weather.gov two-step fetch, 500ms delay between venues, and upsert by (game_date, home_team)
- Updated `enrichMlbPitcherData` to query `mlb_game_weather` by (game_date, home_team) and attach wind_mph/temp_f to raw_data.mlb; indoor venues skipped gracefully
- Updated `computeMLBDriverCards` to extract weatherOverlays from raw_data.mlb and pass wind_mph/temp_f into projectStrikeouts for both home and away pitchers
- Registered `queueMlbWeatherBeforeModel` in scheduler T-minus section, queued after pitcher stats and before model run

## Task Commits

1. **Task 1: Migration 041_create_mlb_game_weather.sql** - `462ac4a` (feat)
2. **Task 2: Implement pull_mlb_weather.js** - `ab63bc1` (feat)
3. **Task 3: Update enrichMlbPitcherData + computeMLBDriverCards** - `001fe0c` (feat)
4. **Task 4: Register pull_mlb_weather in scheduler** - `9b659f8` (feat)

## Files Created/Modified

- `packages/data/db/migrations/041_create_mlb_game_weather.sql` - Table DDL with (game_date, home_team) UNIQUE
- `apps/worker/src/jobs/pull_mlb_weather.js` - Weather fetch job, 30 stadium coords, indoor set, api.weather.gov
- `apps/worker/src/jobs/run_mlb_model.js` - enrichMlbPitcherData: weather lookup by (game_date, home_team)
- `apps/worker/src/models/mlb-model.js` - computeMLBDriverCards: pass weatherOverlays to projectStrikeouts
- `apps/worker/src/schedulers/main.js` - queueMlbWeatherBeforeModel + T-minus registration

## Decisions Made

- Used (game_date, home_team) as the lookup key instead of game_id because the odds provider game_id and MLB API gamePk are in different namespaces. home_team is available in both the weather job (schedule response) and the enricher (oddsSnapshot.home_team).
- Indoor/dome stadiums are stored with conditions='INDOOR' and null weather rather than being entirely absent, so the enricher can distinguish "no weather data yet" from "this is an indoor venue, no overlay applies."
- windSpeed "15 mph" is parsed with parseInt which naturally handles the trailing unit string.
- Venues not in STADIUM_COORDS return null gracefully — model falls back to neutral defaults.

## Deviations from Plan

**1. [Rule 1 - Bug] UNIQUE constraint changed from (game_id, game_date) to (game_date, home_team)**
- **Found during:** Task 1 (planning the migration)
- **Issue:** Plan specified UNIQUE(game_id, game_date) but game_id from weather job (mlb_{date}_{gamePk}) would never match game_id from odds provider — making the enricher lookup by game_id impossible to join
- **Fix:** Changed UNIQUE to (game_date, home_team) and added home_team column per the additional_notes recommendation; enricher queries WHERE game_date = ? AND home_team = ?
- **Files modified:** packages/data/db/migrations/041_create_mlb_game_weather.sql
- **Verification:** Dry run exits 0; enricher test with fake snapshot confirms correct lookup path
- **Committed in:** 462ac4a (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 1 - Bug/correctness)
**Impact on plan:** Fix was required for the enricher to function at all — the original UNIQUE key would make the weather lookup a dead letter. No scope creep.

## Issues Encountered

None — all four tasks executed cleanly. Dry run found 10 MLB games for 2026-03-24.

## User Setup Required

None - api.weather.gov is free and requires no API key.

## Self-Check: PASSED

All files present; all task commits verified on working-branch.

## Next Phase Readiness

- Weather overlays are live end-to-end: DB → enricher → raw_data.mlb → projectStrikeouts
- wind_mph > 15 fires +2% projection boost (verified in Node)
- temp_f < 50 fires +2% boost; temp_f > 85 fires -2% reduction
- mlb-05 can proceed; the weather pipeline is complete
