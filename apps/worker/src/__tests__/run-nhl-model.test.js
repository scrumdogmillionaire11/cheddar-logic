/**
 * Test suite for run_nhl_model.js — WI-0646 playoff-mode detection
 *
 * Minimal scaffold covering playoff fixture (returns overrides, logs flag)
 * and regular-season fixture (no overrides, no flag).
 */

function buildOddsSnapshot(overrides = {}) {
  return {
    id: 'odds-row-nhl-001',
    game_id: 'nhl-game-001',
    home_team: 'Boston Bruins',
    away_team: 'Toronto Maple Leafs',
    game_time_utc: '2026-04-22T00:00:00.000Z',
    captured_at: '2026-04-21T18:00:00.000Z',
    h2h_home: -140,
    h2h_away: 120,
    spread_home: -1.5,
    spread_away: 1.5,
    spread_price_home: 120,
    spread_price_away: -145,
    total: 5.5,
    total_price_over: -115,
    total_price_under: -105,
    raw_data: { nhl: {} },
    ...overrides,
  };
}

function buildFakeDriverCard(gameId = 'nhl-game-001', descriptor = {}) {
  return {
    cardType: descriptor.cardType || 'nhl-base-projection',
    gameId,
    sport: 'NHL',
    cardTitle: descriptor.cardTitle || 'NHL Base Projection: HOME',
    modelOutputIds: null,
    runId: null,
    payloadData: {
      game_id: gameId,
      sport: 'NHL',
      model_version: 'nhl-drivers-v1',
      prediction: descriptor.prediction || 'HOME',
      confidence: descriptor.confidence ?? 0.60,
      confidence_pct: Math.round((descriptor.confidence ?? 0.60) * 100),
      tier: descriptor.tier || 'B',
      market_type: descriptor.market_type || 'TOTAL',
      consistency: descriptor.consistency || {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
      },
      line: descriptor.line ?? 6.5,
      price: descriptor.price ?? -110,
      pipeline_state: null,
      run_id: null,
      decision_v2: {
        sharp_price_status:
          descriptor.price == null ? 'UNPRICED' : 'PRICED',
        official_status: 'PLAY',
      },
    },
  };
}

function loadRunNHLModel({
  oddsSnapshots = [buildOddsSnapshot()],
  driverCards = [buildFakeDriverCard()],
  syntheticSnapshots = [],
  shouldRunJobKey = true,
  validationResult = { success: true, errors: [] },
  withoutOddsMode = false,
  projectionComplete = true,
  enrichImpl = async (snap) => snap,
  generateCardImpl = null,
} = {}) {
  jest.resetModules();

  if (withoutOddsMode) process.env.ENABLE_WITHOUT_ODDS_MODE = 'true';
  else delete process.env.ENABLE_WITHOUT_ODDS_MODE;

  delete process.env.ENABLE_WELCOME_HOME;

  const insertJobRun = jest.fn();
  const markJobRunSuccess = jest.fn();
  const markJobRunFailure = jest.fn();
  const setCurrentRunId = jest.fn();
  const insertCardPayload = jest.fn();
  const prepareModelAndCardWrite = jest.fn(() => ({
    deletedOutputs: 0,
    deletedCards: 0,
  }));
  const validateCardPayloadMock = jest.fn(() => validationResult);
  const shouldRunJobKeyMock = jest.fn(() => shouldRunJobKey);
  const withDb = jest.fn(async (fn) => fn());
  const enrichOddsSnapshotWithEspnMetrics = jest.fn(enrichImpl);
  const updateOddsSnapshotRawData = jest.fn();
  const getDatabase = jest.fn(() => ({
    prepare: jest.fn(() => ({ all: jest.fn(() => []) })),
  }));
  const getOddsWithUpcomingGames = jest.fn(() => oddsSnapshots);
  const getUpcomingGamesAsSyntheticSnapshots = jest.fn(() => syntheticSnapshots);

  jest.doMock('@cheddar-logic/data', () => ({
    insertJobRun,
    markJobRunSuccess,
    markJobRunFailure,
    setCurrentRunId,
    getOddsWithUpcomingGames,
    getUpcomingGamesAsSyntheticSnapshots,
    insertCardPayload,
    prepareModelAndCardWrite,
    validateCardPayload: validateCardPayloadMock,
    shouldRunJobKey: shouldRunJobKeyMock,
    withDb,
    enrichOddsSnapshotWithEspnMetrics,
    updateOddsSnapshotRawData,
    getDatabase,
  }));

  jest.doMock('../moneypuck', () => ({
    enrichOddsSnapshotWithMoneyPuck: jest.fn(async (snap) => snap),
    fetchMoneyPuckSnapshot: jest.fn(async () => null),
  }));

  const computeNHLDriverCardsMock = jest.fn(() => driverCards);
  const generateCardMock = jest.fn((opts) =>
    generateCardImpl
      ? generateCardImpl(opts)
      : buildFakeDriverCard(opts.gameId, opts.descriptor),
  );

  jest.doMock('../models', () => ({
    computeNHLDriverCards: computeNHLDriverCardsMock,
    generateCard: generateCardMock,
    computeNHLMarketDecisions: jest.fn(() => ({})),
    selectExpressionChoice: jest.fn(() => null),
    buildMarketPayload: jest.fn(() => ({})),
    determineTier: jest.fn(() => 'B'),
    buildMarketCallCard: jest.fn(() => null),
    getModel: jest.fn(),
    extractNhlDriverDataQualityContext: jest.fn(() => ({})),
  }));

  jest.doMock('../models/projections', () => ({
    assessProjectionInputs: jest.fn(() => ({
      projection_inputs_complete: projectionComplete,
      missing_inputs: projectionComplete ? [] : ['spread', 'total'],
    })),
  }));

  jest.doMock('../models/nhl-goalie-state', () => ({
    resolveGoalieState: jest.fn(() => null),
  }));

  jest.doMock('../utils/normalize-raw-data-payload', () => ({
    normalizeRawDataPayload: jest.fn((raw) => raw),
  }));

  jest.doMock('../utils/playoff-detection', () => ({
    isPlayoffGame: jest.requireActual('../utils/playoff-detection').isPlayoffGame,
    PLAYOFF_SIGMA_MULTIPLIER: 1.2,
    PLAYOFF_EDGE_MIN_INCREMENT: 0.01,
    PLAYOFF_PACE_WEIGHT_CAP: 0.5,
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
      moneyline_home: '-140',
      moneyline_away: '+120',
    })),
    buildPipelineState: jest.fn((args) => ({ ...args })),
    collectDecisionReasonCodes: jest.fn(() => []),
    marginToWinProbability: jest.fn(() => 0.6),
    WATCHDOG_REASONS: {
      CONSISTENCY_MISSING: 'CONSISTENCY_MISSING',
      MARKET_UNAVAILABLE: 'MARKET_UNAVAILABLE',
      GOALIE_CONFLICTING: 'GOALIE_CONFLICTING',
    },
    buildDecisionBasisMeta: jest.fn(() => ({})),
    resolveThresholdProfile: jest.fn(() => ({
      edge: { lean_edge_min: 0.035 },
    })),
    edgeCalculator: {
      computeSigmaFromHistory: jest.fn(() => ({ total: 8, spread: 3.0 })),
      computeConfidence: jest.fn((opts) => opts.baseConfidence),
      // WI-0646: getSigmaDefaults used by NHL model as base sigma
      getSigmaDefaults: jest.fn(() => ({ total: 8, spread: 3.0 })),
    },
    generateCard: jest.fn(),
    buildMarketCallCard: jest.fn(),
  }));

  const publishDecisionForCardMock = jest.fn(() => ({
    gated: false,
    allow: true,
    reasonCode: null,
  }));

  jest.doMock('../utils/decision-publisher', () => ({
    publishDecisionForCard: publishDecisionForCardMock,
    applyUiActionFields: jest.fn((payload) => {
      if (!payload || typeof payload !== 'object') return payload;
      payload.execution_status =
        payload.execution_status ||
        (payload.decision_v2?.sharp_price_status === 'UNPRICED'
          ? 'BLOCKED'
          : 'EXECUTABLE');
      payload.consistency = {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
        ...(payload.consistency || {}),
      };
      return payload;
    }),
  }));

  const moduleUnderTest = require('../jobs/run_nhl_model');

  return {
    ...moduleUnderTest,
    mocks: {
      insertJobRun,
      markJobRunSuccess,
      markJobRunFailure,
      setCurrentRunId,
      insertCardPayload,
      prepareModelAndCardWrite,
      validateCardPayloadMock,
      shouldRunJobKeyMock,
      withDb,
      enrichOddsSnapshotWithEspnMetrics,
      getOddsWithUpcomingGames,
      getUpcomingGamesAsSyntheticSnapshots,
      computeNHLDriverCardsMock,
      generateCardMock,
      publishDecisionForCardMock,
    },
  };
}

describe('runNHLModel', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
    delete process.env.ENABLE_WELCOME_HOME;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
    delete process.env.ENABLE_WELCOME_HOME;
  });

  test('returns success with zero cards when no upcoming odds exist', async () => {
    const { runNHLModel, mocks } = loadRunNHLModel({ oddsSnapshots: [] });

    const result = await runNHLModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
    });
    expect(mocks.computeNHLDriverCardsMock).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('runs inference on a single game and writes driver cards to DB', async () => {
    const { runNHLModel, mocks } = loadRunNHLModel();

    const result = await runNHLModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 1,
      cardsFailed: 0,
    });
    expect(mocks.computeNHLDriverCardsMock).toHaveBeenCalledTimes(1);
    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(1);
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      result.jobRunId,
      expect.any(Object),
    );
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('attaches immutable NHL pace snapshot fields and demotes unknown-goalie pace cards from EXECUTABLE', async () => {
    const paceResult = {
      homeExpected: 3.01,
      awayExpected: 2.77,
      expectedTotal: 5.78,
      rawTotalModel: 5.82,
      regressedTotalModel: 5.79,
      modifierBreakdown: {
        base_5v5_total: 5.61,
        special_teams_delta: 0.09,
        home_ice_delta: 0.07,
        rest_delta: 0.01,
        goalie_delta_raw: 0.12,
        goalie_delta_applied: 0.02,
        raw_modifier_total: 0.21,
        capped_modifier_total: 0.21,
        modifier_cap_applied: false,
      },
      homeGoalieCertainty: 'UNKNOWN',
      awayGoalieCertainty: 'CONFIRMED',
      homeAdjustmentTrust: 'NEUTRALIZED',
      awayAdjustmentTrust: 'FULL',
      official_eligible: true,
      first_period_model: {
        classification: 'PASS',
        reason_codes: ['NHL_1P_GOALIE_UNCERTAIN'],
      },
    };
    const descriptors = [
      {
        cardType: 'nhl-pace-totals',
        cardTitle: 'NHL Total: OVER 5.78 vs Line 5.5',
        prediction: 'OVER',
        confidence: 0.64,
        tier: 'BEST',
        market_type: 'TOTAL',
        price: -110,
        auditContext: { paceResult },
      },
    ];

    const { runNHLModel, mocks } = loadRunNHLModel({
      driverCards: descriptors,
    });

    await runNHLModel();

    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(1);
    const insertedCard = mocks.insertCardPayload.mock.calls[0][0];
    expect(insertedCard.cardType).toBe('nhl-pace-totals');
    expect(insertedCard.payloadData.execution_status).toBe('PROJECTION_ONLY');
    expect(insertedCard.payloadData._pricing_state).toMatchObject({
      status: 'FRESH',
    });
    expect(insertedCard.payloadData._publish_state).toMatchObject({
      publish_ready: false,
      execution_status: 'PROJECTION_ONLY',
    });
    expect(insertedCard.payloadData.nhl_goalie_certainty_pair).toBe(
      'UNKNOWN/CONFIRMED',
    );
    expect(insertedCard.payloadData._model_snapshot).toMatchObject({
      homeExpected: 3.01,
      awayExpected: 2.77,
      sigma_total: 8,
      consistency: {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
      },
    });
    expect(Object.isFrozen(insertedCard.payloadData._model_snapshot)).toBe(
      true,
    );
    expect(
      Object.isFrozen(insertedCard.payloadData._model_snapshot.consistency),
    ).toBe(true);
  });
});

// WI-0646: Playoff mode detection tests for NHL model
describe('runNHLModel — playoff mode detection', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
    delete process.env.ENABLE_WELCOME_HOME;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
    delete process.env.ENABLE_WELCOME_HOME;
  });

  test('applies PLAYOFF_MODE sigma override and logs flag when raw_data.season.type is 3', async () => {
    const playoffSnapshot = buildOddsSnapshot({
      game_id: 'nhl-playoff-001',
      raw_data: { season: { type: 3 } },
    });

    const { runNHLModel, mocks } = loadRunNHLModel({
      oddsSnapshots: [playoffSnapshot],
    });

    await runNHLModel();

    // Should log [PLAYOFF_MODE]
    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0]);
    expect(logCalls.some((msg) => /\[PLAYOFF_MODE\]/.test(String(msg)))).toBe(true);

    // publishDecisionForCard should be called with inflated sigma
    // getSigmaDefaults('NHL') mock returns { total: 8, spread: 3.0 }
    // After PLAYOFF_SIGMA_MULTIPLIER=1.2: spread=3.6, total=9.6
    expect(mocks.publishDecisionForCardMock).toHaveBeenCalled();
    const calls = mocks.publishDecisionForCardMock.mock.calls;
    const sigmaArgs = calls.map((c) => c[0].options?.sigmaOverride).filter(Boolean);
    expect(sigmaArgs.length).toBeGreaterThan(0);
    sigmaArgs.forEach((sigma) => {
      if (Number.isFinite(sigma.spread)) {
        expect(sigma.spread).toBeGreaterThan(3.0);
      }
      if (Number.isFinite(sigma.total)) {
        expect(sigma.total).toBeGreaterThan(8);
      }
    });
  });

  test('does not apply PLAYOFF_MODE for regular-season game', async () => {
    const regularSnapshot = buildOddsSnapshot({
      game_id: 'nhl-regular-001',
      raw_data: { season: { type: 2 } },
    });

    const { runNHLModel, mocks } = loadRunNHLModel({
      oddsSnapshots: [regularSnapshot],
    });

    await runNHLModel();

    // Should NOT log [PLAYOFF_MODE]
    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0]);
    expect(logCalls.some((msg) => /\[PLAYOFF_MODE\]/.test(String(msg)))).toBe(false);

    // publishDecisionForCard should be called with unmodified base sigma
    expect(mocks.publishDecisionForCardMock).toHaveBeenCalled();
    const calls = mocks.publishDecisionForCardMock.mock.calls;
    const sigmaArgs = calls.map((c) => c[0].options?.sigmaOverride).filter(Boolean);
    expect(sigmaArgs.length).toBeGreaterThan(0);
    sigmaArgs.forEach((sigma) => {
      if (Number.isFinite(sigma.spread)) {
        expect(sigma.spread).toBe(3.0);
      }
      if (Number.isFinite(sigma.total)) {
        expect(sigma.total).toBe(8);
      }
    });
  });
});
