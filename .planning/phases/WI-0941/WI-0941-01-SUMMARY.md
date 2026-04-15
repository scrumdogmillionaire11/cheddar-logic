---
phase: WI-0941
plan: "01"
subsystem: nba-model-worker
tags: [decision-consistency, execution-gate, no-odds-mode, quarantine]
dependency_graph:
  requires: []
  provides: [decision_v2.official_status-consistent-at-execution-gate, NBA_NO_ODDS_MODE_LEAN-post-publish]
  affects: [run_nba_model.js, decision-pipeline-v2-nba-total-quarantine.test.js]
tech_stack:
  added: []
  patterns: [post-publish-mutation, decision_v2-stamping, NHL-WI-0940-precedent]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/run_nba_model.js
    - apps/worker/src/jobs/__tests__/run_nba_model.test.js
decisions:
  - TD-01: Stamp decision_v2.official_status=PASS + primary_reason_code at execution gate demotion
  - TD-02: Post-publish TOTAL no-odds-mode stamping of NBA_NO_ODDS_MODE_LEAN after publishDecisionForCard
  - Quarantine on/off tests remain in packages/models; no cross-package imports added
metrics:
  duration: "31m"
  completed: "2026-04-15T01:13:00Z"
  tasks_completed: 2
  files_modified: 2
---

# Phase WI-0941 Plan 01: Execution Gate Decision_V2 Consistency

Decision_v2.official_status now stamped at execution gate demotion and post-publish TOTAL no-odds-mode path, eliminating divergence between legacy status fields and canonical decision_v2 contract.

## Tasks Completed

| Task | Status | Commit |
|------|--------|--------|
| Task 1: Stamp decision_v2 at execution gate and post-publish TOTAL no-odds override | Complete | e8973d05 |
| Task 2: Quarantine on/off contract via updated test cases | Complete | pre-existing (13 tests all pass) |

## Key Changes

### TD-01: applyExecutionGateToNbaCard decision_v2 stamping

Added to `apps/worker/src/jobs/run_nba_model.js` after the existing execution gate demotion block:

```js
// WI-0941 TD-01: Stamp decision_v2 at execution gate demotion so official_status remains consistent
if (payload.decision_v2 && typeof payload.decision_v2 === 'object') {
  payload.decision_v2.official_status = 'PASS';
  payload.decision_v2.primary_reason_code = passReasonCode;
}
```

### TD-02: Post-publish TOTAL no-odds-mode LEAN stamping

`NBA_NO_ODDS_MODE_LEAN` appended to `reason_codes` and set as `decision_v2.primary_reason_code` after `publishDecisionForCard` in the nba-totals-call loop. Matches NHL WI-0940 pattern exactly.

### Test update

Updated the existing "execution gate demotes blocked executable market-call cards to PASS" test to assert the new stamped decision_v2 fields rather than the pre-gate values.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] apps/worker/src/jobs/run_nba_model.js modified with TD-01 stamp at line ~629
- [x] apps/worker/src/jobs/run_nba_model.js has NBA_NO_ODDS_MODE_LEAN at lines 1786-1792
- [x] Commit e8973d05 exists
- [x] 16/16 run_nba_model tests pass
- [x] 13/13 quarantine tests pass
