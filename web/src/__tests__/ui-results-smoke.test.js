/*
 * UI results smoke test
 * Ensures /api/results returns a well-formed payload for UI display.
 * Run: npm --prefix web run test:ui:results
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/api/results?limit=5`);

  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');
  assert.ok(payload.data, 'API data is missing');

  const summary = payload.data.summary;
  assert.ok(summary, 'Summary missing');
  [
    'totalCards',
    'settledCards',
    'wins',
    'losses',
    'pushes',
    'totalPnlUnits',
    'winRate',
    'avgPnl',
  ].forEach((key) => {
    assert.ok(
      Object.prototype.hasOwnProperty.call(summary, key),
      `Summary missing ${key}`,
    );
  });
  ['totalCards', 'settledCards', 'wins', 'losses', 'pushes', 'winRate'].forEach(
    (key) => {
      assert.strictEqual(
        typeof summary[key],
        'number',
        `Summary ${key} must be numeric`,
      );
    },
  );
  assert.ok(
    summary.totalPnlUnits === null || typeof summary.totalPnlUnits === 'number',
    'Summary totalPnlUnits must be number|null',
  );
  assert.ok(
    summary.avgPnl === null || typeof summary.avgPnl === 'number',
    'Summary avgPnl must be number|null',
  );
  assert.ok(
    summary.wins + summary.losses + summary.pushes <= summary.settledCards,
    'Summary W/L/P counts cannot exceed settledCards',
  );

  assert.ok(Array.isArray(payload.data.segments), 'Segments is not an array');
  assert.ok(
    Array.isArray(payload.data.segmentFamilies),
    'segmentFamilies is not an array',
  );
  const segmentFamilies = payload.data.segmentFamilies;
  ['play', 'slight_edge'].forEach((segmentId) => {
    assert.ok(
      segmentFamilies.some((segment) => segment.segmentId === segmentId),
      `segmentFamilies missing ${segmentId}`,
    );
  });
  assert.ok(Array.isArray(payload.data.ledger), 'Ledger is not an array');

  console.log('✅ UI results smoke test passed');
}

run().catch((error) => {
  console.error('❌ UI results smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
