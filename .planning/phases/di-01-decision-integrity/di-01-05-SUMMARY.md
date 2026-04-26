---
phase: di-01-decision-integrity
plan: "05"
subsystem: model-core
completed: 2026-04-11
---

# di-01-05 Summary

`computeNBADriverCards()` now uses the same canonical NBA projection engine as the market-decision path.

- Replaced the legacy `projectNBA()` base-projection call with `projectNBACanonical()` plus `analyzePaceSynergy()`.
- Preserved the deprecated `projectNBA()` export for legacy callers.
- Added `nba-projection-parity.test.js` and re-ran the existing `nba-total-projection-alignment` suite.

Verification:
- `npm --prefix apps/worker test -- --runInBand --testPathPattern='(nba-projection-parity|nba-total-projection-alignment)'`
