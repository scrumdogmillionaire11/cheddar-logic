---
phase: mlb-model-port
plan: 01
subsystem: database
tags: [mlb, sqlite, migrations, worker-jobs, statsapi]

# Dependency graph
requires: []
provides:
  - mlb_pitcher_stats SQLite table with idempotent DDL (migration 040)
  - pull_mlb_pitcher_stats ingest job fetching probable pitchers from statsapi.mlb.com
  - recent_k_per_9 and recent_ip pre-computed from last 5 game log starts
affects: [mlb-model-port-02, any MLB model layer that reads mlb_pitcher_stats]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ensurePitcherStatsTable inline DDL pattern (same as ensureTeamStatsTable in NHL job)"
    - "fetchProbablePitcherIds deduplicates pitcher IDs from home+away across all games"
    - "Promise.all per-pitcher fetch with per-pitcher .catch to guard missing stats"

key-files:
  created:
    - packages/data/db/migrations/040_create_mlb_pitcher_stats.sql
    - apps/worker/src/jobs/pull_mlb_pitcher_stats.js
  modified: []

key-decisions:
  - "Migration 040 is DDL-only (CREATE IF NOT EXISTS); no down migration provided per plan spec"
  - "Season hardcoded to 2026 constant in job; configurable via --date flag for schedule endpoint"
  - "fetchAllPitcherData does 3 parallel fetches per pitcher (info, seasonStats, gameLog); outer Promise.all per pitcher ID"
  - "Missing/null stats stored gracefully as null — no throws for pitchers with no 2026 data yet"

patterns-established:
  - "MLB Stats API base: https://statsapi.mlb.com/api/v1 with user-agent cheddar-logic-worker"
  - "Probable pitchers: /schedule?sportId=1&date=YYYY-MM-DD&hydrate=probablePitcher(note),team"
  - "Season stats path: stats[0].splits[0].stat; gameLog path: stats[0].splits (last 5 entries)"

requirements-completed: []

# Metrics
duration: 2min
completed: 2026-03-24
---

# Phase mlb-model-port Plan 01: MLB Pitcher Stats Ingest Summary

**SQLite migration + worker job that fetches today's probable pitchers from statsapi.mlb.com, pre-computes recent_k_per_9 from last 5 starts, and upserts to mlb_pitcher_stats table**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-03-24T19:17:43Z
- **Completed:** 2026-03-24T19:19:22Z
- **Tasks:** 2 of 2
- **Files modified:** 2

## Accomplishments
- Migration 040 creates mlb_pitcher_stats table with correct schema (id, mlb_id UNIQUE, era, whip, k_per_9, innings_pitched, recent_k_per_9, recent_ip, updated_at) — idempotent, applied cleanly
- pull_mlb_pitcher_stats.js fetches probable pitcher IDs from MLB schedule endpoint, parallel-fetches per-pitcher season stats + game log, upserts via ON CONFLICT(mlb_id)
- Dry-run verified live against API — 17 probable pitchers found for 2026-03-24, exits 0

## Task Commits

Each task was committed atomically:

1. **Task 1: Write migration 040_create_mlb_pitcher_stats.sql** - `3b10076` (feat)
2. **Task 2: Implement pull_mlb_pitcher_stats.js** - `757210e` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `packages/data/db/migrations/040_create_mlb_pitcher_stats.sql` - Idempotent DDL for mlb_pitcher_stats + idx_mlb_pitcher_stats_mlb_id
- `apps/worker/src/jobs/pull_mlb_pitcher_stats.js` - Ingest job: probable pitchers, season + recent stats, upsert, withDb/insertJobRun pattern

## Decisions Made
- Migration is DDL-only with no down migration (plan spec)
- Season 2026 hardcoded as constant; date is configurable via --date flag
- Three parallel fetches per pitcher (info, season stats, game log) using Promise.all, with per-pitcher .catch so one failed pitcher does not abort the batch
- k_per_9 computed as strikeOuts / inningsPitched * 9; null propagated if IP is 0 or missing

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- better-sqlite3 not available at root node_modules but available at packages/data/node_modules — used that path for in-process migration verification. Not a code issue; dry-run against live DB confirmed migration applied cleanly.

## User Setup Required
None - no external service configuration required. statsapi.mlb.com is a free public API, no auth key needed.

## Next Phase Readiness
- mlb_pitcher_stats table exists and is populated on dry-run (17 pitchers for 2026-03-24)
- pull_mlb_pitcher_stats job ready to wire into scheduler
- Model layer (mlb-model-port-02+) can now read mlb_pitcher_stats synchronously

---
*Phase: mlb-model-port*
*Completed: 2026-03-24*

## Self-Check: PASSED
- packages/data/db/migrations/040_create_mlb_pitcher_stats.sql: FOUND
- apps/worker/src/jobs/pull_mlb_pitcher_stats.js: FOUND
- .planning/phases/mlb-model-port/mlb-01-SUMMARY.md: FOUND
- commit 3b10076: FOUND
- commit 757210e: FOUND
