---
phase: quick-23
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/lib/db-init.ts
  - web/src/app/api/cards/route.ts
  - web/src/app/api/games/route.ts
  - web/src/app/api/results/route.ts
autonomous: true
requirements: [QUICK-23]

must_haves:
  truths:
    - "Web server starts without running migrations or acquiring write locks"
    - "GET /api/cards returns cards without writing to the DB"
    - "GET /api/games returns games without writing to the DB"
    - "GET /api/results returns results without writing to the DB"
    - "card_display_log entries are NOT written by web server (dropped entirely)"
    - "Worker remains the sole process that writes, migrates, and saves snapshots"
  artifacts:
    - path: "web/src/lib/db-init.ts"
      provides: "Read-only DB init — loads SQL.js and reads file, no migrations, no lock"
    - path: "web/src/app/api/cards/route.ts"
      provides: "Cards API — read-only queries only"
    - path: "web/src/app/api/games/route.ts"
      provides: "Games API — read-only queries only"
    - path: "web/src/app/api/results/route.ts"
      provides: "Results API — read-only queries only"
  key_links:
    - from: "web/src/lib/db-init.ts"
      to: "packages/data/src/db.js initDb()"
      via: "initDb() only — no runMigrations()"
      pattern: "initDb.*no.*runMigrations"
    - from: "web/src/app/api/cards/route.ts"
      to: "DB"
      via: "SELECT only — no INSERT/UPDATE/exec"
      pattern: "no stmt\\.run|no db\\.exec"
---

<objective>
Enforce single-writer architecture: the worker is the only process that writes to the sql.js
SQLite database. The Next.js web server becomes strictly read-only.

Purpose: sql.js does not support safe concurrent multi-process writes. Both processes writing
causes lock contention and data corruption risk. The worker owns all DB mutations.

Output: Web server that only reads from the DB — no migrations on startup, no write locks
acquired, no schema DDL, no INSERT/UPDATE from request handlers.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
</execution_context>

<context>
@.planning/STATE.md

Key facts discovered during planning:

**What the web server currently writes (all must be removed):**

1. `web/src/lib/db-init.ts` — calls `initDb()` + `runMigrations()` on first request.
   - `runMigrations()` is a write operation. Must be dropped.
   - `initDb()` only initializes SQL.js (no write); keep it.

2. `web/src/app/api/cards/route.ts`:
   - `ensureRunStateSchema(db)` — runs `CREATE TABLE IF NOT EXISTS run_state` + `INSERT OR IGNORE`
   - `ensureCardPayloadRunIdColumn(db)` — runs `ALTER TABLE` + `CREATE INDEX` + `UPDATE`
   - `ensureCardDisplayLogSchema(db)` — runs `CREATE TABLE IF NOT EXISTS card_display_log` + `CREATE INDEX`
   - `logCardDisplay(db, ...)` — runs `INSERT OR IGNORE INTO card_display_log`
   - `closeDatabase()` — saves DB snapshot to disk (write). Must be replaced with read-only close.

3. `web/src/app/api/games/route.ts`:
   - Same `ensureRunStateSchema`, `ensureCardDisplayLogSchema`, `logCardDisplay` calls
   - Same `closeDatabase()` snapshot-save issue

4. `web/src/app/api/results/route.ts`:
   - `ensureCardDisplayLogSchema(db)` call
   - `closeDatabase()` call

**What to keep (read-only operations — all fine):**
- `initDb()` — just initializes SQL.js engine, no writes
- `getDatabase()` — loads file into memory (read-only load)
- All `SELECT` queries via `db.prepare(...).get(...)` and `db.prepare(...).all(...)`
- `PRAGMA table_info(...)` — read-only introspection

**Strategy for `closeDatabase()`:**
`closeDatabase()` calls `saveDatabase()` which writes the in-memory DB snapshot back to disk,
then releases the file lock. Instead, web should call `db.close()` (or just let the instance
be garbage collected) without saving. A new helper `closeDatabaseReadOnly()` should be exported
from `packages/data/src/db.js` that closes without saving.

OR simpler: just call `dbInstance.close()` directly and skip `closeDatabase()`. Since web only
reads, there is nothing to persist. We'll add a `closeDatabaseReadOnly` export.

**card_display_log writes:**
These log which cards were displayed to users. Dropping them from the web server means this
analytics table is no longer populated. That is acceptable — the table was created by the web
server and is only used for the results ledger filter. Document this tradeoff in a comment.
If display-log tracking is needed later, a separate lightweight append service or the worker
can handle it.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add closeDatabaseReadOnly to data package and fix db-init.ts</name>
  <files>packages/data/src/db.js, packages/data/index.js, web/src/lib/db-init.ts</files>
  <action>
**Step 1 — Add `closeDatabaseReadOnly` to `packages/data/src/db.js`:**

After the existing `closeDatabase()` function (line ~639), add:

```js
/**
 * Close database without saving to disk (read-only consumers).
 * Use this in the web server — it must never write or acquire write locks.
 */
function closeDatabaseReadOnly() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
  releaseDbFileLock();
  oddsContextReferenceRegistry = new WeakMap();
}
```

Add `closeDatabaseReadOnly` to the `module.exports` object at the bottom of `db.js`.

**Step 2 — Export from `packages/data/index.js`:**

Add `closeDatabaseReadOnly: db.closeDatabaseReadOnly,` alongside the existing `closeDatabase` export.

**Step 3 — Rewrite `web/src/lib/db-init.ts`:**

Replace the entire file with a read-only version that:
- Only calls `initDb()` (SQL.js engine init — no disk write)
- Does NOT call `runMigrations()`
- Logs clearly that this is a read-only init

```typescript
/**
 * Database Read-Only Initialization
 *
 * The web server is strictly read-only. It MUST NOT run migrations,
 * write snapshots, or acquire write locks.
 * The worker process owns all DB writes.
 */

import { initDb } from '@cheddar-logic/data';

let dbReadyPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (dbReadyPromise) {
    return dbReadyPromise;
  }

  dbReadyPromise = (async () => {
    try {
      await initDb();
      // NOTE: No runMigrations() here. Worker owns all schema changes.
      console.log('[DB] SQL.js engine initialized (read-only mode)');
    } catch (error) {
      dbReadyPromise = null;
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[DB] Read-only init failed:', errorMsg);
      throw error;
    }
  })();

  return dbReadyPromise;
}
```
  </action>
  <verify>
Check that `runMigrations` is absent from `web/src/lib/db-init.ts`:
`grep -n "runMigrations" /Users/ajcolubiale/projects/cheddar-logic/web/src/lib/db-init.ts` — must return nothing.
Check `closeDatabaseReadOnly` is exported: `grep "closeDatabaseReadOnly" /Users/ajcolubiale/projects/cheddar-logic/packages/data/index.js` — must match.
  </verify>
  <done>
`db-init.ts` contains only `initDb()`, no `runMigrations`. `closeDatabaseReadOnly` is exported from `@cheddar-logic/data`. No file on disk is written when the web server starts.
  </done>
</task>

<task type="auto">
  <name>Task 2: Strip all writes from web API routes</name>
  <files>
    web/src/app/api/cards/route.ts,
    web/src/app/api/games/route.ts,
    web/src/app/api/results/route.ts
  </files>
  <action>
In all three route files, make these changes:

**A. Replace `closeDatabase` import with `closeDatabaseReadOnly`:**

In each file, change:
```typescript
import { getDatabase, closeDatabase } from '@cheddar-logic/data';
```
to:
```typescript
import { getDatabase, closeDatabaseReadOnly } from '@cheddar-logic/data';
```

**B. Replace all `closeDatabase()` calls with `closeDatabaseReadOnly()`:**

In each `finally` block, change `closeDatabase()` to `closeDatabaseReadOnly()`.

**C. Remove all write operations from `cards/route.ts`:**

1. Delete the `ensureCardDisplayLogSchema()` function entirely.
2. Delete the `ensureRunStateSchema()` function entirely.
3. Delete the `logCardDisplay()` function entirely.
4. In the `GET` handler body, remove the call to `ensureRunStateSchema(db)`.
5. Remove the `for` loop that calls `logCardDisplay(db, {...})` over each row.
6. Remove the call to `ensureCardDisplayLogSchema(db)` before the loop.
7. Add this comment where the logCardDisplay loop was:
   ```typescript
   // NOTE: card_display_log writes intentionally removed.
   // Worker owns all DB writes (single-writer architecture).
   // Display analytics can be added back via worker-side logging if needed.
   ```

Keep `getActiveRunIds()` and `getRunStatus()` — these are pure reads (SELECT only).

**D. Remove all write operations from `games/route.ts`:**

Same pattern as cards:
1. Delete `ensureCardDisplayLogSchema()` function.
2. Delete `ensureRunStateSchema()` function.
3. Delete `logCardDisplay()` function.
4. Remove calls to `ensureRunStateSchema(db)` and `ensureCardDisplayLogSchema(db)` from GET handler.
5. Remove the `logCardDisplay` loop.
6. Add the same "single-writer" comment where removed.

Keep all SELECT-based helpers (e.g., `getActiveRunIds`, `getRunStatus`, `getPlaysByGameId`, etc.).

**E. Remove write operations from `results/route.ts`:**

1. Delete `ensureCardDisplayLogSchema()` function.
2. Remove its call from the GET handler.
3. Add single-writer comment.

After all changes, verify no write operations remain:
- No `db.exec(...)` calls in any web route
- No `stmt.run(...)` calls in any web route
- No `CREATE TABLE`, `INSERT`, `UPDATE`, `ALTER TABLE`, `CREATE INDEX` SQL strings in any web route
  </action>
  <verify>
Run these checks — all must return no output:
```
grep -n "db\.exec\|stmt\.run\|INSERT\|UPDATE\|ALTER TABLE\|CREATE TABLE\|CREATE INDEX" \
  /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/cards/route.ts \
  /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/games/route.ts \
  /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/results/route.ts
```

Also verify `closeDatabase` is no longer imported:
```
grep -n "closeDatabase[^R]" \
  /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/cards/route.ts \
  /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/games/route.ts \
  /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/results/route.ts
```

Confirm web app still builds: `cd /Users/ajcolubiale/projects/cheddar-logic/web && npm run build 2>&1 | tail -20`
  </verify>
  <done>
No INSERT, UPDATE, ALTER TABLE, CREATE TABLE, CREATE INDEX, db.exec, or stmt.run calls exist in any web API route. All finally blocks use `closeDatabaseReadOnly()`. Build succeeds with no TypeScript errors.
  </done>
</task>

</tasks>

<verification>
After both tasks:

1. Web startup does not run migrations:
   `grep -rn "runMigrations" /Users/ajcolubiale/projects/cheddar-logic/web/src/` — must return nothing

2. Web routes have zero write SQL:
   `grep -rn "db\.exec\|stmt\.run\|INSERT\|UPDATE\|ALTER" /Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/` — must return nothing

3. Worker still has full write access (no regressions):
   `grep -rn "runMigrations\|insertCard\|upsertGame\|saveSnapshot\|setCurrentRunId" /Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/` — must return matches (worker functions intact)

4. TypeScript build passes: `cd /Users/ajcolubiale/projects/cheddar-logic/web && npm run build`
</verification>

<success_criteria>
- Web server is provably read-only: no write SQL, no migrations, no lock acquisition on startup
- Worker retains all write capabilities unchanged
- Both processes can coexist without DB lock contention
- Web build passes with no TypeScript errors
</success_criteria>

<output>
After completion, create `.planning/quick/23-single-writer-architecture-worker-owns-d/23-SUMMARY.md`
with what was changed, what was removed, and any tradeoffs (card_display_log no longer populated by web).
</output>
