---
phase: WI-0820
plan: "01"
subsystem: models/input-gate
tags: [input-gate, NO_BET, DEGRADED, MODEL_OK, gate-utility]
depends_on: []
provides: [classifyModelStatus, buildNoBetResult, DEGRADED_CONSTRAINTS]
affects: [WI-0820-02, WI-0820-03, mlb-model, nhl-pace-model, projections, cross-market]
tech-stack:
  added: []
  patterns: [input-gate-utility, frozen-constraint-object, canonical-envelope]
key-files:
  created:
    - apps/worker/src/models/input-gate.js
    - apps/worker/src/models/__tests__/input-gate.test.js
  modified: []
decisions:
  - "FORBIDDEN_TIERS array inside DEGRADED_CONSTRAINTS must be separately frozen (Object.freeze(['PLAY']))"
  - "classifyModelStatus treats NaN as missing (isMissing checks Number.isNaN)"
  - "buildNoBetResult returns canonical envelope: {status, missingCritical, reason, projection_source, sport, market}"
metrics:
  duration: "~1 hour"
  completed: "2026-06-10"
---

# Phase WI-0820 Plan 01: Core Input Gate Utility — Summary

**One-liner:** Created `input-gate.js` with `classifyModelStatus`, `buildNoBetResult`, and frozen `DEGRADED_CONSTRAINTS` shared by all sport models.

## Objective

Establish a single gate utility that all sport model functions can require to classify input completeness into `MODEL_OK`, `DEGRADED`, or `NO_BET` states, and to produce canonical NO_BET envelopes in place of `null` returns or synthetic fallbacks.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| T1 | Create input-gate.js | `7447821` | `apps/worker/src/models/input-gate.js` |
| T2 | Create input-gate.test.js | `7447821` | `apps/worker/src/models/__tests__/input-gate.test.js` |

## Decisions Made

1. **FORBIDDEN_TIERS inner-freeze**: The outer `Object.freeze()` on `DEGRADED_CONSTRAINTS` does not freeze nested arrays. Required `Object.freeze(['PLAY'])` to ensure `isFrozen(DEGRADED_CONSTRAINTS.FORBIDDEN_TIERS)` returns `true`.
2. **NaN as missing**: `isMissing` includes `Number.isNaN(v)` check so statistical NaN values (e.g. K/9 computed on 0 IP) are correctly gated.
3. **canonical envelope fields**: `buildNoBetResult` always includes `status:'NO_BET'`, `missingCritical`, `reason`, and spread `context` so callers can always check `result.status === 'NO_BET'`.

## Verification

- 23 tests, all passing
- Covers: MODEL_OK, DEGRADED, NO_BET paths; NaN detection; asymmetric team failure; frozen contract; buildNoBetResult envelope shape

## Deviations from Plan

None — plan executed exactly as written (with one test fix for the inner-freeze constraint discovered during TDD RED phase).

## Next Phase Readiness

- `input-gate.js` exports are stable and ready for all three Wave-2 consumers
- No blockers
