---
phase: di-01-decision-integrity
plan: "06"
subsystem: model-core
completed: 2026-04-11
---

# di-01-06 Summary

The v2 threshold registry now covers NHL spread and puckline explicitly and has a completeness test.

- Added explicit `NHL:SPREAD` and `NHL:PUCKLINE` threshold entries.
- Added `threshold-registry-completeness.test.js` for the currently supported explicit registry keys.

Verification:
- `npm --prefix packages/models test -- --runInBand --testPathPattern=threshold-registry-completeness`
