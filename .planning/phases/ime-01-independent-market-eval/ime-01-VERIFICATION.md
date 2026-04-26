---
phase: ime-01-independent-market-eval
verified: 2026-04-13T14:54:30Z
status: passed
score: 13/13 must-haves verified
human_verification:
  - test: "Run MLB and NHL model jobs on production-like odds snapshots and compare emitted card counts by market"
    expected: "Qualified markets in market_results appear as inserted cards; rejected markets only logged"
    why_human: "Requires live DB state, realistic odds feeds, and job scheduler behavior not fully reproducible in unit tests"
---

# Phase ime-01-independent-market-eval Verification Report

**Phase Goal:** Independent market evaluation with explicit terminal status accounting, no silent drops, and documented contract.
**Verified:** 2026-04-13T14:54:30Z
**Status:** passed
**Re-verification:** Yes — gap resolved

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | evaluateSingleMarket returns terminal status per market | ✓ VERIFIED | packages/models/src/market-eval.js exports evaluateSingleMarket; tests pass in packages/models suite (79/79) |
| 2 | finalizeGameMarketEvaluation partitions into official_plays/leans/rejected with game status | ✓ VERIFIED | packages/models/src/market-eval.js: finalizeGameMarketEvaluation and assertNoSilentMarketDrop |
| 3 | assertNoSilentMarketDrop enforces no silent drop invariant | ✓ VERIFIED | packages/models/src/market-eval.js throws UNACCOUNTED_MARKET_RESULTS and validates terminal status/reason_codes |
| 4 | REASON_CODES is centralized and exported | ✓ VERIFIED | packages/models/src/market-eval.js exports REASON_CODES |
| 5 | selectMlbGameMarket removed; evaluateMlbGameMarkets present | ✓ VERIFIED | apps/worker/src/models/mlb-model.js has evaluateMlbGameMarkets; no function definition for selectMlbGameMarket |
| 6 | MLB evaluation uses evaluateSingleMarket on all cards | ✓ VERIFIED | apps/worker/src/models/mlb-model.js: driverCards.map(card => evaluateSingleMarket(card, evalCtx)) |
| 7 | run_mlb_model uses evaluateMlbGameMarkets + assertNoSilentMarketDrop before write | ✓ VERIFIED | apps/worker/src/jobs/run_mlb_model.js: gameEval call then assertNoSilentMarketDrop at lines ~2150-2151 |
| 8 | MLB writes include official_plays + leans and logs rejected | ✓ VERIFIED | apps/worker/src/jobs/run_mlb_model.js: spreads gameEval.official_plays/gameEval.leans and calls logRejectedMarkets |
| 9 | cross-market exports evaluateNHLGameMarkets + choosePrimaryDisplayMarket | ✓ VERIFIED | apps/worker/src/models/cross-market.js lines ~1361, ~1395, exports lines ~1482-1483 |
| 10 | run_nhl_model uses evaluateNHLGameMarkets + assertNoSilentMarketDrop | ✓ VERIFIED | apps/worker/src/jobs/run_nhl_model.js lines ~2339-2341 |
| 11 | selectExpressionChoice preserved for backward compatibility | ✓ VERIFIED | apps/worker/src/jobs/run_nhl_model.js lines ~1420 and ~2336 |
| 12 | Contract doc exists with required invariants/reasoning | ✓ VERIFIED | docs/market_evaluation_contract.md contains UNACCOUNTED_MARKET_RESULTS and DUPLICATE_MARKET_SUPPRESSED |
| 13 | plan-01 key link: market-eval linked to decision-pipeline-v2 | ✓ VERIFIED | packages/models/src/market-eval.js now imports WATCHDOG_REASONS and buildDecisionV2 from decision-pipeline-v2 |

**Score:** 13/13 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| packages/models/src/market-eval.js | IME contract core + validation exports | ✓ VERIFIED | 307 lines, exports include evaluateSingleMarket/finalize/assert/log + VALID_* arrays |
| packages/models/src/market-eval.test.js | Unit coverage for terminal states/invariants | ✓ VERIFIED | 263 lines; packages/models tests all pass |
| apps/worker/src/models/mlb-model.js | evaluateMlbGameMarkets replacing selector | ✓ VERIFIED | evaluateMlbGameMarkets present; evaluateSingleMarket/finalize link present |
| apps/worker/src/jobs/run_mlb_model.js | Multi-market insertion using gameEval | ✓ VERIFIED | assert + rejected logs + official/lean insertion paths present |
| apps/worker/src/models/cross-market.js | evaluateNHLGameMarkets + choosePrimaryDisplayMarket | ✓ VERIFIED | both functions present and exported |
| apps/worker/src/jobs/run_nhl_model.js | NHL runner uses gameEval wiring | ✓ VERIFIED | evaluateNHLGameMarkets/assertNoSilentMarketDrop/choosePrimaryDisplayMarket wired |
| docs/market_evaluation_contract.md | Canonical market evaluation contract doc | ✓ VERIFIED | file exists with shapes, invariants, forbidden behaviors, smoke scenarios |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| apps/worker/src/models/mlb-model.js | packages/models/src/market-eval.js | require + evaluateSingleMarket/finalizeGameMarketEvaluation | WIRED | direct require and mapping present |
| apps/worker/src/jobs/run_mlb_model.js | evaluateMlbGameMarkets | import + per-game call + assert | WIRED | evaluateMlbGameMarkets called before transaction |
| apps/worker/src/models/cross-market.js | evaluateSingleMarket | marketDecisions mapped to evaluateSingleMarket | WIRED | market_results built from evaluateSingleMarket(card, evalCtx) |
| apps/worker/src/jobs/run_nhl_model.js | evaluateNHLGameMarkets | import via models index + call in loop | WIRED | gameEval created and asserted |
| packages/models/src/market-eval.js | packages/models/src/decision-pipeline-v2.js | require/import pattern from plan-01 | WIRED | explicit import of WATCHDOG_REASONS/buildDecisionV2 plus watchdog rejection path |
| docs/market_evaluation_contract.md | packages/models/src/market-eval.js | module path + symbol references | WIRED | doc references market-eval module and exports |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| IME-CONTRACT-01 | ime-01-01-PLAN.md | Shared market evaluation contract module | ✓ SATISFIED | packages/models/src/market-eval.js + tests |
| IME-MLB-01 | ime-01-02-PLAN.md | MLB independent evaluation replacing selector | ✓ SATISFIED | apps/worker/src/models/mlb-model.js |
| IME-MLB-02 | ime-01-02-PLAN.md | No silent MLB market drops | ✓ SATISFIED | evaluate + finalize + run_mlb assertions |
| IME-MLB-03 | ime-01-03-PLAN.md | run_mlb_model uses gameEval for writes | ✓ SATISFIED | official_plays + leans write path |
| IME-MLB-04 | ime-01-03-PLAN.md | Explicit skip statuses/logging for empty games | ✓ SATISFIED | SKIP_MARKET_NO_EDGE/SKIP_GAME_INPUT_FAILURE handling |
| IME-NHL-01 | ime-01-04-PLAN.md | NHL independent market evaluation | ✓ SATISFIED | evaluateNHLGameMarkets implementation |
| IME-NHL-02 | ime-01-04-PLAN.md | ML emitted independently from rank winner | ✓ SATISFIED | gameEval qualification gating + tests |
| IME-NHL-03 | ime-01-04-PLAN.md | Ranking is display-only; non-primary not deleted | ✓ SATISFIED | choosePrimaryDisplayMarket + tests |
| IME-CONTRACT-02 | ime-01-05-PLAN.md | Contract docs + VALID_* exports | ✓ SATISFIED | docs/market_evaluation_contract.md + market-eval exports |
| REQUIREMENTS.md mapping | global | Cross-reference against .planning/REQUIREMENTS.md | ? NEEDS HUMAN | .planning/REQUIREMENTS.md not present in workspace |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| apps/worker/src/jobs/run_nhl_model.test.js | 365 | Integration assertion expects NHL but reads MLB row from shared DB fixture | ⚠️ Warning | Produces 4 recurring test failures unrelated to IME changes |

### Human Verification Required

### 1. Live NHL Multi-Qualify Emission

**Test:** Run NHL model job on real snapshots where TOTAL and ML both qualify, then inspect inserted card_payloads for both nhl-totals-call and nhl-moneyline-call.
**Expected:** Both cards inserted with primary display metadata set and rejected market logged explicitly.
**Why human:** Requires live data timing and DB state not fully represented by deterministic fixtures.

### 2. Live MLB Empty-Edge Behavior

**Test:** Run MLB model on low-edge slate and inspect per-game logs + inserts.
**Expected:** `SKIP_MARKET_NO_EDGE` or `SKIP_GAME_INPUT_FAILURE` logged with zero inserted market cards.
**Why human:** Depends on production-like edge distribution and pipeline freshness.

### Gaps Summary

None. The prior key-link mismatch is resolved: `market-eval.js` now has explicit `decision-pipeline-v2` linkage and watchdog rejection handling aligned with the plan.

---

_Verified: 2026-04-13T14:54:30Z_
_Verifier: Claude (gsd-verifier)_
