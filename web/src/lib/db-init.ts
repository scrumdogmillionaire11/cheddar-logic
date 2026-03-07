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
