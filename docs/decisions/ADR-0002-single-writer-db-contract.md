# ADR-0002: Single-Writer DB Contract

- Status: Accepted
- Date: 2026-03-07
- Decision Makers: lane/data-platform, lane/web-platform

## Context

Cheddar Logic uses sql.js (an in-memory SQLite implementation). The database is persisted as a binary file on disk. Two processes run in production:

1. **Worker** (`apps/worker`) — runs model pipelines, writes cards, runs migrations
2. **Web server** (`web/`) — Next.js app, serves cards and results via REST API

Both processes previously performed DB writes:
- Web routes called `ensureRunStateSchema()`, `ensureCardDisplayLogSchema()`, `logCardDisplay()` (DDL + DML on every request)
- Web `db-init.ts` called `runMigrations()` on startup
- Web routes called `closeDatabase()` in `finally` blocks, which saves the in-memory DB snapshot back to disk

sql.js does not support safe concurrent multi-process writes. This caused:
- **File clobbering**: two in-memory copies saved independently, each overwriting the other
- **Lock contention**: web server's `closeDatabase()` prevented the worker from acquiring its write lock
- **JSON parse errors on the client** when the worker wrote while the web server held a lock, producing a truncated/corrupt DB file on the next read
- **Bootstrap DDL proliferation**: schema-creation logic spread across web routes instead of being owned by migrations

## Decision

The worker is the **sole writer** to the sql.js database. The web server is **strictly read-only**.

### Rules

| Aspect | Worker | Web server |
|--------|--------|-----------|
| DB writes (INSERT, UPDATE, DELETE) | Allowed | **Prohibited** |
| Schema changes (CREATE TABLE, ALTER TABLE, CREATE INDEX) | Allowed (via migrations only) | **Prohibited** |
| Snapshot save (`closeDatabase()`) | Allowed | **Prohibited** — use `closeDatabaseReadOnly()` |
| Migrations (`runMigrations()`) | Allowed | **Prohibited** |
| Reads (SELECT, PRAGMA) | Allowed | Allowed |

### Implementation

- `packages/data/src/db.js` exports `closeDatabaseReadOnly()` — closes the in-memory SQL.js instance without saving to disk.
- `web/src/lib/db-init.ts` calls only `initDb()` (SQL.js engine init; no disk write, no migrations).
- All web API routes (`web/src/app/api/**`) import and call `closeDatabaseReadOnly()` in `finally` blocks.
- Web routes that previously contained inline DDL/DML helpers (`ensureRunStateSchema`, `ensureCardDisplayLogSchema`, `logCardDisplay`) have had those removed. Schema must exist before the web server serves requests — guaranteed by the worker running migrations on startup.

### Graceful degradation

Web routes that query tables managed exclusively by migrations (e.g. `run_state`) must wrap those queries in `try/catch` and return an empty/sensible default if the table doesn't exist yet. This handles cold-start order (worker hasn't migrated yet).

## Consequences

### Positive
- No more DB lock contention between web and worker
- Snapshot-save race conditions eliminated
- Schema authority is centralized in migrations (single source of truth)
- `card_display_log` writes are no longer scatter-shot across web routes

### Negative
- `card_display_log` is no longer populated by the web server. If display analytics are needed, the worker must own that write path (e.g. via a lightweight event queue or direct worker-side logging).
- Web server returns empty data if the worker hasn't run migrations yet (first cold start). This is acceptable and clearly documented in route code.

## References
- Quick Task 23 implementation: `.planning/quick/23-single-writer-architecture-worker-owns-d/`
- `packages/data/src/db.js` — `closeDatabaseReadOnly` function
- `web/src/lib/db-init.ts` — read-only init
- `README.md` — repository-level runtime and ownership summary
- `packages/data/README.md` — DB path and migration/runtime notes
- `web/README.md` — web read-only runtime contract
