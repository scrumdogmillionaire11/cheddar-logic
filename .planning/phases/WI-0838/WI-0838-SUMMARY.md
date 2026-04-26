---
phase: WI-0838
plan: 01
subsystem: clv-data-integrity
tags: [clv, card-payloads, migration, sqlite, settle-pending-cards]
requires: [WI-0812]
provides: [first_seen_price-column, accurate-clv-odds-at-pick]
affects: [WI-0826]
tech-stack:
  added: []
  patterns: [write-once-at-insert, coalesce-fallback-for-migration-backcompat]
key-files:
  created:
    - packages/data/db/migrations/067_add_first_seen_price.sql
  modified:
    - packages/data/src/db/cards.js
    - apps/worker/src/jobs/settle_pending_cards.js
    - apps/worker/src/jobs/__tests__/settle_pending_cards.market-contract.test.js
decisions:
  - "first_seen_price is write-once: INSERT binds it, stmtUpdate (upsert refresh) intentionally omits it"
  - "null COALESCE fallback preserves backward compat for cards that predate migration 067"
metrics:
  duration: "~15 minutes"
  completed: "2026-04-10"
---

# WI-0838: CLV First-Seen Price Lock — Summary

**One-liner:** Added `first_seen_price` column (write-once at INSERT) to `card_payloads` and wired it as `odds_at_pick` in CLV ledger, eliminating drift from every-30-min model rewrites.

## What Was Done

`odds_at_pick` in `clv_ledger` was recording the price from the most recent `prepareModelAndCardWrite` cycle. Because the upsert cycle runs every 30 minutes, the opening price drifted and true CLV (beat the opening line) was unmeasurable.

### Changes

1. **Migration 067** (`packages/data/db/migrations/067_add_first_seen_price.sql`)
   - `ALTER TABLE card_payloads ADD COLUMN first_seen_price REAL`
   - Nullable; written once at card creation

2. **`packages/data/src/db/cards.js`** — `insertCardPayload`
   - Added `first_seen_price` to `INSERT OR IGNORE` column list
   - Bound to `lockedMarket?.lockedPrice ?? null` at INSERT time
   - `stmtUpdate` (upsert payload refresh) intentionally does **not** touch `first_seen_price` — the original price is frozen permanently

3. **`apps/worker/src/jobs/settle_pending_cards.js`**
   - Added `cp.first_seen_price` to `pendingStmt` SELECT so it arrives on each `pendingCard` row
   - `buildClvEntryFromPendingCard`: prefers `pendingCard.first_seen_price` over `lockedMarket.lockedPrice`; falls back to `lockedPrice` when `first_seen_price IS NULL` (backward compat for pre-migration cards)

4. **Tests** (`settle_pending_cards.market-contract.test.js`, +2 tests)
   - `first_seen_price` preferred over drifted `lockedPrice`: card `-115` vs lockedPrice `-125` → `oddsAtPick = -115`
   - `null first_seen_price` falls back to `lockedPrice`: → `oddsAtPick = -110`

## Test Results

| Suite | Result |
|-------|--------|
| settle_pending_cards.market-contract | 6/6 pass |
| settle_pending_cards (all suites) | 34/34 pass |

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Write-once at INSERT; UPDATE omits column | Simplest correct approach — no need for COALESCE trigger logic; the upsert UPDATE path is explicit and controlled |
| COALESCE null fallback in CLV builder | Pre-migration card rows have `first_seen_price = NULL`; reading `lockedPrice` as fallback avoids breaking existing CLV entries |

## Deviations from Plan

None — plan executed exactly as written.

## Next Phase Readiness

WI-0826 (`run_clv_snapshot.js`) reads pick-side data from `clv_ledger.odds_at_pick`. This WI's fix makes those values accurate. WI-0826 can now execute and produce correct CLV deltas from Day 1 of the new card cycle.
