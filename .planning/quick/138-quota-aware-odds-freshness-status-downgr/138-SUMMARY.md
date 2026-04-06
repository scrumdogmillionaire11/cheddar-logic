---
phase: quick-138
plan: "01"
subsystem: worker/pipeline-health
tags: [quota, health-check, odds-freshness, warning-downgrade]
dependency_graph:
  requires: [apps/worker/src/schedulers/quota.js]
  provides: [quota-aware checkOddsFreshness]
  affects: [pipeline_health dashboard, odds freshness alerts]
tech_stack:
  added: []
  patterns: [quota-tier branching, jest.doMock module isolation, TDD]
key_files:
  modified:
    - apps/worker/src/jobs/check_pipeline_health.js
    - apps/worker/src/__tests__/check-pipeline-health.mlb.test.js
decisions:
  - "Export checkOddsFreshness from module to enable unit testing (was previously private)"
  - "Write 'warning' (not 'failed') when stale odds + MEDIUM/LOW/CRITICAL quota tier"
  - "Warning reason string contains tier name and 'paused' per plan spec"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-06"
  tasks_completed: 2
  files_modified: 2
---

# Quick Task 138: Quota-Aware Odds Freshness Status Downgrade — Summary

**One-liner:** `checkOddsFreshness` now writes `warning` (not `failed`) when odds are stale due to quota-constrained scheduler pausing odds fetches (tier MEDIUM/LOW/CRITICAL), eliminating false-alarm failure streaks on the pipeline health dashboard.

## What Was Built

`checkOddsFreshness` in `check_pipeline_health.js` previously always wrote `status='failed'` when stale odds were found. This caused false-positive failure alerts whenever the quota scheduler legitimately paused odds fetching due to low token budget.

The fix adds quota-tier awareness: when the scheduler is at MEDIUM, LOW, or CRITICAL tier (which all pause odds fetching), stale odds is expected behavior and the status is downgraded to `warning`. The reason string includes the tier name and explains the fetch is paused. FULL-tier behavior is unchanged — stale odds still write `failed`.

## Tasks

| Task | Name                                                                              | Commit  | Files                                                               |
| ---- | --------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------- |
| 1    | Import getCurrentQuotaTier and downgrade stale odds status when quota-constrained | 1582632 | apps/worker/src/jobs/check\_pipeline\_health.js                     |
| 2    | Add checkOddsFreshness quota-aware tests                                          | 5c17550 | check-pipeline-health.mlb.test.js, check\_pipeline\_health.js       |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Export `checkOddsFreshness` from module**

- **Found during:** Task 2
- **Issue:** `checkOddsFreshness` was not in `module.exports`, causing `require('../jobs/check_pipeline_health').checkOddsFreshness` to return `undefined`, breaking all three new tests with `TypeError: checkOddsFreshness is not a function`
- **Fix:** Added `checkOddsFreshness` to `module.exports` alongside `checkPipelineHealth` and `checkMlbF5MarketAvailability`
- **Files modified:** `apps/worker/src/jobs/check_pipeline_health.js`
- **Commit:** 5c17550

## Self-Check: PASSED

- FOUND: apps/worker/src/jobs/check_pipeline_health.js
- FOUND: apps/worker/src/__tests__/check-pipeline-health.mlb.test.js
- FOUND: commit 1582632
- FOUND: commit 5c17550
