/*
 * API POTD smoke test
 * Ensures /api/potd exposes the read-only POTD contract.
 *
 * Live mode: CARDS_API_BASE_URL=http://127.0.0.1:3000 node web/src/__tests__/api-potd.test.js
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 node web/src/__tests__/api-potd.test.js';

function isConnectionIssue(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND')
  );
}

function buildFallbackMessage(baseUrl) {
  return (
    `POTD API endpoint unavailable at ${baseUrl}; running source fallback checks. ` +
    `To run live assertions: ${LIVE_COMMAND}`
  );
}

async function validatePotdSourceContract(assert) {
  const fs = await import('node:fs/promises');
  const routeSource = await fs.readFile(
    new URL('../app/api/potd/route.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    routeSource.includes('getDatabaseReadOnly') &&
      routeSource.includes('closeReadOnlyInstance'),
    'potd route must use read-only DB helpers',
  );
  assert.ok(
    routeSource.includes('await ensureDbReady()') &&
      routeSource.includes('db = getDatabaseReadOnly()'),
    'potd route must initialize and open the DB in read-only mode',
  );
  assert.ok(
    routeSource.includes('if (db) closeReadOnlyInstance(db);'),
    'potd route must close per-request read-only connections',
  );
  assert.ok(
    routeSource.includes('const data = await getPotdResponseData();') &&
      routeSource.includes('today: data.today') &&
      routeSource.includes('history: data.history') &&
      routeSource.includes('bankroll: data.bankroll') &&
      routeSource.includes('schedule: data.schedule'),
    'potd route must expose the today/history/bankroll/schedule contract',
  );
  [
    'runMigrations(',
    'closeDatabase(',
    'db.exec(',
    '.run(',
  ].forEach((token) => {
    assert.ok(
      !routeSource.includes(token),
      `potd route must remain read-only and not contain ${token}`,
    );
  });
}

async function validateLivePayload(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/api/potd`);

  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');
  assert.ok(payload.data, 'API data is missing');

  ['today', 'history', 'bankroll', 'schedule'].forEach((key) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(payload.data, key),
      `POTD payload missing ${key}`,
    );
  });

  assert.ok(Array.isArray(payload.data.history), 'history must be an array');
  assert.ok(payload.data.today === null || typeof payload.data.today === 'object');
  assert.ok(
    payload.data.schedule === null || typeof payload.data.schedule === 'object',
    'schedule must be object|null',
  );

  const bankroll = payload.data.bankroll;
  [
    'current',
    'starting',
    'netProfit',
    'postedCount',
    'settledCount',
    'wins',
    'losses',
    'pushes',
    'winRate',
    'roi',
  ].forEach((key) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(bankroll, key),
      `bankroll summary missing ${key}`,
    );
  });
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    await validateLivePayload(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
    await validatePotdSourceContract(assert);
  }

  console.log('✅ API POTD smoke test passed');
}

run().catch((error) => {
  console.error('❌ API POTD smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
