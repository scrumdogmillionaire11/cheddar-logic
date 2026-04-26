---
phase: WI-0780-scheduler-decompose
plan: "01"
subsystem: scheduler
tags: [scheduler, windows, nfl, refactor]
completed: "2026-04-05"
duration: "~10 minutes"

dependency-graph:
  requires: []
  provides:
    - schedulers/windows.js — all pure key builders and time predicates
    - schedulers/nfl.js — computeNflDueJobs (first working sub-scheduler)
  affects:
    - WI-0780-02 (imports windows.js in nhl.js and nba.js)
    - WI-0780-03 (slimming pass reads windows.js exports)

tech-stack:
  added: []
  patterns:
    - Sub-scheduler interface: computeXxxDueJobs(nowEt, ctx) with context params
    - windows.js: zero-DB shared utility module for all sub-schedulers

key-files:
  created:
    - apps/worker/src/schedulers/windows.js
    - apps/worker/src/schedulers/nfl.js
  modified:
    - apps/worker/src/schedulers/main.js

decisions:
  - desc: "ODDS_FETCH_SLOT_MINUTES read inline in keyEspnGamesDirect/keyOddsHourly rather than at module top level"
    why: "Keeps functions pure relative to caller; consistent with original verbatim copy as spec requires"
  - desc: "NFL T-minus loop filters games to sport==='nfl' inside the function; no pre-model odds pull since NFL is not a projection-model sport (NBA/NHL only)"
    why: "isProjectionModelSport returns false for nfl — faithful replication of SPORT_JOBS loop behavior"
  - desc: "Migration call to computeNflDueJobs added as comment in main.js before section 4 — not activated"
    why: "Avoids double-firing NFL jobs during migration; uncommented in Plan 03 when old sections are removed"
---

# Phase WI-0780 Plan 01: Scheduler Windows Utilities + NFL Sub-Scheduler Summary

**One-liner:** Created `windows.js` shared utility module (27 pure exports) and `nfl.js` first sub-scheduler validating the `computeXxxDueJobs(nowEt, ctx)` interface.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create schedulers/windows.js — pure key generators and time predicates | ec5e194 | apps/worker/src/schedulers/windows.js |
| 2 | Create schedulers/nfl.js and wire into main.js | 7e48ee0 | apps/worker/src/schedulers/nfl.js, apps/worker/src/schedulers/main.js |

## Decisions Made

1. **`windows.js` copies key-builder functions verbatim** — ODDS_FETCH_SLOT_MINUTES is read inline inside each function (not at module level) to keep functions pure and match the original behavior exactly.

2. **NFL sub-scheduler receives context params** — `pullOddsHourly`, `claimTminusPullSlot`, `ENABLE_WITHOUT_ODDS_MODE`, and `maybeQueueTeamMetricsRefresh` are received as context params rather than imported directly, avoiding circular dependencies and making the dependency graph explicit.

3. **Migration call commented** — The delegate call `computeNflDueJobs(...)` is added as a comment in `main.js` before section 4. Activating it before removing the old SPORT_JOBS loop would double-fire NFL model jobs. It is uncommented and the old sections removed in Plan 03.

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- `node --check apps/worker/src/schedulers/windows.js` → OK
- `node --check apps/worker/src/schedulers/nfl.js` → OK  
- `node --check apps/worker/src/schedulers/main.js` → OK
- `npm run test:scheduler:windows` (via `--testPathPattern scheduler`) → **54/54 pass**
- DRY_RUN output: unchanged (old SPORT_JOBS loop still active; NFL jobs still fire via existing section 3)

## Next Phase Readiness

- Plan 02 can proceed: `windows.js` exports all 27 functions; nfl.js proves the interface works
- NHL and NBA sub-schedulers import `{ ..., keyNhlPlayerAvailabilitySync, keyNbaPlayerAvailabilitySync, keyNhlGoalieStarters, keyNhlSogPlayerSync, keyNhlTeamStats }` from `windows.js`
- No blockers

---
_Completed: 2026-04-05 — GitHub Copilot (pax-executor)_
