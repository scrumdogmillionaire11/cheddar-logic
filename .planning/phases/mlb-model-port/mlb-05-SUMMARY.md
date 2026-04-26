---
phase: mlb-model-port
plan: "05"
subsystem: mlb-data-pipeline
tags: [mlb, pitcher-stats, game-logs, backtest, walk-forward]
dependency_graph:
  requires: [mlb-04]
  provides: [mlb_pitcher_game_logs, computePitcherStatsAsOf, backtest_mlb]
  affects: [pull_mlb_pitcher_stats, mlb-model]
tech_stack:
  added: []
  patterns: [walk-forward-backtest, anti-look-ahead, raw-game-log-storage]
key_files:
  created:
    - packages/data/db/migrations/042_create_mlb_pitcher_game_logs.sql
    - scripts/backtest_mlb.js
  modified:
    - apps/worker/src/jobs/pull_mlb_pitcher_stats.js
    - apps/worker/src/models/mlb-model.js
decisions:
  - "Remove require('dotenv') from backtest script — scripts/ convention relies on env vars set by shell, not dotenv (consistent with audit-lineage.js)"
metrics:
  duration: "~3 minutes"
  completed: "2026-03-24"
  tasks_completed: 4
  tasks_total: 4
  files_created: 2
  files_modified: 2
---

# Phase mlb-model-port Plan 05: Pitcher Game Logs and Walk-Forward Backtest Summary

One-liner: Raw per-start pitcher game logs stored to SQLite with computePitcherStatsAsOf() walk-forward helper and standalone backtest script replaying model against settled cards.

## What Was Built

This plan closes Gap 2 from the MLB model port: the JS side now has the same walk-forward capability as the Python backtest engine. Raw game logs are persisted to `mlb_pitcher_game_logs`, and `computePitcherStatsAsOf()` queries them with a strict `game_date < asOfDate` filter to prevent any look-ahead bias.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Migration 042_create_mlb_pitcher_game_logs.sql | 95a8835 | packages/data/db/migrations/042_create_mlb_pitcher_game_logs.sql |
| 2 | Update pull_mlb_pitcher_stats.js to store raw game logs | 81961b1 | apps/worker/src/jobs/pull_mlb_pitcher_stats.js |
| 3 | Add computePitcherStatsAsOf to mlb-model.js | 45b89d2 | apps/worker/src/models/mlb-model.js |
| 4 | Create scripts/backtest_mlb.js | 123e67b | scripts/backtest_mlb.js |

## Verification Results

- `node apps/worker/src/jobs/pull_mlb_pitcher_stats.js --dry-run` exits 0, migration 042 applied
- `node -e "const {computePitcherStatsAsOf}=require('./apps/worker/src/models/mlb-model'); console.log(typeof computePitcherStatsAsOf)"` → `function`
- `node scripts/backtest_mlb.js --days 30` runs without crash, prints "No settled MLB cards found" (expected early in season)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Removed dotenv dependency from backtest script**
- **Found during:** Task 4
- **Issue:** `require('dotenv')` threw MODULE_NOT_FOUND — dotenv is installed in `apps/worker/node_modules` but not at repo root
- **Fix:** Replaced with a comment documenting the scripts/ convention (same as audit-lineage.js): rely on CHEDDAR_DB_PATH being set in the calling environment
- **Files modified:** scripts/backtest_mlb.js
- **Commit:** 123e67b (included in task commit)

## Key Design Decisions

1. **`fetchPitcherRecentStats` now returns `allSplits`** — The full season game log splits pass through `fetchAllPitcherData` to the main job, so all raw starts are written to `mlb_pitcher_game_logs`. The existing `mlb_pitcher_stats` upsert still uses only the last 5 for `recent_k_per_9`.

2. **`ensureGameLogsTable` called inline from `upsertGameLogs`** — Follows the same pattern as `ensurePitcherStatsTable` → `upsertPitcherRows`.

3. **`computePitcherStatsAsOf` takes a `db` parameter** — Keeps mlb-model.js dependency-free at module load time; the backtest script and any future caller passes the DB instance explicitly.

## Self-Check: PASSED

- packages/data/db/migrations/042_create_mlb_pitcher_game_logs.sql: FOUND
- scripts/backtest_mlb.js: FOUND
- Commit 95a8835 (Task 1): FOUND
- Commit 81961b1 (Task 2): FOUND
- Commit 45b89d2 (Task 3): FOUND
- Commit 123e67b (Task 4): FOUND
