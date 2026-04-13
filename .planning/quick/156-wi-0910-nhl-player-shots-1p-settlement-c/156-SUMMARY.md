---
phase: quick-156
plan: "01"
subsystem: settlement
tags: [nhl, player-shots, 1p, settlement, completeness-guard]
dependency_graph:
  requires: [WI-0909]
  provides: [WI-0910]
  affects: [settle_pending_cards]
tech_stack:
  added: []
  patterns: [completeness-guard, market-error-code, TDD-red-green]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/__tests__/settle_pending_cards.phase2.test.js
decisions:
  - "Treat absent firstPeriodVerification permissively (no throw) so older game_result records written before nhl_api_ method was available continue to settle"
  - "Guard fires only when isComplete is explicitly false — the boolean false check is intentional and distinct from null/undefined"
  - "Guard is additive and placed after normalizedPeriod/usingFirstPeriod computation, before byPlayerId read"
metrics:
  duration: "~10 minutes"
  completed_date: "2026-04-12"
  tasks_completed: 3
  files_modified: 2
---

# Phase quick-156 Plan 01: NHL 1P Player Shots Settlement Completeness Guard Summary

**One-liner:** Added `PERIOD_NOT_COMPLETE` guard to `resolvePlayerShotsActualValue` that blocks 1P shots grading when `firstPeriodVerification.isComplete` is explicitly `false`, with 5 new contract tests covering the complete/incomplete/missing-player/absent-verification/full-game-not-guarded matrix.

## Tasks Completed

| # | Name | Commit | Files |
|---|------|--------|-------|
| 1 | Add firstPeriodVerification.isComplete completeness guard | f1d1903 | settle_pending_cards.js |
| 2 | Add 1P shots contract tests (WI-0910) | f1d1903 | settle_pending_cards.phase2.test.js |
| 3 | Non-regression sweep — settle_projections, phase2, settle_game_results | (no files changed) | — |

## What Was Built

### Production Change

In `resolvePlayerShotsActualValue` (settle_pending_cards.js), inserted a completeness guard immediately after `const usingFirstPeriod = normalizedPeriod === '1P';` and before the `byPlayerId` read:

```js
if (usingFirstPeriod) {
  const verification =
    gameResultMetadata.firstPeriodVerification &&
    typeof gameResultMetadata.firstPeriodVerification === 'object'
      ? gameResultMetadata.firstPeriodVerification
      : null;
  if (verification && verification.isComplete === false) {
    throw createMarketError(
      'PERIOD_NOT_COMPLETE',
      'First period not yet complete — cannot grade 1P player shots',
      { period: normalizedPeriod, gameState: verification.gameState ?? null },
    );
  }
}
```

### Test Coverage Added

New describe block: `resolvePlayerShotsActualValue — 1P shots contract (WI-0910)` with 5 tests:

1. `returns 1P shot value when firstPeriodVerification.isComplete=true and player found` — happy path
2. `throws PERIOD_NOT_COMPLETE when firstPeriodVerification.isComplete=false` — core guard
3. `throws MISSING_PERIOD_PLAYER_SHOTS_VALUE when 1P complete but player absent` — existing error unchanged
4. `reads firstPeriodByPlayerId permissively when firstPeriodVerification absent` — backwards compat
5. `FULL_GAME is not guarded even when firstPeriodVerification.isComplete=false` — guard scope isolation

## Non-Regression Results

| Suite | Tests | Result |
|-------|-------|--------|
| settle_projections | 33 | PASS |
| settle_pending_cards.phase2 | 26 (21 original + 5 new) | PASS |
| settle_game_results | 16 | PASS |

Total: 75 passed, 1 pre-existing skip, 0 failures.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `PERIOD_NOT_COMPLETE` string present in settle_pending_cards.js
- [x] Guard only fires when `usingFirstPeriod === true` AND `isComplete === false`
- [x] Absent `firstPeriodVerification` treated permissively (confirmed by test 4)
- [x] Full-game path not guarded (confirmed by test 5)
- [x] All three test suites pass with zero regressions
- [x] Commit f1d1903 exists on branch agent/spike/WI-0908-f5-lines

## Self-Check: PASSED
