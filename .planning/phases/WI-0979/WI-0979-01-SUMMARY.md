---
phase: WI-0979
plan: 01
status: complete
---

# WI-0979: Forward-compatible migration preflight

## What was built

`scripts/migration-preflight.js` — runs on the Pi before `run-migrations.js`, aborts the deploy if any pending migration contains a destructive SQL operation.

## How it works

1. Queries the `migrations` table via `sqlite3` CLI to identify which files are already applied
2. Falls back to scanning all files if the DB isn't queryable yet
3. Scans each pending `.sql` file for destructive patterns:
   - `DROP TABLE` (non-temp — `*_new` suffix tables are excluded as a known cleanup pattern)
   - `DELETE FROM`
   - `RENAME TABLE` / `RENAME COLUMN`
   - `DROP COLUMN`
   - `TRUNCATE`
4. Reports the file name, line number, and matching snippet for each finding

## Bypass

`MIGRATION_PREFLIGHT_BYPASS=1` skips the exit-1 gate with a visible warning — for confirmed intentional data migrations.

## Integration

Added to `deploy-branch.yml` SSH script, ordered: config-drift → stop worker → install deps → **preflight** → run-migrations → restart → smoke checks.

The preflight runs after `packages/data install` (so sqlite3 is available) but before the worker is stopped — meaning a blocked preflight leaves the running worker completely untouched.
