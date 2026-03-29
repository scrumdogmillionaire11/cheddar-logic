---
phase: quick
plan: 99
subsystem: worker/jobs
tags: [playoff, nba, nhl, sigma, edge-threshold, model-runner]
dependency_graph:
  requires: [WI-0644 (NBA test suite, optional parallel)]
  provides: [playoff-mode detection in NBA+NHL models]
  affects: [run_nba_model.js, run_nhl_model.js, publishDecisionForCard options]
tech_stack:
  added: [apps/worker/src/utils/playoff-detection.js]
  patterns: [applyPlayoffSigmaMultiplier helper, isPlayoffGame ESPN season.type check]
key_files:
  created:
    - apps/worker/src/utils/playoff-detection.js
    - apps/worker/src/__tests__/playoff-detection.test.js
    - apps/worker/src/__tests__/run-nhl-model.test.js
  modified:
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/__tests__/run-nba-model.test.js
    - WORK_QUEUE/WI-0646.md
decisions:
  - "NHL model uses edgeCalculator.getSigmaDefaults('NHL') as base sigma (not computeSigmaFromHistory — no history yet)"
  - "applyPlayoffSigmaMultiplier duplicated into each job file rather than shared util (job files are not shared utilities)"
  - "effectiveSpreadLeanMin computed per-game inside loop and passed as spreadLeanMin param to generateNBAMarketCallCards"
  - "publishDecisionForCardMock exposed in mocks return from loadRunNBAModel to support sigma assertion tests"
metrics:
  duration: "~25 minutes"
  completed: "2026-03-29"
  tasks_completed: 2
  tasks_total: 2
  files_created: 3
  files_modified: 4
  tests_added: 20
---

# Quick Task 99: WI-0646 Playoff-Mode Detection Summary

**One-liner:** `isPlayoffGame()` utility detecting ESPN season.type===3 gates sigma*1.2 + edge_min+0.01 overrides and [PLAYOFF_MODE] log in both NBA and NHL model runners before Apr 19 playoff start.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create playoff-detection.js utility (TDD) | 2752780 | playoff-detection.js, playoff-detection.test.js |
| 2 | Wire playoff overrides into NBA and NHL models + test suites (TDD) | 98b8730 | run_nba_model.js, run_nhl_model.js, run-nba-model.test.js, run-nhl-model.test.js |

## What Was Built

### playoff-detection.js (new utility)

- `isPlayoffGame(oddsSnapshot)` — returns true when `raw_data.season.type === 3` (ESPN playoff encoding) or `raw_data.gameType === 'P'`
- Returns false for null, missing `raw_data`, non-object `raw_data`, regular-season type 2
- Exports: `PLAYOFF_SIGMA_MULTIPLIER=1.2`, `PLAYOFF_EDGE_MIN_INCREMENT=0.01`, `PLAYOFF_PACE_WEIGHT_CAP=0.5`
- 10 unit tests covering all 8 behavior cases

### NBA Model (run_nba_model.js)

Per-game loop additions (after `normalizeRawDataPayload`):
- `const isPlayoff = isPlayoffGame(oddsSnapshot)` — detects playoff context
- `if (isPlayoff) console.log('[PLAYOFF_MODE] gameId: ...')` — flag logging
- `effectiveSigma` = `computedSigma` multiplied by 1.2 on playoff games (spread and total)
- `effectiveSpreadLeanMin` = `lean_edge_min + 0.01` on playoff games
- Both `publishDecisionForCard` call sites updated to `{ sigmaOverride: effectiveSigma }`
- `generateNBAMarketCallCards` extended with `spreadLeanMin` parameter
- `applyPlayoffSigmaMultiplier` helper added at module level

### NHL Model (run_nhl_model.js)

- `nhlBaseSigma = edgeCalculator.getSigmaDefaults('NHL')` computed at job start
- Per-game playoff detection and `effectiveSigma` following same pattern as NBA
- Both `publishDecisionForCard` call sites updated to `{ sigmaOverride: effectiveSigma }`
- `applyPlayoffSigmaMultiplier` helper added at module level (copied, not shared)

### Test Coverage

- `playoff-detection.test.js`: 10 tests — all behavior cases pass
- `run-nba-model.test.js`: +2 playoff describe tests, publishDecisionForCardMock now exposed in `mocks` return
- `run-nhl-model.test.js`: new file with 2 base tests + 2 playoff describe tests
- Combined `--testPathPattern=run-nba-model|run-nhl-model`: 17/17 pass
- Full suite: 864 tests pass, 3 pre-existing skipped, exits 0

## Verification

```
npm --prefix apps/worker test -- --testPathPattern=playoff-detection   # 10/10
npm --prefix apps/worker test -- --testPathPattern=run-nba-model       # 13/13
npm --prefix apps/worker test -- --testPathPattern=run-nhl-model       # 4/4
npm --prefix apps/worker test                                           # 864 pass
```

## Deviations from Plan

None — plan executed exactly as written.

The plan noted `PLAYOFF_EDGE_MIN` as an export constant but the actual export is `PLAYOFF_EDGE_MIN_INCREMENT` (matches the task spec precisely). No ambiguity.

## Self-Check

```
[ -f "apps/worker/src/utils/playoff-detection.js" ] && echo "FOUND" || echo "MISSING"
[ -f "apps/worker/src/__tests__/playoff-detection.test.js" ] && echo "FOUND" || echo "MISSING"
[ -f "apps/worker/src/__tests__/run-nhl-model.test.js" ] && echo "FOUND" || echo "MISSING"
```

## Self-Check: PASSED

All created files exist. Commits 2752780 and 98b8730 both present in git log.
