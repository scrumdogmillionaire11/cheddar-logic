/**
 * /api/readyz contract-aware health tests
 *
 * Validates that checkDbReady() and GET /api/readyz correctly distinguish
 * DB reachability from schema contract compliance.
 *
 * Test matrix:
 * 1. Healthy DB with all required tables/columns → 200, ready=true, failures=[]
 * 2. DB reachable but required table missing → 503, ready=false, MISSING_TABLE
 * 3. DB reachable but required column missing → 503, ready=false, MISSING_COLUMN
 * 4. DB reachable, unrelated historical table absent → 200, ready=true
 * 5. DB reachable but optional/fallback column missing → 200, ready=true, warning present
 * 6. DB unreachable/open failure → 503, ready=false, db.reachable=false
 *
 * Run: node web/src/__tests__/api-readyz-contract-aware-health.test.js
 */

import assert from 'node:assert/strict';
import db from '../../../packages/data/src/db.js';
import { setupIsolatedTestDb } from './db-test-runtime.js';
import { checkDbReady } from '../lib/db-init.ts';
import { GET } from '../app/api/readyz/route.ts';

const { closeDatabase } = db;

const originalRetryMs = process.env.CHEDDAR_DB_READ_RETRY_MS;

function setReadRetryFast() {
  process.env.CHEDDAR_DB_READ_RETRY_MS = '0';
}

function restoreReadRetry() {
  if (originalRetryMs !== undefined) {
    process.env.CHEDDAR_DB_READ_RETRY_MS = originalRetryMs;
  } else {
    delete process.env.CHEDDAR_DB_READ_RETRY_MS;
  }
}

async function run() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(error);
      failed += 1;
    }
  }

  console.log('Running api-readyz-contract-aware-health tests');

  // ── Test 1: Healthy DB with all required tables/columns ─────────────────────
  await test('healthy DB with all required tables/columns → 200, ready=true, failures=[]', async () => {
    const { cleanup } = await setupIsolatedTestDb('readyz-healthy');
    try {
      const result = checkDbReady();
      assert.equal(result.ok, true, 'ok should be true');
      assert.equal(result.ready, true, 'ready should be true');
      assert.equal(result.db.reachable, true, 'db.reachable should be true');
      assert.deepEqual(result.contracts.failures, [], 'no failures on healthy DB');
      assert.deepEqual(
        result.contracts.checked.sort(),
        ['cards', 'games', 'results'],
        'all three surfaces should be checked',
      );

      const response = GET();
      assert.equal(response.status, 200, 'route should return 200');
      const body = await response.json();
      assert.equal(body.ok, true);
      assert.equal(body.ready, true);
      assert.deepEqual(body.contracts.failures, []);
    } finally {
      cleanup();
    }
  });

  // ── Test 2: Required table missing → 503, MISSING_TABLE ─────────────────────
  await test('required table missing (games) → 503, ready=false, MISSING_TABLE', async () => {
    const { cleanup } = await setupIsolatedTestDb('readyz-missing-table');
    try {
      db.getDatabase().exec('DROP TABLE IF EXISTS games');
      closeDatabase();

      const result = checkDbReady();
      assert.equal(result.ok, false, 'ok should be false');
      assert.equal(result.ready, false, 'ready should be false');
      assert.equal(result.db.reachable, true, 'db should still be reachable');

      const gamesFailure = result.contracts.failures.find(
        (f) => f.table === 'games' && f.reason === 'MISSING_TABLE',
      );
      assert.ok(gamesFailure, 'should have MISSING_TABLE failure for games table');
      assert.equal(gamesFailure.surface, 'games');

      const response = GET();
      assert.equal(response.status, 503, 'route should return 503');
      const body = await response.json();
      assert.equal(body.ready, false);
      assert.ok(body.contracts.failures.some((f) => f.table === 'games' && f.reason === 'MISSING_TABLE'));
    } finally {
      cleanup();
    }
  });

  // ── Test 3: Required column missing in card_results → 503, MISSING_COLUMN ───
  await test('required column missing (card_results.market_key) → 503, ready=false, MISSING_COLUMN', async () => {
    const { cleanup } = await setupIsolatedTestDb('readyz-missing-col');
    try {
      db.getDatabase().exec('ALTER TABLE card_results DROP COLUMN market_key');
      closeDatabase();

      const result = checkDbReady();
      assert.equal(result.ok, false, 'ok should be false');
      assert.equal(result.ready, false, 'ready should be false');
      assert.equal(result.db.reachable, true, 'db should still be reachable');

      const colFailure = result.contracts.failures.find(
        (f) => f.table === 'card_results' && f.column === 'market_key' && f.reason === 'MISSING_COLUMN',
      );
      assert.ok(colFailure, 'should have MISSING_COLUMN failure for card_results.market_key');
      assert.equal(colFailure.surface, 'results');

      const response = GET();
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.ready, false);
      assert.ok(
        body.contracts.failures.some(
          (f) => f.table === 'card_results' && f.column === 'market_key' && f.reason === 'MISSING_COLUMN',
        ),
      );
    } finally {
      cleanup();
    }
  });

  // ── Test 4: Unrelated historical table absent → 200, ready=true ──────────────
  await test('unrelated historical table absent (fpl_matches) → 200, ready=true', async () => {
    const { cleanup } = await setupIsolatedTestDb('readyz-unrelated-table');
    try {
      // fpl_matches is not a migration table; verify it doesn't exist
      const client = db.getDatabase();
      const fplExists = client
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fpl_matches'")
        .get();
      assert.equal(fplExists, null, 'fpl_matches should not exist in this DB');
      closeDatabase();

      const result = checkDbReady();
      assert.equal(result.ok, true, 'ok should be true — unrelated tables are not checked');
      assert.equal(result.ready, true, 'ready should be true');
      assert.deepEqual(result.contracts.failures, [], 'no failures for unrelated missing tables');
    } finally {
      cleanup();
    }
  });

  // ── Test 5: Fallback column missing → 200, ready=true, warning present ───────
  await test('fallback column missing (odds_snapshots.spread_consensus_line) → 200, ready=true, warning present', async () => {
    const { cleanup } = await setupIsolatedTestDb('readyz-fallback-col');
    try {
      db.getDatabase().exec('ALTER TABLE odds_snapshots DROP COLUMN spread_consensus_line');
      closeDatabase();

      const result = checkDbReady();
      assert.equal(result.ok, true, 'ok should be true — fallback column does not fail readiness');
      assert.equal(result.ready, true, 'ready should be true');
      assert.equal(result.db.reachable, true);
      assert.deepEqual(result.contracts.failures, [], 'no failures for missing fallback column');

      const warning = result.contracts.warnings.find(
        (w) =>
          w.table === 'odds_snapshots' &&
          w.column === 'spread_consensus_line' &&
          w.reason === 'MISSING_COLUMN_FALLBACK',
      );
      assert.ok(warning, 'should have MISSING_COLUMN_FALLBACK warning for odds_snapshots.spread_consensus_line');
      assert.equal(warning.surface, 'games');

      const response = GET();
      assert.equal(response.status, 200, 'route should return 200 despite fallback column missing');
      const body = await response.json();
      assert.equal(body.ready, true);
      assert.ok(
        body.contracts.warnings.some(
          (w) =>
            w.table === 'odds_snapshots' &&
            w.column === 'spread_consensus_line' &&
            w.reason === 'MISSING_COLUMN_FALLBACK',
        ),
      );
    } finally {
      cleanup();
    }
  });

  // ── Test 6: DB unreachable → 503, db.reachable=false ────────────────────────
  await test('DB unreachable/open failure → 503, ready=false, db.reachable=false', async () => {
    const originalDbPath = process.env.CHEDDAR_DB_PATH;
    process.env.CHEDDAR_DB_PATH = '/tmp/__nonexistent_cheddar_readyz_contract_test__.db';
    setReadRetryFast();
    try {
      const result = checkDbReady();
      assert.equal(result.ok, false, 'ok should be false');
      assert.equal(result.ready, false, 'ready should be false');
      assert.equal(result.db.reachable, false, 'db.reachable should be false');
      assert.ok(typeof result.db.reason === 'string', 'db.reason should be a string');
      assert.ok(result.db.reason.length > 0, 'db.reason should be non-empty');
      assert.deepEqual(result.contracts.checked, [], 'no surfaces checked when DB unreachable');
      assert.deepEqual(result.contracts.failures, []);
      assert.deepEqual(result.contracts.warnings, []);

      const response = GET();
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.ok, false);
      assert.equal(body.ready, false);
      assert.equal(body.db.reachable, false);
      assert.ok(typeof body.db.reason === 'string');
    } finally {
      if (originalDbPath !== undefined) {
        process.env.CHEDDAR_DB_PATH = originalDbPath;
      } else {
        delete process.env.CHEDDAR_DB_PATH;
      }
      restoreReadRetry();
    }
  });

  // ── Invariant: ok=true only when ready=true ──────────────────────────────────
  await test('invariant: ok is never true unless ready is true', async () => {
    const { cleanup } = await setupIsolatedTestDb('readyz-invariant');
    try {
      // Healthy case
      const healthy = checkDbReady();
      assert.equal(
        healthy.ok,
        healthy.ready,
        'ok must equal ready on healthy DB',
      );
      cleanup();
    } catch (e) {
      cleanup();
      throw e;
    }
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
