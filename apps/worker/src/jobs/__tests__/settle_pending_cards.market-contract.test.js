const { deriveLockedMarketContext } = require('@cheddar-logic/data');
const { __private } = require('../settle_pending_cards');
const {
  isExecutableMlbFullGameLean,
  resolveStrictStatus,
} = require('../repair_mlb_full_game_display_log');

describe('settle_pending_cards market contract', () => {
  test('same game spread and moneyline lock different market keys and prices, then settle independently', () => {
    const basePayload = {
      game_id: 'game-test-001',
      kind: 'PLAY',
      home_team: 'Boston Celtics',
      away_team: 'Miami Heat',
      odds_context: {
        h2h_home: -180,
        h2h_away: 155,
        spread_home: -3.5,
        spread_away: 3.5,
        spread_price_home: -110,
        spread_price_away: -110,
        total: 221.5,
        total_price_over: -108,
        total_price_under: -112,
      },
    };

    const spreadPayload = {
      ...basePayload,
      market_type: 'SPREAD',
      selection: { side: 'HOME' },
      line: -3.5,
      price: -110,
    };

    const moneylinePayload = {
      ...basePayload,
      market_type: 'MONEYLINE',
      selection: { side: 'HOME' },
      line: null,
      price: -180,
    };

    const spread = deriveLockedMarketContext(spreadPayload, {
      gameId: 'game-test-001',
      homeTeam: 'Boston Celtics',
      awayTeam: 'Miami Heat',
      requirePrice: true,
      requireLineForMarket: true,
    });
    const moneyline = deriveLockedMarketContext(moneylinePayload, {
      gameId: 'game-test-001',
      homeTeam: 'Boston Celtics',
      awayTeam: 'Miami Heat',
      requirePrice: true,
      requireLineForMarket: true,
    });

    expect(spread.marketKey).toBe('game-test-001:SPREAD:HOME:-3.5');
    expect(moneyline.marketKey).toBe('game-test-001:MONEYLINE:HOME:NA');
    expect(spread.marketKey).not.toBe(moneyline.marketKey);
    expect(spread.lockedPrice).toBe(-110);
    expect(moneyline.lockedPrice).toBe(-180);

    const spreadResult = __private.gradeLockedMarket({
      marketType: spread.marketType,
      selection: spread.selection,
      line: spread.line,
      homeScore: 112,
      awayScore: 105,
    });
    const moneylineResult = __private.gradeLockedMarket({
      marketType: moneyline.marketType,
      selection: moneyline.selection,
      line: moneyline.line,
      homeScore: 112,
      awayScore: 105,
    });

    expect(spreadResult).toBe('win');
    expect(moneylineResult).toBe('win');
    expect(
      __private.computePnlUnits(spreadResult, spread.lockedPrice),
    ).toBeCloseTo(100 / 110, 6);
    expect(
      __private.computePnlUnits(moneylineResult, moneyline.lockedPrice),
    ).toBeCloseTo(100 / 180, 6);
  });

  test('spread with OVER selection throws INVALID_SPREAD_SELECTION', () => {
    const payload = {
      game_id: 'game-test-002',
      kind: 'PLAY',
      market_type: 'SPREAD',
      selection: { side: 'OVER' },
      line: -4.5,
      price: -110,
      home_team: 'Lakers',
      away_team: 'Suns',
      odds_context: { spread_price_home: -110, spread_price_away: -110 },
    };

    expect(() =>
      deriveLockedMarketContext(payload, {
        gameId: 'game-test-002',
        homeTeam: 'Lakers',
        awayTeam: 'Suns',
        requirePrice: true,
        requireLineForMarket: true,
      }),
    ).toThrow(/INVALID_SPREAD_SELECTION|Spread selection/);
  });

  test('settlement contract fails when row lacks market_key (game-level settlement blocked)', () => {
    const row = {
      card_id: 'card-missing-market-key',
      game_id: 'game-test-003',
      market_key: null,
      market_type: 'MONEYLINE',
      selection: 'HOME',
      line: null,
      locked_price: -140,
    };

    const payload = {
      home_team: 'Knicks',
      away_team: 'Bulls',
    };

    expect(() => __private.assertLockedMarketContext(row, payload)).toThrow(
      /market_key/,
    );
  });

  test('buildClvEntryFromPendingCard builds deterministic odds-backed ledger payload', () => {
    const pendingCard = {
      card_id: 'card-clv-001',
      game_id: 'game-clv-001',
      sport: 'NBA',
    };
    const payloadData = {
      decision_basis_meta: {
        decision_basis: 'ODDS_BACKED',
        volatility_band: 'LOW',
      },
      recommended_bet_type: 'moneyline',
    };
    const lockedMarket = {
      marketType: 'MONEYLINE',
      selection: 'HOME',
      line: null,
      lockedPrice: -125,
    };

    const entry = __private.buildClvEntryFromPendingCard({
      pendingCard,
      payloadData,
      lockedMarket,
    });

    expect(entry).toMatchObject({
      id: 'clv-card-clv-001',
      cardId: 'card-clv-001',
      gameId: 'game-clv-001',
      sport: 'NBA',
      marketType: 'MONEYLINE',
      selection: 'HOME',
      oddsAtPick: -125,
      volatilityBand: 'LOW',
      decisionBasis: 'ODDS_BACKED',
    });

    const projectionOnly = __private.buildClvEntryFromPendingCard({
      pendingCard,
      payloadData: {
        decision_basis_meta: { decision_basis: 'PROJECTION_ONLY' },
      },
      lockedMarket,
    });
    expect(projectionOnly).toBeNull();
  });

  // WI-0838: first_seen_price lock tests
  test('buildClvEntryFromPendingCard uses first_seen_price when present, ignoring drifted lockedPrice', () => {
    // Simulate: card was created at -115, model re-ran and lockedPrice drifted to -125
    const pendingCard = {
      card_id: 'card-fsp-001',
      game_id: 'game-fsp-001',
      sport: 'NHL',
      first_seen_price: -115, // original opening-line pick price
    };
    const payloadData = {
      decision_basis_meta: {
        decision_basis: 'ODDS_BACKED',
        volatility_band: 'MEDIUM',
      },
    };
    const lockedMarket = {
      marketType: 'TOTAL',
      selection: 'OVER',
      line: 5.5,
      lockedPrice: -125, // drifted on most-recent model run
    };

    const entry = __private.buildClvEntryFromPendingCard({
      pendingCard,
      payloadData,
      lockedMarket,
    });

    expect(entry).not.toBeNull();
    // Must use first_seen_price (-115), not the drifted lockedPrice (-125)
    expect(entry.oddsAtPick).toBe(-115);
  });

  test('buildClvEntryFromPendingCard falls back to lockedPrice when first_seen_price is null', () => {
    // Simulate: card predates migration — first_seen_price column exists but is null
    const pendingCard = {
      card_id: 'card-fsp-002',
      game_id: 'game-fsp-002',
      sport: 'NBA',
      first_seen_price: null,
    };
    const payloadData = {
      decision_basis_meta: {
        decision_basis: 'ODDS_BACKED',
        volatility_band: 'LOW',
      },
    };
    const lockedMarket = {
      marketType: 'TOTAL',
      selection: 'UNDER',
      line: 220.5,
      lockedPrice: -110,
    };

    const entry = __private.buildClvEntryFromPendingCard({
      pendingCard,
      payloadData,
      lockedMarket,
    });

    expect(entry).not.toBeNull();
    // Falls back to lockedPrice when first_seen_price is null
    expect(entry.oddsAtPick).toBe(-110);
  });

  test('strict legacy fallback treats PASS/WATCH/HOLD as non-actionable', () => {
    expect(
      __private.resolveBackfillOfficialStatus({
        decision_v2: { official_status: 'LEAN' },
        status: 'WATCH',
      }),
    ).toBe('LEAN');
    expect(
      __private.resolveBackfillOfficialStatus({
        decision_v2: { official_status: 'MAYBE' },
        status: 'FIRE',
      }),
    ).toBe('');
    expect(__private.resolveBackfillOfficialStatus({ status: 'FIRE' })).toBe(
      'PLAY',
    );
    expect(__private.resolveBackfillOfficialStatus({ status: 'PLAY' })).toBe(
      'PLAY',
    );
    expect(__private.resolveBackfillOfficialStatus({ status: 'LEAN' })).toBe(
      'LEAN',
    );
    expect(__private.resolveBackfillOfficialStatus({ status: 'PASS' })).toBe('');
    expect(__private.resolveBackfillOfficialStatus({ status: 'WATCH' })).toBe(
      '',
    );
    expect(__private.resolveBackfillOfficialStatus({ status: 'HOLD' })).toBe(
      '',
    );
    expect(__private.resolveBackfillOfficialStatus({ status: 'MONITOR' })).toBe(
      '',
    );
    expect(__private.resolveBackfillOfficialStatus({})).toBe('');
  });

  test('MLB full-game settlement telemetry buckets include total and moneyline', () => {
    expect(
      __private.resolveSettlementMarketBucket({
        sport: 'MLB',
        marketType: 'TOTAL',
        period: 'FULL_GAME',
      }),
    ).toBe('MLB_TOTAL');
    expect(
      __private.resolveSettlementMarketBucket({
        sport: 'baseball_mlb',
        marketType: 'MONEYLINE',
        period: 'FULL_GAME',
      }),
    ).toBe('MLB_MONEYLINE');
    expect(
      __private.resolveSettlementMarketBucket({
        sport: 'MLB',
        marketType: 'TOTAL',
        period: '1P',
      }),
    ).toBeNull();
  });

  test('repair job eligibility is limited to executable MLB full-game LEAN rows', () => {
    const totalRow = {
      sport: 'MLB',
      card_type: 'mlb-full-game',
      market_type: 'TOTAL',
      selection: 'OVER',
      line: 8.5,
      locked_price: -110,
    };
    expect(
      isExecutableMlbFullGameLean(totalRow, {
        status: 'LEAN',
        execution_status: 'EXECUTABLE',
      }),
    ).toBe(true);
    expect(
      isExecutableMlbFullGameLean(totalRow, {
        status: 'WATCH',
        execution_status: 'EXECUTABLE',
      }),
    ).toBe(false);
    expect(
      isExecutableMlbFullGameLean(totalRow, {
        status: 'LEAN',
        execution_status: 'PROJECTION_ONLY',
      }),
    ).toBe(false);
    expect(
      isExecutableMlbFullGameLean(totalRow, {
        status: 'LEAN',
      }),
    ).toBe(false);
    expect(resolveStrictStatus({ status: 'FIRE' })).toBe('PLAY');
    expect(resolveStrictStatus({ status: 'WATCH' })).toBe('');
    expect(
      isExecutableMlbFullGameLean(
        {
          sport: 'MLB',
          card_type: 'mlb-full-game-ml',
          market_type: 'MONEYLINE',
          selection: 'HOME',
          line: null,
          locked_price: -125,
        },
        {
          decision_v2: { official_status: 'LEAN' },
          status: 'WATCH',
          execution_status: 'EXECUTABLE',
        },
      ),
    ).toBe(true);
  });
});
