---
phase: 32-p2-nhl-decision-integrity-chain
plan: 32
subsystem: nhl-decision-pipeline
tags: [nhl, goalie, decision-integrity, consistency, watchdog, wrapper, results-ui]
dependency_graph:
  requires: [WI-0381, WI-0384]
  provides: [WI-0382, WI-0383]
  affects:
    - packages/models/src/decision-pipeline-v2.js
    - apps/worker/src/models/cross-market.js
    - apps/worker/src/utils/decision-publisher.js
    - apps/worker/src/jobs/run_nhl_model.js
    - web/src/app/results/page.tsx
    - web/src/app/api/results/route.ts
tech_stack:
  added: []
  patterns:
    - goalieUncertaintyBlocks helper guards both consistency layer and vol_env derivation
    - official_eligible hard-gate in applyUiActionFields before any tier/pipeline logic
    - server-side extraction of 1P projection fields from payload_data in API route
key_files:
  created: []
  modified:
    - packages/models/src/decision-pipeline-v2.js
    - apps/worker/src/models/cross-market.js
    - apps/worker/src/utils/decision-publisher.js
    - apps/worker/src/jobs/run_nhl_model.js
    - apps/worker/src/models/__tests__/cross-market.test.js
    - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
    - web/src/app/results/page.tsx
    - web/src/app/api/results/route.ts
    - WORK_QUEUE/WI-0382.md
    - WORK_QUEUE/WI-0383.md
decisions:
  - "goalieUncertaintyBlocks() lives in cross-market.js and is imported by decision-publisher — no circular dep, clean import direction"
  - "official_eligible gate fires in applyUiActionFields before isWave1EligiblePayload check — canonical field wins over any downstream logic"
  - "1P projections extracted server-side in API route (not client-side) because payload_data is not passed through to frontend response"
  - "GOALIE_UNCONFIRMED added to deriveGameBlockingReasonCodes but does NOT force PASS alone — confidence-cap from pace model handles demotion"
metrics:
  duration: 25min
  completed: 2026-03-13
  tasks_completed: 2
  files_modified: 10
---

# Phase 32: NHL Decision Integrity Chain Summary

**One-liner:** Goalie uncertainty escalation chain (UNKNOWN/CONFLICTING → VOLATILE/INSUFFICIENT_DATA) plus official_eligible PASS gate and 1P projection display on /results ledger.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 (RED) | Failing tests for WI-0382/WI-0383 | b90e6ea | cross-market.test.js, decision-publisher.v2.test.js |
| 1 (GREEN) | WI-0382+WI-0383 implementation | db940e1 | decision-pipeline-v2.js, cross-market.js, decision-publisher.js, run_nhl_model.js, tests |
| 2 | 1P projections on /results ledger | 1112623 | results/page.tsx, api/results/route.ts |

## What Was Built

### WI-0382 — Consistency Escalation

- `goalieUncertaintyBlocks(homeGoalieState, awayGoalieState)` helper added to `cross-market.js` and exported. Returns `true` for UNKNOWN or CONFLICTING starter state; false for EXPECTED, CONFIRMED, null/undefined. Null-safe.
- `computeTotalBias(totalDecision, homeGoalieState, awayGoalieState)` — new 3-argument signature. Guards at function start: if `goalieUncertaintyBlocks` returns true, immediately returns `'INSUFFICIENT_DATA'`. Backward-compatible: callers that pass only `totalDecision` get null goalie states → no escalation.
- `deriveVolEnv(payload, homeGoalieState, awayGoalieState)` — new 3-argument signature. Guards at start: if `goalieUncertaintyBlocks` returns true, immediately returns `'VOLATILE'`. Exported for testability.
- `ensureDecisionConsistencyEnvelope()` passes `payload.homeGoalieState` / `payload.awayGoalieState` to `deriveVolEnv()`.
- `goalieUncertaintyBlocks` imported from cross-market into decision-publisher (no circular dependency).

### WI-0383 — Watchdog/Wrapper Alignment

- `WATCHDOG_REASONS.GOALIE_UNCONFIRMED: 'GOALIE_UNCONFIRMED'` and `GOALIE_CONFLICTING: 'GOALIE_CONFLICTING'` added to `decision-pipeline-v2.js`.
- `deriveGameBlockingReasonCodes()` in `run_nhl_model.js` extended to accept `homeGoalieState`/`awayGoalieState` params and push appropriate reason codes. CONFLICTING pushes `GOALIE_CONFLICTING`; UNKNOWN pushes `GOALIE_UNCONFIRMED` (non-veto).
- `applyUiActionFields()` hard-gates `official_eligible === false` at the top — before `isWave1EligiblePayload` check and before `buildDecisionV2`. Sets `action = 'PASS'`, `status = 'PASS'`, `classification = 'PASS'`. Legacy `homeGoalieConfirmed: true` cannot override this (FC-7 passes).
- DEPRECATED comment placed on the gate logic pointing to `homeGoalieState.starter_state` as the authoritative source.

### 1P Projections on /results Play Ledger

- API route extracts `model.expectedTotal` (projectionTotal) and `model.expected1pTotal` / `first_period_model.projection_final` (projection1p) from `payload_data` for NHL rows server-side.
- `LedgerRow` type extended with `projection1p?: number | null` and `projectionTotal?: number | null`.
- Desktop ledger: NHL rows with data show `Tot: X.XX · 1P: Y.YY` as a sub-line beneath the Pick cell.
- Mobile ledger: NHL rows with data show a Projection row in the expanded details grid.
- Non-NHL rows and NHL rows without projection data are unaffected.

## Test Results

All 95 tests pass:
- 15 nhl-totals-fault-harness tests: green (unchanged from before)
- 6 nhl-pace-model tests: green (WI-0381 unchanged)
- 2 nhl-pace-model-shim + calibration tests: green
- 22 new cross-market tests (goalieUncertaintyBlocks + computeTotalBias with goalie states): green
- 7 new decision-publisher v2 tests (deriveVolEnv escalation + official_eligible gate): green
- All pre-existing cross-market and decision-publisher v2 tests: green
- TypeScript: 0 errors in new code (pre-existing decision-logic.test.ts missing @types/jest is out of scope)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] 1P projection data not available in frontend response**

- **Found during:** Task 2
- **Issue:** The plan assumed `payload_data` would be available in the frontend via the `/api/results` response. In reality, the API route processes `payload_data` server-side and omits it from the response object — it returns only cleaned fields (tier, market, prediction, etc.).
- **Fix:** Extracted `projection1p` and `projectionTotal` server-side in the API route's mapper (where `payload_data` is already parsed as `const parsed = safeJsonParse(row.payload_data)`) and added them to the returned ledger row object. This required modifying `route.ts` in addition to `page.tsx`, but is the correct minimal-change approach — no new API calls, no schema changes.
- **Files modified:** `web/src/app/api/results/route.ts` (add extraction + return fields), `web/src/app/results/page.tsx` (type extension + render)
- **Commit:** 1112623

**2. [Rule 1 - Test authoring] FC-7 / official_eligible test payloads had line/odds mismatch**

- **Found during:** Task 1 (GREEN phase)
- **Issue:** New test cases for `official_eligible=true` used `line: 6.5` (NHL) but the base `buildWave1Payload` helper sets `odds_context.total: 220.5` (NBA). This triggered `EXACT_WAGER_MISMATCH` in `buildDecisionV2` and caused the test to return PASS unexpectedly.
- **Fix:** Added explicit `odds_context: { total: 6.5, total_price_over: -110, total_price_under: -110 }` overrides to all NHL TOTAL test cases that set a custom line.
- **Files modified:** `apps/worker/src/utils/__tests__/decision-publisher.v2.test.js`
- **Commit:** db940e1

## Self-Check: PASSED

All key files exist on disk. All 3 task commits verified in git log. 95 tests pass.
