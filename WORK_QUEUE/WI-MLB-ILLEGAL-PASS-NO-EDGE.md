---
ID: WI-MLB-ILLEGAL-PASS-NO-EDGE
Goal: Investigate and resolve the recurring ILLEGAL_PASS_NO_EDGE error in MLB model audit jobs
Scope:
  - apps/worker/src/jobs/run_mlb_model.js
  - apps/worker/src/audit/fixtures/mlb/*.json
  - Any related model logic or audit validation code
Out of scope:
  - Non-MLB model jobs
  - Unrelated audit fixtures
Acceptance:
  - CI audit jobs for MLB run without ILLEGAL_PASS_NO_EDGE errors
  - Root cause and fix are documented in the work item
Owner agent: TBD
Time window: TBD
Coordination flag: none
Depends on: none
Tests to run:
  - npm run job:run-mlb-model:test --prefix apps/worker
Manual validation:
  - Confirm error is resolved in CI and local runs
---

# Work Item: Investigate MLB ILLEGAL_PASS_NO_EDGE Audit Error

## Context

The MLB model audit job is currently producing an error:

    ILLEGAL_PASS_NO_EDGE: candidate=... raw_edge=... evaluation_status=EDGE_COMPUTED inputs_status=COMPLETE. PASS_NO_EDGE requires: EDGE_COMPUTED + COMPLETE inputs + threshold_passed=false + no block_reasons.

This work item is to be refined and prioritized for a future fix. No immediate action required until refinement.

## Notes
- Baseline drift issues have been resolved; this is a model logic/data validation issue.
- Attach logs and findings as the investigation proceeds.
