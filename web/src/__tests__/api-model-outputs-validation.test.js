import assert from 'node:assert/strict';
import { validateQueryParams } from '../lib/api-security/validation.ts';

const ROUTE = '/api/model-outputs';

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

  console.log('Running /api/model-outputs validation tests');

  test('accepts valid sport param', () => {
    const result = validateQueryParams(ROUTE, {
      sport: 'mlb',
    });
    assert.equal(result.valid, true);
    assert.equal(result.sanitizedParams.sport, 'mlb');
  });

  test('rejects unknown query params', () => {
    const result = validateQueryParams(ROUTE, {
      sport: 'mlb',
      limit: '10',
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.includes('Unknown parameter: limit')), true);
  });

  test('rejects invalid sport characters', () => {
    const result = validateQueryParams(ROUTE, {
      sport: '<script>alert(1)</script>',
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.some((error) => error.includes('sport contains invalid characters')), true);
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
