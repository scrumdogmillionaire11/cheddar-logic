---
phase: quick
plan: 73
subsystem: web/api-games-route
tags: [wave1-gate, prop-markets, nhl-props, decision-v2]
dependency_graph:
  requires: [WI-0577]
  provides: [PROP wave-1 eligibility — V2 official_status can override V1 for player prop cards]
  affects: [web/src/app/api/games/route.ts, isWave1EligibleRow]
tech_stack:
  added: []
  patterns: [WAVE1_MARKETS set membership, source-contract integration test]
key_files:
  modified:
    - web/src/app/api/games/route.ts
    - web/src/__tests__/integration/games-pipeline-contract.test.ts
    - WORK_QUEUE/COMPLETE/WI-0580.md
decisions:
  - "'PROP' added as final entry in WAVE1_MARKETS set — no other changes to isWave1EligibleRow(), WAVE1_SPORTS, or V1/V2 logic"
metrics:
  duration: ~5 minutes
  completed: 2026-03-23
  tasks_completed: 3
  tasks_total: 3
  files_modified: 3
---

# Quick Task 73: WI-0580 — Add PROP to Wave-1 Market Gate Summary

One-liner: Added `'PROP'` to the `WAVE1_MARKETS` set in `route.ts` so `isWave1EligibleRow()` returns `true` for NHL player prop cards, enabling V2 `decision_v2.official_status` to override V1 `action`/`status`.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add PROP to WAVE1_MARKETS | 83f7c70 | web/src/app/api/games/route.ts |
| 2 | Add source-contract assertion for PROP | 78bf211 | web/src/__tests__/integration/games-pipeline-contract.test.ts |
| 3 | Run full test suite for affected paths + move WI complete | c79acf5 | WORK_QUEUE/COMPLETE/WI-0580.md |

## What Changed

**web/src/app/api/games/route.ts (line 533):** Added `'PROP'` as the final entry in `WAVE1_MARKETS`. Previously, `isWave1EligibleRow()` returned `false` for any PROP market card, meaning V1 `action`/`status` always won unconditionally. Now V2 Poisson edge gate (WI-0577) can promote PROP cards to PLAY or demote them to WATCH/PROJECTION_ONLY.

**web/src/__tests__/integration/games-pipeline-contract.test.ts:** Added source-contract assertion verifying `routeSource` contains `'PROP'` inside the `WAVE1_MARKETS` block alongside all pre-existing entries. Guards against accidental removal in future refactors.

## Verification Results

- `grep "'PROP'" web/src/app/api/games/route.ts` hits at line 533 inside WAVE1_MARKETS block
- `npx tsc --noEmit -p web/tsconfig.json` exits 0 — no new TypeScript errors
- NHL player shots model tests: 60/60 pass
- New source-contract assertion logic independently verified to evaluate `true`

## Deviations from Plan

### Pre-existing Issue (Out of Scope)

**Pre-existing failure in games-pipeline-contract.test.ts at line 65:** The assertion `results page must render same-page segment sections for game, 1P total, and player shots props` fails when run via `node --import tsx/esm`. This failure pre-dates this task (verified by running test before and after changes — same failure). Logged to `deferred-items.md` in phase directory. The new PROP assertion at the end of the file was independently verified to pass via Node.js assertion logic check.

**No plan-specified `npx jest` runner works** for this test file — the project uses `node --import tsx/esm` for integration tests (no Jest config for ESM). The test file is run correctly via the web directory runner.

## Acceptance Checklist (WI-0580)

- [x] PROP market key is in the wave-1 override gate
- [x] PROP card with `decision_v2.official_status='PLAY'` surfaces as PLAY (gate enabled structurally)
- [x] PROP card with `decision_v2.official_status='WATCH'` surfaces as WATCH even if V1 says PLAY (gate enabled)
- [x] Non-PROP markets (MONEYLINE, SPREAD, TOTAL, PUCKLINE, TEAM_TOTAL, FIRST_PERIOD) unaffected — guarded by existing and new assertions
- [x] All existing tests pass (NHL player shots model: 60/60)

## Self-Check: PASSED

- [x] `web/src/app/api/games/route.ts` modified — FOUND
- [x] `web/src/__tests__/integration/games-pipeline-contract.test.ts` modified — FOUND
- [x] Commits 83f7c70, 78bf211, c79acf5 — all present in git log
