---
phase: WI-0839
verified: 2026-04-08T20:00:00Z
status: passed
score: 5/5 must-haves verified
---

# WI-0839 Verification Report

**Phase Goal:** Gate 1P PLAY cards to LEAN when fewer than 40 settled NHL 1P results exist; add sigma_1p_source: static to all 1P card payloads.
**Status:** PASSED | **Score:** 5/5 | **Re-verification:** No

## Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | All 1P card payloads carry sigma_1p_source: static | VERIFIED | run_nhl_model.js L830: unconditional set before PLAY/EVIDENCE branch |
| 2 | 1P PLAY cards downgraded to LEAN when settled count < 40 | VERIFIED | L832-838: guards kind===PLAY and not sigma1pGatePassed; sets kind=LEAN |
| 3 | Downgraded cards carry SIGMA_1P_INSUFFICIENT_HISTORY reason code | VERIFIED | L834-836: spreads existing reason_codes + appends code |
| 4 | [SIGMA_1P] log fires once per run with settled count and sigma | VERIFIED | L1733: fires at L1721, before oddsSnapshots.forEach at L~1782 |
| 5 | Settled-count query uses json_extract(metadata) not missing column | VERIFIED | L1726-1727: json_extract(metadata,$.firstPeriodScores) OR $.first_period_scores; sport=NHL AND status=final |

## Required Artifacts

| Artifact | Exists | Substantive | Wired | Status |
| --- | --- | --- | --- | --- |
| apps/worker/src/jobs/run_nhl_model.js | YES | YES | YES | VERIFIED |
| apps/worker/src/jobs/__tests__/run_nhl_model.test.js | YES | YES (4 new tests in WI-0839 describe) | YES | VERIFIED |

## Key Links

| From | To | Via | Status |
| --- | --- | --- | --- |
| Pre-game-loop setup | settled1pCount + sigma1pGatePassed | getDatabase().prepare SQL L1721 | WIRED — fires before oddsSnapshots.forEach |
| applyNhlSettlementMarketContext | payload.sigma_1p_source | always-set L830 | WIRED |
| applyNhlSettlementMarketContext | payload.kind=LEAN | L832-838 PLAY-only guard | WIRED — EVIDENCE path unaffected |
| Call site L1990 | sigma1pGatePassed arg | applyNhlSettlementMarketContext(card, oddsSnapshot, sigma1pGatePassed) | WIRED |
| Call site L2076 | sigma1pGatePassed arg | applyNhlSettlementMarketContext(card, oddsSnapshot, sigma1pGatePassed) | WIRED |

## Requirements Coverage

| Criterion | Status |
| --- | --- |
| (1) All 1P card payloads carry sigma_1p_source: static in payloadData | SATISFIED — L830 |
| (2) < 40 settled rows => 1P PLAY->LEAN + SIGMA_1P_INSUFFICIENT_HISTORY | SATISFIED — L831-838 + json_extract query L1726 |
| (3) [SIGMA_1P] log emitted once per run with settled count and source | SATISFIED — L1733, pre-loop |
| (4) Test: assert PLAY->LEAN downgrade when settled count < 40 | SATISFIED — 4 tests, 30/30 passing |

## Anti-Patterns Found

None. EVIDENCE path unchanged. Game-total WI-0814 sigma gate unchanged.

## Human Verification Required

1. Empty-DB suppression check
   Test: On fresh DB run (empty game_results), confirm no 1P PLAY cards emitted.
   Expected: All nhl-pace-1p cards have kind: LEAN with SIGMA_1P_INSUFFICIENT_HISTORY.
   Why human: Requires DB state with 0 settled NHL 1P results.

2. Threshold boundary check
   Test: Run model against DB with exactly 39 vs 40 settled NHL 1P game_results rows.
   Expected: 39 rows => LEAN; 40 rows => PLAY permitted.
   Why human: Requires seeding game_results with specific row counts.

---
_Verified: 2026-04-08_
_Verifier: Claude (pax-verifier)_
