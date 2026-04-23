/**
 * Database Read-Only Initialization
 *
 * The web server is strictly read-only. It MUST NOT run migrations,
 * write snapshots, or acquire write locks.
 * The worker process owns all DB writes.
 */

import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
const cheddarData = _require('@cheddar-logic/data') as {
  getDatabaseReadOnly: () => unknown;
  closeReadOnlyInstance: (db: unknown) => void;
};

let dbReadyPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  if (dbReadyPromise) {
    return dbReadyPromise;
  }

  dbReadyPromise = (async () => {
    try {
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

/**
 * Synchronous readiness probe used by /api/readyz.
 *
 * Opens a real read-only DB connection, executes SELECT 1, then closes.
 * Returns { ok: false, reason } if the DB file is missing, locked, or
 * malformed - making the probe capable of surfacing real failures.
 */
export function checkDbReady(): { ok: boolean; reason?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  try {
    db = cheddarData.getDatabaseReadOnly();
    (db as { prepare: (sql: string) => { get: () => unknown } })
      .prepare('SELECT 1')
      .get();
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason };
  } finally {
    if (db) {
      try {
        cheddarData.closeReadOnlyInstance(db);
      } catch {
        // best-effort close on probe failure path
      }
    }
  }
}
