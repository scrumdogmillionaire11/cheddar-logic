---
phase: quick-129
plan: "01"
subsystem: worker-tests
tags: [test-fix, decision-publisher, post-discord-cards, ci-unblock]
dependency_graph:
  requires: []
  provides: [WI-0790-ci-unblocked]
  affects: [decision-publisher.v2, post_discord_cards]
tech_stack:
  added: []
  patterns: [test-alignment-to-production-threshold]
key_files:
  modified:
    - apps/worker/src/utils/__tests__/decision-publisher.v2.test.js
    - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
decisions:
  - "Updated stale-input threshold from 60 min to 160 min to exceed STALE_BLOCK_THRESHOLD_MINUTES=150"
  - "Updated LEAN label assertion from '🟡 LEAN' to '🟡 Slight Edge' to match sectionLines renderer output"
metrics:
  duration: "3 minutes"
  completed: "2026-04-05T00:05:34Z"
  tasks_completed: 2
  files_modified: 2
---

# Phase quick-129 Plan 01: Fix decision-publisher.v2 stale-input and post_discord_cards LEAN label Summary

Aligned two test assertions to production behavior: STALE_BLOCK_THRESHOLD_MINUTES=150 (stale-input BLOCKED uses 160-min snapshot) and Discord renderer '🟡 Slight Edge' heading (replacing '🟡 LEAN').

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Fix decision-publisher.v2 stale-input BLOCKED test | 1b79af8 | apps/worker/src/utils/__tests__/decision-publisher.v2.test.js |
| 2 | Fix post_discord_cards LEAN label assertion | 9981f1f | apps/worker/src/jobs/__tests__/post_discord_cards.test.js |

## Verification Results

Joint run: `npm --prefix apps/worker test -- --testPathPattern="decision-publisher.v2|post_discord_cards"`

- Test Suites: 2 passed, 2 total
- Tests: 57 passed, 57 total
- 0 failures, 0 skipped

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check

- [x] `apps/worker/src/utils/__tests__/decision-publisher.v2.test.js` modified as specified
- [x] `apps/worker/src/jobs/__tests__/post_discord_cards.test.js` modified as specified
- [x] Commit 1b79af8 exists (Task 1)
- [x] Commit 9981f1f exists (Task 2)
- [x] Joint test run exits 0 with 57 passing tests

## Self-Check: PASSED
