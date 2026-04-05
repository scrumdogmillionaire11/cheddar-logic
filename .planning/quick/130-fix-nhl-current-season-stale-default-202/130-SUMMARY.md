---
phase: quick-130
plan: "01"
subsystem: worker/jobs
tags: [nhl, season-key, ingest, env]
key-files:
  modified:
    - apps/worker/src/jobs/ingest_nst_blk_rates.js
    - apps/worker/src/jobs/pull_nhl_player_shots.js
    - .env.production
decisions:
  - "Used existing deriveNhlSeasonKey() from pull_moneypuck_blk_rates.js as the fallback — no duplication of season logic"
  - ".env.production is gitignored; file updated on disk only (correct — secrets file should not be in VCS)"
metrics:
  completed: "2026-04-05"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 3
---

# Quick Task 130: Fix NHL Current Season Stale Default (20242025 -> 20252026) Summary

**One-liner:** Replaced hardcoded '20242025' season fallbacks in two ingest jobs with `deriveNhlSeasonKey()` from pull_moneypuck_blk_rates.js and pinned `NHL_CURRENT_SEASON=20252026` in `.env.production`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Replace stale '20242025' fallbacks in both job files | b8567fd | ingest_nst_blk_rates.js, pull_nhl_player_shots.js |
| 2 | Pin NHL_CURRENT_SEASON=20252026 in .env.production | (gitignored — disk only) | .env.production |

## Changes Made

### Task 1: Job File Fallback Fix

**ingest_nst_blk_rates.js**
- Added `const { deriveNhlSeasonKey } = require('./pull_moneypuck_blk_rates');` after the existing require line
- Changed default param: `season = process.env.NHL_CURRENT_SEASON || '20242025'` → `season = process.env.NHL_CURRENT_SEASON || deriveNhlSeasonKey()`

**pull_nhl_player_shots.js**
- Added `const { deriveNhlSeasonKey } = require('./pull_moneypuck_blk_rates');` after the `@cheddar-logic/data` require block
- Replaced both `process.env.NHL_CURRENT_SEASON || '20242025'` occurrences (lines 396 and 412, currentSeason and currentSeason2) with `process.env.NHL_CURRENT_SEASON || deriveNhlSeasonKey()`

### Task 2: .env.production Pin

Added after the `TZ=America/New_York` / `FIXED_CATCHUP=true` block:

```
# ----------------------------------
# NHL Season
# ----------------------------------
NHL_CURRENT_SEASON=20252026
```

Note: `.env.production` is gitignored and was not committed. The file was updated on disk only. This is correct behavior — the production env file contains secrets and must not be tracked in VCS.

## Verification

- `grep -n "20242025" apps/worker/src/jobs/ingest_nst_blk_rates.js apps/worker/src/jobs/pull_nhl_player_shots.js` → no output (CLEAN)
- `grep "NHL_CURRENT_SEASON=20252026" .env.production` → exits 0
- All 3 targeted test suites: **40/40 tests pass**
  - `ingest_nst_blk_rates` — 3/3
  - `pull_nhl_player_shots` — 33/33
  - `run-nhl-player-shots-model` — 4/4

## Deviations from Plan

None — plan executed exactly as written, except that `.env.production` was not committed because it is correctly gitignored. The file is updated on disk for the production deployment.

## Work Items

- WI-0798 moved to `WORK_QUEUE/COMPLETE/WI-0798.md`

## Self-Check: PASSED

- [x] `apps/worker/src/jobs/ingest_nst_blk_rates.js` — modified, committed in b8567fd
- [x] `apps/worker/src/jobs/pull_nhl_player_shots.js` — modified, committed in b8567fd
- [x] `.env.production` — updated on disk; gitignored (not committed — expected)
- [x] `WORK_QUEUE/COMPLETE/WI-0798.md` — exists
- [x] b8567fd commit exists in git log
- [x] No '20242025' literals remain in either job file
