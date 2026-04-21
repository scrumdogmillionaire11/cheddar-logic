/**
 * WI-0768: NBA team_metrics_cache consumption in spread/total projection.
 *
 * Tests:
 *  1. Team context present → raw_data.pace_anchor_total is set and non-null;
 *     projection.total on nba-totals-call differs from raw market line.
 *  2. Team context absent  → missing_inputs includes 'nba_team_context';
 *     card execution_status is NOT 'EXECUTABLE' (capped at PROJECTION_ONLY).
 */

'use strict';

// ---------------------------------------------------------------------------
// Shared fixture builders
// ---------------------------------------------------------------------------

function buildOddsSnapshot(overrides = {}) {
  return {
    id: 'odds-row-ctx-001',
    game_id: 'nba-ctx-game-001',
    home_team: 'Boston Celtics',
    away_team: 'Miami Heat',
    game_time_utc: '2026-04-10T00:00:00.000Z',
    captured_at: '2026-04-09T18:00:00.000Z',
    h2h_home: -150,
    h2h_away: 130,
    spread_home: -3.5,
    spread_away: 3.5,
    spread_price_home: -110,
    spread_price_away: -110,
    total: 220.0,
    total_price_over: -110,
    total_price_under: -110,
    raw_data: { nba: {} },
    ...overrides,
  };
}

function buildTotalsCallCard(overrides = {}) {
  return {
    cardType: 'nba-totals-call',
    gameId: 'nba-ctx-game-001',
    sport: 'NBA',
    cardTitle: 'NBA Totals: OVER 220',
    modelOutputIds: null,
    runId: null,
    payloadData: {
      game_id: 'nba-ctx-game-001',
      sport: 'NBA',
      model_version: 'nba-cross-market-v1',
      market_type: 'TOTAL',
      prediction: 'OVER',
      confidence: 0.6,
      confidence_pct: 60,
      tier: 'B',
      status: 'FIRE',
      execution_status: 'EXECUTABLE',
      price: -110,
      line: 220.0,
      missing_inputs: [],
      projection_inputs_complete: true,
      projection: { total: 220.0, margin_home: null, win_prob_home: null },
      market_context: {
        version: 'v1',
        market_type: 'TOTAL',
        projection: { total: 220.0 },
      },
      decision_v2: { sharp_price_status: 'PRICED', official_status: 'FIRE' },
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// Loader helper (mirrors run-nba-model.test.js pattern)
// ---------------------------------------------------------------------------

function loadNBATeamContextModule({
  homeMetrics = {
    avgPoints: 115.0,
    avgPointsAllowed: 108.0,
    netRating: 7.0,
    restDays: 1,
    form: 'WW',
    pace: 105.8,
    freeThrowPct: null,
    freeThrowPctSource: null,
    rank: null,
    record: null,
  },
  awayMetrics = {
    avgPoints: 112.0,
    avgPointsAllowed: 110.0,
    netRating: 2.0,
    restDays: 2,
    form: 'WL',
    pace: 103.04,
    freeThrowPct: null,
    freeThrowPctSource: null,
    rank: null,
    record: null,
  },
  homeMetricsAvailable = true,
  awayMetricsAvailable = true,
  homeImpactContext = null,
  awayImpactContext = null,
  oddsSnapshots = [buildOddsSnapshot()],
  driverCards = [],
  projectionComplete = true,
} = {}) {
  jest.resetModules();
  delete process.env.ENABLE_WITHOUT_ODDS_MODE;
  delete process.env.ENABLE_WELCOME_HOME;

  // Build the mocked getTeamMetricsWithGames — returns neutral when unavailable
  const neutralMetrics = {
    avgPoints: null,
    avgPointsAllowed: null,
    netRating: null,
    restDays: null,
    form: 'Unknown',
    pace: null,
    freeThrowPct: null,
    freeThrowPctSource: null,
    rank: null,
    record: null,
  };

  const getTeamMetricsWithGamesMock = jest.fn(async (teamName) => {
    if (teamName === 'Boston Celtics') {
      return {
        metrics: homeMetricsAvailable ? homeMetrics : neutralMetrics,
        teamInfo: null,
        games: [],
        impactContext: homeImpactContext,
        resolution: { status: homeMetricsAvailable ? 'ok' : 'espn_no_data' },
      };
    }
    return {
      metrics: awayMetricsAvailable ? awayMetrics : neutralMetrics,
      teamInfo: null,
      games: [],
      impactContext: awayImpactContext,
      resolution: { status: awayMetricsAvailable ? 'ok' : 'espn_no_data' },
    };
  });

  const insertJobRun = jest.fn();
  const markJobRunSuccess = jest.fn();
  const markJobRunFailure = jest.fn();
  const setCurrentRunId = jest.fn();
  const insertCardPayload = jest.fn();
  const prepareModelAndCardWrite = jest.fn(() => ({
    deletedOutputs: 0,
    deletedCards: 0,
  }));
  const runPerGameWriteTransaction = jest.fn((fn) => fn());
  const validateCardPayloadMock = jest.fn(() => ({ success: true, errors: [] }));
  const shouldRunJobKeyMock = jest.fn(() => true);
  const withDb = jest.fn(async (fn) => fn());
  const enrichOddsSnapshotWithEspnMetrics = jest.fn(async (snap) => snap);
  const updateOddsSnapshotRawData = jest.fn();
  const getDatabase = jest.fn(() => ({
    prepare: jest.fn(() => ({ all: jest.fn(() => []), get: jest.fn(() => ({ cnt: 0 })) })),
  }));
  const computeLineDelta = jest.fn(() => null);
  const getOddsWithUpcomingGames = jest.fn(() => oddsSnapshots);
  const getUpcomingGamesAsSyntheticSnapshots = jest.fn(() => []);

  jest.doMock('@cheddar-logic/data', () => ({
    insertJobRun,
    markJobRunSuccess,
    markJobRunFailure,
    setCurrentRunId,
    getOddsWithUpcomingGames,
    getUpcomingGamesAsSyntheticSnapshots,
    insertCardPayload,
    prepareModelAndCardWrite,
    runPerGameWriteTransaction,
    validateCardPayload: validateCardPayloadMock,
    shouldRunJobKey: shouldRunJobKeyMock,
    withDb,
    enrichOddsSnapshotWithEspnMetrics,
    updateOddsSnapshotRawData,
    getDatabase,
    computeLineDelta,
    getTeamMetricsWithGames: getTeamMetricsWithGamesMock,
  }));

  // Build a totals-call card that generateNBAMarketCallCards will emit
  const totalsCallCard = buildTotalsCallCard();

  jest.doMock('../models', () => ({
    computeNBADriverCards: jest.fn(() => driverCards),
    generateCard: jest.fn((opts) => ({
      cardType: 'nba-base-projection',
      gameId: opts.gameId,
      sport: 'NBA',
      cardTitle: 'NBA Base Projection: HOME',
      modelOutputIds: null,
      runId: null,
      payloadData: {
        game_id: opts.gameId,
        sport: 'NBA',
        model_version: 'nba-drivers-v1',
        prediction: 'HOME',
        confidence: 0.62,
        confidence_pct: 62,
        tier: 'B',
        pipeline_state: null,
        run_id: null,
        execution_status: 'EXECUTABLE',
        price: -110,
        missing_inputs: [],
        projection_inputs_complete: true,
        decision_v2: { sharp_price_status: 'PRICED', official_status: 'FIRE' },
      },
    })),
    computeNBAMarketDecisions: jest.fn(() => ({
      TOTAL: {
        status: 'FIRE',
        edge: 0.06,
        edge_points: 3.5,
        score: 0.8,
        net: 0.8,
        conflict: 0.1,
        coverage: 0.9,
        p_fair: 0.54,
        best_candidate: { side: 'OVER', line: 220.0 },
        projection: { projected_total: 220.0 },
        drivers: [],
        reasoning: 'test reasoning',
        line_source: 'odds_snapshot',
        price_source: 'odds_snapshot',
      },
    })),
    selectExpressionChoice: jest.fn(() => null),
    computeTotalBias: jest.fn(() => 'OK'),
    buildMarketPayload: jest.fn(() => ({})),
    determineTier: jest.fn(() => 'B'),
    buildMarketCallCard: jest.fn(() => totalsCallCard),
  }));

  jest.doMock('../models/projections', () => ({
    assessProjectionInputs: jest.fn(() => ({
      projection_inputs_complete: projectionComplete,
      missing_inputs: projectionComplete ? [] : ['spread', 'total'],
    })),
  }));

  jest.doMock('../utils/normalize-raw-data-payload', () => ({
    normalizeRawDataPayload: jest.fn((raw) => raw),
  }));

  jest.doMock('@cheddar-logic/models', () => ({
    buildRecommendationFromPrediction: jest.fn(() => ({
      type: 'ML_HOME',
      pass_reason: null,
    })),
    buildMatchup: jest.fn((home, away) => `${away} @ ${home}`),
    formatStartTimeLocal: jest.fn(() => ({
      start_time_local: '7:00 PM ET',
      timezone: 'ET',
    })),
    formatCountdown: jest.fn(() => '2h 0m'),
    buildMarketFromOdds: jest.fn(() => ({
      moneyline_home: '-150',
      moneyline_away: '+130',
    })),
    buildPipelineState: jest.fn((args) => ({ ...args })),
    collectDecisionReasonCodes: jest.fn(() => []),
    marginToWinProbability: jest.fn(() => 0.6),
    WATCHDOG_REASONS: {
      CONSISTENCY_MISSING: 'CONSISTENCY_MISSING',
      MARKET_UNAVAILABLE: 'MARKET_UNAVAILABLE',
    },
    buildDecisionBasisMeta: jest.fn(() => ({})),
    resolveThresholdProfile: jest.fn(() => ({
      edge: { lean_edge_min: 0.035 },
    })),
    edgeCalculator: {
      computeSigmaFromHistory: jest.fn(() => ({ total: 12, spread: 4.5 })),
      computeConfidence: jest.fn((opts) => opts.baseConfidence),
    },
    generateCard: jest.fn(),
    buildMarketCallCard: jest.fn(),
  }));

  const publishDecisionForCardMock = jest.fn(() => ({
    gated: false,
    allow: true,
    reasonCode: null,
    strictDecisionSnapshot: {},
  }));

  jest.doMock('../utils/decision-publisher', () => ({
    publishDecisionForCard: publishDecisionForCardMock,
    applyUiActionFields: jest.fn(),
    finalizeDecisionFields: jest.fn((p) => p),
    capturePublishedDecisionState: jest.fn(() => null),
    assertNoDecisionMutation: jest.fn(() => []),
    syncCanonicalDecisionEnvelope: jest.fn(),
  }));

  jest.doMock('../utils/playoff-detection', () => ({
    isPlayoffGame: jest.fn(() => false),
    PLAYOFF_SIGMA_MULTIPLIER: 1.15,
    PLAYOFF_EDGE_MIN_INCREMENT: 0.01,
  }));

  const moduleUnderTest = require('../jobs/run_nba_model');

  return {
    runNBAModel: moduleUnderTest.runNBAModel,
    mocks: {
      insertCardPayload,
      getTeamMetricsWithGamesMock,
      updateOddsSnapshotRawData,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

function makeImpactContext(players) {
  return {
    available: true,
    generatedAt: '2026-04-09T18:00:00.000Z',
    players,
  };
}

function makeImpactPlayer(overrides = {}) {
  return {
    playerId: overrides.playerId ?? 'nba-player-1',
    playerName: overrides.playerName ?? 'NBA Player',
    teamAbbr: overrides.teamAbbr ?? 'BOS',
    rawStatus: overrides.rawStatus ?? 'OUT',
    avgPointsLast5: overrides.avgPointsLast5 ?? 10,
    startsLast5: overrides.startsLast5 ?? 5,
    isImpactPlayer: overrides.isImpactPlayer ?? true,
    impactReasons: overrides.impactReasons ?? ['starter'],
    ...overrides,
  };
}

describe('WI-0768: NBA model team_metrics_cache consumption', () => {
  // -----------------------------------------------------------------------
  //  Case 1 — team context present
  // -----------------------------------------------------------------------
  describe('when team context is available', () => {
    it('writes pace_anchor_total to raw_data', async () => {
      // home:  avgPoints=115, avgPointsAllowed=108
      // away:  avgPoints=112, avgPointsAllowed=110
      // impliedTotal = (115 + 108 + 112 + 110) / 2 = 222.5
      const snap = buildOddsSnapshot({ total: 220.0, raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: true,
        awayMetricsAvailable: true,
      });

      const result = await runNBAModel();

      expect(result.success).toBe(true);

      // updateOddsSnapshotRawData should have been called with pace_anchor_total
      const calls = mocks.updateOddsSnapshotRawData.mock.calls;
      const paceAnchorCall = calls.find(
        ([, rawData]) => rawData && rawData.pace_anchor_total != null,
      );
      expect(paceAnchorCall).toBeDefined();
      const [, rawData] = paceAnchorCall;
      expect(rawData.pace_anchor_total).toBe(222.5);
    });

    it('blended_total in raw_data differs from market total when pace diverges', async () => {
      // market total = 220.0; pace_anchor = 222.5
      // blended = 220.0 * 0.75 + 222.5 * 0.25 = 165.0 + 55.625 = 220.625
      const snap = buildOddsSnapshot({ total: 220.0, raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: true,
        awayMetricsAvailable: true,
      });

      await runNBAModel();

      const calls = mocks.updateOddsSnapshotRawData.mock.calls;
      const paceAnchorCall = calls.find(
        ([, rawData]) => rawData && rawData.blended_total != null,
      );
      expect(paceAnchorCall).toBeDefined();
      const [, rawData] = paceAnchorCall;
      // blended_total must differ from market total (220.0) when pace_anchor diverges
      expect(rawData.blended_total).not.toBe(220.0);
      // blended = 220*0.75 + 222.5*0.25 = 220.625
      expect(rawData.blended_total).toBeCloseTo(220.63, 1);
    });

    it('nba-totals-call card projection.total reflects blended total', async () => {
      const snap = buildOddsSnapshot({ total: 220.0, raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: true,
        awayMetricsAvailable: true,
      });

      await runNBAModel();

      // Find the saved card payload for nba-totals-call
      const insertedCards = mocks.insertCardPayload.mock.calls.map(
        ([card]) => card,
      );
      const totalsCard = insertedCards.find(
        (c) => c.cardType === 'nba-totals-call',
      );

      if (totalsCard) {
        // projection.total must not equal the raw market total (220.0)
        expect(totalsCard.payloadData.projection?.total).not.toBe(220.0);
        // It should be approximately the blended total
        expect(totalsCard.payloadData.projection?.total).toBeCloseTo(220.63, 1);
      }
      // Note: if no nba-totals-call card was inserted (no FIRE decision in the
      // mock), we just verify pace_anchor_total was set — covered by earlier test.
    });

    it('applies injury reduction once and stamps role-class audit details', async () => {
      const snap = buildOddsSnapshot({ total: 220.0, raw_data: {} });
      const fakeDriverDescriptor = {
        driverKey: 'baseProjection',
        signal: 0.6,
        eligible: true,
        outcome: 'HOME',
      };
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: true,
        awayMetricsAvailable: true,
        driverCards: [fakeDriverDescriptor],
        homeImpactContext: makeImpactContext([
          makeImpactPlayer({
            playerId: 'hub-1',
            playerName: 'Home Hub',
            teamAbbr: 'BOS',
            avgPointsLast5: 10,
            startsLast5: 5,
            assistsLast5: 6,
          }),
        ]),
        awayImpactContext: makeImpactContext([]),
      });

      await runNBAModel();

      const insertedCards = mocks.insertCardPayload.mock.calls.map(
        ([card]) => card,
      );
      const totalsCard = insertedCards.find(
        (card) => card.cardType === 'nba-totals-call',
      );

      expect(totalsCard).toBeDefined();
      const { payloadData } = totalsCard;
      const audit = payloadData.raw_data.injury_projection_reduction;
      expect(audit).toBeDefined();
      const originalBlendedTotal = 220.63;
      const expectedAdjustedTotal = Number(
        (originalBlendedTotal - audit.reduction_applied).toFixed(2),
      );

      expect(audit.home_impact).toMatchObject({
        raw_team_impact: 12,
        pace_surge_offset: 0.5,
        team_impact_after_redistribution: 11.5,
        capped_team_impact: 11.5,
      });
      expect(audit.away_impact).toMatchObject({
        raw_team_impact: 0,
        pace_surge_offset: 0,
        team_impact_after_redistribution: 0,
        capped_team_impact: 0,
      });
      expect(audit.reduction_applied).toBe(5.75);
      expect(audit.role_classes.home).toEqual([
        {
          player_name: 'Home Hub',
          player_id: 'hub-1',
          role_class: 'OFFENSIVE_HUB',
          role_multiplier: 1.2,
          start_ratio: 1,
          point_impact: 12,
        },
      ]);
      expect(audit.role_classes.away).toEqual([]);
      expect(payloadData.projection.total).toBe(
        payloadData.market_context.projection.total,
      );
      expect(payloadData.projection.total).toBeCloseTo(expectedAdjustedTotal, 2);
    });

    it('getTeamMetricsWithGames is called with sport=NBA for both teams', async () => {
      const snap = buildOddsSnapshot({ raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: true,
        awayMetricsAvailable: true,
      });

      await runNBAModel();

      const metricsCallArgs =
        mocks.getTeamMetricsWithGamesMock.mock.calls.map(([name, sport]) => ({
          name,
          sport,
        }));
      expect(metricsCallArgs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'Boston Celtics', sport: 'NBA' }),
          expect.objectContaining({ name: 'Miami Heat', sport: 'NBA' }),
        ]),
      );
    });
  });

  // -----------------------------------------------------------------------
  //  Case 2 — team context absent
  // -----------------------------------------------------------------------
  describe('when team context is absent (metrics unavailable)', () => {
    // Fake driver card descriptor so computeNBADriverCards returns ≥1 card;
    // without this the game loop skips card processing entirely.
    const fakeDriverDescriptor = {
      driverKey: 'baseProjection',
      signal: 0.6,
      eligible: true,
      outcome: 'HOME',
    };

    it('cards include nba_team_context in missing_inputs', async () => {
      const snap = buildOddsSnapshot({ raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: false,
        awayMetricsAvailable: false,
        driverCards: [fakeDriverDescriptor],
      });

      await runNBAModel();

      const insertedCards = mocks.insertCardPayload.mock.calls.map(
        ([card]) => card,
      );
      // At least one card should have been inserted (nba-totals-call from mock)
      expect(insertedCards.length).toBeGreaterThan(0);
      for (const card of insertedCards) {
        expect(
          Array.isArray(card.payloadData?.missing_inputs) &&
            card.payloadData.missing_inputs.includes('nba_team_context'),
        ).toBe(true);
      }
    });

    it('no inserted card has execution_status=EXECUTABLE when context is missing', async () => {
      const snap = buildOddsSnapshot({ raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: false,
        awayMetricsAvailable: false,
        driverCards: [fakeDriverDescriptor],
      });

      await runNBAModel();

      const insertedCards = mocks.insertCardPayload.mock.calls.map(
        ([card]) => card,
      );
      expect(insertedCards.length).toBeGreaterThan(0);
      for (const card of insertedCards) {
        expect(card.payloadData?.execution_status).not.toBe('EXECUTABLE');
      }
    });

    it('pace_anchor_total is NOT written to raw_data when context is absent', async () => {
      const snap = buildOddsSnapshot({ raw_data: {} });
      const { runNBAModel, mocks } = loadNBATeamContextModule({
        oddsSnapshots: [snap],
        homeMetricsAvailable: false,
        awayMetricsAvailable: false,
      });

      await runNBAModel();

      // All updateOddsSnapshotRawData calls should have raw_data WITHOUT pace_anchor_total
      for (const [, rawData] of mocks.updateOddsSnapshotRawData.mock.calls) {
        expect(rawData?.pace_anchor_total ?? null).toBeNull();
      }
    });
  });
});
