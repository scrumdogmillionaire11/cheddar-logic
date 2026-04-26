---
phase: di-01-decision-integrity
plan: "04"
subsystem: worker-betting
completed: 2026-04-11
---

# di-01-04 Summary

Execution-gate vetoes now mutate decision state atomically instead of leaving ghost-bet contradictions behind.

- Added `applyDecisionVeto()` in `decision-publisher.js` and used it from the NHL execution gate.
- Added a settlement contradiction guard that skips `action=PASS` plus `decision_v2.official_status=PLAY`.
- Added `execution-gate-decision-consistency.test.js` to pin the veto contract.

Verification:
- `npm --prefix apps/worker test -- --runInBand --testPathPattern=execution-gate-decision-consistency`
