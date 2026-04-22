import assert from 'node:assert/strict';
import { validateQueryParams } from '../lib/api-security/validation.ts';

const ROUTE = '/api/performance';

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(error);
      failed += 1;
    }
  }

  console.log('Running /api/performance validation tests');

  test('accepts valid market and days params', () => {
    const result = validateQueryParams(ROUTE, {
      market: 'NHL_TOTAL',
      days: '30',
    });
    assert.equal(result.valid, true);
    assert.equal(result.sanitizedParams.days, 30);
  });

  test('rejects unknown query params', () => {
    const result = validateQueryParams(ROUTE, {
      market: 'NHL_TOTAL',
      bad: '1',
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.includes('Unknown parameter: bad')), true);
  });

  test('rejects non-numeric days', () => {
    const result = validateQueryParams(ROUTE, {
      market: 'NHL_TOTAL',
      days: 'abc',
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.includes('days must be a number')), true);
  });

  test('rejects out-of-range days', () => {
    const result = validateQueryParams(ROUTE, {
      market: 'NHL_TOTAL',
      days: '999',
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.includes('days must be between 1 and 365')), true);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
