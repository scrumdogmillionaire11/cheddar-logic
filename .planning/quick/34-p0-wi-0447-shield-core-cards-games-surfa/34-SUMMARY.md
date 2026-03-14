---
phase: quick
plan: 34
subsystem: test-infrastructure
tags: [regression-test, run-state, nhl-props, WI-0447]
dependency_graph:
  requires: []
  provides: [behavioral-run-state-isolation-test]
  affects: [api-cards-lifecycle-regression.test.js]
tech_stack:
  added: []
  patterns: [direct-db-query-replication, behavioral-regression-test]
key_files:
  created: []
  modified:
    - web/src/__tests__/api-cards-lifecycle-regression.test.js
decisions:
  - "Added job_name column to INSERT statements after discovering NOT NULL schema constraint at runtime"
metrics:
  duration: "~10 minutes"
  completed: "2026-03-14"
  tasks_completed: 1
  files_modified: 1
---

# Quick Task 34: Shield Core Cards/Games Surfaces — WI-0447 Behavioral Regression Test

**One-liner:** Behavioral DB-level regression test proving nhl_props run_state rows cannot contaminate canonical run_id selection in cards/games routes.

## What Was Changed

Added Test 6 to `web/src/__tests__/api-cards-lifecycle-regression.test.js`, closing the behavioral coverage gap identified in WI-0447. The existing Test 5 is a source-text grep that proves the guard SQL is present in three API route files. Test 6 proves the guard executes correctly at runtime against mixed DB state.

## API Route State Before This Task

All three routes (`cards/route.ts`, `cards/[gameId]/route.ts`, `games/route.ts`) already contained the canonical `getActiveRunIds` SQL guard:

```sql
LOWER(COALESCE(rs.sport, rs.id, '')) IN ('nba', 'nhl', 'ncaam', 'soccer', 'mlb', 'nfl', 'fpl')
```

No route changes were needed. Only behavioral test coverage was missing.

## Test 6 Verification Output

```
Test 6: Non-canonical run_state rows (nhl_props) are excluded from core run_id selection
✓ Non-canonical nhl_props run_state row correctly excluded from core run_id selection
```

## All 6 Tests Pass

```
✅ All WI-0392/WI-0447 Lifecycle Parity + Run-State Shield Tests Passed!
```

Full output:
- Test 1: Default behavior returns cards from both active and settled games — PASS
- Test 2: lifecycle=active excludes cards from FINAL games — PASS
- Test 3: lifecycle=active excludes cards from CANCELLED games — PASS
- Test 4: Multiple cards from included game all return — PASS
- Test 5: Source contract enforces canonical run-state sport filtering — PASS
- Test 6: Non-canonical run_state rows (nhl_props) are excluded from core run_id selection — PASS

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added job_name to job_runs INSERT statements**
- **Found during:** Task 1 (first test run)
- **Issue:** Plan's INSERT template omitted `job_name` column; live DB schema has `job_name TEXT NOT NULL` constraint
- **Fix:** Added `job_name` with test-scoped values (`'test-wi0447-canonical'`, `'test-wi0447-noncanonical'`) to both INSERT statements
- **Files modified:** web/src/__tests__/api-cards-lifecycle-regression.test.js
- **Commit:** f268a6e

## Self-Check: PASSED

- [x] `web/src/__tests__/api-cards-lifecycle-regression.test.js` exists and modified
- [x] Commit f268a6e present in git log
- [x] Test suite exits 0 with all 6 tests passing
- [x] Test 6 output line matches required string exactly
