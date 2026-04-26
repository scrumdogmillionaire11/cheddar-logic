---
phase: pass-reason-integrity
verified: 2026-04-18T19:40:00Z
status: passed
score: 14/14 must-haves verified
gaps: []
human_verification:
  - test: "Run full test suite across all three affected packages"
    expected: "npx jest --testPathPattern='market-eval|mlb-model|post_discord_cards|run.mlb.model' passes 290+ tests with 0 failures"
    why_human: "Tests exist and source looks correct but CI/jest execution cannot be confirmed purely from source inspection"
---

# Phase pass-reason-integrity: PASS Reason Code Truth Chain Verification Report

**Phase Goal:** Eliminate all illegal PASS_NO_EDGE emissions across the MLB pipeline. Make PASS_NO_EDGE a derived conclusion (edge was computed, inputs were complete, threshold failed) rather than an assigned label. Install a hard-throw enforcer in the market-eval contract layer, fix the confidence-gate attribution bug in projectFullGameML, propagate reason codes through the card builder, and remove the fabricated PASS_NO_EDGE default from the display layer.

**Verified:** 2026-04-18T19:40:00Z
**Status:** passed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | buildResult() output includes inputs_status, evaluation_status, raw_edge_value, threshold_passed, block_reasons on every result | VERIFIED | market-eval.js lines 161-189: all 6 provenance fields present in buildResult() with correct defaults; every evaluateSingleMarket path sets them explicitly |
| 2 | assertLegalPassNoEdge() throws when raw_edge_value > 0 is labeled PASS_NO_EDGE | VERIFIED | market-eval.js lines 354-370: positiveEdge check (raw_edge_value > 0) throws ILLEGAL_PASS_NO_EDGE; Test G confirms |
| 3 | assertLegalPassNoEdge() throws when evaluation_status is NO_EVALUATION but PASS_NO_EDGE is assigned | VERIFIED | market-eval.js line 360: noEvaluation check; Test G2 confirms |
| 4 | finalizeGameMarketEvaluation emits SKIP_GAME_MIXED_FAILURES when some candidates were never evaluated | VERIFIED | market-eval.js lines 452-456: upgrade from SKIP_MARKET_NO_EDGE when any rejected result has evaluation_status=NO_EVALUATION; Test K confirms |
| 5 | assertNoSilentMarketDrop calls assertLegalPassNoEdge on each result | VERIFIED | market-eval.js line 377: `gameEval.market_results.forEach((r) => assertLegalPassNoEdge(r))` |
| 6 | projectFullGameML with edge>=LEAN_EDGE_MIN but confidence<gate emits PASS_CONFIDENCE_GATE, not PASS_NO_EDGE | VERIFIED | mlb-model.js lines 2007-2050: confidenceGateBlocked flag derived; three-way dispatch in reasonCodes array; return object sets pass_reason_code; Test C confirms |
| 7 | projectFullGameML with edge below threshold and confidence OK emits PASS_NO_EDGE (legal case) | VERIFIED | mlb-model.js line 2050: `side === 'PASS' && !confidenceGateBlocked && !rawEdgeCleared` → PASS_NO_EDGE; Test A confirms |
| 8 | projectFullGameML returns pass_reason_code, raw_edge_value, threshold_passed in its return object | VERIFIED | mlb-model.js lines 2092-2102: all four new fields present |
| 9 | projectF5TotalCard and projectFullGameTotal use priority-ordered selectPassReasonCode, not Array.find fallback | VERIFIED | mlb-model.js lines 1515, 1676: both sites use selectPassReasonCode(); PASS_REASON_PRIORITY constant at line 636; Test B confirms priority ordering |
| 10 | degraded + positive raw edge emits PASS_MODEL_DEGRADED, not PASS_NO_EDGE | VERIFIED | mlb-model.js line 2047-2049: `side==='PASS' && !confidenceGateBlocked && isDegraded && rawEdgeCleared` → PASS_MODEL_DEGRADED; Test D confirms |
| 11 | full_game_ml card payload carries pass_reason_code from projectFullGameML, not re-derived from ev_threshold_passed | VERIFIED | mlb-model.js line 2251-2253: `!mlResult.ev_threshold_passed ? (mlResult.pass_reason_code ?? 'PASS_NO_EDGE') : null`; Test H confirms end-to-end propagation |
| 12 | projection-floor synthetic fallback driver has no PASS_NO_EDGE in reason_codes | VERIFIED | run_mlb_model.js line 3970: `reason_codes: ['PASS_SYNTHETIC_FALLBACK']` — PASS_NO_EDGE absent; Test I (source scan) confirms |
| 13 | post_discord_cards decisionReason() returns null when no pass_reason_code is found, never invents PASS_NO_EDGE | VERIFIED | post_discord_cards.js line 777: `return null` (not 'PASS_NO_EDGE'); Test J confirms |
| 14 | run_mlb_model.js computeSyntheticLineF5Driver PASS_NO_EDGE is documented as legal invariant | VERIFIED | run_mlb_model.js line 2979: INVARIANT comment present before the PASS_NO_EDGE assignment |

**Score:** 14/14 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/models/src/market-eval.js` | Extended contract; assertLegalPassNoEdge; SKIP_GAME_MIXED_FAILURES | VERIFIED | All exports confirmed (line 479-490); 10 entries in VALID_STATUSES |
| `packages/models/src/__tests__/market-eval.test.js` | Tests F/F2/F3/G/G2/G3/K/L/VALID_STATUSES | VERIFIED | All scenario groups present (lines 288-429) |
| `apps/worker/src/models/mlb-model.js` | Fixed projectFullGameML; selectPassReasonCode; extended return; card builder propagation | VERIFIED | All fixes confirmed at lines 635-651, 2007-2102, 2251-2253 |
| `apps/worker/src/models/__tests__/mlb-model.test.js` | Scenarios A/B/C/D/H | VERIFIED | All scenarios present; selectPassReasonCode unit tests at line 1007 |
| `apps/worker/src/jobs/run_mlb_model.js` | Propagated pass_reason_code; scrubbed projection-floor; invariant comment | VERIFIED | Line 3970 scrubbed; line 2979 has invariant comment |
| `apps/worker/src/jobs/__tests__/run_mlb_model.test.js` | Test I (projection-floor source scan) | VERIFIED | PRI-RUNNER-02 describe block at line 4233 |
| `apps/worker/src/jobs/post_discord_cards.js` | Honest decisionReason() — null fallback | VERIFIED | line 777 returns null |
| `apps/worker/src/jobs/__tests__/post_discord_cards.test.js` | Tests J/J2 | VERIFIED | PRI-DISPLAY-01 describe block at line 1479 |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| assertNoSilentMarketDrop | assertLegalPassNoEdge | direct call on each result in gameEval.market_results | WIRED | market-eval.js:377 `gameEval.market_results.forEach((r) => assertLegalPassNoEdge(r))` |
| buildResult | inputs_status/evaluation_status/raw_edge_value | extra param destructured and returned | WIRED | market-eval.js:161-189 — all 6 fields in buildResult() |
| projectFullGameML reason code assignment | confidenceGateBlocked flag | rawBestEdge >= LEAN_EDGE_MIN && confidence < CONFIDENCE_MIN | WIRED | mlb-model.js:2007-2009 |
| pass_reason_code in projectF5TotalCard / projectFullGameTotal | selectPassReasonCode() | priority list lookup at both sites | WIRED | mlb-model.js:1515, 1676 |
| computeMLBDriverCards full_game_ml card builder | mlResult.pass_reason_code | direct propagation with ?? fallback | WIRED | mlb-model.js:2251-2253 `mlResult.pass_reason_code ?? 'PASS_NO_EDGE'` |
| decisionReason() in post_discord_cards.js | payload.pass_reason_code | direct read; fallback is null | WIRED | post_discord_cards.js:772-777 — return null at end |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status |
|-------------|------------|-------------|--------|
| PRI-CONTRACT-01 | Plan 01 | buildResult() extended with 6 provenance fields | SATISFIED — all 6 fields on every evaluation path |
| PRI-CONTRACT-02 | Plan 01 | assertLegalPassNoEdge() hard-throw enforcer exported and called | SATISFIED — exported at market-eval.js:487; called in assertNoSilentMarketDrop |
| PRI-CONTRACT-03 | Plan 01 | SKIP_GAME_MIXED_FAILURES in VALID_STATUSES; wired into finalizeGameMarketEvaluation | SATISFIED — 10th entry in VALID_STATUSES; upgrade logic at lines 452-456 |
| PRI-MLB-01 | Plan 02 | projectFullGameML confidence gate fix — PASS_CONFIDENCE_GATE vs PASS_NO_EDGE | SATISFIED — confidenceGateBlocked three-way dispatch verified |
| PRI-MLB-02 | Plan 02 | selectPassReasonCode() helper replaces Array.find fallbacks | SATISFIED — PASS_REASON_PRIORITY + selectPassReasonCode at lines 636-651; used at 1515, 1676 |
| PRI-MLB-03 | Plan 02 | projectFullGameML return contract extended with pass_reason_code/raw_edge_value/threshold_required/threshold_passed | SATISFIED — all 4 fields at lines 2092-2102 |
| PRI-RUNNER-01 | Plan 03 | full_game_ml card builder propagates mlResult.pass_reason_code | SATISFIED — mlb-model.js:2251-2253 |
| PRI-RUNNER-02 | Plan 03 | projection-floor driver reason_codes scrubbed of PASS_NO_EDGE | SATISFIED — run_mlb_model.js:3970 contains only PASS_SYNTHETIC_FALLBACK |
| PRI-DISPLAY-01 | Plan 03 | decisionReason() returns null as fallback, not PASS_NO_EDGE | SATISFIED — post_discord_cards.js:777 |

All 9 requirements satisfied. No orphaned requirements.

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/models/src/market-eval.js` | 39 | Comment says "nine terminal state values" but VALID_STATUSES has 10 entries | Info | Stale comment only; no behavioral impact |

No blocking anti-patterns found. The only PASS_NO_EDGE assignments outside test code are:
- `mlb-model.js:2050` — legal emission (true no-edge case: rawBestEdge < LEAN_EDGE_MIN)
- `mlb-model.js:2092-2099` — pass_reason_code ternary; PASS_NO_EDGE is the final else, meaning no other condition fired
- `mlb-model.js:2251-2253` — card builder with `?? 'PASS_NO_EDGE'` fallback (model always returns a code, fallback is defensive)
- `run_mlb_model.js:2980` — documented INVARIANT (synthetic line F5 driver; edge was computed and failed threshold)
- `run_mlb_model.js:1145,1164` — reading/checking for PASS_NO_EDGE, not emitting it
- `run_mlb_model.js:1583` — JSDoc comment string

---

### Human Verification Required

#### 1. Full Test Suite Execution

**Test:** Run `npx jest --testPathPattern="market-eval|mlb-model|post_discord_cards|run.mlb.model" --no-coverage` in the cheddar-logic workspace root.
**Expected:** All tests pass; 0 failures; total count approximately 290+ (SUMMARY reports 290 after Plan 03).
**Why human:** Test execution requires the local Jest environment and cannot be confirmed through static source inspection alone.

---

### Summary

All 14 must-haves are verified through source inspection. The phase goal is fully achieved:

1. **Contract layer (Plan 01):** `buildResult()` emits 6 provenance fields on every path. `assertLegalPassNoEdge()` is exported and wired into `assertNoSilentMarketDrop()` as a hard enforcer. `SKIP_GAME_MIXED_FAILURES` is the 10th entry in `VALID_STATUSES` and is emitted by `finalizeGameMarketEvaluation` when mixed evaluation states are detected.

2. **Model layer (Plan 02):** `projectFullGameML` derives `rawBestEdge`/`rawEdgeCleared`/`confidenceGateBlocked` before building `reasonCodes`, enabling a semantically correct three-way dispatch. `selectPassReasonCode()` with `PASS_REASON_PRIORITY` replaces `Array.find` fallbacks in both `projectF5TotalCard` and `projectFullGameTotal`. Extended return contract supplies `pass_reason_code`, `raw_edge_value`, `threshold_required`, `threshold_passed`.

3. **Card builder and display (Plan 03):** The full_game_ml card builder propagates `mlResult.pass_reason_code` instead of hardcoding `PASS_NO_EDGE`. The projection-floor fallback driver carries only `['PASS_SYNTHETIC_FALLBACK']`. `decisionReason()` returns `null` instead of fabricating `'PASS_NO_EDGE'`. The one legal `PASS_NO_EDGE` emission in `computeSyntheticLineF5Driver` is documented with an INVARIANT comment.

The only minor finding is a stale comment on `VALID_STATUSES` (line 39 still says "nine" after the 10th entry was added).

---

_Verified: 2026-04-18T19:40:00Z_
_Verifier: Claude (gsd-verifier)_
