---
phase: WI-0941
plan: "02"
subsystem: check-pipeline-health
tags: [diagnostics, health-check, NBA, reason-family, audit]
dependency_graph:
  requires: []
  provides: [NBA-market-call-diagnostics, TD-03-proof, nba-blocking-audit]
  affects: [check_pipeline_health.js, check-pipeline-health.nba.test.js, docs/audits/nba-blocking-audit.md]
tech_stack:
  added: []
  patterns: [replicated-NHL-diagnostics-pattern, proof-by-rg]
key_files:
  created:
    - apps/worker/src/__tests__/check-pipeline-health.nba.test.js
    - docs/audits/nba-blocking-audit.md
  modified:
    - apps/worker/src/jobs/check_pipeline_health.js
decisions:
  - TD-04: NBA diagnostics added with POLICY_QUARANTINE family for NBA_TOTAL_QUARANTINE_DEMOTE
  - TD-03: Handled as proof-in-audit-doc; web filter contract already correct (no code change)
  - Discord phaseLookup wired for nba_market_call_diagnostics
metrics:
  duration: "20m"
  completed: "2026-04-15T01:13:00Z"
  tasks_completed: 2
  files_modified: 3
---

# Phase WI-0941 Plan 02: NBA Market Call Diagnostics

NBA reason-family diagnostics added to check_pipeline_health with POLICY_QUARANTINE family for quarantine-demoted cards; TD-03 proved by rg that filters.ts already handles decision_v2.official_status correctly.

## Tasks Completed

| Task | Status | Commit |
|------|--------|--------|
| Task 1: NBA reason-family diagnostics + health check wiring (TD-04) | Complete | 3103200c |
| Task 2: TD-03 proof and audit doc scaffold | Complete | 3103200c |

## Key Changes

### TD-04: NBA diagnostics in check_pipeline_health.js

- `NBA_REJECT_REASON_FAMILIES`: 7 families including `POLICY_QUARANTINE`
- `NBA_MARKET_CALL_CARD_TYPES`: `['nba-totals-call', 'nba-spread-call']`
- `classifyNbaRejectReasonFamily`: routes `NBA_TOTAL_QUARANTINE_DEMOTE` → `POLICY_QUARANTINE`
- `summarizeNbaRejectReasonFamilies`: per-market reason-family count summary
- `checkNbaMarketCallDiagnostics`: returns `{ok, reason, diagnostics: diag}` shape; writes to pipeline_health
- Wired into `checks` map and `checkPhaseLookup` for Discord alerts
- Exported via `module.exports`

### TD-03: Web filter proof

`rg -n "decision_v2.official_status|play.action === 'PASS'|play.classification === 'PASS'" web/src/lib/game-card/filters.ts` shows lines 354, 475, 476, 494 — PASS cards filtered, LEAN cards surface, no web-side reconstruction needed.

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] apps/worker/src/jobs/check_pipeline_health.js has summarizeNbaRejectReasonFamilies at line ~790
- [x] checkNbaMarketCallDiagnostics wired in checks map at line ~1346
- [x] nba_market_call_diagnostics in checkPhaseLookup at line ~1380
- [x] check-pipeline-health.nba.test.js created with 11 tests
- [x] docs/audits/nba-blocking-audit.md created
- [x] Commit 3103200c exists
- [x] 11/11 NBA health check tests pass
