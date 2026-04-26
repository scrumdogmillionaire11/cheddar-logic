---
phase: WI-0818-price-staleness-warning
plan: 01
subsystem: decision-publishing
tags: [price-staleness, discord, hard-lock, card-payload]
dependency-graph:
  requires: []
  provides: [price_staleness_warning on hard-locked card payloads, Discord warning line for stale prices]
  affects: [Discord card rendering, downstream payload consumers]
tech-stack:
  added: []
  patterns: [advisory-only warning attachment, optional-arg options object pattern]
key-files:
  created: []
  modified:
    - apps/worker/src/utils/decision-publisher.js
    - apps/worker/src/jobs/post_discord_cards.js
    - apps/worker/src/jobs/__tests__/post_discord_cards.test.js
decisions:
  - id: WI-0818-D1
    decision: Advisory-only warning; no change to lock/flip/gate logic
    rationale: Architectural changes to lock thresholds are out of scope; this is informational only
metrics:
  duration: ~3 minutes
  completed: 2026-04-09
---

# Phase WI-0818 Plan 01: Price Staleness Warning Summary

**One-liner:** `price_staleness_warning` payload field + Discord warning line when hard-locked card price drifts inside T-60 minutes.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Add price_staleness_warning to applyPublishedDecisionToPayload | 77b726e (prior) | decision-publisher.js, decision-publisher.v2.test.js |
| 2 | Discord embed rendering + 2 new tests | 22e69e9 | post_discord_cards.js, post_discord_cards.test.js |

## What Was Built

**Task 1** (pre-existing in this session): `applyPublishedDecisionToPayload` accepts `{ minutesToStart, candidatePrice }` options. When `minutesToStart < 60` and `|candidatePrice - lockedPrice| > 0`, attaches:
```json
{
  "locked_price": -110,
  "current_candidate_price": -130,
  "delta_american": 20,
  "minutes_to_start": 30,
  "reason": "HARD_LOCK_PRICE_DRIFT"
}
```
Also appends `PRICE_STALENESS_WARNING` to `payload.tags`. Call site in `publishDecisionForCard` passes `{ minutesToStart, candidatePrice: price }`.

**Task 2**: `renderDecisionLine` in `post_discord_cards.js` checks `payload?.price_staleness_warning` and appends:
```
⚠️ Hard-locked at -110 — current may be -130 (20 pts drift, T-30min)
```
Applies to both prop and market card rendering paths.

## Test Coverage

| Suite | Result |
|-------|--------|
| decision-publisher.v2 | 3 staleness tests pass (drift T<60, no drift T>=60, same price) |
| post_discord_cards | 2 new tests (warning shown, warning absent) + 15 existing |
| **Total** | **62/62 pass** |

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Advisory-only, no lock logic change | Behavioral changes to lock threshold are architectural (Rule 4 scope) |
| Warning in `renderDecisionLine` not `buildDiscordSnapshot` | Per-card concern; keeps rendering logic co-located |

## Deviations from Plan

None — plan executed exactly as written. Task 1 was already committed before this session started; Task 2 was the remaining gap.

## Next Phase Readiness

- No blockers introduced
- WI-0837 (ESPN null metrics alerting) and WI-0824 (two-layer execution gate) can proceed independently
