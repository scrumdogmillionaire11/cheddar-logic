/**
 * Database Initialization Wrapper
 *
 * Ensures the database is fully initialized and migrated before any operations.
 * Uses promise caching to prevent concurrent duplicate work in the same process.
 * 
 * Key behavior:
 * - First call: runs initDb() + runMigrations()
 * - Subsequent calls: await the cached promise
 * - On failure: clears cache so next caller retries
 */

import { initDb, runMigrations } from '@cheddar-logic/data';

let dbReadyPromise: Promise<void> | null = null;

export async function ensureDbReady(): Promise<void> {
  // Return cached promise if already running or resolved
  if (dbReadyPromise) {
    return dbReadyPromise;
  }

  // Create new promise and cache it
  dbReadyPromise = (async () => {
    try {
      await initDb();
      await runMigrations();
      console.log('[DB] Database initialized and migrated successfully');
    } catch (error) {
      // 🔑 Critical: clear cache on failure so next caller retries
      // This prevents a single transient failure from poisoning the process forever
      dbReadyPromise = null;
      
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[DB] Initialization failed, cache cleared for retry:', errorMsg);
      
      throw error;
    }
  })();

  return dbReadyPromise;
}
