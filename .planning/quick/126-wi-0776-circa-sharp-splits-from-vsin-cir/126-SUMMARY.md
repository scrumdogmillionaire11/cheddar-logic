---
phase: quick-126
plan: 01
subsystem: data-pipeline / odds / model-payloads
tags: [circa, vsin, splits, sharp-money, nhl-model, nba-model, migration]
dependency_graph:
  requires: [WI-0776, migration-058, pull_vsin_splits, updateOddsSnapshotVsinSplits]
  provides: [migration-059, updateOddsSnapshotCircaSplits, circa-fetch-pass, sharp_divergence-field]
  affects: [odds_snapshots table, pull_vsin_splits job, run_nhl_model, run_nba_model]
tech_stack:
  added: []
  patterns: [soft-fail CIRCA fetch pass, sharp-vs-public IIFE signal]
key_files:
  created:
    - packages/data/db/migrations/059_add_circa_splits_to_odds_snapshots.sql
  modified:
    - packages/data/src/db/odds.js
    - packages/data/src/db/index.js
    - apps/worker/src/jobs/pull_vsin_splits.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/jobs/run_nba_model.js
decisions:
  - No circa_captured_at column — CIRCA fetch shares vsin_captured_at from DK pass; no separate timestamp needed
  - CIRCA pass wrapped in outer try/catch so any failure returns success:true (DK result unaffected)
  - sharp_divergence uses circa_handle_pct_home vs dk_bets_pct_home (sharp handle vs public ticket action)
  - 10-19 diff range emits null (inconclusive) rather than a weak signal label
metrics:
  duration: "~10 minutes"
  completed: "2026-04-04"
  tasks_completed: 2
  files_changed: 6
requirements: [WI-0776]
---

# Phase quick-126 Plan 01: Circa Sharp Splits from VSIN Summary

**One-liner:** Circa Sports sharp-money splits pipeline — migration 059, updateOddsSnapshotCircaSplits DB writer, soft-fail CIRCA fetch pass in pull_vsin_splits, and sharp_divergence signal wired into all five NHL/NBA model payload sites.

## What Was Built

### Task 1: Migration 059 + updateOddsSnapshotCircaSplits + export

- Created `packages/data/db/migrations/059_add_circa_splits_to_odds_snapshots.sql` adding 4 `circa_*` REAL columns with DEFAULT NULL to `odds_snapshots` (circa_handle_pct_home, circa_handle_pct_away, circa_tickets_pct_home, circa_tickets_pct_away). No separate `circa_captured_at` — shares `vsin_captured_at` from the DK pass.
- Added `updateOddsSnapshotCircaSplits({ gameId, circaData })` to `packages/data/src/db/odds.js` immediately after `updateOddsSnapshotVsinSplits`, mirroring its exact structure. Updates the most-recent odds_snapshot for a game via subquery.
- Exported from `odds.js` module.exports and re-exported from `packages/data/src/db/index.js`.

### Task 2: CIRCA fetch pass in pull_vsin_splits + sharp_divergence in NHL/NBA models

- Added `updateOddsSnapshotCircaSplits` to the destructured require in `pull_vsin_splits.js`.
- Added a second independent CIRCA fetch pass after the DK write loop, entirely wrapped in try/catch (soft-fail). On any failure (fetch error, parse error, DB error) the job continues and returns `success: true`. The CIRCA pass uses `fetchSplitsHtml({ source: 'CIRCA' })`, `parseSplitsHtml(..., 'CIRCA')`, and `matchSplitsToGameId` — same adapter utilities as the DK pass.
- Field mapping: VSIN's `public_handle_pct_home/away` → `circa_handle_pct_*`; `public_bets_pct_home/away` → `circa_tickets_pct_*`.
- Job return extended with `circaTotalWritten` and `circaSportStats` (additive — DK return fields unchanged).
- Added `sharp_divergence` IIFE after `splits_divergence` in all three NHL payload sites (TOTAL ~line 1093, SPREAD ~line 1262, ML ~line 1439) and both NBA payload sites (TOTAL ~line 868, SPREAD ~line 1043).
- Signal logic: `|circa_handle_pct_home - dk_bets_pct_home| >= 20` → `'SHARP_VS_PUBLIC'`; `< 10` → `'SHARP_ALIGNED'`; 10-19 range or either source null → `null`.

## Verification Results

- Migration file present: confirmed
- `typeof updateOddsSnapshotCircaSplits` → `function`
- `node --check` passes on pull_vsin_splits.js, run_nhl_model.js, run_nba_model.js
- `grep -c updateOddsSnapshotVsinSplits pull_vsin_splits.js` → 3 (DK path unaffected)
- `grep -c sharp_divergence run_nhl_model.js` → 3 (TOTAL, SPREAD, ML)
- `grep -c sharp_divergence run_nba_model.js` → 2 (TOTAL, SPREAD)
- Adapter tests: 209 passed, 0 failed

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Task | Commit  | Message |
|------|---------|---------|
| 1    | 70c8f43 | feat(quick-126): migration 059 + updateOddsSnapshotCircaSplits + export |
| 2    | cea1631 | feat(quick-126): CIRCA fetch pass in pull_vsin_splits + sharp_divergence in NHL/NBA models |

## Self-Check: PASSED
