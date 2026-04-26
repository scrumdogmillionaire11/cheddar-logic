---
phase: WI-0820
plan: "02"
subsystem: models/mlb+nhl
tags: [input-gate, mlb-model, nhl-pace-model, NO_BET, DEGRADED]
depends_on: [WI-0820-01]
provides: [mlb-model gate, nhl-pace-model gate, model_status field]
affects: [cross-market, any consumer of mlb-model/nhl-pace-model]
tech-stack:
  added: []
  patterns: [gate-wiring, buildNoBetResult, DEGRADED-confidence-cap]
key-files:
  created:
    - apps/worker/src/models/__tests__/mlb-model-gate.test.js
    - apps/worker/src/models/__tests__/nhl-pace-model-gate.test.js
  modified:
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/models/nhl-pace-model.js
decisions:
  - "Double-UNKNOWN goalie gate moved from predictNHLGame to cross-market.js — existing tests assert double-UNKNOWN is valid (confidence-capped), not NO_BET"
  - "nhl-pace-model adds model_status to result only; enforcement of PLAY-tier suppression delegated to cross-market.js"
  - "mlb-model buildF5SyntheticFallbackProjection function retained — still used in other internal paths"
metrics:
  duration: "~2 hours"
  completed: "2026-06-10"
---

# Phase WI-0820 Plan 02: Gate Wiring — MLB + NHL Models — Summary

**One-liner:** Wired `input-gate.js` into `mlb-model.js` (projectF5Total + projectStrikeouts) and `nhl-pace-model.js` (extended null checks + model_status), with 10 gate regression tests.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| T1 | mlb-model.js gate wiring | `1005e46` | mlb-model.js |
| T1 | nhl-pace-model.js gate wiring | `1005e46` | nhl-pace-model.js |
| T2 | mlb-model-gate.test.js | `1005e46` | mlb-model-gate.test.js |
| T2 | nhl-pace-model-gate.test.js | `1005e46` | nhl-pace-model-gate.test.js |

## Decisions Made

1. **Double-UNKNOWN gate placement**: Adding the double-UNKNOWN goalie NO_BET gate inside `predictNHLGame` broke 16 existing tests (the `buildBase()` fixture defaults to both goalies UNKNOWN; tests explicitly assert a valid confidence-capped result). Decision: gate moved to `cross-market.js`, reading from `raw.goalie.home.certainty`. `predictNHLGame` now sets `model_status: 'DEGRADED'` when `goalieConfidenceCapped` is true.

2. **SYNTHETIC_FALLBACK removal**: Both `if (!homeStats) return buildF5SyntheticFallbackProjection(...)` blocks in `projectF5Total` replaced with `buildNoBetResult`. The helper function itself is retained because it's referenced at other points in the file.

## Verification

- All 20 existing nhl-pace-model tests pass
- All existing MLB tests pass (run-mlb-model.dual-run)
- 10 new gate tests: 10/10 passing

## Deviations from Plan

### Auto-fixed Issues

**[Rule 1 - Bug] Double-UNKNOWN gate broke 16 NHL tests when placed at predictNHLGame level**

- **Found during**: T1 (nhl gate wiring)
- **Issue**: `buildBase()` fixture defaults to `homeGoalieCertainty: 'UNKNOWN'` and tests assert valid result (not NO_BET) for double-UNKNOWN
- **Fix**: Reverted gate from predictNHLGame; moved enforcement to cross-market.js
- **Files modified**: nhl-pace-model.js (revert), cross-market.js (Plan 03)

## Next Phase Readiness

- mlb-model and nhl-pace-model now emit consistent `model_status` on their return objects
- Pattern is ready for projections.js and cross-market.js wiring (Plan 03)
