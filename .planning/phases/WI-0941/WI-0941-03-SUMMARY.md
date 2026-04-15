---
phase: WI-0941
plan: "03"
subsystem: nba-model-closeout
tags: [regression-tests, quarantine, execution-gate, audit-closeout, TD-05]
dependency_graph:
  requires: [WI-0941-01, WI-0941-02]
  provides: [WI-0941-acceptance, nba-regression-coverage]
  affects: [run_nba_model.test.js, nba-blocking-audit.md]
tech_stack:
  added: []
  patterns: [TDD-regression, quarantine-on-off-coverage, post-publish-assertion]
key_files:
  created: []
  modified:
    - apps/worker/src/jobs/__tests__/run_nba_model.test.js
    - docs/audits/nba-blocking-audit.md
decisions:
  - TD-05: No actionable stale NBA selector-era comments found; all WI-reference comments accurate
  - Test A: Quarantine ON demotes PLAY to LEAN; price_reason_codes carries NBA_TOTAL_QUARANTINE_DEMOTE
  - Test B: Quarantine OFF leaves PLAY intact
  - Test C: Execution gate stamps decision_v2.official_status=PASS
  - DB validation in local env shows 0 NBA rows (expected; team metrics absent in dev)
metrics:
  duration: "30m"
  completed: "2026-04-15T01:13:00Z"
  tasks_completed: 3
  files_modified: 2
---

# Phase WI-0941 Plan 03: Regression Tests and Acceptance Closeout

Worker-side quarantine boundary tests + acceptance validation complete; all 4 required WI-0941 test suites pass; nba-blocking-audit.md finalized with rg proofs for all TDs.

## Tasks Completed

| Task | Status | Commit |
|------|--------|--------|
| Task 1: TD-05 stale comment cleanup | Complete (no-op) | cd0dcf1e |
| Task 2: Worker-side regression tests (quarantine + execution gate parity) | Complete | cd0dcf1e |
| Task 3: Final acceptance run + audit doc finalization | Complete | fcb32a68 |

## Key Changes

### Task 1: TD-05 Stale Comment Audit

Grep scan found no TODO/FIXME/deprecated/NBA selector-era comments in `run_nba_model.js`. All WI-reference comments are accurate historical annotations. TD-05 recorded as `retained-intentional` in audit doc.

### Task 2: Three new regression tests in run_nba_model.test.js

**Test A (quarantine path):** `QUARANTINE_NBA_TOTAL=true` → demotes PLAY → LEAN; `decision_v2.price_reason_codes` contains `NBA_TOTAL_QUARANTINE_DEMOTE`.

**Test B (non-quarantine path):** `QUARANTINE_NBA_TOTAL=false` → `decision_v2.official_status=PLAY` without quarantine code.

**Test C (execution gate parity):** `applyExecutionGateToNbaCard` on blocked card → `decision_v2.official_status=PASS` and `primary_reason_code=pass_reason_code`.

Note: Test A/B use `p_fair=0.595` fixture which clears NBA TOTAL `play_edge_min=0.062` (edge ≈ 0.071 > 0.062).

### Task 3: Acceptance RUN Results

```
Suites:
  decision-pipeline-v2-nba-total-quarantine.test.js: 13/13 pass
  report_telemetry_calibration.test.js: 8/8 pass
  run_nba_model.test.js: 19/19 pass (16 existing + 3 new)
  check-pipeline-health.nba.test.js: 11/11 pass
  TOTAL: 51 tests, 0 failures
```

## Deviations from Plan

**[Rule 1 - Bug] Updated existing execution-gate test expectations** (Task 2 setup)

The existing "execution gate demotes blocked executable market-call cards to PASS" test expected `decision_v2.official_status` to remain unchanged (== pre-gate PLAY). After TD-01 fix, it now correctly becomes PASS. Updated test to assert the correct post-fix behavior and removed the now-unused `decisionStatusBeforeGate` variable.

**[Rule 2 - Missing critical test fixture detail] Adjusted p_fair for PLAY-tier threshold**

Fixture `p_fair=0.58` produces LEAN (edge≈0.056 < play_edge_min=0.062). Updated to `p_fair=0.595` (edge≈0.071 > 0.062) to produce a PLAY-tier total card as intended.

## Self-Check

- [x] apps/worker/src/jobs/__tests__/run_nba_model.test.js has WI-0941 describe block
- [x] docs/audits/nba-blocking-audit.md has Final Acceptance Run section
- [x] Commits cd0dcf1e, fcb32a68 exist
- [x] 19/19 run_nba_model tests pass
- [x] All 4 required WI-0941 suites pass (51 total)

## Self-Check: PASSED
