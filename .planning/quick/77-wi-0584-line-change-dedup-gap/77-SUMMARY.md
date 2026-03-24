---
phase: qt-77
plan: 01
subsystem: nhl-props-dedup
tags: [dedup, props, route, worker, WI-0584]
dependency_graph:
  requires: []
  provides: [line-agnostic-dedup, secondary-prop-dedup]
  affects: [web/src/app/api/games/route.ts, apps/worker/src/jobs/run_nhl_player_shots_model.js]
tech_stack:
  added: []
  patterns: [source-contract-test, block-scoped-dedup]
key_files:
  created:
    - web/src/__tests__/api-games-prop-line-change-dedup.test.js
  modified:
    - web/src/app/api/games/route.ts
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
decisions:
  - "Worker dedup key (seenNhlShotsPlayKeys) does not exist in the worker file; only route.ts had it. Plan interface block incorrectly attributed it to both files. Only route.ts fix was needed for Edit B."
  - "Secondary dedup pass inserted after main card loop (line 3326) before displayLogRows loop, using block scope to contain seenPropTupleKeys."
  - "Source contract tests in web/src/__tests__ are run as node scripts, not via Jest; verified via node directly."
metrics:
  duration: 4m
  completed_date: 2026-03-24
  tasks_completed: 2
  files_changed: 3
---

# Quick Task 77: WI-0584 Line-Change Dedup Gap Summary

**One-liner:** Line-agnostic prop dedup in route.ts: removed `dedupeLine` from 7-element key to 6-element key + added `seenPropTupleKeys` secondary pass keeping newest card per (gameId, playerId, propType, side); worker gets warn-on-zero for primary purge call.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Fix worker dedup key and add purge warn-on-zero | e3b7934 | apps/worker/src/jobs/run_nhl_player_shots_model.js |
| 2 | Fix route dedup key and add secondary dedup pass, plus test | 974f114 | web/src/app/api/games/route.ts, web/src/__tests__/api-games-prop-line-change-dedup.test.js |

## Changes Made

### Task 1 — Worker: purge warn-on-zero

Added `else` branch to the primary `purgePlayerCardsForGame` call at ~line 1388. When `purgedCount === 0`, emits `console.warn` with player name, player ID, and game ID to alert that duplicate cards may persist. The injured-player fire-and-forget purge calls are unaffected (0 rows expected there).

Note: The plan's Task 1 Edit B (remove `dedupeLine` from worker dedup key) did not apply — the worker has no `seenNhlShotsPlayKeys` mechanism. This pattern only exists in route.ts. Confirmed via grep.

### Task 2 — Route: line-agnostic dedup key

Removed `dedupeLine != null ? dedupeLine.toFixed(3) : ''` from the `dedupeKey` array in `seenNhlShotsPlayKeys` block (~line 3177). Key is now 6 elements: `[canonicalGameId, card_type, dedupeIdentity, dedupePropType, dedupePeriod, dedupeSide]`.

### Task 2 — Route: secondary dedup pass

Inserted a block-scoped `seenPropTupleKeys` pass after `perf.cardsParseMs` assignment and before `displayLogRows` loop. Iterates `playsMap`, filters NHL prop cards (`nhl-player-shots`, `nhl-player-shots-1p`, `market_type === 'PROP'`) keeping only the first occurrence of each `(gid|pid|pType|side)` tuple. Since SQL query orders by `created_at DESC, id DESC`, first = newest.

### Task 2 — New test file

`web/src/__tests__/api-games-prop-line-change-dedup.test.js` — 4 assertions verifying:
1. `dedupeKey` array does not reference `dedupeLine`
2. `seenPropTupleKeys` identifier exists in route.ts
3. `playsMap.set(gid, dedupedPropPlays)` pattern exists
4. Card type guards (`nhl-player-shots`, `nhl-player-shots-1p`, `=== 'PROP'`) are present

## Verification

- 62 worker tests pass (`npx jest apps/worker/src/jobs/__tests__/run_nhl_player_shots_model --no-coverage`)
- New test passes (`node web/src/__tests__/api-games-prop-line-change-dedup.test.js`)
- Existing prop decision contract test passes (`node web/src/__tests__/api-games-prop-decision-contract.test.js`)
- `tsc --noEmit` exits 0

## Deviations from Plan

### Auto-noted Discovery

**Worker dedup key (Edit B) did not exist in worker file**
- **Found during:** Task 1
- **Issue:** Plan's interface block said worker had `seenNhlShotsPlayKeys` with `dedupeLine` at ~line 3177. Worker does not have this pattern — grep for `dedupeLine`, `seenNhlShotsPlayKeys`, `dedupeKey` all return no matches in worker file.
- **Resolution:** Skipped the inapplicable edit. The actual fix (remove `dedupeLine` from 6-element key) was applied to route.ts only in Task 2 as specified.
- **Impact:** None — success criteria met; the fix is in the right place (route.ts is the read path that serves the API).

## Self-Check: PASSED

- FOUND: web/src/__tests__/api-games-prop-line-change-dedup.test.js
- FOUND: web/src/app/api/games/route.ts
- FOUND: commit e3b7934 (worker warn-on-zero)
- FOUND: commit 974f114 (route dedup key + secondary pass + test)
