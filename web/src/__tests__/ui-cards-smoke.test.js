/*
 * UI cards smoke test
 * Ensures /api/games returns at least one playable card for UI display.
 * Run: npm --prefix web run test:ui:cards
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/api/games?limit=50`);

  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');
  assert.ok(Array.isArray(payload.data), 'API data is not an array');
  assert.ok(payload.data.length > 0, 'No games returned from API');

  const playsCount = payload.data.reduce(
    (sum, game) => sum + (game.plays?.length || 0),
    0,
  );
  assert.ok(playsCount > 0, 'No plays returned for UI display');

  console.log('✅ UI cards smoke test passed');
}

run().catch((error) => {
  console.error('❌ UI cards smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
