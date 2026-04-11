---
phase: quick-154
plan: 01
subsystem: potd-signal-engine
tags: [nhl, goalie-composite, signal-engine, moneyline, potd]
dependency_graph:
  requires: [WI-0823 nhl-pace-model resolveGoalieComposite, WI-0880 h2h market on NHL odds]
  provides: [resolveNHLModelSignal, getLatestNhlModelOutput, NHL moneyline model override]
  affects: [signal-engine.js scoreCandidate, buildCandidates, run_potd_engine gatherBestCandidate]
tech_stack:
  added: []
  patterns: [mirror MLB oddsSnapshot pattern for NHL nhlSnapshot, complement AWAY win prob from HOME]
key_files:
  created: []
  modified:
    - packages/data/src/db/cards.js
    - packages/data/src/db/index.js
    - packages/data/index.js
    - apps/worker/src/jobs/potd/signal-engine.js
    - apps/worker/src/jobs/potd/run_potd_engine.js
    - apps/worker/src/jobs/potd/__tests__/signal-engine.test.js
decisions:
  - "Used payload_data column (not raw_data which does not exist in card_payloads schema)"
  - "h2h rows use { home, away } field names — resolver reads both home/homePrice with fallback"
  - "goalieEdgeDelta clamped to [-0.06, 0.06]; homeModelWinProb clamped to [0.05, 0.95]"
metrics:
  duration_minutes: 25
  completed_date: "2026-04-11"
  tasks_completed: 2
  tasks_total: 2
  new_tests: 22
  files_modified: 6
---

# Phase quick-154 Plan 01: Wire NHL Goalie Composite into POTD Signal Summary

**One-liner:** NHL POTD moneyline scoring now uses goalie composite (GSaX + SV%) from card_payloads to produce model-backed edge scores instead of relying on vig-removal consensus alone.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add getLatestNhlModelOutput and wire nhlSnapshot in run_potd_engine | 2f0c925 | cards.js, db/index.js, data/index.js, run_potd_engine.js |
| 2 | Implement resolveNHLModelSignal in signal-engine and add tests | 096653b | signal-engine.js, signal-engine.test.js, cards.js (bug fix) |

## What Was Built

### Task 1: getLatestNhlModelOutput + nhlSnapshot wiring

- Added `getLatestNhlModelOutput(gameId)` to `packages/data/src/db/cards.js` — queries `card_payloads WHERE sport='icehockey_nhl' ORDER BY created_at DESC LIMIT 1`, parses `payload_data` JSON, returns `{ homeGoalie: { savePct, gsax }, awayGoalie: { savePct, gsax } }` with dual-key fallback (flat keys `goalie_home_save_pct` / legacy nested `goalie.home.save_pct`). Returns `null` when no row found.
- Re-exported from `packages/data/src/db/index.js` and `packages/data/index.js`.
- In `run_potd_engine.js`: destructured `getLatestNhlModelOutput` from `@cheddar-logic/data`; expanded `gatherBestCandidate` ternary to attach `nhlSnapshot` for `sport === 'NHL'` games — exact mirror of the MLB `oddsSnapshot` branch.

### Task 2: resolveNHLModelSignal + NHL scoreCandidate override

- Added `isNhlSport(sport)` — recognises `'NHL'` and `'ICEHOCKEY_NHL'` tokens (case-insensitive).
- Added `resolveNHLModelSignal(game)`:
  - Returns `null` if `game.nhlSnapshot` is null or both goalies have no data.
  - Calls `resolveGoalieComposite(savePct, gsax)` for each side (defaults to neutral `0.5` for missing side).
  - Computes `goalieEdgeDelta = clamp(homeComposite - awayComposite, -0.06, 0.06)`.
  - Derives `consensusImpliedHome` via `medianImplied` on raw h2h rows + `removeVigFromImplied`.
  - Returns `{ homeModelWinProb: round(clamp(consensusImpliedHome + goalieEdgeDelta, 0.05, 0.95), 6), projection_source }`.
  - `projection_source` is `'NHL_GOALIE_COMPOSITE'` when both sides have data, `'NHL_GOALIE_PARTIAL'` otherwise.
- NHL block in `buildCandidates`: attaches `nhlSignal` to all candidates when `isNhlSport` and snapshot is present.
- NHL override in `scoreCandidate`:
  - `HOME`: `modelWinProb = nhlSignal.homeModelWinProb`
  - `AWAY`: `modelWinProb = round(1 - nhlSignal.homeModelWinProb, 6)` (complement, not mirror)
  - `edgePct = modelWinProb - impliedProb(price)` — selection-specific
  - `scoreBreakdown` includes `model_win_prob` and `projection_source`
- Exported `isNhlSport` and `resolveNHLModelSignal` from `module.exports`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed SQL column name in getLatestNhlModelOutput**
- **Found during:** Task 2 (test run revealed SQL prepare error)
- **Issue:** Plan spec used `raw_data` column name but `card_payloads` table has `payload_data` (verified in migration 005_create_card_payloads.sql)
- **Fix:** Changed `SELECT raw_data` to `SELECT payload_data` and `row.raw_data` to `row.payload_data`
- **Files modified:** `packages/data/src/db/cards.js`
- **Commit:** 096653b

**2. [Rule 1 - Bug] Fixed h2h field names in resolveNHLModelSignal**
- **Found during:** Task 2 (pre-emptive code review before test run)
- **Issue:** Plan spec used `r?.homePrice` / `r?.awayPrice` but raw h2h rows use `{ home, away }` field names (as established by `buildMoneylineCandidates` consensus computation at lines 213-214)
- **Fix:** Changed to `r?.home ?? r?.homePrice` and `r?.away ?? r?.awayPrice` for robust dual-key reading
- **Files modified:** `apps/worker/src/jobs/potd/signal-engine.js`
- **Commit:** 096653b

## Test Results

- 22 new tests added across 3 describe blocks: `isNhlSport` (6), `resolveNHLModelSignal` (9), `scoreCandidate - NHL moneyline override` (7)
- All 55 POTD tests pass (41 signal-engine + 14 run-potd-engine)
- Full worker suite: 1 pre-existing failure in `check_pipeline_health.test.js` (confirmed pre-existing via git stash verification)

## Self-Check: PASSED

- `packages/data/src/db/cards.js` — getLatestNhlModelOutput function present
- `packages/data/index.js` — getLatestNhlModelOutput re-exported
- `apps/worker/src/jobs/potd/signal-engine.js` — isNhlSport, resolveNHLModelSignal, NHL buildCandidates block, NHL scoreCandidate block present
- `apps/worker/src/jobs/potd/run_potd_engine.js` — nhlSnapshot branch in gatherBestCandidate present
- Commits 2f0c925 and 096653b exist in git log
- `node -e "const { getLatestNhlModelOutput } = require('./packages/data'); console.log(typeof getLatestNhlModelOutput)"` → `function`
