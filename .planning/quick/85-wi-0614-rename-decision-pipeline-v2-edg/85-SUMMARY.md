---
phase: quick
plan: 85
subsystem: models
tags: [rename, edge-config, housekeeping]
dependency_graph:
  requires: [WI-0614]
  provides: [decision-pipeline-v2-edge-config]
  affects:
    - packages/models/src/decision-pipeline-v2.js
    - packages/models/src/index.js
    - scripts/calibrate_nba_totals.js
tech_stack:
  added: []
  patterns: [module-rename, require-path-update]
key_files:
  created:
    - packages/models/src/decision-pipeline-v2-edge-config.js
  modified:
    - packages/models/src/decision-pipeline-v2.js
    - packages/models/src/index.js
    - packages/models/src/__tests__/decision-pipeline-v2-nba-total-quarantine.test.js
    - scripts/calibrate_nba_totals.js
    - WORK_QUEUE/COMPLETE/WI-0614.md
    - .planning/STATE.md
  deleted:
    - packages/models/src/decision-pipeline-v2.patch.js
decisions:
  - Preserved runtime logic and exports exactly; only the module filename and listed live call sites changed.
metrics:
  duration: "~10 minutes"
  completed: "2026-03-28"
  tasks_completed: 2
  tests_run: 2
---

# Quick Task 85: WI-0614 Rename decision-pipeline-v2.patch.js

**One-liner:** Renamed the active production edge-config module to `decision-pipeline-v2-edge-config.js`, updated every in-scope live caller, and closed WI-0614 without changing runtime behavior.

## What Was Done

- Renamed `packages/models/src/decision-pipeline-v2.patch.js` to `packages/models/src/decision-pipeline-v2-edge-config.js` with identical contents.
- Updated in-scope callers to the new path:
  - `packages/models/src/decision-pipeline-v2.js`
  - `packages/models/src/index.js`
  - `packages/models/src/__tests__/decision-pipeline-v2-nba-total-quarantine.test.js`
  - `scripts/calibrate_nba_totals.js`
- Moved `WORK_QUEUE/WI-0614.md` to `WORK_QUEUE/COMPLETE/WI-0614.md`.
- Updated `.planning/STATE.md` to record qt-85 and the latest activity.

## Verification

- `rg -n "decision-pipeline-v2\\.patch(\\.js)?" packages scripts --glob '!**/node_modules/**'`
  - No remaining live code references to the old module path.
- `npm --prefix apps/worker test`
  - Failed in pre-existing, out-of-scope suites:
    - `src/jobs/__tests__/run_nhl_model.market-calls.test.js`
    - `src/utils/__tests__/decision-publisher.v2.test.js`
    - `src/__tests__/run-mlb-model.dual-run.test.js`
  - These failures are outside WI-0614 scope and were not changed by this rename-only task.
- `npx tsc --noEmit --project web/tsconfig.json`
  - Passed.

## Scope Check

- [x] Rename limited to the module file and listed live callers
- [x] No logic, thresholds, or exports changed
- [x] WI-0614 moved to `WORK_QUEUE/COMPLETE/`
- [x] STATE records qt-85

## Self-Check: PASSED

- `packages/models/src/decision-pipeline-v2.patch.js` is absent from the working tree
- `packages/models/src/decision-pipeline-v2-edge-config.js` exists
- `rg` confirms live code uses the new module path
- Summary and state updates were written inside the qt-85 directory and approved scope
