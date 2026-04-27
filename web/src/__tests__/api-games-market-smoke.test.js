/*
 * API → UI smoke test for canonical market fields.
 * Live mode: CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:games:market
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 npm --prefix web run test:api:games:market';

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
    `Games API endpoint unavailable at ${baseUrl}; running source fallback checks. ` +
    `To run live assertions: ${LIVE_COMMAND}`
  );
}

async function preflightGamesEndpoint(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/api/games?limit=1`);
  assert.strictEqual(
    response.ok,
    true,
    `Games API preflight not ok: ${response.status}`,
  );
}

async function runSourceContractAssertions(assert) {
  const fs = await import('node:fs/promises');
  // WI-0621 thinned app/api/games/route.ts to a re-export shim; read the handler directly.
  const routeSource = await fs.readFile(
    new URL('../lib/games/route-handler.ts', import.meta.url),
    'utf8',
  );
  // WI-0621 extracted inferMarketFromCardType into a separate module.
  const marketInferenceSource = await fs.readFile(
    new URL('../lib/games/market-inference.ts', import.meta.url),
    'utf8',
  );

  assert(
    routeSource.includes('Math.abs(rawPriceOver) > 10') &&
      routeSource.includes('Math.abs(rawPriceUnder) > 10'),
    'WI-0573: already-American guard must use Math.abs() to handle negative American prices (-110, -115)',
  );

  assert(
    marketInferenceSource.includes("normalized === 'mlb-pitcher-k'") &&
      marketInferenceSource.includes("return 'PROP'"),
    'WI-0599: mlb-pitcher-k must map to PROP via inferMarketFromCardType',
  );
  assert(
    routeSource.includes("'mlb-pitcher-k'") &&
      routeSource.includes('playProducerCardTypes'),
    'WI-0599: mlb-pitcher-k must be in MLB playProducerCardTypes contract',
  );
  assert(
    routeSource.includes('isMlbPitcherKPlay') &&
      routeSource.includes('seenMlbPitcherKPlayKeys') &&
      routeSource.includes("play.canonical_market_key === 'pitcher_strikeouts'"),
    'WI-0599: MLB pitcher K prop plays must have a pitcher-strikeouts-specific dedup block instead of matching every MLB PROP row',
  );
  assert(
    routeSource.includes('const isProp = p.market_type === \'PROP\';') &&
      routeSource.includes('p.canonical_market_key ??') &&
      routeSource.includes('p.cardType ??'),
    'Prop secondary dedupe must use a prop-family key, not generic PROP, so MLB pitcher K rows are not collapsed',
  );
  assert(
    routeSource.includes('cardRows = mergeMlbGameLineFallbackRows({') &&
      routeSource.includes('isEligibleMlbGameLineFallbackRow'),
    'MLB full-game fallback merge must be enabled with strict eligibility guards to restore publishable rows lost by active-run filtering',
  );
}

async function validateLivePayload(baseUrl, assert) {
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
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  await runSourceContractAssertions(assert);

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    await preflightGamesEndpoint(baseUrl, assert);
    await validateLivePayload(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
  }

  console.log('✅ API games market smoke test passed');
}

run().catch((error) => {
  console.error('❌ API games market smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
