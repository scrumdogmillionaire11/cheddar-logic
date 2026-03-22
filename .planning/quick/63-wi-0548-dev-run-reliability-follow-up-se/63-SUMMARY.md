---
phase: 63-wi-0548-dev-run-reliability-follow-up-se
plan: 63
subsystem: worker/settlement, packages/data/normalize, worker/discord
tags: [reliability, settlement, normalization, mls, dedup, discord]
dependency_graph:
  requires: []
  provides: [collision-dedup, mls-normalization, missing-market-key-autoclose, discord-skip-logging]
  affects: [settle_game_results, settle_pending_cards, post_discord_cards, normalize]
tech_stack:
  added: []
  patterns: [TDD-red-green, __private-export for unit testing, resolveNonActionableFinalReason row-param extension]
key_files:
  created:
    - .planning/quick/63-wi-0548-dev-run-reliability-follow-up-se/63-SUMMARY.md
  modified:
    - apps/worker/src/jobs/settle_game_results.js
    - apps/worker/src/jobs/__tests__/settle_game_results.matching.test.js
    - packages/data/src/normalize.js
    - packages/data/src/__tests__/normalize.soccer-team-variants.test.js
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/__tests__/settle_pending_cards.non-actionable.test.js
    - apps/worker/src/jobs/post_discord_cards.js
    - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
    - docs/DATA_PIPELINE_TROUBLESHOOTING.md
decisions:
  - "Extracted applyEventUseDedupRule() as a named, exported function (vs inline fix) to enable direct unit testing without requiring full settlement loop mocks"
  - "Added row as second parameter to resolveNonActionableFinalReason() (vs separate pre-pass) to keep all non-actionable reason logic co-located in one function"
  - "MISSING_MARKET_KEY check placed first in resolveNonActionableFinalReason() — market_key absence is a stronger blocker than kind/status classification"
  - "Discord skip tests: moved logSpy.mockRestore() after assertions (not in finally) to preserve call tracking before assertion"
metrics:
  duration: ~20 minutes
  completed: 2026-03-22
  tasks_completed: 2
  files_modified: 8
---

# Quick Task 63: WI-0548 Dev Run Reliability Follow-up Summary

**One-liner:** Collision dedup via `applyEventUseDedupRule()`, 11 MLS team variants in normalize.js, MISSING_MARKET_KEY auto-close in pending settlement, actionable Discord skip logging — 4 reliability gaps closed with TDD regression coverage.

## Tasks Completed

### Task 1: Settlement collision dedup + MLS team normalization

**settle_game_results.js — collision dedup:**

Extracted `applyEventUseDedupRule(eventId, gameSignature, eventUseById, errors)` from the inline collision check. The new function:

- Returns `'proceed'` when the event is not yet registered (normal path)
- Returns `'skip'` with a `console.log` debug message when the same signature is already registered (harmless duplicate row — no warn, no error push)
- Returns `'skip'` with `console.warn` + error push when a different game signature maps to the same ESPN event (true collision — existing behavior preserved)

The function is exported via `__private` for direct unit testing without full settlement loop mocks.

**normalize.js — MLS team variants:**

Added 9 explicit `TEAM_VARIANTS` alias arrays and 11 `LOGGED_TEAM_VARIANTS` passthrough entries covering all 11 MLS teams that appeared in `TEAM_MAPPING_UNMAPPED` during the 2026-03-22 dev run.

### Task 2: Pending market_key backlog + Discord local/dev skip + troubleshooting docs

**settle_pending_cards.js — MISSING_MARKET_KEY:**

Extended `resolveNonActionableFinalReason(payloadData, row)` with a `row` second parameter. Rows with `market_key IS NULL` are immediately classified as `MISSING_MARKET_KEY` before any kind/status checks and auto-closed with `status='error', result='void'`. The candidate query now selects `cr.market_key`. A `console.log` is emitted per auto-closed row with `resultId`, `cardId`, and `gameId` for diagnostics.

**post_discord_cards.js — actionable skip logging:**

Added `console.log` before both early-return skip blocks (`disabled` and `missing_webhook_url`) so operators see an explicit message in dev logs explaining why Discord posting is inactive, with instructions on what to set.

**docs/DATA_PIPELINE_TROUBLESHOOTING.md:**

Added "2026-03-22 Dev Run Reliability Fixes" section with before/after documentation for all 4 gaps.

## Test Coverage

| File | Tests Added | All Pass |
| ---- | ----------- | -------- |
| settle_game_results.matching.test.js | 5 new (getGameSignature pre-conditions + applyEventUseDedupRule 3 behaviors) | 16/16 |
| normalize.soccer-team-variants.test.js | 21 new MLS test.each cases | 42/42 |
| settle_pending_cards.non-actionable.test.js | 3 new (MK1/MK2/MK3) | 9/9 |
| post_discord_cards.test.js | 2 new skip-path tests | 10/10 |

## Commits

| Hash | Description |
| ---- | ----------- |
| 86d803e | test(63): RED — collision dedup + MLS variant failing tests |
| 2fc6813 | feat(63): collision dedup + MLS team normalization (GREEN) |
| f4fb8b5 | test(63): RED — MISSING_MARKET_KEY + Discord skip failing tests |
| fc4ef8a | feat(63): MISSING_MARKET_KEY auto-close + Discord skip logging + troubleshooting docs (GREEN) |

## Deviations from Plan

**1. [Rule 1 - Bug] Discord skip tests required moving mockRestore after assertions**

- **Found during:** Task 2, post_discord_cards skip-path tests
- **Issue:** Tests had `logSpy.mockRestore()` in a `finally` block before `expect(logSpy).toHaveBeenCalledWith(...)`. Jest `mockRestore()` clears call tracking, causing the assertion to see 0 calls even after a successful invocation.
- **Fix:** Moved `logSpy.mockRestore()` to after the assertions, with env cleanup inline.
- **Files modified:** `apps/worker/src/jobs/__tests__/post_discord_cards.test.js`

All other plan tasks executed exactly as written.

## Self-Check: PASSED

All 5 modified source files confirmed present. All 4 commits (86d803e, 2fc6813, f4fb8b5, fc4ef8a) confirmed in git log.
