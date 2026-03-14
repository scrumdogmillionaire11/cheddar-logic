---
phase: 36-wi-0449-settlecards-run-log-failure-reme
plan: "01"
subsystem: settlement
tags: [settlement, telemetry, error-handling, sql-wrapper, counter-integrity]
dependency_graph:
  requires: []
  provides: [clean-non-actionable-auto-close, safe-statement-error-serialization, mutually-exclusive-settlement-counters]
  affects: [settle_pending_cards, db.js, db-multi.js, db-dual-init.js]
tech_stack:
  added: []
  patterns: [e?.message ?? String(e), closedResultIds Set, early-continue guard]
key_files:
  created:
    - apps/worker/src/jobs/__tests__/settle_pending_cards.non-actionable.test.js
  modified:
    - packages/data/src/db.js
    - packages/data/src/db-multi.js
    - packages/data/src/db-dual-init.js
    - apps/worker/src/jobs/settle_pending_cards.js
decisions:
  - "Track closedResultIds as a Set from re-querying card_results after the auto-close loop, not by inferring from which entries succeeded — ensures accuracy even if pre-empted by a concurrent writer"
  - "Skip guard in pendingRows loop uses String(pendingCard.result_id ?? '') for safe coercion, matching the same normalization used when building the closedResultIds Set"
metrics:
  duration_seconds: 209
  completed_date: "2026-03-14"
  tasks_completed: 3
  files_modified: 5
---

# Phase 36 Plan 01: SettleCards Run-Log Failure Remediation Summary

**One-liner:** Fixed `Statement run error: undefined` via `e?.message ?? String(e)` in all three db wrappers; added `closedResultIds` Set to prevent auto-closed rows from double-counting in raced/errored buckets.

## Objective

Three defects observed in the dev run log:

1. `Statement run error: undefined` — sql.js throws non-Error strings; `e.message` is undefined.
2. Counter contradiction — `pendingRows` snapshot taken before `autoCloseNonActionableFinalPendingRows` runs, so auto-closed rows re-enter the main loop and inflate `cardsRaced`/`cardsErrored`.
3. Write failure diagnostics — catch block logged `cardId` and `reasonCode` but omitted `resultId` and did not safely serialize the error.

## Files Changed

| File | Change |
| ---- | ------ |
| `packages/data/src/db.js` | `Statement.run` and `.get` catch blocks: `e.message` -> `e?.message ?? String(e)` |
| `packages/data/src/db-multi.js` | `Statement.run`, `.get`, `.all` catch blocks: `e.message` -> `e?.message ?? String(e)` |
| `packages/data/src/db-dual-init.js` | `Statement.run`, `.get`, `.all` catch blocks: `e.message` -> `e?.message ?? String(e)` |
| `apps/worker/src/jobs/settle_pending_cards.js` | (1) Auto-close catch block uses safe error serialization and includes `resultId` in warn log; (2) Returns `closedResultIds: Set` from all code paths; (3) `autoClosedResultIdSet` built from return value; (4) Early-continue guard skips rows in `autoClosedResultIdSet` at top of `pendingRows` loop |
| `apps/worker/src/jobs/__tests__/settle_pending_cards.non-actionable.test.js` | New regression test file: 6 tests covering T1-T5 + T2b (counter alignment) |

## Before / After Run-Log Behavior

**Before (observed in dev run log):**

```text
[SettleCards] Failed to auto-close non-actionable card card-abc (NON_ACTIONABLE_FINAL_KIND): Statement run error: undefined
[SettleCards] Auto-closed 3 non-actionable final pending card_results as void (...)
[SettleCards] Step 1 complete — pending: 8, eligible: 8, settled: 2, errored: 0, raced: 3, skipped: 0, autoClosedNonActionable: 3
```

The same 3 rows appear in both `autoClosedNonActionable` and `raced`. The `undefined` error text gives no diagnostic value.

**After (corrected behavior):**

```text
[SettleCards] Failed to auto-close non-actionable card card-abc (resultId=r-001, reason=NON_ACTIONABLE_FINAL_KIND): disk full
[SettleCards] Auto-closed 3 non-actionable final pending card_results as void (...)
[SettleCards] Step 1 complete — pending: 8, eligible: 8, settled: 2, errored: 0, raced: 0, skipped: 0, autoClosedNonActionable: 3
```

Counters are mutually exclusive. Write failure includes `resultId`, `cardId`, `reasonCode`, and a concrete error string.

## Regression Tests

All 6 tests in `settle_pending_cards.non-actionable.test.js` pass. The tests exercise the internal function via `__private.autoCloseNonActionableFinalPendingRows` with in-memory db stubs that simulate:

- **T1:** Normal success path — `closed=1, failures=0`
- **T2:** DB throws a string (`'disk full'`) — `failures=1`, no rethrow, warn log includes `resultId=r-002`, `cardId=c-002`, `reasonCode`, and `disk full` (not "undefined")
- **T2b:** 2 candidates, 1 throws — `closed=1, failures=1`
- **T3:** `closedResultIds` Set returned containing the auto-closed `result_id`
- **T4:** `closedResultIds.size` equals `closed` count
- **T5:** Empty `closedResultIds` Set when no candidates

The 5 sampled result_id values exercised across the test suite:

- `r-001` (T1 — success)
- `r-002` (T2 — string-throw failure, verified in warn log)
- `r-003` / `r-004` (T2b — split outcome)
- `r-skip-001` (T3 — closedResultIds membership check)
- `r-10` / `r-11` (T4 — two-candidate closed count alignment)

## All Tests Pass

```text
PASS settle_pending_cards.non-actionable.test.js   6 tests
PASS settle_pending_cards.market-contract.test.js  3 tests
PASS settle_pending_cards.phase2.test.js           3 tests
Total: 12 tests, 0 failures
data package: All tests passed
```

## Commits

| Hash | Description |
| ---- | ----------- |
| da27d3a | test(36-01): add failing regression tests for non-actionable auto-close path (RED) |
| 552516b | fix(36-01): safe error serialization in Statement wrappers and non-actionable auto-close diagnostics |
| af58e8b | fix(36-02): exclude auto-closed rows from main settlement loop to prevent double-counting |

## Deviations from Plan

None — plan executed exactly as written. The `closedResultIds` population strategy (re-query card_results after the loop) matches the plan's pseudocode. The `Statement.all` catch blocks in db-multi.js and db-dual-init.js were also fixed for consistency (plan called for run/get; all was an adjacent defect covered by Rule 2).

## Self-Check: PASSED

- packages/data/src/db.js: FOUND
- packages/data/src/db-multi.js: FOUND
- packages/data/src/db-dual-init.js: FOUND
- apps/worker/src/jobs/settle_pending_cards.js: FOUND
- apps/worker/src/jobs/**tests**/settle_pending_cards.non-actionable.test.js: FOUND
- commit da27d3a: FOUND
- commit 552516b: FOUND
- commit af58e8b: FOUND
