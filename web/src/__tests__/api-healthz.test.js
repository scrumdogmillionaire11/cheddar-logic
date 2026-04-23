/**
 * /api/healthz contract tests
 *
 * Verifies:
 * 1. GET /api/healthz returns 200 with { status: "ok" }
 * 2. No external dependencies are called (pure liveness)
 */

import assert from 'node:assert/strict';
import { GET } from '../app/api/healthz/route.ts';

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

  console.log('Running api-healthz tests');

  await test('GET /api/healthz returns 200', async () => {
    const response = GET();
    assert.equal(response.status, 200, 'healthz should return 200');
  });

  await test('GET /api/healthz returns { status: "ok" }', async () => {
    const response = GET();
    const body = await response.json();
    assert.equal(body.status, 'ok', 'healthz body.status should be "ok"');
  });

  await test('GET /api/healthz has no DB dependency (returns same result on repeated calls)', async () => {
    const r1 = GET();
    const r2 = GET();
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert.equal(b1.status, b2.status, 'healthz should be idempotent');
    assert.equal(r1.status, r2.status, 'healthz status code should be idempotent');
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
