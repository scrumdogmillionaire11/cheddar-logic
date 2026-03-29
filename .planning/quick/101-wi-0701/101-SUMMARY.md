---
phase: quick-101
plan: 01
subsystem: frontend/cards
tags: [error-handling, ux, resilience, fetch]
requirements: [WI-0701]

dependency_graph:
  requires: []
  provides: [games-preserved-on-5xx, games-preserved-on-timeout]
  affects: [CardsPageContext.tsx, cards-error-paths]

tech_stack:
  added: []
  patterns: [recoverable-vs-non-recoverable-error-classification]

key_files:
  created:
    - web/src/__tests__/cards-transient-error-preserves-games.test.js
  modified:
    - web/src/components/cards/CardsPageContext.tsx

decisions:
  - "429 (rate limit) classified as recoverable — consistent with 5xx treatment; already has its own early-return path"
  - "catch block: remove setGames([]) entirely rather than classifying error types — all thrown fetch errors are transient by definition"
  - "Non-JSON body and !data.success paths left unchanged — these indicate a fundamentally broken response, not a transient outage"

metrics:
  duration: "~15 minutes"
  completed_date: "2026-03-29"
  tasks_completed: 2
  files_modified: 1
  files_created: 1
---

# Phase quick-101 Plan 01: WI-0701 Transient Error Game Preservation Summary

**One-liner:** Added `isRecoverableHttpError(status)` helper to classify 5xx/429 as recoverable, preventing `setGames([])` from wiping plays during transient outages.

## What Was Changed

### `web/src/components/cards/CardsPageContext.tsx`

**Lines 82-90 (new):** Added module-level helper function:
```typescript
function isRecoverableHttpError(status: number): boolean {
  return status >= 500 || status === 429;
}
```

**Line 731 (modified):** In the `!response.ok` branch, the `setGames([])` call is now conditional:
```
// Before:
if (isInitialLoad.current) { setGames([]); }

// After:
if (isInitialLoad.current && !isRecoverableHttpError(response.status)) { setGames([]); }
```
This means 5xx and 429 responses no longer wipe games state. Auth errors (401, 403), bad requests (400, 404) still clear state.

**Lines 789-791 (modified):** In the `catch` block, removed the `if (isInitialLoad.current) { setGames([]); }` block entirely. Any error that throws (network error, fetch failure) is transient by nature — clearing games would be wrong. `setError(message)` and the `!isAbort` guard remain unchanged.

**Unchanged paths:**
- Line 596: stale JS asset chunk failure — non-recoverable, clears games (correct)
- Line 744: non-JSON body branch — non-recoverable, clears games (correct)
- Line 754: `!data.success` branch — non-recoverable, clears games (correct)

### `web/src/__tests__/cards-transient-error-preserves-games.test.js` (new)

Source-assertion test with 11 cases:
1. `isRecoverableHttpError` declared
2. Returns true for `status >= 500`
3. Returns true for `status === 429`
4. `isRecoverableHttpError` used in `!response.ok` branch
5. `setGames([])` guarded by `!isRecoverableHttpError(response.status)`
6. `setError(nonJsonDetail)` still present in `!response.ok` branch
7. `catch` block contains no `setGames([])`
8. `catch` block still calls `setError(message)`
9. `catch` block keeps `!isAbort` guard
10. Non-JSON body branch still calls `setGames([])`
11. `!data.success` branch still calls `setGames([])`

## Acceptance Criteria Verification

| Criterion | Status |
|---|---|
| 5xx responses: `setGames([])` NOT called | PASS — guarded by `!isRecoverableHttpError` |
| Timeout / abort: `setGames([])` NOT called | PASS — catch block drop confirmed by test 7 |
| 401 / malformed JSON / !data.success: `setGames([])` IS called | PASS — non-recoverable paths unchanged |
| Error message always shown | PASS — `setError()` on every path |
| TypeScript compiles clean | PASS — `npx tsc --noEmit` exits 0 |
| New test file passes | PASS — 11/11 assertions pass |

## Deviations from Plan

None — plan executed exactly as written.

## Commits

| Task | Commit | Message |
|---|---|---|
| Task 1 | 18d32b7 | fix(quick-101): preserve games state on transient fetch errors (WI-0701) |
| Task 2 | cee5421 | test(quick-101): add WI-0701 regression test for transient-error game preservation |

## Self-Check

- [x] `web/src/components/cards/CardsPageContext.tsx` exists and contains `isRecoverableHttpError`
- [x] `web/src/__tests__/cards-transient-error-preserves-games.test.js` exists and all 11 tests pass
- [x] Commits 18d32b7 and cee5421 exist in git log
- [x] `npx tsc --noEmit` exits 0

## Self-Check: PASSED
