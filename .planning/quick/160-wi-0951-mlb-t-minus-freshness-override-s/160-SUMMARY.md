---
phase: quick-160
plan: 01
subsystem: scheduler/mlb
tags: [mlb, scheduler, freshness, t-minus, pre-model-pull, WI-0951]
dependency_graph:
  requires: [WI-0950 (cadence-aligned execution gate freshness contract)]
  provides: [MLB T-minus freshness override schedule with pre-model pull and structured logging]
  affects: [apps/worker/src/schedulers/mlb.js, apps/worker/src/schedulers/windows.js]
tech_stack:
  added: []
  patterns: [claimTminusPullSlot dedupe, structured JSON logging, band-ladder resolver]
key_files:
  created: []
  modified:
    - apps/worker/src/schedulers/windows.js
    - apps/worker/src/schedulers/mlb.js
    - apps/worker/src/__tests__/scheduler-windows.test.js
    - apps/worker/src/__tests__/scheduler-main-calibration.test.js
decisions:
  - Ladder order: descending (180/90/45/15) matching plan behavior spec; resolver uses Math.min on matches to pick strictest
  - Floor constraint added: minutesToGame < min(ladder.minutesToGameLte) returns null (e.g., 14 => null)
  - Mock leak fix: afterEach calls jest.unmock('../schedulers/windows') to prevent FALLBACK_BASELINE test from polluting dedupe test
metrics:
  duration: ~30 minutes
  completed: 2026-04-16
  tasks_completed: 2
  files_modified: 4
---

# Quick Task 160: WI-0951 MLB T-minus Freshness Override Schedule Summary

**One-liner:** MLB T-minus model runs now tighten snapshot freshness by minutes-to-game band (15/45/90/180 min ladder) and enqueue a deduped pre-model odds pull before run_mlb_model when triggerPreModelRefresh=true.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add TMinusFreshnessOverride resolver and key builder to windows.js | e513127f | windows.js, scheduler-windows.test.js |
| 2 | Rewire MLB T-minus loop with override evaluation, structured logging, deduped pre-model pull | a39e2fcb | mlb.js, scheduler-main-calibration.test.js |

---

## WI-0951 Guard Evidence

### Pre-model pull ordering

For a game at T-28 (minutesToGame=28, band=45, triggerPreModelRefresh=true), the jobs array contains:
```
[
  { jobName: 'run_mlb_model', jobKey: 'mlb|fixed|2026-04-15|1500' },  // fixed run
  { jobName: 'pull_odds_hourly', jobKey: 'pull-odds:mlb:premodel:test:45:2026-04-15T19:00' },  // pre-model pull
  { jobName: 'run_mlb_model', jobKey: 'mlb|tminus|test|30' }           // T-minus model
]
```

The pre-model pull_odds_hourly job appears before the T-minus run_mlb_model. Test confirms `oddsPremodelIdx < tminusModelIdx`.

### Sample EXECUTION_FRESHNESS_TMINUS log payloads

**Triggered band (band 45, decision: ALLOW_AFTER_REFRESH):**
```json
{
  "type": "EXECUTION_FRESHNESS_TMINUS",
  "minutes_to_game": 28,
  "matched_band": 45,
  "required_max_snapshot_age_minutes": 20,
  "triggered_refresh": true,
  "decision": "ALLOW_AFTER_REFRESH"
}
```

**Non-triggered band (band 180, decision: ALLOW):**
```json
{
  "type": "EXECUTION_FRESHNESS_TMINUS",
  "minutes_to_game": 118,
  "matched_band": 180,
  "required_max_snapshot_age_minutes": 75,
  "triggered_refresh": false,
  "decision": "ALLOW"
}
```

**No override row (decision: FALLBACK_BASELINE):**
```json
{
  "type": "EXECUTION_FRESHNESS_TMINUS",
  "minutes_to_game": null,
  "matched_band": null,
  "required_max_snapshot_age_minutes": null,
  "triggered_refresh": false,
  "decision": "FALLBACK_BASELINE"
}
```

### Dedupe proof

With a `claimTminusPullSlot` mock that returns `true` on first call and `false` on subsequent calls for the same key:
- Call 1: claimFn returns true → pull_odds_hourly pushed (1 job)
- Call 2: claimFn returns false → no push (0 jobs)
- Total across both calls: 1 unique pre-model pull key

Test confirms: `oddsPremodelJobs.length === 1`

### Boundary and precedence evidence

From scheduler-windows.test.js (15 tests):

| minutesToGame | Expected band | Result |
|---|---|---|
| 180 | 180 | PASS |
| 90 | 90 | PASS |
| 45 | 45 | PASS |
| 15 | 15 | PASS |
| 38 | 45 (not 90 or 180) | PASS |
| 14 | null | PASS |
| 181 | null | PASS |

Strictest-match precedence: `38 => band 45`, not band 90 or 180 — confirmed by `result.minutesToGameLte < 90`.

### Key format

`keyMlbPremodelOdds('mlb_game_1', 45, '2026-04-15T19:38')` => `'pull-odds:mlb:premodel:mlb_game_1:45:2026-04-15T19:38'`

Truncation: `keyMlbPremodelOdds('mlb_game_2', 90, '2026-04-15T19:38:00.000Z')` => `'pull-odds:mlb:premodel:mlb_game_2:90:2026-04-15T19:38'`

---

## Test Results

```
scheduler-windows.test.js:         39 passed
scheduler-main-calibration.test.js: 16 passed
Total:                              55 passed, 0 failed
```

All 4 verification commands pass:
1. `node --check apps/worker/src/schedulers/mlb.js` — PASS
2. `node --check apps/worker/src/schedulers/main.js` — PASS
3. `npm --prefix apps/worker run test -- --runInBand src/__tests__/scheduler-windows.test.js` — 39/39 PASS
4. `npm --prefix apps/worker run test -- --runInBand src/__tests__/scheduler-main-calibration.test.js` — 16/16 PASS

---

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Floor constraint added to resolveTMinusFreshnessOverride**
- **Found during:** Task 1 RED→GREEN cycle
- **Issue:** The plan spec says `minutesToGame=14 => null (below all thresholds)`. With pure `minutesToGame <= minutesToGameLte` filter, 14 <= 15 is true so band 15 would be selected. The spec intent is that band 15 applies only from minutesToGame=15 upward.
- **Fix:** Added a floor check: `if (minutesToGame < min(ladder.minutesToGameLte)) return null`. For default ladder, floor=15.
- **Files modified:** apps/worker/src/schedulers/windows.js
- **Commit:** e513127f

**2. [Rule 1 - Bug] Jest mock leak between FALLBACK_BASELINE test and dedupe test**
- **Found during:** Task 2 test debugging
- **Issue:** The FALLBACK_BASELINE test uses `jest.doMock('../schedulers/windows', ...)` to mock `resolveTMinusFreshnessOverride` to return null. `jest.resetModules()` clears the module registry but NOT mock factory registrations. The windows mock leaked into the dedupe test, causing all mlb.js T-minus jobs to see `override=null` and produce 0 pre-model pull jobs.
- **Fix:** Added `jest.unmock('../schedulers/windows')` to the WI-0951 describe's `afterEach` hook.
- **Files modified:** apps/worker/src/__tests__/scheduler-main-calibration.test.js
- **Commit:** a39e2fcb

**3. [Rule 1 - Bug] computeMlbJobsForGame helper didn't re-setup feature flag mock after jest.resetModules()**
- **Found during:** Task 2 test debugging
- **Issue:** The outer describe's `beforeEach` sets `ENABLE_MLB_MODEL=false` via process.env. The helper `computeMlbJobsForGame` called `jest.resetModules()` (clearing feature-flags mock from WI-0951 `beforeEach`) and loaded the real feature-flags module, which saw `ENABLE_MLB_MODEL=false` and returned `[]`.
- **Fix:** Added `jest.doMock('@cheddar-logic/data/src/feature-flags', ...)` inside `computeMlbJobsForGame` after `jest.resetModules()`.
- **Files modified:** apps/worker/src/__tests__/scheduler-main-calibration.test.js
- **Commit:** a39e2fcb

---

## Self-Check

Files exist:
- apps/worker/src/schedulers/windows.js — FOUND
- apps/worker/src/schedulers/mlb.js — FOUND
- apps/worker/src/__tests__/scheduler-windows.test.js — FOUND
- apps/worker/src/__tests__/scheduler-main-calibration.test.js — FOUND

Commits exist:
- e513127f — FOUND
- a39e2fcb — FOUND

## Self-Check: PASSED
