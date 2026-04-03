---
phase: quick
plan: 118
subsystem: worker/data
tags: [settlement, projection, nhl, mlb, sqlite, worker-job]
dependency_graph:
  requires: [WI-0755, settle_mlb_f5.js, nhl-settlement-source.js]
  provides: [actual_result column, setProjectionActualResult, getUnsettledProjectionCards, settle_projections job]
  affects: [card_payloads table, @cheddar-logic/data exports, worker scheduler]
tech_stack:
  added: []
  patterns: [ensureColumn guard (PRAGMA table_info + ALTER TABLE), withDb + insertJobRun/markJobRunSuccess/markJobRunFailure pattern, game_id_map NHL ID resolution]
key_files:
  created:
    - apps/worker/src/jobs/settle_projections.js
  modified:
    - packages/data/src/db/cards.js
    - packages/data/src/db/index.js
    - packages/data/index.js
    - apps/worker/src/schedulers/main.js
    - WORK_QUEUE/COMPLETE/WI-0757.md
decisions:
  - "getUnsettledProjectionCards omits nhl_game_id from SELECT (column may not exist on games table); job resolves NHL ID via game_id_map at runtime"
  - "NHL ID resolution: game_id_map WHERE provider IN ('nhl','nhl_api','nhl_gamecenter') first, fallback to pure-numeric game_id (mirrors settle_game_results.js resolveNhlGamecenterId)"
  - "settle_projections registered unconditionally (no ENABLE_* flag guard) matching the post-game settlement window alongside settle_mlb_f5; can be flag-gated later if needed"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-03"
  tasks_completed: 2
  files_changed: 5
---

# Quick Task 118: Actual Result Ingestion for Projection Cards (WI-0757) Summary

**One-liner:** Idempotent `actual_result` column + `setProjectionActualResult`/`getUnsettledProjectionCards` DB functions + `settle_projections` worker job writing `{"goals_1p": N}` for nhl-pace-1p and `{"runs_f5": N}` for mlb-f5 cards after games complete.

## Objective

Add the storage layer and worker job needed to record actual game outcomes against projection-only cards (`nhl-pace-1p`, `mlb-f5`), enabling future MAE tracking and HIT/MISS grading.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add actual_result column and DB functions | c2e56d8 | packages/data/src/db/cards.js, packages/data/src/db/index.js, packages/data/index.js |
| 2 | Create settle_projections.js and register in scheduler | e62a240 | apps/worker/src/jobs/settle_projections.js, apps/worker/src/schedulers/main.js |

## Verification Results

- `typeof d.setProjectionActualResult === 'function'` — PASS
- `typeof d.getUnsettledProjectionCards === 'function'` — PASS
- `PRAGMA table_info(card_payloads)` includes `actual_result` — PASS
- `node settle_projections.js --dry-run` exits 0, `settled=0 skipped=100` — PASS
- `grep -r setProjectionActualResult web/ --include="*.ts" --include="*.tsx" --include="*.js"` — 0 matches (single-writer contract PASS)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing functionality] getUnsettledProjectionCards omits nhl_game_id from SELECT**

- **Found during:** Task 1 — plan spec included `g.nhl_game_id` in the SELECT but the `games` table does not have this column (confirmed via PRAGMA output showing only: id, sport, game_id, home_team, away_team, game_time_utc, status, created_at, updated_at).
- **Fix:** Removed `g.nhl_game_id` from the query. The settle_projections job resolves the NHL ID at runtime via `game_id_map` (same pattern as `settle_game_results.js`).
- **Files modified:** packages/data/src/db/cards.js
- **Commit:** c2e56d8

## Self-Check: PASSED

- apps/worker/src/jobs/settle_projections.js — FOUND
- packages/data/src/db/cards.js — FOUND
- WORK_QUEUE/COMPLETE/WI-0757.md — FOUND
- commit c2e56d8 — FOUND
- commit e62a240 — FOUND
