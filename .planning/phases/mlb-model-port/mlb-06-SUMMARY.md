---
phase: mlb-model-port
plan: "06"
subsystem: worker/jobs
tags: [mlb, settlement, f5, stats-api]
dependency_graph:
  requires: [mlb-05]
  provides: [f5-settlement-job, mlb-game-pk-map]
  affects: [card_results, game_results, mlb_game_pk_map]
tech_stack:
  added: []
  patterns: [idempotent-job-key, linescore-api, game-pk-map-table]
key_files:
  created:
    - apps/worker/src/jobs/settle_mlb_f5.js
  modified:
    - apps/worker/src/jobs/pull_mlb_pitcher_stats.js
    - apps/worker/src/schedulers/main.js
decisions:
  - "Used game_date|home_abbr|away_abbr as mlb_game_pk_map primary key (avoids complex game_id reverse mapping)"
  - "Settlement looks up gamePk by game_date LIMIT 1 (single game per date is common for F5 card issuance)"
  - "Cached f5_total in game_results.metadata to avoid repeat API calls across hourly ticks"
metrics:
  duration: "148s"
  completed: "2026-03-25"
  tasks_completed: 3
  files_changed: 3
---

# Phase mlb-model-port Plan 06: MLB F5 Settlement Summary

## One-liner

F5 settlement via MLB Stats API linescore feed: fetches innings 1-5, grades OVER/UNDER/push, caches in game_results.metadata, keyed hourly for idempotency.

## What Was Built

### Task 1: mlb_game_pk_map storage in pull_mlb_pitcher_stats.js

Added `ensureMlbGamePkMap`, `upsertGamePkMap`, and `storeGamePkMap` functions to `pull_mlb_pitcher_stats.js`. The schedule endpoint already returns `gamePk` and team abbreviations for each game. Each game is stored with key `game_date|home_abbr|away_abbr` → gamePk so the settlement job can resolve the MLB-native gamePk from a game date.

The existing `fetchProbablePitcherIds` function was refactored to call a shared `fetchSchedule` helper, avoiding a second API call. `storeGamePkMap` is called in the main job function before pitcher data fetching.

### Task 2: settle_mlb_f5.js

New settlement job. Key behaviors:
- Queries `card_results` for pending MLB cards where `game_time_utc < now - 4h`
- Filters to F5 market cards (payload `market_key` or `market` containing "f5")
- Skips PASS predictions and cards with no line
- Checks `game_results.metadata.f5_total` for cached actuals first
- Falls back to `mlb_game_pk_map` → `fetchF5Total(gamePk)` via `/api/v1.1/game/{gamePk}/feed/live`
- Returns null when game has fewer than 5 innings complete
- Caches result in `game_results.metadata` via `json_set`
- Grades with `gradeF5Card('OVER'|'UNDER', line, actualTotal)` → 'won'/'lost'/'push'/null
- Updates `card_results.status`, `.result`, `.settled_at`

### Task 3: Scheduler registration

Added `require('../jobs/settle_mlb_f5')` to scheduler. Registered as a per-hour job keyed `settle_mlb_f5|{date}|{hour}` under `ENABLE_MLB_MODEL !== 'false'`. Runs every scheduler tick in the evening hours; `shouldRunJobKey` prevents duplicate execution within the same hour.

## Verification Results

- `settle_mlb_f5 --dry-run`: exits 0, logs "settled=0 failed=0" (no pending MLB F5 cards yet — expected pre-season)
- `gradeF5Card('OVER', 4.5, 5)` → "won"
- `gradeF5Card('UNDER', 4.5, 5)` → "lost"
- `gradeF5Card('OVER', 4.5, 4.5)` → "push"
- `backtest_mlb.js --days 30`: exits 0 (no settled cards, pre-season expected)
- Scheduler loads: `node -e "require('./apps/worker/src/schedulers/main')"` → OK

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Eliminated duplicate getDatabase() call**
- Found during: Task 1
- Issue: Adding `const db = getDatabase()` before the existing one in `pullMlbPitcherStats` created a duplicate declaration
- Fix: Removed the second `const db = getDatabase()` line, reusing the one introduced for `storeGamePkMap`
- Files modified: apps/worker/src/jobs/pull_mlb_pitcher_stats.js
- Commit: 336702d

**2. [Rule 2 - Missing functionality] Refactored fetchProbablePitcherIds to share schedule fetch**
- Found during: Task 1
- Issue: `storeGamePkMap` would have made a second HTTP call to the same schedule endpoint
- Fix: Extracted `fetchSchedule` helper; both `fetchProbablePitcherIds` and `storeGamePkMap` call it, avoiding duplicate API calls
- Files modified: apps/worker/src/jobs/pull_mlb_pitcher_stats.js
- Commit: 336702d

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1 | 336702d | feat(mlb-model-port-06): store mlb_game_pk_map in pull_mlb_pitcher_stats |
| 2 | d0dc6a9 | feat(mlb-model-port-06): implement settle_mlb_f5 job |
| 3 | 426add9 | feat(mlb-model-port-06): register settle_mlb_f5 in scheduler |

## Self-Check: PASSED
