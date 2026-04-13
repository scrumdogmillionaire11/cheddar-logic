---
phase: quick-159
plan: "01"
subsystem: settlement
tags: [nhl, settlement, projection-audit, blk, policy]
dependency_graph:
  requires: []
  provides: [isProjectionAuditOnlyBlkRow, PROJECTION_AUDIT_ONLY_BLK auto-close, settlement_policy on nhl-player-blk payloads]
  affects: [settle_pending_cards.js, run_nhl_player_shots_model.js]
tech_stack:
  added: []
  patterns: [explicit-auto-close pattern (PROJECTION_AUDIT_ONLY_BLK), settlement_policy metadata field]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js
    - apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js
decisions:
  - "nhl-player-blk rows in the settlement loop are auto-closed with status=error, result=NO_GRADE, outcome=PROJECTION_AUDIT_ONLY — not silently skipped"
  - "settlement_policy field added to payloads (not just metadata) so the policy is self-documenting at card creation time"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-12"
  tasks_completed: 2
  files_modified: 4
  tests_added: 4
---

# Phase quick-159 Plan 01: WI-0911 NHL Player Blocks Projection-Set Policy Summary

**One-liner:** Explicit PROJECTION_AUDIT_ONLY_BLK auto-close guard in settle_pending_cards + settlement_policy: {grading_eligible: false} on nhl-player-blk payloads, with 4 new tests — 136 total passing.

## Objective

Formalize the nhl-player-blk settlement policy so grading is never attempted (not implicit via missing market_key or fallthrough errors) and the policy is explicit in both runtime behavior and card metadata.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add isProjectionAuditOnlyBlkRow guard in settle_pending_cards.js | 89e8d49 | settle_pending_cards.js, settle_pending_cards.phase2.test.js |
| 2 | Add settlement_policy metadata to nhl-player-blk payloads + settle_projections tests | 66e861d | run_nhl_player_shots_model.js, run_nhl_player_shots_model.test.js |

## What Was Built

### Task 1: isProjectionAuditOnlyBlkRow guard

Added `isProjectionAuditOnlyBlkRow(row)` predicate and `autoCloseBlkProjectionAuditRow(db, row, settledAt)` DB helper to `settle_pending_cards.js`.

The guard fires BEFORE `isProjectionOnlyF5Row` and BEFORE `isNhlShotsOnGoalCard` in the main settlement loop. When triggered it:
- Writes `status=error, result=NO_GRADE, outcome=PROJECTION_AUDIT_ONLY` to `card_results`
- Includes `settlement_error.classification=PROJECTION_AUDIT_ONLY_AUTO_CLOSE` in metadata
- Increments `cardsSettled` (not `cardsSkipped`) — this is an explicit close, not a pass-through
- Respects `dryRun` flag

`isProjectionAuditOnlyBlkRow` is exported in `__private`.

### Task 2: settlement_policy metadata

Added `settlement_policy: { grading_eligible: false, reason: 'PROJECTION_AUDIT_ONLY', market: 'player_blocked_shots' }` to `payloadDataBlk` after `applyNhlDecisionBasisMeta` in `run_nhl_player_shots_model.js`. Same field applied to multi-line extra BLK cards in the loop.

The settle_projections.js nhl-player-blk path is unchanged — it still records `{ blocks: N }` for projection audit.

## Test Results

All three suites green — 136 tests total:

- `settle_pending_cards.phase2` — 29 tests (3 new: isProjectionAuditOnlyBlkRow unit tests)
- `run_nhl_player_shots_model` — 74 tests (1 new: WI-0911 settlement_policy assertion)
- `settle_projections` — 33 tests (0 new — existing nhl-player-blk projection audit tests pass unchanged)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

Files exist:
- apps/worker/src/jobs/settle_pending_cards.js — MODIFIED
- apps/worker/src/jobs/run_nhl_player_shots_model.js — MODIFIED
- apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js — MODIFIED
- apps/worker/src/jobs/__tests__/run_nhl_player_shots_model.test.js — MODIFIED

Commits:
- 89e8d49 — feat(quick-159-01): add isProjectionAuditOnlyBlkRow guard
- 66e861d — feat(quick-159-02): add settlement_policy metadata

## Self-Check: PASSED
