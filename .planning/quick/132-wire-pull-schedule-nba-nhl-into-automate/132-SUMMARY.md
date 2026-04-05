---
phase: quick-132
plan: 01
subsystem: scheduler
tags: [scheduler, nba, nhl, games-table, pull_schedule_nba, pull_schedule_nhl, computeDueJobs]

# Dependency graph
requires: []
provides:
  - pull_schedule_nba wired into tick loop at 04:00 ET and 11:00 ET via getScheduleRefreshDue()
  - pull_schedule_nhl wired into tick loop at 04:00 ET and 11:00 ET via getScheduleRefreshDue()
  - keyPullScheduleNba and keyPullScheduleNhl exported from main.js module.exports
  - scheduler-windows test asserting NBA/NHL schedule pull jobs emit at 04:05 ET
affects: [scheduler, nba-model, nhl-model, games-table, team-sequence-signals]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Schedule pull jobs wired via getScheduleRefreshDue() returning non-null at 04:00 ET and 11:00 ET fixed windows"
    - "Daily key pattern for idempotency: pull_schedule_nba|<date> (no hour suffix — same key re-used across both windows after first success)"
    - "ENABLE_ env flag defaulting to true via !== 'false' pattern, consistent with all other scheduler feature flags"

key-files:
  created: []
  modified:
    - apps/worker/src/schedulers/main.js
    - apps/worker/src/__tests__/scheduler-windows.test.js

key-decisions:
  - "keyPullScheduleNba and keyPullScheduleNhl use date-only keys (no hour suffix) so the job is idempotent across the two daily windows — the first success blocks the second window trigger"
  - "Previous executor had already added the requires, env flags, key builders, and computeDueJobs entries — only the module.exports entries were missing"

patterns-established:
  - "Schedule pull jobs: date-scoped idempotency key, ENABLE_ flag default-on, getScheduleRefreshDue() gate"

requirements-completed: [QUICK-132]

# Metrics
duration: 12min
completed: 2026-04-05
---

# Quick Task 132: Wire pull_schedule_nba and pull_schedule_nhl into Automate Summary

**NBA and NHL schedule pull jobs wired into the scheduler tick loop at 04:00 ET and 11:00 ET via getScheduleRefreshDue(), with ENABLE_ env flags and date-scoped idempotency keys**

## Performance

- **Duration:** ~12 min
- **Started:** 2026-04-05T~01:00Z
- **Completed:** 2026-04-05
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `keyPullScheduleNba` and `keyPullScheduleNhl` to `module.exports` in main.js (the one missing piece — previous executor had already wired requires, ENABLE_ constants, key builders, and computeDueJobs entries)
- Added jest test asserting both `pull_schedule_nba` and `pull_schedule_nhl` appear in `computeDueJobs` output at 04:05 ET
- All 10 scheduler-windows tests pass with no regressions

## Task Commits

1. **Task 1: Wire pull_schedule_nba and pull_schedule_nhl into main.js** - `f29570c` (feat)
2. **Task 2: Assert schedule pulls appear in scheduler-windows test at 04:00 ET** - `1bbe0b6` (test)

## Files Created/Modified

- `apps/worker/src/schedulers/main.js` - Added `keyPullScheduleNba` and `keyPullScheduleNhl` to module.exports (requires, ENABLE_ flags, key builders, computeDueJobs entries were already present from previous executor run)
- `apps/worker/src/__tests__/scheduler-windows.test.js` - Added jest test block asserting NBA/NHL schedule jobs emitted at 04:05 ET

## Decisions Made

- Used date-only key (no hour suffix) for both schedule pull jobs to ensure idempotency across the two daily windows (04:00 ET and 11:00 ET). Once the first window succeeds, `shouldRunJobKey` blocks the second window from re-running the same day.
- Test added as a jest `test()` block (not inside the plain `runSchedulerWindowTests()` function) to match the established pattern of the MLB statcast test at line 248.

## Deviations from Plan

**Note on prior executor state:** The previous executor (which made no commits) had already written most of Task 1 — requires, ENABLE_ constants, key builder functions, and computeDueJobs entries were all present in main.js. Only `keyPullScheduleNba` and `keyPullScheduleNhl` were missing from `module.exports`. Task 1 completion was adding those two export entries.

None beyond the above — plan executed correctly for both tasks once prior state was accounted for.

## Issues Encountered

None. The module already loaded cleanly; the exports were the only gap.

## Next Phase Readiness

- `pull_schedule_nba` and `pull_schedule_nhl` now run automatically at 04:00 ET and 11:00 ET each day
- Games table will be kept fresh without manual script invocation
- Team-sequence signals (Welcome Home Fade, etc.) for NBA/NHL can now rely on continuously refreshed game records

---
*Quick Task: 132*
*Completed: 2026-04-05*
