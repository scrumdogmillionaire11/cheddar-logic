# potd-01-01 Summary: POTD DB Contract

**Completed:** 2026-04-09
**Commit:** not committed

## What Was Done

Added the two POTD schema migrations required for the worker-owned write path and
the web read surface:

- `packages/data/db/migrations/063_create_potd_plays.sql`
- `packages/data/db/migrations/064_create_potd_bankroll.sql`

`potd_plays` now holds the single daily published play, settlement state, and
bankroll-at-post metadata. `potd_bankroll` is an append-only ledger keyed to the
published play via `play_id`.

## Verification

- `node packages/data/src/migrate.js`
- Verified `potd_plays` and `potd_bankroll` exist in `sqlite_master` on a fresh DB

## Acceptance Criteria Status

- [x] `potd_plays` created with unique `play_date` and `card_id`
- [x] `potd_bankroll` created as an append-only ledger
- [x] Both migrations use repo-standard `IF NOT EXISTS` patterns
- [x] Migration suite applies cleanly from a fresh database
