# Quick Task 23: single-writer architecture — Summary

**Completed:** 2026-03-07
**Commits:** feat(quick-23-01), feat(quick-23-02)

## What changed

### Task 1 — `closeDatabaseReadOnly` + read-only `db-init.ts`
- `packages/data/src/db.js`: added `closeDatabaseReadOnly()` — closes DB without saving snapshot to disk
- `packages/data/index.js`: exported `closeDatabaseReadOnly`
- `web/src/lib/db-init.ts`: rewrote to call only `initDb()` — removed `runMigrations()` call entirely

### Task 2 — Strip all writes from web API routes
- `web/src/app/api/cards/route.ts`: already used `closeDatabaseReadOnly` (done in Task 1)
- `web/src/app/api/cards/[gameId]/route.ts`: removed `ensureRunStateSchema` (DDL + DML), made `getCurrentRunId` defensive (try/catch for missing table), switched to `closeDatabaseReadOnly`
- `web/src/app/api/games/route.ts`: fixed stale `closeDatabase()` call → `closeDatabaseReadOnly()`
- `web/src/app/api/results/route.ts`: removed `ensureCardDisplayLogSchema` (DDL), removed its call, switched to `closeDatabaseReadOnly`

## What was removed (and why)

| Removed | File | Reason |
|---------|------|--------|
| `runMigrations()` | `db-init.ts` | Migrations are writes — worker owns schema changes |
| `ensureRunStateSchema()` | `cards/[gameId]/route.ts` | CREATE TABLE + INSERT + ALTER TABLE + UPDATE |
| `ensureCardDisplayLogSchema()` | `results/route.ts` | CREATE TABLE + CREATE INDEX |
| `logCardDisplay()` calls | `cards/route.ts`, `games/route.ts` | INSERT into card_display_log |
| `closeDatabase()` (snapshot-save) | all routes | Replaced with `closeDatabaseReadOnly()` |

## Tradeoffs

- **`card_display_log` no longer populated by web server.** This table tracked which cards were displayed to users (used for results ledger filtering). If display analytics are needed, the worker can own this via a separate lightweight endpoint or event queue.
- **`run_state` table must exist before web serves cards.** If the worker hasn't run migrations yet, `getCurrentRunId` now returns `null` gracefully (returns empty card list) rather than creating the table itself.

## Result

Web server is provably read-only: no DDL, no DML, no snapshot saves. Worker is the sole writer. DB lock contention eliminated at the architectural level.
