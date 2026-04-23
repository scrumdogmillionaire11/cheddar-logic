/**
 * /api/readyz contract tests
 *
 * Verifies:
 * 1. checkDbReady returns { ok: false, reason } when DB file is missing
 * 2. GET /api/readyz returns 503 { status: "unavailable", reason } when DB is unreachable
 * 3. GET /api/readyz returns 200 { status: "ok" } when DB probe passes
 *
 * Uses CHEDDAR_DB_PATH env var control to simulate DB unavailability.
 * Sets CHEDDAR_DB_READ_RETRY_MS=0 so the probe fails fast (no retry wait).
 */

import assert from 'node:assert/strict';
import { checkDbReady } from '../lib/db-init.ts';
import { GET } from '../app/api/readyz/route.ts';

const originalDbPath = process.env.CHEDDAR_DB_PATH;
const originalRetryMs = process.env.CHEDDAR_DB_READ_RETRY_MS;

function setMissingDb() {
  process.env.CHEDDAR_DB_PATH = '/tmp/__nonexistent_cheddar_probe_test__.db';
  process.env.CHEDDAR_DB_READ_RETRY_MS = '0';
}

function restoreDb() {
  if (originalDbPath !== undefined) {
    process.env.CHEDDAR_DB_PATH = originalDbPath;
  } else {
    delete process.env.CHEDDAR_DB_PATH;
  }
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

  console.log('Running api-readyz tests');

  await test('checkDbReady returns { ok: false } when DB file does not exist', () => {
    setMissingDb();
    try {
      const result = checkDbReady();
      assert.equal(result.ok, false, 'probe should fail when DB is missing');
      assert.ok(typeof result.reason === 'string', 'probe should include a reason string');
      assert.ok(result.reason.length > 0, 'reason should be non-empty');
    } finally {
      restoreDb();
    }
  });

  await test('GET /api/readyz returns 503 when DB is unavailable', async () => {
    setMissingDb();
    try {
      const response = GET();
      assert.equal(response.status, 503, 'readyz should return 503 when DB is unavailable');
      const body = await response.json();
      assert.equal(body.status, 'unavailable', 'readyz body.status should be "unavailable"');
      assert.ok(typeof body.reason === 'string', 'readyz body should include a reason');
    } finally {
      restoreDb();
    }
  });

  await test('GET /api/readyz 503 body has no extra fields beyond status and reason', async () => {
    setMissingDb();
    try {
      const response = GET();
      const body = await response.json();
      const keys = Object.keys(body);
      assert.deepEqual(
        keys.sort(),
        ['reason', 'status'],
        'readyz 503 body should only contain status and reason',
      );
    } finally {
      restoreDb();
    }
  });

  // DB-present path: only run if CHEDDAR_DB_PATH is set and file exists
  const dbPath = originalDbPath;
  if (dbPath) {
    const { existsSync } = await import('node:fs');
    if (existsSync(dbPath)) {
      await test('checkDbReady returns { ok: true } when DB is accessible', () => {
        const result = checkDbReady();
        assert.equal(result.ok, true, 'probe should pass when DB is accessible');
        assert.equal(result.reason, undefined, 'reason should be absent on success');
      });

      await test('GET /api/readyz returns 200 when DB is accessible', async () => {
        const response = GET();
        assert.equal(response.status, 200, 'readyz should return 200 when DB is accessible');
        const body = await response.json();
        assert.equal(body.status, 'ok', 'readyz body.status should be "ok"');
      });
    } else {
      console.log('  SKIP DB-present tests (CHEDDAR_DB_PATH set but file not found)');
    }
  } else {
    console.log('  SKIP DB-present tests (CHEDDAR_DB_PATH not set)');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
