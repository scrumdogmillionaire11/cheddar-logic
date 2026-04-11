/*
 * API admin model-health source contract
 * Ensures the admin model-health route stays dev-only, read-only, and pinned
 * to the latest 30-day snapshot per sport.
 *
 * Run: node web/src/__tests__/api-admin-model-health.test.js
 */

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const fs = await import('node:fs/promises');

  const routeSource = await fs.readFile(
    new URL('../app/api/admin/model-health/route.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    routeSource.includes("process.env.NODE_ENV !== 'development'"),
    'route must remain dev-only',
  );
  assert.ok(
    routeSource.includes('await ensureDbReady()') &&
      routeSource.includes('db = getDatabaseReadOnly()'),
    'route must initialize and open the DB in read-only mode',
  );
  assert.ok(
    routeSource.includes("performSecurityChecks(request, '/api/admin/model-health')"),
    'route must use the admin security checks',
  );
  assert.ok(
    routeSource.includes('if (db) closeReadOnlyInstance(db);'),
    'route must close per-request read-only connections',
  );
  assert.ok(
    routeSource.includes('mhs.lookback_days = 30'),
    'route must filter snapshots to the 30-day admin window',
  );
  assert.ok(
    routeSource.includes('SELECT MAX(latest.run_at)'),
    'route must return the latest snapshot per sport',
  );
  assert.ok(
    routeSource.includes('signals: parseSignals(row.signals_json)'),
    'route must parse persisted degradation signals into response data',
  );

  [
    'runMigrations(',
    'closeDatabase(',
    'db.exec(',
    '.run(',
  ].forEach((token) => {
    assert.ok(
      !routeSource.includes(token),
      `route must remain read-only and not contain ${token}`,
    );
  });

  console.log('✅ API admin model-health source contract passed');
}

run().catch((error) => {
  console.error('❌ API admin model-health source contract failed');
  console.error(error.message || error);
  process.exit(1);
});
