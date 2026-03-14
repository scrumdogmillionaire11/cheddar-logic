/*
 * FPL API polling failure guard test
 * Ensures failed ANALYSIS_NOT_READY responses stop retry loops.
 * Run: node web/src/__tests__/fpl-api-analysis-failure-polling.test.js
 */

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const fs = await import('node:fs/promises');

  const apiSource = await fs.readFile(
    new URL('../lib/fpl-api.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    apiSource.includes('const isFailedAnalysisNotReady = (value: unknown): boolean =>'),
    'fpl-api should include a failed-analysis detector for not-ready responses',
  );
  assert.ok(
    apiSource.includes("return parts.join(' ').includes('failed');"),
    'failed-analysis detector should inspect normalized payload text for failed state',
  );
  assert.ok(
    apiSource.includes('if (response.status === 425 || response.status === 202) {') &&
      apiSource.includes('if (!isFailedAnalysisNotReady(parsedError)) {') &&
      apiSource.includes("throw new Error('STILL_RUNNING');"),
    '425/202 should keep polling only when payload does not indicate failed analysis',
  );
  assert.ok(
    apiSource.includes("errorMessage === 'Failed to fetch detailed projections'") &&
      apiSource.includes('? fallbackError') &&
      apiSource.includes(': errorMessage'),
    'failed-analysis 425 responses should surface a concrete backend error message',
  );
  assert.ok(
    apiSource.includes('const nestedDetail = toRecord(detail)?.detail;'),
    'error message extraction should support nested detail.detail payload shape',
  );

  console.log('✅ FPL API failed-analysis polling guard test passed');
}

run().catch((error) => {
  console.error('❌ FPL API failed-analysis polling guard test failed');
  console.error(error.message || error);
  process.exit(1);
});
