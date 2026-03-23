---
phase: quick-67
plan: "01"
subsystem: edge-math
tags: [sigma, edge-calculator, nba-model, wI-0552]
dependency_graph:
  requires: [WI-0551]
  provides: [computeSigmaFromHistory, empirical-sigma]
  affects: [edge-calculator.js, run_nba_model.js]
tech_stack:
  added: []
  patterns: [better-sqlite3 sync query, population std-dev, mock-db unit testing]
key_files:
  created: []
  modified:
    - packages/models/src/edge-calculator.js
    - apps/worker/src/jobs/run_nba_model.js
    - packages/models/src/__tests__/edge-calculator.test.js
    - WORK_QUEUE/COMPLETE/WI-0552.md
decisions:
  - "Implemented computeSigmaFromHistory in edge-calculator.js (not a separate module) for co-location with getSigmaDefaults"
  - "Used edgeCalculator.computeSigmaFromHistory via existing edgeCalculator import in run_nba_model.js — no new require needed"
  - "Deferred injection of computedSigma into cross-market.js calls (WI-0552 acceptance requires log confirmation, not full wiring)"
metrics:
  duration: "~12 minutes"
  completed: "2026-03-23"
  tasks_completed: 3
  tasks_total: 3
  files_modified: 4
---

# Quick Task 67: WI-0552 Summary

**One-liner:** empirical sigma from game_results via population std-dev, with <20-game fallback to hardcoded NBA constants (margin=12, total=14)

## What Was Implemented

### Task 1: computeSigmaFromHistory + getSigmaDefaults update (TDD)

Added `computeSigmaFromHistory({ sport, marketType, db, windowGames = 60 })` to `packages/models/src/edge-calculator.js`:

- Queries `game_results` WHERE `sport = ?` AND `status = 'final'` ORDER BY `settled_at DESC LIMIT windowGames`
- Returns `sigma_source: 'fallback'` when fewer than 20 games returned or on any DB error
- Returns `sigma_source: 'computed'` with `games_sampled` count when 20+ games available
- Computes population std-dev of `(home - away)` for margin sigma and `(home + away)` for total sigma
- Wrapped in try/catch — DB errors silently fall back

Updated `getSigmaDefaults` JSDoc to document that current constants are uncalibrated fallbacks set ~2024 with no calibration lineage, and that live callers should prefer `computeSigmaFromHistory()`.

Exported `computeSigmaFromHistory` in `module.exports`.

13 new tests written covering: export check, 0-game fallback, 15-game fallback, 25-game computed path, games_sampled field, windowGames param, DB error fallback, getSigmaDefaults backward compat.

### Task 2: Wire into run_nba_model.js

Added at job start (immediately after `insertJobRun`):

```js
const computedSigma = edgeCalculator.computeSigmaFromHistory({
  sport: 'NBA',
  db: getDatabase(),
});
console.log('[run_nba_model] sigma:', JSON.stringify(computedSigma));
```

Uses existing `edgeCalculator` import from `@cheddar-logic/models` — no new require needed.

### Task 3: Close WI-0552

- All 31 edge-calculator tests pass (0 failures)
- `npm --prefix web run test:card-decision` passes
- WI-0552.md moved to `WORK_QUEUE/COMPLETE/WI-0552.md` with completion annotation

## Files Changed

| File | Change |
|------|--------|
| `packages/models/src/edge-calculator.js` | Added `computeSigmaFromHistory`, `_populationStdDev`; updated `getSigmaDefaults` JSDoc; exported new function |
| `packages/models/src/__tests__/edge-calculator.test.js` | 13 new tests for `computeSigmaFromHistory` |
| `apps/worker/src/jobs/run_nba_model.js` | Added `computeSigmaFromHistory` call + log at job start |
| `WORK_QUEUE/COMPLETE/WI-0552.md` | WI closed and moved |

## Test Results

```
=== Results: 31 passed, 0 failed ===
```

- noVigImplied: 9 tests
- computeSpreadEdge vig removal: 3 tests
- computeMoneylineEdge vig removal: 2 tests
- computeTotalEdge vig removal: 3 tests
- WI-0555 spread gate: 2 tests
- WI-0552 computeSigmaFromHistory: 13 tests (new)

card-decision suite: passed

## Commits

| Hash | Message |
|------|---------|
| 0494772 | feat(quick-67): add computeSigmaFromHistory to edge-calculator.js (WI-0552) |
| db90cca | feat(quick-67): wire computeSigmaFromHistory into run_nba_model.js at job start (WI-0552) |
| b55095d | chore(quick-67): close WI-0552 — move to COMPLETE, mark done (WI-0552) |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

All files verified on disk. All 3 commits confirmed in git history.
