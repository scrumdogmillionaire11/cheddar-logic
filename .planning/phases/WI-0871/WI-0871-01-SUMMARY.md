---
phase: WI-0871
plan: 01
subsystem: mlb-model
tags: [mlb, f5-ml, projectF5ML, projectTeamF5RunsAgainstStarter, run-projection, offense-composite]

# Dependency graph
requires:
  - phase: WI-0821
    provides: resolveOffenseComposite + projectTeamF5RunsAgainstStarter (per-team F5 run model)
provides:
  - projectF5ML() accepts homeOffenseProfile/awayOffenseProfile/context as optional params
  - When both offense profiles present — calls projectTeamF5RunsAgainstStarter for each side; shared run distribution with F5 total path
  - ERA formula fallback (F5_ML_FALLBACK_ERA) preserved when profiles absent or f5_runs degrades to null
  - Confidence derivation: starts at 7; -1 per side with degraded_inputs; floor 5
  - run_mlb_model.js call site updated to pass mlb.home_offense_profile / mlb.away_offense_profile
  - 4 new tests: shared-path alignment, elite-offense uplift, ERA fallback, confidence drop
affects:
  - WI-0877 (synthetic-line edge path — also needs projectTeamF5RunsAgainstStarter exported)
  - Any downstream F5 ML consumer that inspects projection_source or confidence

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Optional-extension pattern: new params default null so existing 4-arg callers are unaffected (backward compat)"
    - "Shared run model: F5 total and F5 ML now compute run expectations through identical projectTeamF5RunsAgainstStarter() path"
    - "Two-tier projection_source: FULL_MODEL_F5_ML (aligned) vs F5_ML_FALLBACK_ERA (degraded/absent profiles)"

key-files:
  created: []
  modified:
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/models/__tests__/mlb-model.test.js
    - apps/worker/src/jobs/run_mlb_model.js

key-decisions:
  - "Kept logistic coefficient 0.8 (empirical for F5) unchanged — only run-mean inputs were replaced"
  - "Fallback to ERA formula when either offenseProfile is absent rather than gating entirely — preserves F5 ML card generation for data-poor games"
  - "Confidence fixed at 7 (not inherited from projectF5Total) — the aligned path never calls projectF5Total"
  - "Call site passes mlb.home_offense_profile ?? null — coalesces with the null default so ERA fallback is automatic on missing profiles"

patterns-established:
  - "Optional profile enrichment: add new capability params with null defaults so existing tests and call sites continue without modification"
  - "Two-level projection_source taxonomy: FULL_MODEL_* for aligned paths, *_FALLBACK_ERA for legacy fallbacks"

# Metrics
duration: ~1 day
completed: 2026-04-11
---

# WI-0871: Fix F5 ML Formula — Summary

**projectF5ML() now uses the shared per-team run distribution (projectTeamF5RunsAgainstStarter) when offense profiles are present, aligning F5 ML edge with F5 total math; ERA fallback preserved for data-poor games.**

## Performance

| Metric | Value |
|--------|-------|
| Tasks | 1/1 |
| Tests | 4 new passing; 97/97 run_mlb_model.test all pass; 17/17 mlb-model.test all pass |
| Regressions | 0 |
| Files modified | 3 |
| Duration | ~1 day |

## Commits

| Hash | Message | Files |
|------|---------|-------|
| 702c77c | WI-0871: align F5 ML with shared run projection path | mlb-model.js, mlb-model.test.js, run_mlb_model.js |

## Acceptance Criteria Results

| AC | Status | Evidence |
|----|--------|---------|
| 1. reads f5_runs from projectTeamF5RunsAgainstStarter when profiles present | ✅ PASS | mlb-model.js lines 733–744; test "uses the shared per-team F5 run means" |
| 2. winProbHome logistic 0.8 preserved | ✅ PASS | mlb-model.js line 781 |
| 3. f5_runs null → ERA fallback + F5_ML_FALLBACK_ERA | ✅ PASS | test "falls back to legacy ERA math when offense inputs are missing" |
| 4. Same pitcher/offense → identical f5_runs in F5 total and F5 ML | ✅ PASS | test "uses the shared per-team F5 run means when offense/context inputs are provided" |
| 5. Elite-offense vs poor pitcher → higher f5_runs | ✅ PASS | test "elite offense against a weaker starter raises home F5 runs and win probability" |
| 6. Existing WI-0603 10-test block passes unchanged | ✅ PASS | run_mlb_model.test.js 97/97 pass |
| 7. Confidence starts at 7; drops for degraded_inputs | ✅ PASS | test "confidence starts at 7 on the aligned path and drops for degraded inputs" |
| 8. npm test passes, zero regressions | ✅ PASS | 1480/1481 tests pass; sole failure is signal-engine WIP (see note) |

**Note on test suite:** 1 failure in `signal-engine.test.js` is from unstaged WIP to `potd/signal-engine.js` (WI-0878 in-progress). Confirmed pre-existing: full suite passes after `git stash` of the working-tree changes. Zero WI-0871 regressions.

## Deviations from Plan

None — plan executed exactly as written. The implementation commit (702c77c) predates the SUMMARY creation; plan patches applied afterward (41a790d, 7a47fd9, 4500692) were for WI-0872 and WI-0877, not WI-0871.

## Next Phase Readiness

**WI-0877** (synthetic-line F5 edge path) depends on `projectTeamF5RunsAgainstStarter` being exported from `mlb-model.js`. As of this commit it is **NOT yet exported**. Step 0 of WI-0877-01-PLAN.md adds the export — execute WI-0877 on a fresh branch.
