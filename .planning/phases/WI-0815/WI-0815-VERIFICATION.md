---
phase: WI-0815-edge-sanity-clamp-watchdog
verified: 2026-04-09T23:10:00Z
status: passed
score: 4/4 must-haves verified
---

# WI-0815 Verification Report

**Goal:** Force watchdogStatus=CAUTION when NHL edge sanity clamp fires in computeTotalEdge, blocking PLAY classification.
**Status:** PASSED | **Score:** 4/4 | **Re-verification:** No

## Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | NHL raw edge >18% exits with confidence reduced >=0.10 vs unclamped | VERIFIED | AUDIT-FIX-01 test line 618; node:test 9/9 pass |
| 2 | EDGE_SANITY_CLAMP_APPLIED remains in rail_flags | VERIFIED | edge-calculator.js line 362; present alongside effectiveConfidenceContext |
| 3 | NBA totals (sigmaTotal>=14) edge <18% unaffected | VERIFIED | isNhlStyleTotal gate line 360 (sigmaTotal <= 3) never triggers for NBA |
| 4 | Clamped NHL card receives LEAN or PASS not PLAY | VERIFIED | sigma-fallback-gate: clamped NHL total does not stay PLAY; 12/12 |

**Score: 4/4**

## Artifacts

| Artifact | Status |
| --- | --- |
| packages/models/src/edge-calculator.js (487 lines) | VERIFIED - effectiveConfidenceContext at lines 359/363/377; no stubs |
| packages/models/src/__tests__/edge-calculator.test.js (765 lines) | VERIFIED - AUDIT-FIX-01 describe block; confidence delta test at line 618 |

## Key Links

| From | To | Status |
| --- | --- | --- |
| clamp block (isNhlStyleTotal && edge>0.18) | effectiveConfidenceContext.watchdogStatus=CAUTION | WIRED lines 363-366 |
| effectiveConfidenceContext | computeConfidence(...effectiveConfidenceContext) | WIRED line 377 |
| EDGE_SANITY_CLAMP_APPLIED | rail_flags result object | WIRED line 362 |
| CAUTION watchdog | LEAN/PASS gate via require_watchdog_ok | WIRED - sigma-fallback-gate 12/12 |

## Test Suites

| Suite | Result | Notes |
| --- | --- | --- |
| edge-calculator node:test | 9/9 pass | Jest 0-tests is pre-existing require(node:test)/Jest globals conflict - not a regression |
| decision-pipeline-v2-sigma-fallback-gate | 12/12 pass | Validates Truth 4 end-to-end |
| run_nhl_model at HEAD | 30/30 pass | 2 working-tree failures are WI-0824 WIP stubs; stash-confirmed not regressions |

## Human Verification Required

1. Live NHL card check: run game-day with NHL total odds producing raw edge >18%.
   Expected: LEAN or PASS; rail_flags includes EDGE_SANITY_CLAMP_APPLIED; watchdog_status=CAUTION.
   Why human: No production snapshot with implausibly wide NHL odds for automated diff.

---
_Verified: 2026-04-09 | Verifier: Claude (pax-verifier)_