---
phase: WI-0780-scheduler-decompose
plan: "02"
subsystem: scheduler
tags: [scheduler, nhl, nba, refactor]
completed: "2026-04-05"
duration: "~8 minutes"

dependency-graph:
  requires:
    - WI-0780-01 (windows.js baseline)
  provides:
    - schedulers/nhl.js — computeNhlDueJobs (sections 2.55, 2.6, 2.8, 2.9, NHL model)
    - schedulers/nba.js — computeNbaDueJobs (section 2.8b, NBA model)
  affects:
    - WI-0780-03 (slimming pass removes original sections from main.js)

tech-stack:
  added: []
  patterns:
    - Sub-scheduler pattern confirmed: computeXxxDueJobs(nowEt, ctx) with sport-filtered games
    - T-minus pre-model odds pulls delegated via claimTminusPullSlot context param

key-files:
  created:
    - apps/worker/src/schedulers/nhl.js
    - apps/worker/src/schedulers/nba.js
  modified:
    - apps/worker/src/schedulers/main.js

decisions:
  - desc: "Guard expression uses local const from process.env, evaluated at call-time (not module top)"
    why: "Consistent with how main.js reads env flags; safe for test env overrides"
  - desc: "Migration comments for nhl/nba delegate calls align with nfl comment format from Plan 01"
    why: "All three will be uncommented simultaneously in Plan 03 — uniform comment style makes that edit predictable"
---

# Phase WI-0780 Plan 02: NHL and NBA Sub-Schedulers Summary

**One-liner:** Created `nhl.js` (5 concerns: SOG sync + team stats + availability + goalie + model) and `nba.js` (2 concerns: availability + model) following validated `computeXxxDueJobs(nowEt, ctx)` interface.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create schedulers/nhl.js | 942b033 | apps/worker/src/schedulers/nhl.js |
| 2 | Create schedulers/nba.js | 942b033 | apps/worker/src/schedulers/nba.js, apps/worker/src/schedulers/main.js |

## Decisions Made

1. **nhl.js guard checks all 4 feature flags together** — returns `[]` only if ALL of `ENABLE_NHL_MODEL`, `ENABLE_NHL_PLAYER_AVAILABILITY_SYNC`, `ENABLE_NHL_GOALIE_STARTERS`, and `ENABLE_NHL_SOG_PLAYER_SYNC` are disabled, consistent with main.js behavior.

2. **nba.js returns early jobs array (not empty)** — if `ENABLE_NBA_MODEL=false` but availability sync is enabled, the function still returns the availability sync job. The guard only skips the model sections.

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- `node --check apps/worker/src/schedulers/nhl.js` → OK
- `node --check apps/worker/src/schedulers/nba.js` → OK
- `node --check apps/worker/src/schedulers/main.js` → OK
- `npm run test -- --testPathPattern scheduler` → **54/54 pass**
- DRY_RUN output: unchanged (old sections still active)

## Next Phase Readiness

- Plan 03 ready: mlb.js + settlement.js + slimming pass
- All 5 sub-scheduler imports are now in main.js (3 active requires + 2 pending for mlb/settlement)
- No blockers
