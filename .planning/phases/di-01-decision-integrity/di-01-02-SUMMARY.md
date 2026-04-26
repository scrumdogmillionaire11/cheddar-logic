---
phase: di-01-decision-integrity
plan: "02"
subsystem: worker-betting
completed: 2026-04-11
---

# di-01-02 Summary

NHL `NO_BET` outcomes are now explicit skip states instead of silent zero-card fallthroughs.

- Added `applyNoBetGuard()` after `computeNHLMarketDecisions()` in the NHL runner.
- Wrote `blocking_reason_codes` into `gamePipelineStates` and tracked `noBetCount` in the run summary.
- Added `run_nhl_model.no-bet.test.js` to cover `DOUBLE_UNKNOWN_GOALIE` and the non-guard path.

Verification:
- `npm --prefix apps/worker test -- --runInBand --testPathPattern=run_nhl_model.no-bet`
