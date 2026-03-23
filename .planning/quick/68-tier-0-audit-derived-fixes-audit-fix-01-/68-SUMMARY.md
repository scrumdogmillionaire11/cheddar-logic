---
phase: quick-68
plan: "01"
subsystem: betting-decision-pipeline
tags: [audit-fix, edge-math, nhl, decision-gate, decision-pipeline, reason-codes]
dependency_graph:
  requires: []
  provides: [AUDIT-FIX-01, AUDIT-FIX-02, AUDIT-FIX-03, AUDIT-FIX-04, AUDIT-FIX-05, AUDIT-FIX-06]
  affects: [edge-calculator, decision-gate, decision-pipeline-v2, games-route, decision-publisher, run-nhl-model]
tech_stack:
  added: []
  patterns: [hasFiniteEdge guard, replace-not-merge pattern, PLAY-priority map replacement]
key_files:
  created: []
  modified:
    - packages/models/src/edge-calculator.js
    - packages/models/src/decision-gate.js
    - packages/models/src/__tests__/edge-calculator.test.js
    - packages/models/src/decision-pipeline-v2.js
    - web/src/app/api/games/route.ts
    - apps/worker/src/utils/decision-publisher.js
    - apps/worker/src/jobs/run_nhl_model.js
decisions:
  - "AUDIT-FIX-01: lineIsInteger guard (L % 1 === 0) gates continuity correction — half-integer NHL lines (5.5, 6.5) pass through unadjusted"
  - "AUDIT-FIX-04: reuse existing hasFiniteEdge() from decision-gate.js in both edgeDelta sites — no new helper needed"
  - "AUDIT-FIX-03: officialTier (PLAY=2, LEAN=1) comparison replaces first-come early-exit; edge_pct breaks ties"
  - "AUDIT-FIX-05: reason_codes replaced not merged — Set wraps only [primary_reason_code].filter(Boolean)"
metrics:
  duration: "~20 minutes"
  completed: "2026-03-23"
  tasks_completed: 3
  files_modified: 7
---

# Quick Task 68: Tier 0 Audit-Derived Fixes (AUDIT-FIX-01 through 06) Summary

**One-liner:** Six silent production defects fixed — NHL edge math corrected, pipeline exceptions logged, PLAY-priority card selection, null-safe edge comparison, and reason_codes replacement pattern applied across pipeline.

## Tasks Completed

| Task | Name | Commits | Files |
|------|------|---------|-------|
| 1 | AUDIT-FIX-01 + 04: NHL integer-only correction + null-safe edgeDelta | dd05cc5 | edge-calculator.js, decision-gate.js, edge-calculator.test.js |
| 2 | AUDIT-FIX-02 + 03: PARSE_FAILURE log + PLAY-priority truePlayMap | 9c20ff5 | decision-pipeline-v2.js, route.ts |
| 3 | AUDIT-FIX-05 + 06: reason_codes replace + EVIDENCE card sync | 32b9662 | decision-publisher.js, run_nhl_model.js |

## Fixes Applied

### AUDIT-FIX-01 (CRITICAL) — NHL OVER edge inflation from phantom +0.5 line adjustment

**File:** `packages/models/src/edge-calculator.js` ~L259

**Problem:** Every NHL OVER total with a half-integer line (5.5, 6.5) absorbed a +0.5 continuity correction, raising the effective line and suppressing p_fair by ~0.02–0.04. Integer lines (6, 7) correctly needed the correction to handle the discrete NHL scoring distribution.

**Fix:** Added `lineIsInteger = L % 1 === 0` guard. Correction only applies when `isNhlStyleTotal && lineIsInteger`.

### AUDIT-FIX-02 (CRITICAL) — Silent exception swallow in buildDecisionV2

**File:** `packages/models/src/decision-pipeline-v2.js` ~L1342

**Problem:** The catch block returned a synthetic BLOCKED result with no log output. Parse failures were silent — no visibility into what error caused the BLOCKED state.

**Fix:** Added `console.error('[buildDecisionV2] PARSE_FAILURE — returning synthetic BLOCKED result', { error: { message, stack }, sport, market_type, game_id })` as the first statement in the catch block.

### AUDIT-FIX-03 (HIGH) — truePlayMap first-come ordering shadows later PLAY with earlier LEAN

**File:** `web/src/app/api/games/route.ts` ~L3151

**Problem:** `if (truePlayMap.has(canonicalGameId)) continue;` — the first chronological card for a game won unconditionally, even if it was a LEAN and a later PLAY existed for the same game.

**Fix:** Removed early-exit. Added tier comparison (PLAY=2, LEAN=1). Only replaces existing entry if candidate has strictly higher tier, or same tier with higher edge_pct.

### AUDIT-FIX-04 (HIGH) — shouldFlip coerces null edge to 0 via ?? 0

**File:** `packages/models/src/decision-gate.js` ~L258, L272

**Problem:** `(candidate.edge ?? 0) - (current.edge ?? 0)` — when candidate.edge is null with edge_available=true, edgeDelta computed as `0 - current.edge` (a negative number), potentially suppressing legitimate flips.

**Fix:** Both edgeDelta assignment sites now use `hasFiniteEdge(candidate?.edge) && hasFiniteEdge(current?.edge)` guard. `hasFiniteEdge` was already defined in the file (no new helper needed). Null edge always produces null edgeDelta.

### AUDIT-FIX-05 (HIGH) — reason_codes accumulates monotonically, never purged

**File:** `apps/worker/src/utils/decision-publisher.js` ~L158

**Problem:** `new Set([...(payload.reason_codes || []), decisionV2.primary_reason_code])` — each pipeline run merged new codes into existing stale codes. Cards accumulated an ever-growing set of reason codes contradicting their current status.

**Fix:** Replace with `new Set([decisionV2.primary_reason_code].filter(Boolean))` — only the current primary reason code survives each run.

### AUDIT-FIX-06 (HIGH) — EVIDENCE cards carry stale reason_codes from prior pipeline runs

**File:** `apps/worker/src/jobs/run_nhl_model.js` ~L405

**Problem:** When a 1P card was demoted to EVIDENCE, `pass_reason_code` was set (commit 9f59c8e) but `reason_codes` was not updated. Old accumulated codes remained.

**Fix:** Immediately after `payload.pass_reason_code = ...`, added `payload.reason_codes = [payload.pass_reason_code].filter(Boolean)`.

## Verification

- `jest packages/models --no-coverage`: 9 tests pass (3 suites), including 4 new Jest tests added for AUDIT-FIX-01 and AUDIT-FIX-04
- `tsc --noEmit -p web/tsconfig.json`: exits 0
- `npm run lint`: exits 0 (2 pre-existing warnings in card.tsx, unrelated)

## Deviations from Plan

### Auto-fixed Issues

None — plan executed as specified.

### Notes

1. The edge-calculator.test.js file uses a custom `assert()` pattern that runs as a plain node script; it does not use Jest `test()`/`it()`. Added new Jest `describe/test` blocks at the bottom of the file to enable jest to find and run the TDD RED→GREEN cycle for AUDIT-FIX-01 and AUDIT-FIX-04 while preserving the existing custom assertions.
2. `run_nhl_model.test.js` has 5 pre-existing failures (DB_PATH_CONFLICT infrastructure issue unrelated to this work). Confirmed pre-existing by running tests on baseline without our changes.
3. `hasFiniteEdge` was already defined in decision-gate.js — no new helper needed for AUDIT-FIX-04.

## Self-Check: PASSED

- packages/models/src/edge-calculator.js — lineIsInteger guard present
- packages/models/src/decision-gate.js — hasFiniteEdge guard in both edgeDelta sites
- packages/models/src/decision-pipeline-v2.js — console.error before return in catch
- web/src/app/api/games/route.ts — officialTier comparison replacing early-exit
- apps/worker/src/utils/decision-publisher.js — replace-not-merge pattern
- apps/worker/src/jobs/run_nhl_model.js — reason_codes sync after pass_reason_code

Commits verified: dd05cc5, 9c20ff5, 32b9662
