---
phase: quick-87
plan: "01"
subsystem: worker-settlement + results-api
tags: [settlement, metadata, period-token, backfill, results-api]
dependency_graph:
  requires: []
  provides: [metadata.market_period_token, backfill_period_token_job, coalesce-prefer-persisted-token]
  affects: [card_results.metadata, /api/results, settle_pending_cards.js]
tech_stack:
  added: [backfill_period_token.js]
  patterns: [metadata-merge-at-settlement, prefer-persisted-over-derived, dry-run-job-pattern]
key_files:
  created:
    - apps/worker/src/jobs/backfill_period_token.js
    - apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js (rewritten with new cases)
  modified:
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/__tests__/settlement-pipeline-integration.test.js
    - apps/worker/package.json
    - web/src/app/api/results/route.ts
    - web/src/__tests__/api-results-decision-segmentation.test.js
    - docs/DATA_CONTRACTS.md
decisions:
  - "Inline normalizeSettlementPeriod logic in backfill_period_token.js to avoid coupling to settle_pending_cards.js __private exports"
  - "Use deriveAndMergePeriodToken() helper to merge token into existing metadata, avoiding metadata clobber"
  - "Both CASE blocks in route.ts wrapped with COALESCE to preserve fallback for mixed old/new data during rollout"
metrics:
  duration: "~45 minutes"
  completed_date: "2026-03-27"
  tasks_completed: 3
  files_changed: 7
---

# Phase quick-87 Plan 01: WI-0607 Persist Market Period Token Summary

Persist `market_period_token` ('1P' or 'FULL_GAME') to `card_results.metadata` at settlement time via `deriveAndMergePeriodToken()`, create a standalone backfill job for historical rows with dry-run support, and update `/api/results` to prefer the stored token via `COALESCE(json_extract(cr.metadata, '$.market_period_token'), <derived CASE>)`.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Write market_period_token into metadata at settlement | e384f8c | settle_pending_cards.js, phase2.test.js |
| 2 | Create backfill_period_token.js with dry-run support | 0451585 | backfill_period_token.js, integration.test.js, package.json |
| 3 | Update /api/results to prefer persisted token | 70f1f5b | route.ts, decision-segmentation.test.js, DATA_CONTRACTS.md |

## What Was Built

### Task 1: Settlement metadata persistence

Added `deriveAndMergePeriodToken({ existingMeta, token })` to `settle_pending_cards.js`. Extended the settlement `UPDATE card_results SET status='settled'...` to include `metadata = ?` with the merged JSON. The `period` variable (already computed via `extractSettlementPeriod` earlier in the loop) is passed as the token. All existing metadata fields (backfilledAt, settlement_error, etc.) are preserved via spread merge.

Exported `normalizeSettlementPeriod` and `deriveAndMergePeriodToken` from `__private`. Added 6 new phase2 assertions (15 total) covering 1P, FULL_GAME, metadata-merge preservation, and mock DB integration.

### Task 2: Backfill job

Created `apps/worker/src/jobs/backfill_period_token.js` following the `backfill_card_results.js` pattern:
- Inlines `normalizePeriodToken` / `derivePeriodToken` to avoid tight coupling
- Queries `card_results WHERE status='settled' AND json_extract(metadata, '$.market_period_token') IS NULL`
- Dry-run: counts candidates, returns `{ success, candidates, updated: 0 }` without writing
- Apply: merges token into existing metadata via spread, updates only `metadata` column
- Supports `--since` filter
- Added `job:backfill-period-token` and `job:backfill-period-token:dry-run` npm scripts
- 4 integration tests pass: dry-run, apply (immutable fields check), idempotent, 1P vs FULL_GAME typing
- Dry-run reports 411 eligible historical rows in the live DB

### Task 3: /api/results COALESCE prefer-stored

Wrapped both `CASE ... END AS market_period_token` blocks (lines ~440 and ~815) in route.ts with:
```sql
COALESCE(
  json_extract(cr.metadata, '$.market_period_token'),
  CASE ... END
) AS market_period_token
```
Added 2 assertions to `api-results-decision-segmentation.test.js` confirming the COALESCE pattern and the derived fallback are both present. Documented the field in `docs/DATA_CONTRACTS.md`.

## Verification Results

| Check | Result |
| ----- | ------ |
| `npm test -- settle_pending_cards.phase2.test.js` | 15/15 pass |
| `npm test -- settlement-pipeline-integration.test.js` | 5/5 pass |
| `npm run test:api:results:decision-segmentation` | pass |
| `npm run test:ui:results` | pass |
| `npx tsc --noEmit` | exit 0 |
| `npm run job:backfill-period-token:dry-run` | exit 0, candidates: 411 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test helper missing game row insertion**
- **Found during:** Task 2 integration test run
- **Issue:** `insertSettledRow` in the integration test inserted into `card_results` without first inserting into `games`, causing a FOREIGN KEY constraint failure (`card_results.game_id REFERENCES games.game_id`)
- **Fix:** Added `INSERT OR IGNORE INTO games` before the `card_results` INSERT in the test helper
- **Files modified:** `apps/worker/src/__tests__/settlement-pipeline-integration.test.js`

**2. [Rule 1 - Bug] DB connection closed after withDb() in test assertions**
- **Found during:** Task 2 integration test run
- **Issue:** `backfillPeriodToken` uses `withDb` which calls `closeDatabase()` in its `finally` block. The test held a `db` reference from before the call; subsequent `db.prepare()` calls failed with "database connection is not open"
- **Fix:** Updated 4 tests to call `closeDatabase()` before `backfillPeriodToken`, then get a fresh `getDatabase()` reference for post-call assertions
- **Files modified:** `apps/worker/src/__tests__/settlement-pipeline-integration.test.js`

## Self-Check

### Created files exist:
- `apps/worker/src/jobs/backfill_period_token.js` - FOUND
- `.planning/quick/87-wi-0607-results-persist-market-period-to/87-SUMMARY.md` - this file

### Commits exist:
- e384f8c - FOUND
- 0451585 - FOUND
- 70f1f5b - FOUND

## Self-Check: PASSED
