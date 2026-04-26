---
phase: WI-0820
plan: "03"
subsystem: models/projections+cross-market
tags: [input-gate, projections, cross-market, NBA, NHL, NO_BET, DEGRADED]
depends_on: [WI-0820-01, WI-0820-02]
provides: [projectNBA gate, projectNBACanonical gate, NBA/NHL cross-market enforcement]
affects: [any consumer of computeNBAMarketDecisions, computeNHLMarketDecisions]
tech-stack:
  added: []
  patterns: [NO_BET-hard-block, DEGRADED-enforcement, input-gate-logging]
key-files:
  created:
    - apps/worker/src/models/__tests__/projections-gate.test.js
    - apps/worker/src/models/__tests__/cross-market-gate.test.js
  modified:
    - apps/worker/src/models/projections.js
    - apps/worker/src/models/cross-market.js
decisions:
  - "NHL double-UNKNOWN goalie gate in computeNHLMarketDecisions reads from raw.goalie.home.certainty, NOT from predictNHLGame arguments"
  - "NBA pace required (NO_BET); rest optional (DEGRADED) — removed || 100 pace defaults"
  - "projectNBACanonical returns NO_BET object not null — downstream callers must check result.status"
  - "homeRest/awayRest must be included in projectNBA featureMap (not just the optional array) or gate always sees them as missing"
metrics:
  duration: "~3 hours"
  completed: "2026-06-10"
---

# Phase WI-0820 Plan 03: Gate Wiring — projections.js + cross-market.js — Summary

**One-liner:** Wired gate into NBA projections (pace required, rest optional), replaced projectNBACanonical null return, added NHL double-UNKNOWN hard block and NBA/NHL DEGRADED enforcement in cross-market.js, with 20 gate regression tests.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| T1 | projections.js gate wiring | `4fe5f77` | projections.js |
| T2 | cross-market.js NBA gate + DEGRADED | `4fe5f77` | cross-market.js |
| T2 | cross-market.js NHL double-UNKNOWN gate | `4fe5f77` | cross-market.js |
| T2 | cross-market.js NHL DEGRADED enforcement | `4fe5f77` | cross-market.js |
| T2 | projections-gate.test.js | `4fe5f77` | projections-gate.test.js |
| T2 | cross-market-gate.test.js | `4fe5f77` | cross-market-gate.test.js |

## Decisions Made

1. **NHL double-UNKNOWN location**: Gate reads `raw?.goalie?.home?.certainty` (and legacy `raw?.goalie_home_certainty`) in `computeNHLMarketDecisions`, not in `predictNHLGame`. The model-level function retains its DEGRADED confidence cap behavior for existing test compatibility.

2. **NBA pace always required**: Removed `|| 100` pace defaults because defaulting to 100 silently masked missing data. Pace is now a required gate key — missing pace returns NO_BET.

3. **projectNBACanonical returns object**: Changed `return null` to `return buildNoBetResult(...)`. Callers that previously did `if (!canonical) { ... }` now additionally need `if (canonical.status === 'NO_BET')` — but since projectNBACanonical was only called internally in projections.js, this is safe.

4. **homeRest/awayRest in featureMap**: Bug found — optional keys must be present in the featureMap passed to classifyModelStatus, not just listed in the optional array. Without them in the map they always appear as missing, causing every call to be DEGRADED even when rest is provided.

## Verification

- All 30 existing cross-market + NHL/NBA tests pass after changes
- 20 new gate tests: 20/20 passing
- Full suite: 140 tests, 10 suites, 0 failures

## Deviations from Plan

### Auto-fixed Issues

**[Rule 1 - Bug] projectNHL call accidentally dropped during NHL gate insertion**

- **Found during**: T2 verification of NHL changes
- **Issue**: Prior replace_string_in_file replaced `const projection = projectNHL(` as part of the oldString match but only included the gate block in newString — the actual call was dropped, leaving dangling argument lines
- **Fix**: Restored `const projection = projectNHL(goalsForHome, ...)` call after the gate early-return block
- **Files modified**: cross-market.js
- **Commit**: `4fe5f77`

**[Rule 1 - Bug] homeRest/awayRest missing from projectNBA featureMap**

- **Found during**: Gate test for MODEL_OK with rest values
- **Issue**: Optional keys `homeRest` and `awayRest` were listed in the optional array but not in the featureMap object — classifyModelStatus always saw them as missing (undefined treated as null), making every valid call DEGRADED
- **Fix**: Added `homeRest: homeRest ?? null, awayRest: awayRest ?? null` to the featureMap
- **Files modified**: projections.js
- **Commit**: `4fe5f77`

## Next Phase Readiness

- WI-0820 complete: all three plans executed, all 4 modified model files gate-wired
- 140 tests pass with no regressions
- Downstream Sprint 2 work (model formula corrections) can now rely on gate states
