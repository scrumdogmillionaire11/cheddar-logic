import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

async function run() {
  const routeSource = await fs.readFile(
    new URL('../app/api/results/projection-accuracy/route.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    routeSource.includes('getDatabaseReadOnly') &&
      routeSource.includes('closeReadOnlyInstance'),
    'projection accuracy route must use the read-only DB lifecycle',
  );
  assert.ok(
    routeSource.includes('getProjectionAccuracyEvalSummary') &&
      routeSource.includes('getProjectionAccuracyEvals'),
    'projection accuracy route must read summary and row-level eval data',
  );
  assert.ok(
    routeSource.includes("'MLB_F5_TOTAL'") &&
      routeSource.includes("'MLB_PITCHER_K'") &&
      routeSource.includes("'NHL_PLAYER_SHOTS'") &&
      routeSource.includes("'NHL_PLAYER_BLOCKS'"),
    'projection accuracy route must expose the requested market filters',
  );
  assert.ok(
    routeSource.includes("lineRole: 'SYNTHETIC'"),
    'projection accuracy route must report synthetic-line grading by default',
  );
  assert.ok(
    routeSource.includes('summary,') && routeSource.includes('rows,'),
    'projection accuracy route response must include summary and rows',
  );

  console.log('✅ Projection accuracy results API source contract passed');
}

run().catch((error) => {
  console.error('❌ Projection accuracy results API source contract failed');
  console.error(error.message || error);
  process.exit(1);
});
