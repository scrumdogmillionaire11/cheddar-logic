---
phase: WI-0781-createjob-wrapper
plan: 02
subsystem: job-runtime
tags: [job-lifecycle, dry-run, process-exit, createJob, post_discord_cards, refresh_team_metrics]
status: complete

dependency-graph:
  requires:
    - WI-0781-01 (createJob API available from @cheddar-logic/data)
  provides:
    - post_discord_cards converted (no inline process.exit)
    - refresh_team_metrics_daily converted (no inline process.exit)
    - All 5 pilot jobs using createJob — WI-0781 acceptance criteria met
  affects: []

tech-stack:
  added: []
  patterns:
    - createJob(name, run) adopted across all 5 pilot jobs
    - result.success===false -> throw pattern for success-field health jobs
    - run(dryRun=false) param injection replaces process.argv.includes inside run fn

key-files:
  created: []
  modified:
    - apps/worker/src/jobs/post_discord_cards.js
    - apps/worker/src/jobs/refresh_team_metrics_daily.js

decisions:
  - name: Preserve post_discord_cards skipped/summary log lines inside wrapper
    why: The skipped-with-reason and sent/dry-run summary logs were in the entry block, not inside postDiscordCards. Moved into the createJob wrapper fn to preserve observability without modifying the core function.
  - name: run(dryRun) parameter injection for refresh_team_metrics_daily
    why: The run() fn read dryRun from process.argv internally. Changed signature to run(dryRun=false) and fall back to argv for manual invocation. createJob injects dryRun, preserving backward compat.
  - name: High-failure-rate process.exit(1) -> throw Error in refresh run()
    why: createJob's catch handles exit 1. Converting to throw keeps the exit contract identical while routing through the standard lifecycle.

metrics:
  duration: ~10min (wave 2, post-checkpoint)
  completed: 2026-04-05
  tasks-completed: 2/2 (+ checkpoint)
  tests: 1174 pass, 10 skip, 0 fail (post_discord_cards 10/10)

smoke-test:
  check_odds_health: "[check_odds_health] Starting (dryRun=true) → Complete"
  sync_game_statuses: "[sync_game_statuses] Starting (dryRun=true) → Complete"
  refresh_team_metrics_daily: "[refresh_team_metrics_daily] Starting (dryRun=true) → Complete (success=62/62)"
---

# Phase WI-0781 Plan 02: post_discord_cards + refresh_team_metrics_daily Summary

**One-liner:** Convert `post_discord_cards` and `refresh_team_metrics_daily` to `createJob`, completing WI-0781 pilot — all 5 jobs now use standardized lifecycle with zero `process.exit` in entry blocks.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Convert post_discord_cards.js to createJob | 32bf0af | apps/worker/src/jobs/post_discord_cards.js |
| 2 | Convert refresh_team_metrics_daily.js to createJob | 32bf0af | apps/worker/src/jobs/refresh_team_metrics_daily.js |
| 3 | Human smoke-test checkpoint | — | approved |

## Decisions Made

1. **`post_discord_cards` skipped/summary logs moved into wrapper** — preserved observability without touching core function logic.
2. **`run(dryRun=false)` param injection** — `refresh_team_metrics_daily`'s inner `run()` fn now accepts `dryRun` param; `process.argv` fallback kept for manual direct invocation.
3. **High-failure-rate `process.exit(1)` → `throw`** — routes through `createJob`'s catch, identical observable behavior.

## Deviations from Plan

None — plan executed exactly as written.

## WI-0781 Acceptance Criteria: ALL MET

- [x] `createJob` exported from `@cheddar-logic/data`
- [x] All 5 pilot jobs: `if (require.main === module)` contains only `createJob(...)` — zero `.then/.catch/process.exit`
- [x] DRY_RUN smoke: Starting + Complete emitted for check_odds_health, sync_game_statuses, refresh_team_metrics_daily
- [x] `post_discord_cards.test.js` 10/10 pass
- [x] Full suite: 1174 pass, 0 regressions
