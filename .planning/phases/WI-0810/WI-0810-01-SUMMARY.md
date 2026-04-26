---
phase: WI-0810-residual-devig
plan: "01"
name: Fix Residual Devig Inflation — BLK Multi-Line, card-model Cleanup
subsystem: betting-edge
tags: [devig, vig-removal, nhl-player-shots, card-model, mlb-model, edge-calculator]

dependency-graph:
  requires:
    - WI-0805 (twoSidedFairProb, SOG/BLK primary card devig)
    - quick-task-139 (two-sided vig removal across all sport models)
  provides:
    - BLK multi-line extra-line loop devigged implied/edge computation
    - card-model.js cleaned of calculateMoneylineEdge legacy export
    - mlToImplied comment accurate
  affects: []

tech-stack:
  added: []
  patterns:
    - twoSidedFairProb(over, under) ?? americanToImplied(x) — null-safe devig fallback

key-files:
  created: []
  modified:
    - apps/worker/src/jobs/run_nhl_player_shots_model.js
    - packages/models/src/card-model.js
    - apps/worker/src/models/mlb-model.js

decisions:
  - id: D1
    summary: "All three items pre-completed by quick-task-140 (2026-04-06 commit 16eb2df)"
    rationale: "quick-task-140 was run before WI-0810 was scoped into a formal plan; no code changes required during executor run"

metrics:
  duration: "<1 min (verify-only, no code changes)"
  completed: "2026-04-06"
---

# Phase WI-0810 Plan 01: Fix Residual Devig Inflation — BLK Multi-Line, card-model Cleanup Summary

**One-liner:** BLK multi-line twoSidedFairProb at 7 call sites, calculateMoneylineEdge deleted from card-model, mlToImplied comment corrected — all pre-applied by quick-task-140.

## What Was Built

All three WI-0810 items were pre-completed by quick-task-140 (commit `16eb2df`, 2026-04-06) before this executor run. Executor verified all success criteria and confirmed no code changes were needed.

### Task 1 — BLK Multi-Line Loop: twoSidedFairProb (pre-completed)

`run_nhl_player_shots_model.js` now has **7 occurrences** of `twoSidedFairProb`:
- Line 36: import from `@cheddar-logic/models`.edgeCalculator
- Lines 3153, 3156: primary BLK card `impliedOverProb`/`impliedUnderProb`
- Lines 3348, 3357: extra-line loop `implOvr`/`implUnd` edge computation
- Lines 3375, 3377: extra-line `buildCanonicalPropDecision` implied fields

All remaining `americanToImplied` calls are inside `??` fallback patterns only — no standalone raw calls remain for edge/implied computation.

### Task 2 — card-model.js + mlToImplied (pre-completed)

- `calculateMoneylineEdge` deleted from `packages/models/src/card-model.js` — zero occurrences in any source file
- `mlToImplied` comment in `mlb-model.js` (line 664) reads: `"Raw implied probability — intermediate only; normalized via two-sided devig below"` ✅

## Verification Results

| Check | Result |
|-------|--------|
| `twoSidedFairProb` count in `run_nhl_player_shots_model.js` | **7** (≥4 required) ✅ |
| Standalone `americanToImplied` for edge computation | **None** — all inside `??` fallbacks ✅ |
| `calculateMoneylineEdge` in `card-model.js` | **Absent** ✅ |
| `calculateMoneylineEdge` live callers (monorepo) | **None** ✅ |
| `mlToImplied` comment | `"intermediate only"` ✅ |
| Worker test suite | 92 suites passed, 1177 tests passed, 0 failures ✅ |
| packages/models tests | 31 tests passed, 0 assertion failures ✅ |

**Note on packages/models suites:** 2 suites report "no test blocks found" (`edge-calculator.test.js`, `sharp-divergence-annotation.test.js`). These are **pre-existing** conditions unrelated to WI-0810 — they use manual `console.log` patterns instead of Jest `it()`/`test()` blocks. Zero new failures introduced.

## Decisions Made

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | No code changes made | All three items were pre-applied by quick-task-140 (commit 16eb2df) prior to executor run. Plan objective explicitly instructed executor to verify-first and skip changes if green. |

## Deviations from Plan

None — plan executed exactly as written (verify-first path confirmed by pre-completion).

## Next Phase Readiness

- No blockers
- All devig inflation points from WI-0805 follow-on are resolved
- BLK cards now report accurate implied/edge values at -110/-110 (~0.500, not ~0.524)
