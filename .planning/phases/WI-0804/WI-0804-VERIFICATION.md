---
phase: WI-0804-nhl-blk-model-audit
verified: 2026-04-05T20:00:00Z
status: gaps_found
score: 3/4 must-haves verified
gaps:
  - truth: BLK cards are emitted at 2+ and 3+ lines for high-volume blockers
    status: failed
    reason: lines_to_price is passed to projectBlkV1 (probs computed) but card construction block runs once for blkMarket.line only — no loop over blkLineCandidates to emit 2.5/3.5 cards
    artifacts:
      - path: apps/worker/src/jobs/run_nhl_player_shots_model.js
        issue: Card construction block (~L3185-3340) runs once using blkMarket (blkLineCandidates[0]); no iteration over remaining entries
    missing:
      - Loop over blkLineCandidates[1..] evaluating blk_mu >= 2.0 for 2.5 card and blk_mu >= 2.8 for 3.5 card
      - Integration test: player with blk_mu=2.4 and two lines (1.5, 2.5) produces 2 cards; blk_mu=1.1 produces 1 card
---

# WI-0804: NHL BLK Model Audit Verification Report

**Status:** gaps_found | **Score:** 3/4 must-haves verified | **Verified:** 2026-04-05T20:00:00Z

## Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | opponent_attempt_factor varies per opponent (not fixed 1.0) | VERIFIED | blkOppAttemptFactor from team_metrics_cache pace_proxy at L1978; fallback 1.0 with warn |
| 2 | playoff_tightening_factor > 1.0 for playoff games | VERIFIED | Date-based at L3107: Apr 19-Jun 30 => 1.06; uses game date not game_type col but functionally correct |
| 3 | BLK cards emitted at 2+ and 3+ lines for high-volume blockers | FAILED | lines_to_price wired into projectBlkV1 (probs computed) but card block runs once for blkMarket.line only |
| 4 | Tests added for playoff factor, opponent factor, multi-line pricing | VERIFIED | nhl-blk-model.test.js 423 lines; L50-92 factor tests, L165-174 lines_to_price test |

**Score:** 3/4 truths verified

## Gaps Summary

Gap 3 (multi-line card emission) is half-done. quick-133 wired lines_to_price so the model computes fair_over_prob_by_line for all candidate lines, but the card construction block still runs exactly once for blkLineCandidates[0]. No card is created for the 2.5 or 3.5 line even when blk_mu is high enough. Fix: loop over blkLineCandidates[1..] and call insertCardPayload per qualifying line using the fair/edge values from blkProjection.

Gap 4 (dz_factor / underdog_script_factor): WI lists it as in-scope lower-priority sub-finding but no SUMMARY or written recommendation exists.

---
_Verified: 2026-04-05T20:00:00Z — GitHub Copilot (pax-verifier)_
