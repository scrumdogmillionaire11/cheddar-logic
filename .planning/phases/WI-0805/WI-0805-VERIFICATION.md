---
phase: WI-0805
verified: 2026-04-06T00:00:00Z
status: passed
score: 7/7 must-haves verified
re_verification: false
---

# WI-0805: Two-Sided Vig Removal — Verification Report

**Phase Goal:** All sport models compute edge using devigged implied probability (`twoSidedFairProb` / `noVigImplied`) instead of raw vig-inflated implied probability.
**Verified:** 2026-04-06
**Status:** PASSED
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `twoSidedFairProb(-110,-110)` ≈ 0.500, exported from `edge-calculator.js` | ✓ VERIFIED | `edge-calculator.js` line 50-52 exports helper; test suite shows `PASS: twoSidedFairProb(-110,-110) ≈ 0.5000 (not 0.524)` |
| 2 | NHL SOG (over+under) edge uses two-sided devig | ✓ VERIFIED | `nhl-player-shots.js` lines 496-510, 728-742: `twoSidedFairProb(market_price_over, market_price_under) ?? americanToImplied(...)` |
| 3 | NHL BLK edge (primary + multi-line) uses two-sided devig | ✓ VERIFIED | `run_nhl_player_shots_model.js` lines 3153-3158 (primary) and 3348-3358 (multi-line), same fallback pattern |
| 4 | NHL game totals/spreads: no `VIG_REMOVAL_SKIPPED` when both prices available | ✓ VERIFIED | `decision-pipeline-v2.js` lines 1294, 1344: `result.p_implied` captured from `computeSpreadEdge`/`computeTotalEdge` which call `noVigImplied` internally |
| 5 | NBA totals + spreads: devigged implied probability used | ✓ VERIFIED | NBA model destructures `marketDecisions` from decision-pipeline-v2 (same centralized fix at lines 1272-1350) |
| 6 | MLB F5 ML edge uses `rawHome / (rawHome + rawAway)` normalized form | ✓ VERIFIED | `mlb-model.js` lines 665-676: `mlToImplied` used only to get raw values; `impliedHome = rawHome / (rawHome + rawAway)` |
| 7 | MLB MONEYLINE: devigged via `noVigImplied` from `odds_context` | ✓ VERIFIED | `decision-pipeline-v2.js` lines 1378-1386: `noVigImplied(price, oppositePrice)` for MONEYLINE market type |

**Score:** 7/7 truths verified

---

## Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `packages/models/src/edge-calculator.js` | ✓ VERIFIED | Exports `twoSidedFairProb` (line 473) and `noVigImplied` (line 472) |
| `apps/worker/src/models/nhl-player-shots.js` | ✓ VERIFIED | Imports `twoSidedFairProb` from `@cheddar-logic/models` (line 3); used for SOG over+under |
| `apps/worker/src/jobs/run_nhl_player_shots_model.js` | ✓ VERIFIED | Imports `twoSidedFairProb` (line 36); used for BLK primary and multi-line cards |
| `packages/models/src/decision-pipeline-v2.js` | ✓ VERIFIED | WI-0805 comments at lines 1294, 1344, 1378; devigged `implied_prob` for SPREAD/PUCKLINE/TOTAL/FIRST_PERIOD/MONEYLINE |
| `apps/worker/src/models/mlb-model.js` | ✓ VERIFIED | F5 ML: `impliedHome = rawHome / total` (line 673); K scoring model is score-based, not prob-edge |
| `packages/models/src/__tests__/edge-calculator.test.js` | ✓ VERIFIED | Tests pass: `noVigImplied` (7+ assertions), `twoSidedFairProb` (5+ assertions), all PASS |
| `packages/models/src/__tests__/decision-pipeline-v2-devig.test.js` | ✓ VERIFIED | Dedicated devig Jest test suite — PASS |

---

## Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `nhl-player-shots.js` | `twoSidedFairProb` | import from `@cheddar-logic/models` (line 3) | ✓ WIRED |
| `run_nhl_player_shots_model.js` | `twoSidedFairProb` | import at line 36, used at lines 3153-3158, 3348-3358 | ✓ WIRED |
| `decision-pipeline-v2.js` | `edgeCalculator.noVigImplied` | direct call at line 1385 for MONEYLINE | ✓ WIRED |
| `decision-pipeline-v2.js` | `computeSpreadEdge` / `computeTotalEdge` | `result.p_implied` consumed at lines 1294, 1344 | ✓ WIRED |
| `mlb-model.js` F5 ML | two-sided devig | inline `rawHome / (rawHome + rawAway)` at line 673 | ✓ WIRED |
| `run_nba_model.js` | devigged edge | `marketDecisions` from decision-pipeline-v2 (line 685) | ✓ WIRED |

---

## Test Suites

| Suite | Result | Notes |
|-------|--------|-------|
| `packages/models` — 30 Jest tests | ✓ PASS | `decision-pipeline-v2-devig.test.js`, devig and edge tests all pass |
| `packages/models` — 2 suites "fail" to run | ℹ PRE-EXISTING | `edge-calculator.test.js` and `sharp-divergence-annotation.test.js` use custom `console.log` assertion pattern (no `it()`/`test()` blocks) — Jest reports "no tests" but all 47+ assertions PASS in output. Pre-existing issue, not a WI-0805 regression. |
| `apps/worker` — 1177 tests | ✓ PASS | 0 failures, 10 skipped, 3 suites skipped (unrelated) |

---

## Anti-Patterns Found

None. No TODOs, stubs, or placeholder return values found in modified files.

The `americanToImplied` fallback in `nhl-player-shots.js` and `run_nhl_player_shots_model.js` is intentional — it handles the edge case where only one side price is available (`?? americanToImplied(...)`), not a stub.

---

## Human Verification Required

### 1. Confirm VIG_REMOVAL_SKIPPED absent from live card payloads

**Test:** Pull a recent NHL game card payload from the DB and inspect the `card_payload` JSON.
**Expected:** No `VIG_REMOVAL_SKIPPED: true` field on game total/spread cards where both prices were available at fetch time.
**Why human:** Requires a production (or staging) DB run with real odds data; can't verify from code structure alone.

### 2. Confirm prob_edge_pp is ~2-4pp lower on a known NHL SOG card

**Test:** Compare a sample NHL SOG card's `prob_edge_pp` from a pre-fix run vs. a post-fix run for the same player/line.
**Expected:** Post-fix edge is approximately 2-4pp lower (vig no longer inflating apparent edge).
**Why human:** Requires historical card data for comparison; structural code verification can only confirm the formula changed.

---

## Assessment

All 7 acceptance criteria are structurally verified in the codebase. The implementation chose a **superior centralization strategy** vs. the WI spec: rather than patching every `computeEdge*` call site in `run_nhl_model.js`/`run_nba_model.js`, the fix was applied once in `decision-pipeline-v2.js` (the shared pipeline that both models route through), plus direct fixes in `nhl-player-shots.js`, `run_nhl_player_shots_model.js`, and `mlb-model.js`. This achieves the same correctness with less surface area.

Test suites: **1177 worker tests pass, 30 model tests pass, 0 new failures.**

---

_Verified: 2026-04-06_
_Verifier: GitHub Copilot (pax-verifier)_
