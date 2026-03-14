---
phase: 35-wi-0448-settlement-segmentation-record-t
plan: 35
subsystem: settlement/lineage
tags: [lineage, audit, settlement, segmentation, data-contracts, ops]
dependency-graph:
  requires: []
  provides: [scripts/audit-lineage.js, DATA_CONTRACTS.md#record-lineage-map, ops-runbook.md#lineage-audit-procedure]
  affects: [settlement-pipeline, card_results, card_payloads, tracking_stats]
tech-stack:
  added: []
  patterns: [standalone-node-cli-script, destructured-db-init, per-record-lineage-check]
key-files:
  created:
    - scripts/audit-lineage.js
  modified:
    - docs/DATA_CONTRACTS.md
    - docs/ops-runbook.md
decisions:
  - "Audit script uses same DB init pattern as other root scripts (require packages/data/src/db.js, destructure initDb/getDatabase/closeDatabase) — no dotenv dependency at repo root"
  - "call_action and driver_context 33% baseline is expected: evidence/driver cards do not carry decision_v2 by design; documented as write-path gap (GAP-05, GAP-06) not a runtime bug"
  - "Gap classification covers all 9 gaps found: 5 write-path, 2 read-path, 1 naming-drift, 1 contract-gap"
metrics:
  duration: "~25 minutes"
  completed: "2026-03-14T11:00:07Z"
  tasks: 3
  files: 3
---

# Quick Task 35: WI-0448 Settlement Segmentation Record Traceability — Summary

Settlement/segmentation lineage audit: every play record now has a reproducible verification command, a written lineage map with 9 classified gaps, and triage steps in the ops runbook.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Trace lineage map and classify gaps | (analysis — fed Tasks 2 and 3) | — |
| 2 | Write audit script for reproducible per-record lineage verification | 2c28341, afeb71c | scripts/audit-lineage.js |
| 3 | Update DATA_CONTRACTS.md and ops-runbook.md | 271b099 | docs/DATA_CONTRACTS.md, docs/ops-runbook.md |

## What Was Built

### scripts/audit-lineage.js

Standalone Node.js CLI script (`node scripts/audit-lineage.js` from repo root). No build step. Uses the same DB init pattern as other repo scripts.

Produces three sections:

- **Section A — Coverage Summary**: per-field counts and percentages for sport, market_type, call_action, projection_source, driver_context, and Full Lineage (all 5)
- **Section B — Gap Table**: up to 20 sample records with missing lineage fields, formatted as a columnar table
- **Section C — Segmentation Bucket Coverage**: observed sport x market_type pairs vs expected pairs from TRACKING_DIMENSIONS.md

Actual production baseline (2026-03-14, 500 records):
- sport: 500/500 (100%)
- market_type: 500/500 (100%)
- call_action: 164/500 (33%) — expected; evidence cards lack decision_v2 by design
- projection_source: 453/500 (91%) — 9% gap on records missing model_output_ids
- driver_context: 164/500 (33%) — same root cause as call_action
- Full lineage (all 5): 117/500 (23%) — expected baseline until GAP-05/06 are resolved

### docs/DATA_CONTRACTS.md — ## Record Lineage Map

New top-level section appended. Contains:
- Canonical lifecycle diagram (ingest -> projection -> card gen -> settlement -> aggregation)
- Per-stage lineage fields table (5 stages, source and carried-forward-as columns)
- Segmentation bucket enumeration — all 8 dimensions with source-of-truth column and status
- Gap classification table: GAP-01 through GAP-09 with field, stage, classification, and fix recommendation
- Link to reproducible audit command and ops-runbook triage

### docs/ops-runbook.md — ## Lineage Audit Procedure

New section appended. Contains:
- When to run: settlement failures, schema migrations, monthly health check
- How to run: local and production commands with env loading pattern
- Triage decision table by Full Lineage % (95-100% / 80-94% / 50-79% / <50%)
- Per-field triage for all 5 lineage fields
- Manual sqlite3 record linkage check command
- Gap reference pointer to DATA_CONTRACTS.md

## Gap Classification (Task 1 Analysis)

| Gap ID | Field | Classification |
|--------|-------|---------------|
| GAP-01 | direction | write-path gap |
| GAP-02 | confidence_tier | write-path gap |
| GAP-03 | driver_key | write-path gap |
| GAP-04 | inference_source | read-path gap |
| GAP-05 | call_action (decision_v2.official_status) | write-path gap |
| GAP-06 | driver_context (decision_v2.drivers_used) | write-path gap |
| GAP-07 | projection_source (model_output_ids) | write-path gap |
| GAP-08 | card_type vs recommended_bet_type vs prediction_type | naming drift |
| GAP-09 | ev_threshold | write-path gap |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed db.closeDatabase() reference in audit-lineage.js**
- **Found during:** Task 2 verification
- **Issue:** Last `closeDatabase()` call at the end of `main()` used the old module reference `db.closeDatabase()` instead of the destructured `closeDatabase()`. Script printed the full report but exited with code 1 instead of 0.
- **Fix:** Changed `db.closeDatabase()` to `closeDatabase()` on line 353
- **Files modified:** scripts/audit-lineage.js
- **Commit:** afeb71c

**2. [Rule 3 - Blocking] Removed dotenv dependency from audit script**
- **Found during:** Task 2 first run
- **Issue:** `require('dotenv').config()` failed because dotenv is not installed at repo root (it is a worker-level dependency). The plan specified "no npm packages beyond what is already in the repo."
- **Fix:** Removed dotenv require; script relies on CHEDDAR_DB_PATH being set in the calling environment, matching the pattern used by all other root-level scripts (purge-seed-data.js, backtest-ncaam-ft-spread-rule.js, etc.)
- **Files modified:** scripts/audit-lineage.js
- **Commit:** 2c28341

### Pre-Existing Test Failures (Out of Scope)

Two test suites were failing before this task and remain unchanged:
- `apps/worker: ingest-stable-game-ids.test.js` — pre-existing failure
- `apps/worker: settlement-pipeline-integration.test.js` — pre-existing failure
- `packages/data`: 2 failed, 13 passed — pre-existing failures

These were confirmed pre-existing by running `git stash` and observing same failure counts. Not caused by this task.

## Self-Check: PASSED

- `scripts/audit-lineage.js` exists and exits 0: CONFIRMED
- `docs/DATA_CONTRACTS.md` contains `## Record Lineage Map`: CONFIRMED
- `docs/ops-runbook.md` contains `## Lineage Audit Procedure`: CONFIRMED
- Commits 2c28341, 271b099, afeb71c all exist in git log: CONFIRMED
