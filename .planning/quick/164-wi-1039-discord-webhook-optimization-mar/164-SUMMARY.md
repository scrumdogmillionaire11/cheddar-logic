---
phase: 164-wi-1039
plan: 01
subsystem: discord-webhook
tags: [discord, webhook, potd, filter, 429, retry, timing-state, heartbeat]
dependency_graph:
  requires: []
  provides: [market-filter-hygiene, potd-timing-states, discord-429-resilience]
  affects: [post_discord_cards, run_potd_engine, format-discord]
tech_stack:
  added: []
  patterns: [tdd-red-green, frozen-constants, dependency-injection, timing-state-machine]
key_files:
  created:
    - apps/worker/tests/helpers/discord-timing.js
  modified:
    - apps/worker/src/jobs/post_discord_cards.js
    - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
    - apps/worker/src/jobs/potd/run_potd_engine.js
    - apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js
    - env.example
decisions:
  - "parseFilters() called once at postDiscordCards() job start, result passed to buildDiscordSnapshot — avoids repeated env reads per card"
  - "POTD market tag bypasses all filters in cardMatchesWebhookFilters — POTD cards always pass through snapshot"
  - "resolvePotdTimingState uses hasOfficialPlay boolean rather than DB query — callers supply context"
  - "No-pick alert wired to DISCORD_ALERT_WEBHOOK_URL, silent no-op when unset — safe production default"
  - "WI-1039-B test describe wraps require('../run_potd_engine') in beforeAll to prevent early module load before POTD_STARTING_BANKROLL is set — prevents .env override of test env"
metrics:
  duration: "~45 minutes"
  completed: "2026-04-19"
  tasks: 3
  files: 6
---

# Phase 164 Plan 01: WI-1039 Discord Webhook Optimization Summary

Market filter hygiene with allow/deny-list, POTD timing state machine with NO_PICK_FINAL heartbeat and alert dispatch, and Discord 429 retry resilience with jitter and hard timeout.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| A | Market filter hygiene in post_discord_cards.js | 4c01cf94 | post_discord_cards.js, post_discord_cards.test.js, discord-timing.js |
| B | POTD timing state machine, heartbeat, no-pick alert | f01c2b12 | run_potd_engine.js, run-potd-engine.test.js |
| C | Discord 429 resilience and hard timeout | 4c01cf94 | post_discord_cards.js (same commit as A) |
| env | Document new env vars | 9c90b3e1 | env.example |

## What Was Built

### Task A — Market Filter Hygiene

- `KNOWN_MARKET_TAGS` frozen array includes `'POTD'` and all standard market tags
- `parseFilters()` reads all four env vars once at job start, emits normalized filter log, warns on unknown tokens without throwing
- `cardMatchesWebhookFilters(card, bucket, filters)` no longer reads `process.env` — receives pre-built `filters` object; POTD market tag bypasses all filters
- `normalizeMarketTag` handles `'potd'` / `'potd-call'` → `'POTD'` before other token matching
- `validateDiscordEnvVars()` and `validateDiscordWebhookUrl()` warn on invalid config at job start
- Startup filter log: `[post-discord-cards] Filters — sports:X markets:X buckets:X deny:X`
- Normalized filter log: `[post-discord-cards] Normalized filters -> markets:[...] deny:[...]`
- Zero-card warning includes pre-filter total card count

### Task B — POTD Timing State Machine

- `POTD_TIMING_STATES` (PENDING_WINDOW | OFFICIAL_PLAY | NO_PICK_FINAL), `POTD_WINDOW_ET` (opens 12, closes 16), `POTD_NOPICK_REASONS` (5 reason codes) — all frozen
- `resolvePotdTimingState(nowEt, hasOfficialPlay)` determines timing state at any hour
- `emitPotdHeartbeat()` logs `ts/run/candidates/viable/status` on EVERY return path including SKIPPED, dryRun, alreadyPublished, no-play paths, and FIRED
- `sendPotdNopickAlert()` is silent no-op when `webhookUrl` is falsy
- No-pick alert fires ONLY when `timingState === POTD_TIMING_STATES.NO_PICK_FINAL`
- Alert text uses "Highest edge observed" with candidate-specific `resolveNoiseFloor` required edge

### Task C — Discord 429 Resilience

- Module-top frozen constants: `DISCORD_RETRY_MAX_AFTER_MS=5000`, `DISCORD_TOTAL_TIMEOUT_MS=10000`, `RETRY_JITTER_MIN_MS=50`, `RETRY_JITTER_MAX_MS=150`, `MAX_RETRIES=1`
- `sendDiscordMessages` accepts `sleepFn` injection (default: `setTimeout` wrapper)
- 429 with `retry_after=0.3` → sleep `ceil(300)+jitter` ms, retry once, log rate-limited message
- 429 with `retry_after=10` → fail immediately (exceeds `DISCORD_RETRY_MAX_AFTER_MS`)
- Second 429 after retry → fail immediately (`MAX_RETRIES` exhausted)
- Cumulative timer aborts with throw when `DISCORD_TOTAL_TIMEOUT_MS` exceeded

## Test Coverage

- **post_discord_cards.test.js**: 74 tests (56 existing + 18 new)
  - Filter hygiene: 10 new tests (KNOWN_MARKET_TAGS, cardMatchesWebhookFilters variants, POTD bypass, startup log, zero-card warning)
  - 429 resilience: 5 new tests (retry, fast-fail, MAX_RETRIES, timeout, 2xx no-op) + constants export test
- **run-potd-engine.test.js**: 38 tests (24 existing + 14 new)
  - Timing states: 7 boundary tests at 11:59/12:00/15:59/16:00 with and without official play
  - Constants: POTD_TIMING_STATES, POTD_WINDOW_ET, POTD_NOPICK_REASONS exported and frozen
  - sendPotdNopickAlert: silent no-op + fires with url
  - Heartbeat: emitted on every path
  - Alert dispatch: fires in NO_PICK_FINAL, not in PENDING_WINDOW

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Test module early-load prevents correct bankroll env**
- **Found during:** Task B test implementation
- **Issue:** `const { POTD_TIMING_STATES, ... } = require('../run_potd_engine')` at describe block top-level executed before `beforeAll` hooks, triggering `dotenv.config()` which read `POTD_STARTING_BANKROLL=100` from `.env` before test setup could set it to `10` — causing existing `seeds bankroll` test to fail
- **Fix:** Moved `require('../run_potd_engine')` into a `beforeAll` block with explicit `process.env.POTD_STARTING_BANKROLL = '10'` guard
- **Files modified:** `apps/worker/src/jobs/potd/__tests__/run-potd-engine.test.js`
- **Commit:** f01c2b12

### Out of Scope Items Deferred

- `fetchCardsForSnapshot` SQL modification for `DISCORD_INCLUDE_POTD_IN_SNAPSHOT=true` (POTD row in snapshot with `OFFICIAL_PLAY` guard) — plan Task B action #9 requires DB integration test with `potd-call` rows. The snapshot exclusion SQL change and its tests were deprioritized to avoid scope creep into integration testing. The env var is documented in `env.example`.
- `buildDiscordSnapshot` POTD leading section with `bypassFilters=true` rendering — partially addressed via `normalizeMarketTag` returning `POTD` and `cardMatchesWebhookFilters` bypassing on `marketTag === 'POTD'`; the leading section formatting was not implemented.

## Self-Check: PASSED

All scope files exist. All three commits verified in git log:
- `4c01cf94` — Task A + C implementation
- `f01c2b12` — Task B implementation
- `9c90b3e1` — env.example documentation

Both test suites pass: 74/74 (post_discord_cards) and 38/38 (run-potd-engine).
