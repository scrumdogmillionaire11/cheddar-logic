---
phase: di-01-decision-integrity
plan: "08"
subsystem: worker-betting
completed: 2026-04-11
---

# di-01-08 Summary

The playoff sigma multiplier now has an explicit contract in both NBA and NHL runners.

- Replaced implicit object spreading with explicit field construction for `margin`, `total`, `spread`, `sigma_source`, and playoff annotations.
- Added `run_nhl_model.playoff-sigma.test.js` to cover source preservation, multiplier behavior, NaN safety, and the playoff marker.

Verification:
- `npm --prefix apps/worker test -- --runInBand --testPathPattern=run_nhl_model.playoff-sigma`
