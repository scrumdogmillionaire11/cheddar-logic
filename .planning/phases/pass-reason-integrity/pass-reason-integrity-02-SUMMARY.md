---
phase: pass-reason-integrity
plan: "02"
subsystem: mlb-model
tags: [mlb, pass-reason-code, confidence-gate, reason-codes, tdd]

# Dependency graph
requires:
  - phase: pass-reason-integrity
    plan: "01"
    provides: MarketEvalResult contract with 6 provenance fields, assertLegalPassNoEdge enforcer

provides:
  - Fixed projectFullGameML: PASS_CONFIDENCE_GATE emitted when rawBestEdge >= LEAN_EDGE_MIN but confidence below gate
  - Fixed projectFullGameML: PASS_MODEL_DEGRADED emitted for degraded+edge case (not PASS_NO_EDGE)
  - selectPassReasonCode() helper: priority-ordered PASS_ code selector replacing Array.find fallbacks
  - Extended projectFullGameML return contract: pass_reason_code, raw_edge_value, threshold_required, threshold_passed
  - Both projectF5TotalCard and projectFullGameTotalCard use selectPassReasonCode (not Array.find)

affects:
  - pass-reason-integrity-03 (card builder propagation of pass_reason_code from model layer)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - PASS_REASON_PRIORITY: deterministic priority list for PASS_ code selection
    - confidenceGateBlocked: derived flag for three-way PASS reason code dispatch
    - selectPassReasonCode: module-level helper replacing unsafe Array.find in pass_reason_code sites

key-files:
  created: []
  modified:
    - apps/worker/src/models/mlb-model.js
    - apps/worker/src/models/__tests__/mlb-model.test.js

key-decisions:
  - "selectPassReasonCode exported for unit testing (pass-reason-integrity-02); not intended for external callers"
  - "computeMLBDriverCards line 2251 still overrides pass_reason_code with PASS_NO_EDGE; deferred to Plan 03 (card builder propagation)"
  - "PASS_REASON_PRIORITY order: PASS_DEGRADED_TOTAL_MODEL > PASS_CONFIDENCE_GATE > PASS_MODEL_DEGRADED > PASS_INPUTS_INCOMPLETE > PASS_SYNTHETIC_FALLBACK > PASS_NO_DISTRIBUTION > PASS_NO_EDGE"
  - "Scenario A test fixture uses -137/+113 odds (not -110/-110) because home field advantage always gives rawBestEdge >= 0.025 at even odds"

patterns-established:
  - "rawBestEdge/rawEdgeCleared/confidenceGateBlocked trio must be derived before reasonCodes array construction in any ML model function"
  - "selectPassReasonCode must be used at all pass_reason_code fallback sites in mlb-model.js (no bare Array.find)"

requirements-completed:
  - PRI-MLB-01
  - PRI-MLB-02
  - PRI-MLB-03

# Metrics
duration: 35min
completed: 2026-04-18
---

# Phase pass-reason-integrity Plan 02: MLB Model Pass Reason Code Integrity Summary

**Fixed three PASS_NO_EDGE bugs in projectFullGameML — PASS_CONFIDENCE_GATE and PASS_MODEL_DEGRADED now emitted correctly — plus selectPassReasonCode priority helper replacing Array.find fallbacks in all card builders**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-04-18T00:00:00Z
- **Completed:** 2026-04-18T00:35:00Z
- **Tasks:** 2 (TDD: 4 commits — 2 RED + 2 GREEN)
- **Files modified:** 2

## Accomplishments

- `projectFullGameML` now derives `rawBestEdge`, `rawEdgeCleared`, `confidenceGateBlocked` before building `reasonCodes`, enabling a three-way dispatch: `PASS_CONFIDENCE_GATE` when edge cleared but confidence blocked, `PASS_MODEL_DEGRADED` when degraded model with positive edge, `PASS_NO_EDGE` only for the true no-edge case
- Extended `projectFullGameML` return object with four new fields: `pass_reason_code`, `raw_edge_value`, `threshold_required`, `threshold_passed` — required by Plan 03 card builder propagation
- `selectPassReasonCode()` helper added with `PASS_REASON_PRIORITY` list; replaces `Array.find` in `projectFullGameTotalCard` and `projectF5TotalCard`; exported for unit testing
- 11 new tests added (51 total mlb-model tests, 79 total across all mlb suites, all green)

## Task Commits

1. **Task 1 RED — Scenarios A/C/D failing tests** - `76b6325a` (test)
2. **Task 1 GREEN — projectFullGameML fix + extended return** - `a4b3b694` (feat)
3. **Task 2 RED — selectPassReasonCode failing tests** - `cb226aa7` (test)
4. **Task 2 GREEN — selectPassReasonCode + Array.find replacements** - `750a1281` (feat)

## Files Created/Modified

- `apps/worker/src/models/mlb-model.js` — Added `PASS_REASON_PRIORITY`, `selectPassReasonCode`; fixed `projectFullGameML` reason code dispatch; extended return contract; replaced `Array.find` in `projectFullGameTotalCard` and `projectF5TotalCard`
- `apps/worker/src/models/__tests__/mlb-model.test.js` — 11 new tests: Scenarios A/C/D for `projectFullGameML`; Scenarios B/B2/B3 plus 4 additional unit tests for `selectPassReasonCode`

## Decisions Made

- `selectPassReasonCode` is exported for unit testing rather than kept fully private; this is explicitly noted with a comment in the exports block
- `computeMLBDriverCards` at line 2251 still overrides `pass_reason_code` with `'PASS_NO_EDGE'` directly — this is deferred to Plan 03 which will propagate `mlResult.pass_reason_code` properly
- Scenario A test fixture uses `-137/+113` odds rather than `-110/-110` because the home field advantage model always produces `rawBestEdge >= 0.025` at even odds with symmetric pitchers; calibrated odds that match the model's win probability are required to trigger the true no-edge case

## Deviations from Plan

### Auto-fixed Issues

None — plan executed exactly as written.

### Deferred Items

**computeMLBDriverCards pass_reason_code override (line 2251)**
- **Found during:** Task 1 verification
- **Issue:** `computeMLBDriverCards` hardcodes `pass_reason_code: !mlResult.ev_threshold_passed ? 'PASS_NO_EDGE' : null` instead of using `mlResult.pass_reason_code`; this overwrites the correct code computed by the now-fixed `projectFullGameML`
- **Action:** Deferred to Plan 03 (card builder propagation plan) which is specifically responsible for threading `pass_reason_code` through the card layer
- **File:** `apps/worker/src/models/mlb-model.js:2251`

## Issues Encountered

Scenario A test required iterating on the odds fixture: the initial assumption that `-110/-110` with symmetric pitchers would produce `rawBestEdge < 0.025` was wrong — home field advantage consistently gives `~0.039` edge. Resolved by using odds calibrated to match the model's win probability (`-137/+113`).

## Next Phase Readiness

- `projectFullGameML` return contract now includes `pass_reason_code`, `raw_edge_value`, `threshold_required`, `threshold_passed` — Plan 03 card builder can consume these directly
- `selectPassReasonCode` is the canonical pass-reason picker for all MLB model card builders
- Blocker at `computeMLBDriverCards:2251` documented and targeted by Plan 03

---
*Phase: pass-reason-integrity*
*Completed: 2026-04-18*
