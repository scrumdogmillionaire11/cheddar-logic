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
  const {
    deduplicateDrivers,
    getCardDecisionModel,
    resolvePlayDisplayDecision,
  } = await import('../lib/game-card/decision.js');

  console.log('🧪 Game Card Decision Tests');

  const duplicateDrivers = [
    buildDriver({ tier: 'WATCH', confidence: 0.55, note: 'Same note' }),
    buildDriver({ tier: 'BEST', confidence: 0.72, note: 'Same note' }),
  ];
  const deduped = deduplicateDrivers(duplicateDrivers);
  assert.strictEqual(
    deduped.length,
    1,
    'dedupe should collapse identical drivers',
  );
  assert.strictEqual(
    deduped[0].tier,
    'BEST',
    'dedupe should keep strongest tier',
  );

  const fromBaseClassification = resolvePlayDisplayDecision({
    classification: 'BASE',
  });
  assert.strictEqual(
    fromBaseClassification.action,
    'FIRE',
    'BASE classification should map to FIRE action',
  );
  assert.strictEqual(
    fromBaseClassification.status,
    'FIRE',
    'BASE classification should map to FIRE status',
  );

  const fromLeanClassification = resolvePlayDisplayDecision({
    classification: 'LEAN',
  });
  assert.strictEqual(
    fromLeanClassification.action,
    'HOLD',
    'LEAN classification should map to HOLD action',
  );
  assert.strictEqual(
    fromLeanClassification.status,
    'WATCH',
    'LEAN classification should map to WATCH status',
  );

  const fromFireAction = resolvePlayDisplayDecision({ action: 'FIRE' });
  assert.strictEqual(
    fromFireAction.classification,
    'BASE',
    'FIRE action should map back to BASE classification',
  );

  const actionWinsLegacyStatus = resolvePlayDisplayDecision({
    action: 'HOLD',
    status: 'FIRE',
    classification: 'BASE',
  });
  assert.strictEqual(
    actionWinsLegacyStatus.action,
    'HOLD',
    'canonical action should win over conflicting legacy status/classification',
  );
  assert.strictEqual(
    actionWinsLegacyStatus.status,
    'WATCH',
    'canonical HOLD action should map to WATCH display status',
  );

  const classificationWinsLegacyStatus = resolvePlayDisplayDecision({
    classification: 'LEAN',
    status: 'FIRE',
  });
  assert.strictEqual(
    classificationWinsLegacyStatus.action,
    'HOLD',
    'canonical classification should win over conflicting legacy status',
  );

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
  assert.strictEqual(
    decision.primaryPlay.pick,
    'AWAY +200',
    'primary play should use best away ML',
  );
  assert.ok(
    decision.topContributors.length <= 3,
    'top contributors should cap at 3',
  );
  assert.strictEqual(
    decision.topContributors[0].polarity,
    'pro',
    'first contributor should be pro',
  );
  assert.ok(
    decision.riskCodes.includes('LOW_COVERAGE'),
    'risk codes should surface LOW_COVERAGE',
  );

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
  assert.ok(
    nbaDecision.primaryPlay.pick !== 'NO PLAY',
    'NBA fixture should produce a play',
  );
  assert.ok(
    nbaDecision.primaryPlay.market === 'ML' ||
      nbaDecision.primaryPlay.market === 'SPREAD',
    'NBA fixture should resolve to a side market',
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
  assert.ok(
    ncaamDecision.primaryPlay.pick !== 'NO PLAY',
    'NCAAM fixture should produce a play',
  );
  assert.ok(
    ncaamDecision.primaryPlay.market === 'ML' ||
      ncaamDecision.primaryPlay.market === 'SPREAD',
    'NCAAM fixture should resolve to a side market',
  );

  // ── SpreadCompare derivation ──────────────────────────────────────────────

  console.log('🧪 SpreadCompare derivation tests');

  // Shared spread card helper
  function buildSpreadCard(overrides = {}) {
    return {
      id: 'spread-card-1',
      gameId: 'game-spread-1',
      sport: 'NBA',
      homeTeam: 'Home',
      awayTeam: 'Away',
      startTime: '2026-03-07T18:00:00Z',
      updatedAt: '2026-03-07T12:00:00Z',
      status: 'scheduled',
      markets: {},
      tags: [],
      ...overrides,
    };
  }

  const spreadOdds = {
    h2hHome: -150,
    h2hAway: 130,
    total: 220.5,
    spreadHome: -9.5,
    spreadAway: 9.5,
    capturedAt: '2026-03-07T11:59:00Z',
  };

  // Test 1: market=SPREAD, direction=HOME → spreadCompare.marketLine=-9.5, direction=HOME
  const spreadCard1 = buildSpreadCard({
    play: {
      status: 'FIRE',
      market: 'SPREAD',
      pick: 'Home -9.5',
      lean: '',
      side: 'HOME',
      truthStatus: 'STRONG',
      truthStrength: 0.8,
      conflict: 0.1,
      valueStatus: 'GOOD',
      betAction: 'BET',
      priceFlags: [],
      updatedAt: '2026-03-07T12:00:00Z',
      whyCode: 'EDGE_FOUND',
      whyText: 'Spread edge found',
    },
    drivers: [
      buildDriver({
        key: 'spread_driver',
        market: 'SPREAD',
        tier: 'BEST',
        direction: 'HOME',
        confidence: 0.8,
        note: 'Strong spread edge',
        cardTitle: 'Spread Edge',
      }),
    ],
  });

  const sc1 = getCardDecisionModel(spreadCard1, spreadOdds);
  assert.ok(
    sc1.spreadCompare !== null,
    'Test 1: spreadCompare should be non-null for SPREAD market',
  );
  assert.strictEqual(
    sc1.spreadCompare.direction,
    'HOME',
    'Test 1: direction should be HOME',
  );
  assert.strictEqual(
    sc1.spreadCompare.marketLine,
    -9.5,
    'Test 1: marketLine should be -9.5 (spreadHome)',
  );

  // Test 2: driver note contains "Proj: -8.2" → projectedSpread=-8.2
  const spreadCard2 = buildSpreadCard({
    play: {
      status: 'FIRE',
      market: 'SPREAD',
      pick: 'Home -9.5',
      lean: '',
      side: 'HOME',
      truthStatus: 'STRONG',
      truthStrength: 0.8,
      conflict: 0.1,
      valueStatus: 'GOOD',
      betAction: 'BET',
      priceFlags: [],
      updatedAt: '2026-03-07T12:00:00Z',
      whyCode: 'EDGE_FOUND',
      whyText: 'Spread edge found',
    },
    drivers: [
      buildDriver({
        key: 'spread_proj',
        market: 'SPREAD',
        tier: 'BEST',
        direction: 'HOME',
        confidence: 0.8,
        note: 'Proj: -8.2 vs market -9.5',
        cardTitle: 'Spread Projection',
      }),
    ],
  });

  const sc2 = getCardDecisionModel(spreadCard2, spreadOdds);
  assert.ok(
    sc2.spreadCompare !== null,
    'Test 2: spreadCompare should be non-null',
  );
  assert.strictEqual(
    sc2.spreadCompare.projectedSpread,
    -8.2,
    'Test 2: projectedSpread should parse -8.2 from note',
  );

  // Test 3: market=SPREAD but no parseable projection → projectedSpread=null, marketLine still set
  const spreadCard3 = buildSpreadCard({
    play: {
      status: 'FIRE',
      market: 'SPREAD',
      pick: 'Home -9.5',
      lean: '',
      side: 'HOME',
      truthStatus: 'STRONG',
      truthStrength: 0.8,
      conflict: 0.1,
      valueStatus: 'GOOD',
      betAction: 'BET',
      priceFlags: [],
      updatedAt: '2026-03-07T12:00:00Z',
      whyCode: 'EDGE_FOUND',
      whyText: 'Spread edge found',
    },
    drivers: [
      buildDriver({
        key: 'spread_no_proj',
        market: 'SPREAD',
        tier: 'BEST',
        direction: 'HOME',
        confidence: 0.8,
        note: 'Model edge on spread',
        cardTitle: 'Spread Edge',
      }),
    ],
  });

  const sc3 = getCardDecisionModel(spreadCard3, spreadOdds);
  assert.ok(
    sc3.spreadCompare !== null,
    'Test 3: spreadCompare should be non-null',
  );
  assert.strictEqual(
    sc3.spreadCompare.projectedSpread,
    null,
    'Test 3: projectedSpread should be null when no pattern match',
  );
  assert.strictEqual(
    sc3.spreadCompare.marketLine,
    -9.5,
    'Test 3: marketLine should still be set',
  );

  // Test 4: market=ML → spreadCompare=null
  const mlCard = buildSpreadCard({
    play: {
      status: 'FIRE',
      market: 'ML',
      pick: 'Home ML -150',
      lean: '',
      side: 'HOME',
      truthStatus: 'STRONG',
      truthStrength: 0.8,
      conflict: 0.1,
      valueStatus: 'GOOD',
      betAction: 'BET',
      priceFlags: [],
      updatedAt: '2026-03-07T12:00:00Z',
      whyCode: 'EDGE_FOUND',
      whyText: 'ML edge',
    },
    drivers: [
      buildDriver({
        key: 'ml_driver',
        market: 'ML',
        tier: 'BEST',
        direction: 'HOME',
        confidence: 0.8,
        note: 'ML edge',
        cardTitle: 'ML Edge',
      }),
    ],
  });

  const sc4 = getCardDecisionModel(mlCard, spreadOdds);
  assert.strictEqual(
    sc4.spreadCompare,
    null,
    'Test 4: spreadCompare should be null for ML market',
  );

  // Test 5: market=SPREAD, direction=AWAY → marketLine = spreadAway (9.5)
  const spreadCard5 = buildSpreadCard({
    play: {
      status: 'FIRE',
      market: 'SPREAD',
      pick: 'Away +9.5',
      lean: '',
      side: 'AWAY',
      truthStatus: 'STRONG',
      truthStrength: 0.8,
      conflict: 0.1,
      valueStatus: 'GOOD',
      betAction: 'BET',
      priceFlags: [],
      updatedAt: '2026-03-07T12:00:00Z',
      whyCode: 'EDGE_FOUND',
      whyText: 'Away spread edge',
    },
    drivers: [
      buildDriver({
        key: 'spread_away',
        market: 'SPREAD',
        tier: 'BEST',
        direction: 'AWAY',
        confidence: 0.8,
        note: 'Away spread edge',
        cardTitle: 'Away Spread',
      }),
    ],
  });

  const sc5 = getCardDecisionModel(spreadCard5, spreadOdds);
  assert.ok(
    sc5.spreadCompare !== null,
    'Test 5: spreadCompare should be non-null for AWAY SPREAD',
  );
  assert.strictEqual(
    sc5.spreadCompare.direction,
    'AWAY',
    'Test 5: direction should be AWAY',
  );
  assert.strictEqual(
    sc5.spreadCompare.marketLine,
    9.5,
    'Test 5: marketLine should be 9.5 (spreadAway)',
  );

  console.log('✅ SpreadCompare derivation tests passed');

  console.log('✅ Game card decision tests passed');
}

run().catch((error) => {
  console.error('❌ Game card decision tests failed');
  console.error(error.message || error);
  process.exit(1);
});
