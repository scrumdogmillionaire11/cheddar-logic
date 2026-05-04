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

type TableRequirement = {
  name: string;
  required_columns?: string[];
  fallback_columns?: string[];
};

type SurfaceContract = {
  surface: string;
  required_tables: TableRequirement[];
  optional_tables?: string[];
};

type ContractFailure = {
  surface: string;
  table: string;
  column?: string;
  reason: 'MISSING_TABLE' | 'MISSING_COLUMN';
};

type ContractWarning = {
  surface: string;
  table: string;
  column: string;
  reason: 'MISSING_COLUMN_FALLBACK';
};

export type ReadinessResult = {
  ok: boolean;
  ready: boolean;
  db: { reachable: boolean; reason?: string };
  contracts: {
    checked: string[];
    failures: ContractFailure[];
    warnings: ContractWarning[];
  };
};

const READYZ_SURFACE_CONTRACTS: Record<string, SurfaceContract> = {
  games: {
    surface: '/api/games',
    required_tables: [
      { name: 'games' },
      {
        name: 'odds_snapshots',
        fallback_columns: [
          'spread_consensus_line', 'spread_consensus_confidence',
          'spread_dispersion_stddev', 'spread_source_book_count',
          'total_consensus_line', 'total_consensus_confidence',
          'total_dispersion_stddev', 'total_source_book_count',
          'h2h_consensus_home', 'h2h_consensus_away', 'h2h_consensus_confidence',
        ],
      },
      { name: 'run_state' },
      { name: 'job_runs' },
    ],
  },
  cards: {
    surface: '/api/cards',
    required_tables: [
      { name: 'run_state' },
      { name: 'job_runs' },
      { name: 'card_payloads' },
    ],
  },
  results: {
    surface: '/api/results',
    required_tables: [
      { name: 'game_results' },
      {
        name: 'card_results',
        required_columns: ['market_key', 'market_type', 'selection', 'line', 'locked_price'],
      },
      { name: 'card_payloads' },
    ],
    optional_tables: ['clv_ledger'],
  },
};

/**
 * Synchronous readiness probe used by /api/readyz.
 *
 * Opens a read-only DB connection, runs SELECT 1 (reachability), then validates
 * required tables and columns for each enabled web surface. Returns structured
 * failures and warnings — never throws for expected missing-schema cases.
 */
export function checkDbReady(): ReadinessResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any = null;
  const emptyContracts = { checked: [] as string[], failures: [] as ContractFailure[], warnings: [] as ContractWarning[] };

  try {
    db = cheddarData.getDatabaseReadOnly();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).prepare('SELECT 1').get();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    let reason = 'DB_OPEN_FAILED';
    if (/not accessible|no such file|ENOENT/i.test(msg)) reason = 'DB_FILE_NOT_FOUND';
    else if (/locked|SQLITE_BUSY/i.test(msg)) reason = 'DB_LOCKED';
    try { cheddarData.closeReadOnlyInstance(db); } catch { /* best-effort */ }
    return { ok: false, ready: false, db: { reachable: false, reason }, contracts: emptyContracts };
  }

  const checked: string[] = [];
  const failures: ContractFailure[] = [];
  const warnings: ContractWarning[] = [];

  try {
    for (const [key, contract] of Object.entries(READYZ_SURFACE_CONTRACTS)) {
      checked.push(key);
      for (const tableReq of contract.required_tables) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tableExists = (db as any)
          .prepare('SELECT name FROM sqlite_master WHERE type=? AND name=?')
          .get('table', tableReq.name);

        if (!tableExists) {
          failures.push({ surface: key, table: tableReq.name, reason: 'MISSING_TABLE' });
          continue;
        }

        const hasRequired = tableReq.required_columns && tableReq.required_columns.length > 0;
        const hasFallback = tableReq.fallback_columns && tableReq.fallback_columns.length > 0;

        if (hasRequired || hasFallback) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const colSet = new Set<string>(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ((db as any).pragma(`table_info(${tableReq.name})`) as Array<{ name: string }>).map((c) => c.name),
          );
          for (const col of tableReq.required_columns ?? []) {
            if (!colSet.has(col)) {
              failures.push({ surface: key, table: tableReq.name, column: col, reason: 'MISSING_COLUMN' });
            }
          }
          for (const col of tableReq.fallback_columns ?? []) {
            if (!colSet.has(col)) {
              warnings.push({ surface: key, table: tableReq.name, column: col, reason: 'MISSING_COLUMN_FALLBACK' });
            }
          }
        }
      }
    }
  } finally {
    try { cheddarData.closeReadOnlyInstance(db); } catch { /* best-effort */ }
  }

  const ready = failures.length === 0;
  return {
    ok: ready,
    ready,
    db: { reachable: true },
    contracts: { checked, failures, warnings },
  };
}
