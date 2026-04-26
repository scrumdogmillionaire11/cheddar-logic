---
phase: WI-0822
verified: 2026-04-08T12:55:00Z
status: passed
score: 9/9 must-haves verified
---

# WI-0822 Verification Report

**Phase Goal:** Fix pace-contaminated ORtg proxy in projectNBACanonical; retire dual pace framework; switch computeNBAMarketDecisions to projectNBACanonical+analyzePaceSynergy.
**Status:** PASSED | **Score:** 9/9 | **Re-verification:** No

## Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Fast team homeOffRtgNorm approx 109.3; homeProjected lower than raw | VERIFIED | 118/108x100=109.26; raw=118.6 norm=114.0; test passes |
| 2 | Slow team homeOffRtgNorm approx 110.2; homeProjected higher than raw | VERIFIED | 108/98x100=110.20; raw=107.9 norm=109.0; test passes |
| 3 | computeNBAMarketDecisions no longer calls projectNBA | VERIFIED | Zero matches in cross-market.js |
| 4 | Unit test: same avgPoints different pace yields different homeProjected | VERIFIED | nba-pace-normalization.test.js passes |
| 5 | Existing NBA alignment test still passes | VERIFIED | nba-total-projection-alignment: 2/2 |
| 6 | projectNBA marked @deprecated not deleted | VERIFIED | projections.js line 144 |
| 7 | cross-market.js import: projectNBACanonical in projectNBA out | VERIFIED | line 12 confirmed |
| 8 | analyzePaceSynergy called before projectNBACanonical paceAdjustment as arg 7 | VERIFIED | synergy L865 canonical L867 |
| 9 | Rest-day adjustments absent from canonical path | VERIFIED | No rest params; deferred to WI-0836 |

**Score:** 9/9

## Required Artifacts

| Artifact | Status | Details |
| --- | --- | --- |
| apps/worker/src/models/projections.js | VERIFIED | Lines 428-438: normalization block; PPP uses normalized values |
| apps/worker/src/models/cross-market.js | VERIFIED | Line 12 import swap; lines 862-873 synergy-first ordering |
| apps/worker/src/models/index.js | VERIFIED | projectNBACanonical + analyzePaceSynergy imports added |
| apps/worker/src/models/__tests__/nba-pace-normalization.test.js | VERIFIED | 6 tests 91 lines all pass |

## Key Links

| From | To | Via | Status |
| --- | --- | --- | --- |
| computeNBAMarketDecisions | projectNBACanonical | direct call L867 | WIRED |
| analyzePaceSynergy | projectNBACanonical | synergy.paceAdjustment | WIRED |
| paceSignalData | paceEnvironment driver | const paceSignalData = synergy | WIRED |
| nba-total-projection driver | projectNBACanonical | index.js + alignment test | WIRED |

## Requirements Coverage

All 9 acceptance criteria SATISFIED. 117/117 tests pass.

## Anti-Patterns

None in modified sections.

## Human Verification Required

1. High-pace total deflation: run NBA model on dual-fast matchup; expect lower totals.
2. Rest-day absence: run model on back-to-back game; expect total unchanged (deferred to WI-0836).

---
_Verified: 2026-04-08 | Verifier: Claude (pax-verifier)_
