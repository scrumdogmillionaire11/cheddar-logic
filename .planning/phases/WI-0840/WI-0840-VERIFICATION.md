---
phase: WI-0840
verified: 2026-04-09T22:20:17.539115Z
status: human_needed
score: 8/8 must-haves verified
human_verification:
  - test: Confirm dynamic computation in production
    expected: "[MLB_LEAGUE_AVG] source=computed n>=50 in worker log once mid-April MLB data accumulates"
    why_human: Requires live mlb_pitcher_stats rows >= 50 from 2026 season; cannot mock production DB
---

# WI-0840: MLB Dynamic League Constants - Verification Report

Verified: 2026-04-09T22:20:17.539115Z
Status: human_needed - all automated checks pass; one production smoke-test deferred to mid-April 2026

## Score: 8/8 must-haves verified

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | computeMLBLeagueAverages exists, 79 lines, exported | VERIFIED | module.exports = { computeMLBLeagueAverages } |
| 2 | Returns static_2024 when n < 50 | VERIFIED | code + 2 unit tests confirm |
| 3 | Returns computed when n >= 50 | VERIFIED | 3 unit tests including 60-row kPct==AVG assertion |
| 4 | setLeagueConstants updates 3 module-level mutables | VERIFIED | mlb-model.js L937-945; exported L2543 |
| 5 | run_mlb_model.js calls compute then setLeagueConstants | VERIFIED | L1586-1592 before game loop |
| 6 | 9 hardcoded call-sites replaced by mutables | VERIFIED | 5x _leagueAvgKPct, 2x _defaultXfip, 2x _defaultBbPct |
| 7 | [MLB_LEAGUE_AVG] log emitted | VERIFIED | run_mlb_model.js L~1591 |
| 8 | All tests pass, no regressions | VERIFIED | 6/6 mlb-stats tests; worker 1279 pass; 2 data failures pre-existing |

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| packages/data/src/db/mlb-stats.js | VERIFIED | 79 lines, no stubs, exports computeMLBLeagueAverages |
| packages/data/src/db/__tests__/mlb-stats.test.js | VERIFIED | 85 lines, 6 tests all passing |
| packages/data/src/db/index.js | VERIFIED | re-exports computeMLBLeagueAverages via mlbStats require |
| apps/worker/src/models/mlb-model.js | VERIFIED | setLeagueConstants L937-945, exported L2543, 9 call-sites |
| apps/worker/src/jobs/run_mlb_model.js | VERIFIED | compute+set wired L1586-1592 |
| apps/worker/src/__tests__/run-mlb-model.dual-run.test.js | VERIFIED | computeMLBLeagueAverages + setLeagueConstants mocks present |

## Key Link Verification

| From | To | Via | Status |
|------|----|----|--------|
| run_mlb_model.js | mlb-stats.js | computeMLBLeagueAverages(getDatabase()) | WIRED |
| run_mlb_model.js | mlb-model.js | setLeagueConstants(leagueConstants) | WIRED |
| mlb-stats.js | packages/data exports | db/index.js re-export | WIRED |
| module-level mutables | 9 call-sites | _leagueAvgKPct/_defaultXfip/_defaultBbPct | WIRED |

## Anti-Patterns

None found in any WI-0840 files.

## Human Verification Required

### 1. Production dynamic computation smoke test

Test: After mid-April 2026 (>=50 rows of 2026 MLB pitcher stats in prod DB), check worker log.
Expected: [MLB_LEAGUE_AVG] source=computed n=NN where NN >= 50
Why human: Requires live mlb_pitcher_stats rows from 2026 season; cannot verify against empty/early-season prod DB.

## Summary

WI-0840 fully implemented and wired. All 8 observable truths verified against actual codebase. Implementation is substantive (79 lines, not a stub), wired through three layers (db -> data package -> job). All 9 hardcoded call-sites replaced. Tests confirm both static fallback (n<50) and computed paths.

Single deferred item: confirm source=computed in production once mid-April MLB data accumulates.

---
_Verified: 2026-04-09T22:20:17.539115Z_
_Verifier: Claude (pax-verifier)_
