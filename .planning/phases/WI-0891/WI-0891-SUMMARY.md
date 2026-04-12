---
phase: WI-0891-remove-live-split-brain
plan: 01
subsystem: settlement + api-games
tags: [split-brain, true_play, settlement, authority, regression]
dependency_graph:
  requires: [WI-0890]
  provides: [settlement-authority-guard, true_play-determinism-contract]
  affects: [apps/worker/src/jobs/settle_pending_cards.js, web/src/lib/games/route-handler.ts]
tech_stack:
  added: []
  patterns: [ADR-0003-true-play-authority, display-log-historical-only]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js
    - web/src/__tests__/api-games-missing-data-contract.test.js
decisions:
  - "shouldEnableDisplayBackfill is hard-coded to return false, preventing split-brain even from env-override callers"
  - "API contract test now validates against route-handler (delegate arch) not the thin route.ts shim"
  - "card_display_log is intentionally excluded from all live authority query paths (asserted in test)"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-11"
  tasks_completed: 3
  files_modified: 3
---

# Phase WI-0891 Plan 01: Remove Live Split-Brain — Settlement Backfill vs /api/games

Hard-disabled settlement display-log backfill with an explicit guard function and added deterministic /api/games authority-path regression tests.

## What Was Done

### Task 1: Settlement display-backfill authority guard (worker)

Added `shouldEnableDisplayBackfill()` — a named, exported-to-`__private` function that always returns `false` regardless of `allowDisplayBackfill` option. The settlement flow now routes through this helper instead of an anonymous inline `false`, making the ADR-0003 policy testable and visible in logs.

Added a phase2 regression: `display backfill authority guard stays disabled even when override requested` — asserts the function returns false for all inputs (false, true, null).

**Commit:** `2bed099`

### Task 2+3: /api/games single-path authority contract test

Updated `api-games-missing-data-contract.test.js` to fix stale assertions (the route.ts is a thin delegate shim) and added three authority-path assertions:

1. `selectAuthoritativeTruePlay` is the single true-play selector in `route-handler.ts`
2. `card_display_log` is not queried as a live authority source (the "historical/analytics" comment is present and no `FROM card_display_log` SQL exists in the handler)
3. Active-run and no-active-run coverage both route through the same `buildCardsSql` + fallback pattern — same authority chain

**Commit:** `909b709`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed stale test assertions against thin route.ts shim**
- **Found during:** Task 2 verification
- **Issue:** `api-games-missing-data-contract.test.js` asserted against `route.ts` which is now a 1-line delegate; all implementation lives in `route-handler.ts`
- **Fix:** Added `gamesRouteHandlerSource` reference; updated four existing assertions and added route.ts delegation check
- **Files modified:** `web/src/__tests__/api-games-missing-data-contract.test.js`
- **Commit:** `909b709`

**2. [Rule 1 - Bug] Removed stale transform assertion**
- **Found during:** Task 2 verification
- **Issue:** Assertion for `MISSING_DATA_TEAM_MAPPING` in `transform.ts` was targeting a pattern that no longer exists in that file (moved to route-handler + cards context)
- **Fix:** Removed the stale transform assertion; the cards-page diagnostic assertion still covers the behavior
- **Files modified:** `web/src/__tests__/api-games-missing-data-contract.test.js`
- **Commit:** `909b709`

## Self-Check

### Created file exists
- .planning/phases/WI-0891/WI-0891-01-PLAN.md: ✅ (already verified)
- .planning/phases/WI-0891/WI-0891-SUMMARY.md: this file

### Commits exist
- `2bed099`: feat(WI-0891-01): enforce settlement display-backfill authority guard ✅
- `909b709`: test(WI-0891-01): add authority contract assertions for /api/games true_play path ✅

## Self-Check: PASSED
