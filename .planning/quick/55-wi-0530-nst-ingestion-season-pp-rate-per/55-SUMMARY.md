---
phase: quick
plan: 55
subsystem: nhl-model
tags: [nhl, power-play, model, ingestion, projectSogV2]
dependency_graph:
  requires: [WI-0528]
  provides: [WI-0531, WI-0532]
  affects: [run_nhl_player_shots_model, projectSogV2, pull_nhl_player_shots]
tech_stack:
  added: [ingest_nst_pp_rates.js, 032_create_player_pp_rates.sql]
  patterns: [NST CSV ingestion, PP sanity cap, DB enrichment in job loop]
key_files:
  created:
    - packages/data/db/migrations/032_create_player_pp_rates.sql
    - apps/worker/src/jobs/ingest_nst_pp_rates.js
    - apps/worker/src/jobs/__tests__/ingest_nst_pp_rates.test.js
  modified:
    - apps/worker/src/jobs/pull_nhl_player_shots.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/models/nhl-player-shots.js
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
    - apps/worker/src/models/__tests__/nhl-player-shots-two-stage.test.js
    - apps/worker/src/jobs/__tests__/pull_nhl_player_shots.test.js
decisions:
  - "Used ppRatePer60 for all three pp_shots slots (season/l10/l5) — avoids LOW_SAMPLE false flag until WI-0531 adds real rolling splits"
  - "PP_RATE_MISSING only emitted when ppToi > 0 — non-PP players (ppToi=0) don't need a missing-rate flag"
  - "PP cap fraction 0.45 matches plan spec — prevents NST outlier rates from dominating elite PP player projections"
  - "parseCsv written inline (no dependency on csv-parse) — NST CSVs are simple enough that a minimal parser suffices"
metrics:
  duration: ~25 minutes
  completed: 2026-03-20
  tasks: 2
  files: 9
---

# Phase Quick Plan 55: WI-0530 NST Ingestion + Season PP Rate Wiring Summary

**One-liner:** NST CSV ingestion into player_pp_rates (pp_shots_per60 derived from SOG/PPTOI) + rawData enrichment + projectSogV2 wiring + 45% PP contribution cap with PP_CONTRIBUTION_CAPPED flag.

## What Was Built

**Task 1 — DB migration + ingest_nst_pp_rates.js + enrichedRawData ppRatePer60**

- `032_create_player_pp_rates.sql`: New migration with `(nhl_player_id TEXT, season TEXT)` composite PK, `pp_shots_per60 REAL NOT NULL`, and index. Runs in filename sort order after 031.
- `ingest_nst_pp_rates.js`: Accepts `--file path/to/nst.csv [--season 20242025]`. Parses NST CSV format: extracts Player, PlayerID, Team, PPTOI, SOG columns. Derives `pp_shots_per60 = (SOG / PPTOI) * 60`. Skips rows where PPTOI <= 0 (non-PP players logged at debug level). Upserts via `INSERT OR REPLACE`. Exports `{ ingestNstPpRates, parseCsv }` for testing.
- `pull_nhl_player_shots.js`: Added `getDatabase` import. In the player processing loop, queries `player_pp_rates` for the player's ID + current season. Passes result as `ppRatePer60` parameter to `buildLogRows`. Added `ppRatePer60` field to `enrichedRawData` (null if player absent from table).

**Task 2 — Wire pp_rate_per60 into projectSogV2 + 45% PP cap + flags**

- `run_nhl_player_shots_model.js`:
  - Extends rawData extraction to read `rawData.ppRatePer60`; treats 0 same as null (only positive rates are meaningful).
  - Replaces hardcoded `pp_shots_season_per60: 0` with `ppRatePer60` (null if absent). L10 and L5 slots also use `ppRatePer60` as proxy until WI-0531 adds rolling splits.
  - After `projectSogV2` call: pushes `PP_RATE_MISSING` to `v2Projection.flags` when `ppRatePer60 === null && ppToi > 0`.
  - Adds `pp_rate_per60: ppRatePer60` to `payloadData.drivers` for audit/debugging.
- `nhl-player-shots.js` (projectSogV2):
  - Splits single-line `raw_sog_mu` into separate `ev_component` and `pp_component`.
  - Applies 45% cap: when `pp_component > 0.45 * raw_sog_mu && raw_sog_mu > 0`, pushes `PP_CONTRIBUTION_CAPPED` to flags and solves for capped PP component: `pp_capped = 0.45 * ev_component / 0.55`.

## Tests

| Test Suite | New Tests | Total Passing |
|-----------|-----------|---------------|
| ingest_nst_pp_rates.test.js | 11 | 11 |
| pull_nhl_player_shots.test.js | 2 (WI-0530) | 28 |
| run_nhl_player_shots_model.test.js | 4 (I,J,K,O) | 39 |
| nhl-player-shots-two-stage.test.js | 4 (L,M,N + invariant) | 29 |
| **Total** | **21** | **128** |

All 128 tests pass, zero regressions.

## Deviations from Plan

None — plan executed exactly as written.

## Must-Haves Verification

- [x] NST CSV can be parsed into player_pp_rates rows via ingest_nst_pp_rates.js
- [x] pull_nhl_player_shots.js reads pp_rate_per60 from player_pp_rates by player_id and surfaces it in enrichedRawData
- [x] run_nhl_player_shots_model.js passes pp_rate_per60 to projectSogV2 as pp_shots_season_per60 (replacing hardcoded 0)
- [x] PP-heavy player with pp_rate_per60 > 0 and ppToi > 0 produces higher sog_mu than same player with pp_rate = 0
- [x] Player missing from player_pp_rates gets PP_RATE_MISSING flag — not a fake rate
- [x] PP contribution component (pp_rate * toi_proj_pp / 60) capped at 45% of total sog_mu
- [x] PP_CONTRIBUTION_CAPPED flag pushed to flags[] when cap activates

## Self-Check: PASSED

All artifacts found, all commits verified.

| Item | Status |
|------|--------|
| 032_create_player_pp_rates.sql | FOUND |
| ingest_nst_pp_rates.js | FOUND |
| ingest_nst_pp_rates.test.js | FOUND |
| Task 1 commit 069febd | FOUND |
| Task 2 commit 398aa08 | FOUND |
| 128 tests passing | VERIFIED |
