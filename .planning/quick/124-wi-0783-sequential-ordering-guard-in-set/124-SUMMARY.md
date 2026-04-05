---
phase: quick
plan: 124
subsystem: settlement-pipeline
tags: [settlement, job-ordering, sequential-guard, card-settlement, projection-settlement]
dependency_graph:
  requires: [job_runs table with hasSuccessfulJobRun, WI-0783]
  provides: [sequential ordering guard in settle_pending_cards, sequential ordering guard in settle_projections]
  affects: [settle_pending_cards, settle_projections, settlement pipeline scheduling]
tech_stack:
  added: []
  patterns: [prerequisite-guard via hasSuccessfulJobRun, sibling-key derivation from jobKey]
key_files:
  modified:
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/settle_projections.js
    - apps/worker/src/jobs/settle_game_results.js
decisions:
  - "Guard bypassed when jobKey is null (manual runs) — consistent with existing shouldRunJobKey pattern"
  - "settle_game_results.js required no logic changes; closure contract confirmed via comment anchor"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-04"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 3
---

# Quick Task 124: Sequential Ordering Guard in Settlement Pipeline (WI-0783)

One-liner: Guards in settle_pending_cards and settle_projections block card/projection settlement until settle_game_results writes a success row for the same scheduling window.

## What Was Done

### Task 1 — Guard in settle_pending_cards.js

Added `hasSuccessfulJobRun` to the import block from `@cheddar-logic/data`.

Inserted a guard block immediately after the existing `shouldRunJobKey` idempotency check and before the `dryRun` check. The guard derives the sibling game-results job key:

```
jobKey.split('|').slice(0, -1).join('|') + '|game-results'
```

If `hasSuccessfulJobRun(gameResultsJobKey)` returns false, the function returns early with:

```
SKIP: settle_game_results not yet SUCCESS for this window — skipping card settlement (expected key: ${gameResultsJobKey})
```

Return shape: `{ success: true, jobRunId: null, skipped: true, guardedBy: 'game-results', jobKey }`.

Manual runs (no jobKey) bypass the guard — consistent with the existing `shouldRunJobKey` pattern.

Commit: `6524c4f`

### Task 2 — Guard in settle_projections.js + closure anchor in settle_game_results.js

Same guard pattern added to `settleProjections` after its `shouldRunJobKey` check. Log prefix uses `[${JOB_NAME}]` consistent with the rest of the file.

settle_game_results.js had no logic to change — all four touch points already close the job_key:
- Line 1081: `insertJobRun` — job recorded
- Line 1167: `markJobRunSuccess` — early empty-window exit
- Line 1703: `markJobRunSuccess` — main success path
- Line 1754: `markJobRunFailure` — catch path

Added a one-line comment above `insertJobRun` to make the closure contract explicit and prevent future regressions:

```javascript
// job_key closure contract: success→markJobRunSuccess (L1167, L1703), failure→markJobRunFailure (L1754)
```

Commit: `01070c0`

## Verification

All settle tests pass:
- `npm test -- --testPathPattern=settle`: 123 passed, 1 skipped (11 suites)
- `npm run test:pipeline:settlement`: 5 passed (1 suite)

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `apps/worker/src/jobs/settle_pending_cards.js` — modified with guard
- [x] `apps/worker/src/jobs/settle_projections.js` — modified with guard
- [x] `apps/worker/src/jobs/settle_game_results.js` — modified with closure comment
- [x] Commit `6524c4f` — Task 1
- [x] Commit `01070c0` — Task 2
- [x] All 123 settle tests pass

## Self-Check: PASSED
