---
phase: quick
plan: 57
subsystem: nhl-player-shots
tags: [pp-rate, rolling-splits, model, ingestion, migration, tdd]
dependency_graph:
  requires: [quick-55 (WI-0530 season pp_rate foundation)]
  provides: [pp_l10_shots_per60, pp_l5_shots_per60 in player_pp_rates, weightedRateBlendPP, PP_SMALL_SAMPLE flag, pp blend drivers]
  affects: [projectSogV2 pp_rate computation, enrichedRawData, card_payloads.drivers]
tech_stack:
  added: [weightedRateBlendPP function, 033_add_pp_rolling_splits.sql migration]
  patterns: [TDD red-green per task, NST CSV column name variant fallback, inline IIFE for blend rate]
key_files:
  created:
    - packages/data/db/migrations/033_add_pp_rolling_splits.sql
  modified:
    - apps/worker/src/jobs/ingest_nst_pp_rates.js
    - apps/worker/src/jobs/pull_nhl_player_shots.js
    - apps/worker/src/models/nhl-player-shots.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/jobs/__tests__/ingest_nst_pp_rates.test.js
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
decisions:
  - "weightedRateBlendPP uses 0.40/0.35/0.25 (season/L10/L5) — distinct from EV blend (0.35/0.35/0.30)"
  - "PP_SMALL_SAMPLE fires only when BOTH L10 AND L5 are null (single null = partial data, not small sample)"
  - "Pull job uses a second DB prepare for L10/L5 to avoid restructuring buildLogRows signature completely"
  - "ppBlendRate computed inline via IIFE in model runner (mirrors weightedRateBlendPP) so drivers is source-of-truth consistent"
  - "NST column name variants tried in order: PPTOI.1/SOG.1/PPTOI.2/SOG.2 first, then named variants"
metrics:
  duration: "~25 minutes"
  completed: "2026-03-20"
  tasks: 2
  files_modified: 6
  files_created: 1
  tests_added: 8
  tests_total: 136
---

# Phase quick Plan 57: WI-0531 Rolling PP Rate Splits (L10/L5) + Recency-Weighted Blend Summary

**One-liner**: L10/L5 PP shot rate splits from NST CSV stored in player_pp_rates, blended into projectSogV2 via weightedRateBlendPP (0.40/0.35/0.25), with PP_SMALL_SAMPLE flag and four driver fields surfaced.

## What Was Built

### Task 1: DB Migration + Extended Ingestion + enrichedRawData

**Migration** (`033_add_pp_rolling_splits.sql`): Two `ALTER TABLE` statements add `pp_l10_shots_per60 REAL` and `pp_l5_shots_per60 REAL` columns to `player_pp_rates` (nullable, no DEFAULT — NULL means not yet ingested).

**ingest_nst_pp_rates.js**: Extended per-row processing to extract L10/L5 columns using four column name variant fallbacks each (NST export naming is inconsistent across report types). Computed rates: `(SOG/PPTOI)*60` when PPTOI > 0, else NULL. Upsert SQL extended to include both new columns. Missing column data results in NULL (not 0).

**pull_nhl_player_shots.js**: `buildLogRows` signature extended with `ppRateL10Per60` / `ppRateL5Per60` params. A second DB prepare fetches the new columns and adds `ppRateL10Per60` / `ppRateL5Per60` to `enrichedRawData`.

**Tests added (3)**: L10/L5 computed from CSV, season-only CSV stores NULL, PPTOI=0 → null.

### Task 2: PP Blend + Model Runner Wiring + PP_SMALL_SAMPLE + Drivers

**nhl-player-shots.js**: Added `weightedRateBlendPP(season, l10, l5)` with weights `[0.40, 0.35, 0.25]`. Null slots excluded and remaining weights renormalized identically to the EV `weightedRateBlend` pattern. `projectSogV2` now uses `weightedRateBlendPP` for `pp_rate` (EV blend unchanged).

**run_nhl_player_shots_model.js**:
- `ppRateL10Per60` / `ppRateL5Per60` extracted from `rawData` (null if absent or non-positive)
- `pp_shots_l10_per60` / `pp_shots_l5_per60` in `projectSogV2` call now pass real L10/L5 rates (not season proxy)
- `PP_SMALL_SAMPLE` flag: fires when `ppRatePer60 !== null && ppRateL10Per60 === null && ppRateL5Per60 === null`
- `ppBlendRate` computed via inline IIFE (mirrors `weightedRateBlendPP`)
- Drivers extended: `pp_season_rate`, `pp_l10_rate`, `pp_l5_rate`, `pp_blend_rate` (rounded to 2dp)

**Tests added (5)**: P (L10/L5 passed, no PP_SMALL_SAMPLE), Q (season-only → PP_SMALL_SAMPLE, no PP_RATE_MISSING), R (L5 present, L10 null → no PP_SMALL_SAMPLE), S (four driver fields present with correct values), T (no season rate → PP_RATE_MISSING, no PP_SMALL_SAMPLE).

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

### Files created:
- `/Users/ajcolubiale/projects/cheddar-logic/packages/data/db/migrations/033_add_pp_rolling_splits.sql` — FOUND

### Commits:
- `8d683be` (Task 1) — FOUND
- `f6689d7` (Task 2) — FOUND

### Test results: 136 passed, 0 failed across 5 test suites.

## Self-Check: PASSED
