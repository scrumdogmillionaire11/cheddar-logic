/*
 * API → UI smoke test for canonical market fields.
 * Run: npm --prefix web run test:api:games:market
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const fs = await import('node:fs');
  const path = await import('node:path');

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  const response = await fetch(`${baseUrl}/api/games?limit=200`);
  assert.strictEqual(
    response.ok,
    true,
    `API response not ok: ${response.status}`,
  );

  const payload = await response.json();
  assert.strictEqual(payload.success, true, 'API returned success=false');

  const plays = (payload.data || []).flatMap((game) => game.plays || []);

  const missingMarketType = plays.filter((play) => !play.market_type);
  const unknownLegacyMarket = plays.filter((play) => {
    const title = String(play.cardTitle || '').toLowerCase();
    const looksMarketLike = /total|spread|moneyline|\bml\b|over|under/.test(
      title,
    );
    return !play.market_type && looksMarketLike;
  });

  assert.strictEqual(
    missingMarketType.length,
    0,
    `Expected zero plays with missing market_type, found ${missingMarketType.length}`,
  );

  assert.strictEqual(
    unknownLegacyMarket.length,
    0,
    `Expected zero legacy market-like cards without market_type, found ${unknownLegacyMarket.length}`,
  );

  // WI-0573: negative American prices must not be passed to decimalToAmerican()
  const routeSource = fs.readFileSync(
    path.resolve('src/app/api/games/route.ts'),
    'utf8'
  );
  assert(
    routeSource.includes('Math.abs(rawPriceOver) > 10') &&
      routeSource.includes('Math.abs(rawPriceUnder) > 10'),
    'WI-0573: already-American guard must use Math.abs() to handle negative American prices (-110, -115)',
  );

  // WI-0599: pitcher K cards must flow through props routing without being dropped
  assert(
    routeSource.includes("normalized === 'mlb-pitcher-k'") &&
      routeSource.includes("return 'PROP'"),
    'WI-0599: mlb-pitcher-k must map to PROP via inferMarketFromCardType',
  );
  assert(
    routeSource.includes("'mlb-pitcher-k'") &&
      routeSource.includes('playProducerCardTypes'),
    'WI-0599: mlb-pitcher-k must be in MLB playProducerCardTypes contract',
  );
  assert(
    routeSource.includes('isMlbPitcherKPlay') &&
      routeSource.includes('seenMlbPitcherKPlayKeys'),
    'WI-0599: MLB pitcher K prop plays must have dedup block parallel to isNhlPropPlay',
  );

  console.log('✅ API games market smoke test passed');
}

run().catch((error) => {
  console.error('❌ API games market smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
