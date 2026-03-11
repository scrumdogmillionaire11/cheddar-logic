/*
 * UI cards smoke test
 * Ensures /api/games returns at least one playable card for UI display.
 * Run: npm --prefix web run test:ui:cards
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

function isConnectionIssue(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND')
  );
}

async function validateCardsChunkReachable(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/cards`, {
    headers: { Accept: 'text/html' },
  });
  assert.strictEqual(
    response.ok,
    true,
    `Cards page response not ok: ${response.status}`,
  );
  const html = await response.text();
  const match = html.match(/\/_next\/static\/[^"'\s>]+\.js/);
  assert.ok(match, 'Cards HTML did not reference a Next.js static JS asset');
  const ref = match[0];
  const assetResponse = await fetch(`${baseUrl}${ref}`, {
    headers: { Accept: 'application/javascript,text/javascript,*/*' },
  });
  assert.strictEqual(
    assetResponse.ok,
    true,
    `Referenced cards chunk not reachable (${assetResponse.status}): ${ref}`,
  );
}

async function validateApiSmoke(baseUrl, assert) {
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
}

async function validateCardsSourceContract(assert) {
  const fs = await import('node:fs/promises');
  const source = await fs.readFile(
    new URL('../components/cards-page-client.tsx', import.meta.url),
    'utf8',
  );
  assert.ok(
    !source.includes('displayPlay.edge ?? 0'),
    'cards page must not synthesize edge from `displayPlay.edge ?? 0`',
  );
  assert.ok(
    source.includes('No market-specific edge available'),
    'cards page should show explicit unpriced edge messaging',
  );
  assert.ok(
    source.includes('No edge at current price'),
    'cards page should distinguish true no-edge-at-price from missing edge',
  );
  assert.ok(
    source.includes('Pricing Status:'),
    'cards page should use user-facing pricing status label',
  );
  assert.ok(
    !source.includes('Sharp Verdict:'),
    'cards page should not leak internal sharp verdict label',
  );
}

async function validateDbFallback(assert) {
  const dbModule = await import('../../../packages/data/src/db.js');
  const db = dbModule.default || dbModule;

  await db.initDb();
  const client = db.getDatabase();
  try {
    const successRunRows = client
      .prepare(
        `SELECT rs.current_run_id
         FROM run_state rs
         WHERE rs.id != 'singleton'
           AND rs.current_run_id IS NOT NULL
           AND TRIM(rs.current_run_id) != ''
           AND EXISTS (
             SELECT 1
             FROM job_runs jr
             WHERE jr.id = rs.current_run_id
               AND LOWER(jr.status) = 'success'
           )
         ORDER BY datetime(rs.updated_at) DESC, rs.id ASC`,
      )
      .all();
    const activeRunIds = [
      ...new Set(successRunRows.map((r) => r.current_run_id)),
    ];

    const where = [
      "(cp.expires_at IS NULL OR datetime(cp.expires_at) > datetime('now'))",
      "cp.sport != 'FPL'",
      "cp.card_type != 'welcome-home-v2'",
    ];
    const params = [];

    if (activeRunIds.length > 0) {
      const runIdPlaceholders = activeRunIds.map(() => '?').join(', ');
      where.push(`cp.run_id IN (${runIdPlaceholders})`);
      params.push(...activeRunIds);
    }

    const row = client
      .prepare(
        `SELECT COUNT(*) AS count
         FROM card_payloads cp
         WHERE ${where.join(' AND ')}`,
      )
      .get(...params);

    assert.ok(
      Number(row?.count || 0) > 0,
      'No active cards found in DB fallback check',
    );
  } finally {
    db.closeDatabase();
  }
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  await validateCardsSourceContract(assert);
  try {
    await validateCardsChunkReachable(baseUrl, assert);
    await validateApiSmoke(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) {
      throw error;
    }
    console.warn(
      `⚠️ Cards/API smoke endpoint unavailable at ${baseUrl}; running DB fallback check`,
    );
    await validateDbFallback(assert);
  }

  console.log('✅ UI cards smoke test passed');
}

run().catch((error) => {
  console.error('❌ UI cards smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
