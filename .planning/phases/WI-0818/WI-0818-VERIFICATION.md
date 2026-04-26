---
phase: WI-0818-price-staleness-warning
verified: 2026-04-09T23:38:00Z
status: passed
score: 5/5 must-haves verified
---

# Phase WI-0818 Verification Report

**Goal:** Attach price_staleness_warning to hard-locked card payloads when price drifts inside T-60.
**Status:** PASSED | **Score:** 5/5 | **Re-verification:** No

## Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Hard-locked card at T<60 with drifted price carries price_staleness_warning with all 4 fields | VERIFIED | decision-publisher.js lines 467-476; test v2.test.js:1264 |
| 2 | Hard-locked card at T>=60 does NOT emit warning even with drift | VERIFIED | minutesToStart < 60 guard line 467; test v2.test.js:1341 asserts undefined |
| 3 | Same price (no drift) emits no warning at any time | VERIFIED | priceDelta > 0 gate line 467; test v2.test.js:1410 asserts undefined |
| 4 | PRICE_STALENESS_WARNING tag appears in payload.tags when warning attached | VERIFIED | decision-publisher.js line 476; test v2.test.js:1272 arrayContaining |
| 5 | No behavioral change to lock/flip logic | VERIFIED | hardLockMinutes=120 unchanged line 616; shouldFlip import unmodified |

**Score: 5/5**

## Required Artifacts

| Artifact | Lines | Status |
| --- | --- | --- |
| apps/worker/src/utils/decision-publisher.js | 752 | VERIFIED — wired at call site line 720 |
| apps/worker/src/jobs/post_discord_cards.js | 935 | VERIFIED — renderDecisionLine prop:548 market:583 |
| apps/worker/src/utils/__tests__/decision-publisher.v2.test.js | 1493 | VERIFIED — 3 staleness tests lines 1199/1276/1345 |
| apps/worker/src/jobs/__tests__/post_discord_cards.test.js | 396 | VERIFIED — 2 Discord staleness tests lines 339/374 |

## Key Link Verification

| From | To | Status |
| --- | --- | --- |
| publishDecisionForCard | applyPublishedDecisionToPayload via minutesToStart+candidatePrice line 720 | WIRED |
| priceDelta > 0 and minutesToStart < 60 gate | payload.price_staleness_warning lines 468-475 | WIRED |
| price_staleness_warning | PRICE_STALENESS_WARNING tag line 476 | WIRED |
| price_staleness_warning | Discord market renderDecisionLine line 583 | WIRED |
| price_staleness_warning | Discord prop renderDecisionLine line 548 | WIRED |

## Acceptance Criteria

All 6 AC from WI-0818.md satisfied. minutesToStart/candidatePrice opts wired; T<60+drift attaches warning; T>=60 clean; same-price clean; tag attached; 62/62 tests pass.

## Anti-Patterns

grep -c TODO/FIXME/placeholder on both modified files: 0/0. No stubs.

## Test Results

62/62 PASS (decision-publisher.v2 + post_discord_cards). Zero regressions.

## Human Verification Required

1. **Live staleness on production** — query card_payloads.price_staleness_warning on a HARD-locked card fired within T-60 with drifted market. Why human: requires live gated card with actual price movement.
2. **Discord visual** — run dry-run post with a stale HARD-lock card in DB; expect Hard-locked warning line in output. Why human: requires live webhook or screenshot to confirm rendering.

---
_Verified: 2026-04-09 | Verifier: Claude (pax-verifier)_
