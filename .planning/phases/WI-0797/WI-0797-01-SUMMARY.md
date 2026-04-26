---
phase: WI-0797
plan: "01"
subsystem: pipeline-health
tags: [discord, alerting, watchdog, dedup, cooldown, testing]

dependency-graph:
  requires: []
  provides:
    - Discord alert integration for pipeline health watchdog
    - shouldSendAlert streak+cooldown dedup logic
    - buildHealthAlertMessage Discord formatter
  affects:
    - Any future work touching check_pipeline_health.js alert logic

tech-stack:
  added: []
  patterns:
    - Exporting internal helpers for testability
    - SQL-based streak detection for dedup (no Redis/external state)
    - Cooldown via oldest-in-streak age check

key-files:
  created:
    - apps/worker/src/jobs/__tests__/check_pipeline_health.test.js
  modified:
    - apps/worker/src/jobs/check_pipeline_health.js

decisions:
  - title: "SQL streak query for cooldown dedup — no external state"
    rationale: "Query last N pipeline_health rows; if all failed AND oldest is within cooldown window, send alert. Once streak is older than cooldown, suppress. No Redis or extra table needed."
  - title: "checkPhaseLookup map inside checkPipelineHealth"
    rationale: "Maps checks-dict keys to (phase, check_name) pairs written to DB. Explicit and auditable without changing the check function API."

metrics:
  duration: "~6 minutes"
  completed: "2026-04-06"
---

# Phase WI-0797 Plan 01: Pipeline Health Watchdog Discord Alerts Summary

**One-liner:** Discord watchdog alert wired to `check_pipeline_health.js` using SQL streak detection + 30-minute cooldown dedup via `pipeline_health` table queries.

## What Was Built

Added Discord alert capability to the existing pipeline watchdog job, gated behind `ENABLE_PIPELINE_HEALTH_WATCHDOG=true`. When N consecutive `failed` rows accumulate for a check (default N=3) and the oldest row is within the cooldown window (default 30m), a single alert fires to `DISCORD_CARD_WEBHOOK_URL`. Subsequent ticks where the streak is older suppress the alert, preventing floods.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Add Discord alert logic to check_pipeline_health.js | 86eca79 | check_pipeline_health.js |
| 2 | Write unit tests for alert path and cooldown logic | 9701219 | `__tests__/check_pipeline_health.test.js` |

## Test Results

**19 tests passing** across 2 test suites:
- 6 existing MLB/odds tests untouched
- 13 new tests: shouldSendAlert (4), buildHealthAlertMessage (2), checkPipelineHealth integration (7)

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| SQL streak detection, no external state | Query last N `pipeline_health` rows; all-failed + oldest-within-cooldown = alert. Self-contained. |
| `status='warning'` excluded automatically | `shouldSendAlert` queries for consecutive `status='failed'`; settlement_backlog writes 'warning' → never qualifies |
| `checkPhaseLookup` map inside function | Maps check dict keys → (phase, check_name) pairs stored in DB. Explicit, testable, no API change |
| Optional env overrides with safe defaults | `PIPELINE_HEALTH_ALERT_CONSECUTIVE` (3) and `PIPELINE_HEALTH_COOLDOWN_MINUTES` (30) allow tuning without code changes |

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

- Watchdog is fully implemented and tested
- Requires `ENABLE_PIPELINE_HEALTH_WATCHDOG=true` to activate (off by default)
- Requires `DISCORD_CARD_WEBHOOK_URL` to be set (logs warning and skips if absent)
- No blockers for subsequent work
