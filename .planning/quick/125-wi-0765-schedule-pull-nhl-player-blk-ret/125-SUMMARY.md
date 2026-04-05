---
phase: quick-125
plan: 01
subsystem: worker/nhl-blk-pipeline
tags: [nhl, blocked-shots, ingest, observability, hardening]
dependency_graph:
  requires: []
  provides: [ingest_nst_blk_rates warn-and-return, NHL_BLK_NST env var docs, blkRateRow null WARN, block_rates_stale missing_inputs]
  affects: [apps/worker/src/jobs/ingest_nst_blk_rates.js, apps/worker/src/jobs/run_nhl_player_shots_model.js, env.example]
tech_stack:
  added: []
  patterns: [warn-and-return on missing config, hoisted staleness check, missing_inputs card field]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/ingest_nst_blk_rates.js
    - apps/worker/src/jobs/__tests__/ingest_nst_blk_rates.test.js
    - env.example
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
decisions:
  - Staleness query hoisted outside player loop (single DB call per model run, not N calls per player)
  - missing_inputs appended to payloadDataBlk before applyNhlDecisionBasisMeta so it is carried through to the stored card
metrics:
  duration: ~8 minutes
  completed: "2026-04-04T22:17:55Z"
  tasks_completed: 2
  files_modified: 4
---

# Phase quick-125 Plan 01: NHL Blocked-Shot Pipeline Hardening Summary

**One-liner:** Warn-and-return on absent NST CSV env vars, per-player null WARN in shots model, and card-level `missing_inputs: ['block_rates_stale']` when block-rate data is older than 8 days.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Harden ingest_nst_blk_rates + document env vars | 72ccb5b | ingest_nst_blk_rates.js, ingest_nst_blk_rates.test.js, env.example |
| 2 | Add blkRateRow null WARN + staleness guard to shots model | 62ac8ad | run_nhl_player_shots_model.js |

## What Was Built

### Task 1 — ingest_nst_blk_rates hardening (TDD)

- **Before:** Missing `NHL_BLK_NST_*_CSV_URL` env vars caused `ingestNstBlkRates` to throw, resulting in a job crash (non-zero exit).
- **After:** Replaced `throw` with `console.warn(...)` + `return { inserted: 0, skipped: 0, error: 'missing_urls' }`. Job exits 0 with a clear warning message.
- **Test added:** `returns missing_urls when URL env vars are absent` — verifies the function resolves (does not reject) and returns the expected shape without calling `upsertPlayerBlkRates`.
- **env.example:** Added three commented-out `NHL_BLK_NST_SEASON_CSV_URL / L10 / L5` entries with cadence comment below `ENABLE_NHL_BLK_INGEST`.

### Task 2 — shots model observability

- **Hoisted staleness check:** One `MAX(updated_at)` query on `player_blk_rates` is executed once before the games loop (not per-player). `blkRatesStale = true` if no rows exist or if the newest row is older than 8 days.
- **Per-player WARN:** After fetching `blkRateRow`, logs `[run-nhl-player-shots-model] WARN: no player_blk_rates row for player {id} season {key} — BLK mu will be 0` when the row is absent.
- **Card-level flag:** When `blkRatesStale` is true, `payloadDataBlk.missing_inputs = ['block_rates_stale']` is set before `applyNhlDecisionBasisMeta`.

## Verification

All plan-specified verification checks pass:

- `ingest_nst_blk_rates.test.js` — 3 tests pass (parseCsv, missing-URL path, season/l10/l5 merge)
- `run_nhl_player_shots_model.test.js` — 71 tests pass
- `grep "NHL_BLK_NST_SEASON_CSV_URL" env.example` — 1 match
- `grep "missing_urls" ingest_nst_blk_rates.js` — 1 match (no throw)
- `grep "block_rates_stale" run_nhl_player_shots_model.js` — 1 match
- `grep "no player_blk_rates row" run_nhl_player_shots_model.js` — 1 match
- `grep "pullNhlPlayerBlk" player-props.js` — 3 hits (scheduler registration confirmed, WI-0765 guard satisfied)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- [x] `apps/worker/src/jobs/ingest_nst_blk_rates.js` — modified
- [x] `apps/worker/src/jobs/__tests__/ingest_nst_blk_rates.test.js` — modified
- [x] `env.example` — modified
- [x] `apps/worker/src/jobs/run_nhl_player_shots_model.js` — modified
- [x] Commit 72ccb5b exists
- [x] Commit 62ac8ad exists
