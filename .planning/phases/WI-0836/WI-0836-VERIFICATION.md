---
phase: WI-0836
verified: 2026-04-08T14:00:00Z
status: passed
score: 9/9 must-haves verified
---

# WI-0836 Verification Report

**Status:** PASSED | **Score:** 9/9 | **Re-verification:** No

**Goal:** Activate the silenced rest signal in NBA and NHL by computing rest_days_home/rest_days_away from the games table and injecting into oddsSnapshot before market-decision functions; add homeRest/awayRest params to projectNHL().

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | rest-days.js: 3 exports, correct SQL (game_time_utc), cap=3/floor=0 | VERIFIED | 80+ lines; getTeamLastGameTimeUtc, daysBetween, computeRestDays exported |
| 2 | Default restDays=1 restSource=default when no prior game in DB | VERIFIED | null-guard ~L67; test confirms |
| 3 | NBA oddsSnapshot enriched before computeNBAMarketDecisions | VERIFIED | run_nba_model.js L1324 enrichedSnapshot; computeNBAMarketDecisions(enrichedSnapshot) L1329 |
| 4 | cross-market.js NBA rest-read has raw?.rest_days_home fallback (step 2b) | VERIFIED | L857-861: espn_metrics ?? rest_days_home ?? null |
| 5 | projectNHL homeRest/awayRest params 8-9 default=1 with restAdjustment | VERIFIED | projections.js L299-300; formula L325-335; return L385-386 |
| 6 | NHL oddsSnapshot enriched before computeNHLMarketDecisions (step 4a) | VERIFIED | run_nhl_model.js L85 require; L1917-1924; computeNHLMarketDecisions(enrichedSnapshot) L1924 |
| 7 | cross-market.js NHL projectNHL call passes restDaysHome??1 restDaysAway??1 | VERIFIED | L358-359; NHL rest-read L288-292 already had fallback |
| 8 | rest_source_home/away written to card payloadData NBA+NHL | VERIFIED | NBA L1450-1451; NHL L2074-2075 and L2154-2155 |
| 9 | 83/83 tests pass across 7 suites | VERIFIED | 83 tests 7 suites 2.151s |

**Score: 9/9**

## Required Artifacts

| Artifact | Status |
|----------|--------|
| apps/worker/src/utils/rest-days.js | VERIFIED SUBSTANTIVE WIRED |
| apps/worker/src/utils/__tests__/rest-days.test.js | VERIFIED SUBSTANTIVE WIRED (63 lines 8 tests) |
| apps/worker/src/jobs/run_nba_model.js (modified) | VERIFIED (enrichedSnapshot L1322-1329; payloadData L1448-1451 L1549-1552) |
| apps/worker/src/jobs/run_nhl_model.js (modified) | VERIFIED (enrichedSnapshot L1917-1924; payloadData L2072-2075 L2153-2156) |
| apps/worker/src/models/projections.js (modified) | VERIFIED (projectNHL params L299-300; restAdj L325-335; return L385-386) |
| apps/worker/src/models/cross-market.js (modified) | VERIFIED (NBA fallback L857-861; NHL call L358-359) |

## Key Links

| From | To | Via | Status |
|------|----|-----|--------|
| run_nba_model.js | computeRestDays | require(../utils/rest-days) L82 | WIRED |
| enrichedSnapshot | computeNBAMarketDecisions | passed as enrichedSnapshot not oddsSnapshot | WIRED |
| cross-market NBA | raw.rest_days_home | fallback L857-861 | WIRED |
| run_nhl_model.js | computeRestDays | require(../utils/rest-days) L85 | WIRED |
| enrichedSnapshot | computeNHLMarketDecisions | passed as enrichedSnapshot L1924 | WIRED |
| cross-market NHL restDaysHome/Away | projectNHL args 7-8 | L358-359 | WIRED |
| projectNHL homeRest/awayRest | homeProjected/awayProjected | restAdjustment L332-335 | WIRED |

## Requirements Coverage

| Criterion | Status |
|-----------|--------|
| (1) rest_days non-null on oddsSnapshot at computeNBAMarketDecisions for game with prior game | SATISFIED |
| (2) projectNHL params 7-8 default=1; computeNHLMarketDecisions passes them | SATISFIED |
| (3) Missing prior game: restDays=1 rest_source=default | SATISFIED |
| (4) Tests: back-to-back restDays=0; NHL restAdjustment coverage | SATISFIED |

## Anti-Patterns Found

None in modified sections.

## Human Verification Required

1. **NBA back-to-back card payload**
   Test: Run NBA model on game day with known back-to-back team; inspect card payload raw_data.
   Expected: rest_days_home=0 rest_source_home=computed for the back-to-back team.
   Why human: Requires live DB with actual games table history.

2. **NHL rest signal on projected total**
   Test: Run NHL model on back-to-back matchup; compare projected total to well-rested baseline.
   Expected: Back-to-back team side ~0.25 goals lower.
   Why human: Requires controlled fixture or historical snapshot comparison.

---
_Verified: 2026-04-08_
_Verifier: Claude (pax-verifier)_