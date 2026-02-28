/*
 * Game card decision display tests
 * Run: npm --prefix web run test:card-decision
 */

function buildDriver(overrides) {
  return {
    key: 'driver_key',
    market: 'ML',
    tier: 'WATCH',
    direction: 'HOME',
    confidence: 0.6,
    note: 'baseline',
    cardType: 'nhl-model-output',
    cardTitle: 'Base Driver',
    ...overrides,
  };
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const { deduplicateDrivers, getCardDecisionModel } = await import('../lib/game-card/decision.js');

  console.log('🧪 Game Card Decision Tests');

  const duplicateDrivers = [
    buildDriver({ tier: 'WATCH', confidence: 0.55, note: 'Same note' }),
    buildDriver({ tier: 'BEST', confidence: 0.72, note: 'Same note' }),
  ];
  const deduped = deduplicateDrivers(duplicateDrivers);
  assert.strictEqual(deduped.length, 1, 'dedupe should collapse identical drivers');
  assert.strictEqual(deduped[0].tier, 'BEST', 'dedupe should keep strongest tier');

  const card = {
    id: 'card-1',
    gameId: 'game-1',
    sport: 'NHL',
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    startTime: '2026-02-28T18:00:00Z',
    updatedAt: '2026-02-28T12:00:00Z',
    status: 'scheduled',
    markets: {},
    drivers: [
      buildDriver({
        key: 'ml-away-best',
        tier: 'BEST',
        direction: 'AWAY',
        confidence: 0.86,
        note: 'Edge on away ML',
        cardTitle: 'Away ML Edge',
      }),
      buildDriver({
        key: 'ml-away-super',
        tier: 'SUPER',
        direction: 'AWAY',
        confidence: 0.72,
        note: 'Model aligns',
        cardTitle: 'Away ML Support',
      }),
      buildDriver({
        key: 'ml-home-watch',
        tier: 'WATCH',
        direction: 'HOME',
        confidence: 0.61,
        note: 'Home price resistance',
        cardTitle: 'Home ML Pushback',
      }),
      buildDriver({
        key: 'neutral-coverage',
        market: 'RISK',
        direction: 'NEUTRAL',
        tier: 'WATCH',
        confidence: 0.4,
        note: 'Low coverage',
        cardTitle: 'Coverage Risk',
      }),
    ],
    tags: ['has_fire', 'has_low_coverage'],
  };

  const odds = {
    h2hHome: -120,
    h2hAway: 200,
    total: 5.5,
    spreadHome: -1.5,
    spreadAway: 1.5,
    capturedAt: '2026-02-28T11:59:00Z',
  };

  const decision = getCardDecisionModel(card, odds);
  assert.strictEqual(decision.status, 'FIRE', 'status should resolve to FIRE');
  assert.strictEqual(decision.primaryPlay.pick, 'AWAY +200', 'primary play should use best away ML');
  assert.ok(decision.topContributors.length <= 3, 'top contributors should cap at 3');
  assert.strictEqual(decision.topContributors[0].polarity, 'pro', 'first contributor should be pro');
  assert.ok(decision.riskCodes.includes('LOW_COVERAGE'), 'risk codes should surface LOW_COVERAGE');

  const nbaCard = {
    ...card,
    id: 'card-nba',
    gameId: 'game-nba',
    sport: 'NBA',
    drivers: [
      buildDriver({
        key: 'nba_projection_home',
        market: 'UNKNOWN',
        tier: 'BEST',
        direction: 'HOME',
        confidence: 0.81,
        note: 'NBA projection edge on home side',
        cardTitle: 'NBA Projection',
      }),
      buildDriver({
        key: 'nba_rest_home',
        market: 'UNKNOWN',
        tier: 'SUPER',
        direction: 'HOME',
        confidence: 0.74,
        note: 'NBA rest advantage',
        cardTitle: 'NBA Rest',
      }),
    ],
    tags: ['has_watch'],
  };

  const nbaDecision = getCardDecisionModel(nbaCard, odds);
  assert.ok(nbaDecision.primaryPlay.pick !== 'NO PLAY', 'NBA fixture should produce a play');
  assert.ok(
    nbaDecision.primaryPlay.market === 'ML' || nbaDecision.primaryPlay.market === 'SPREAD',
    'NBA fixture should resolve to a side market'
  );

  const ncaamCard = {
    ...card,
    id: 'card-ncaam',
    gameId: 'game-ncaam',
    sport: 'NCAAM',
    drivers: [
      buildDriver({
        key: 'ncaam_matchup_away',
        market: 'UNKNOWN',
        tier: 'SUPER',
        direction: 'AWAY',
        confidence: 0.7,
        note: 'NCAAM matchup edge',
        cardTitle: 'NCAAM Matchup',
      }),
      buildDriver({
        key: 'ncaam_rest_away',
        market: 'UNKNOWN',
        tier: 'SUPER',
        direction: 'AWAY',
        confidence: 0.66,
        note: 'NCAAM rest edge',
        cardTitle: 'NCAAM Rest',
      }),
    ],
    tags: ['has_watch'],
  };

  const ncaamDecision = getCardDecisionModel(ncaamCard, odds);
  assert.ok(ncaamDecision.primaryPlay.pick !== 'NO PLAY', 'NCAAM fixture should produce a play');
  assert.ok(
    ncaamDecision.primaryPlay.market === 'ML' || ncaamDecision.primaryPlay.market === 'SPREAD',
    'NCAAM fixture should resolve to a side market'
  );

  console.log('✅ Game card decision tests passed');
}

run().catch((error) => {
  console.error('❌ Game card decision tests failed');
  console.error(error.message || error);
  process.exit(1);
});
