/**
 * Test suite for run_nba_model.js
 *
 * Mirrors the structure of run_nfl_model.test.js and run-mlb-model.dual-run.test.js.
 * Covers: no-games guard, single-run with mocked DB, withoutOddsMode dual-run,
 * cards-generated count assertion, error propagation, dryRun, jobKey skip.
 */

function buildOddsSnapshot(overrides = {}) {
  return {
    id: 'odds-row-001',
    game_id: 'nba-game-001',
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
    total: 218.5,
    total_price_over: -110,
    total_price_under: -110,
    raw_data: { nba: {} },
    ...overrides,
  };
}

function buildFakeDriverCard(gameId = 'nba-game-001') {
  return {
    cardType: 'nba-base-projection',
    gameId,
    sport: 'NBA',
    cardTitle: 'NBA Base Projection: HOME',
    modelOutputIds: null,
    runId: null,
    payloadData: {
      game_id: gameId,
      sport: 'NBA',
      model_version: 'nba-drivers-v1',
      prediction: 'HOME',
      confidence: 0.62,
      confidence_pct: 62,
      tier: 'B',
      pipeline_state: null,
      run_id: null,
      decision_v2: { sharp_price_status: 'PRICED', official_status: 'FIRE' },
    },
  };
}

function loadRunNBAModel({
  oddsSnapshots = [buildOddsSnapshot()],
  driverCards = [buildFakeDriverCard()],
  syntheticSnapshots = [],
  shouldRunJobKey = true,
  validationResult = { success: true, errors: [] },
  withoutOddsMode = false,
  projectionComplete = true,
  enrichImpl = async (snap) => snap,
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
  const computeLineDelta = jest.fn(() => null);
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
    computeLineDelta,
  }));

  const computeNBADriverCardsMock = jest.fn(() => driverCards);
  const generateCardMock = jest.fn((opts) => buildFakeDriverCard(opts.gameId));

  jest.doMock('../models', () => ({
    computeNBADriverCards: computeNBADriverCardsMock,
    generateCard: generateCardMock,
    computeNBAMarketDecisions: jest.fn(() => ({})),
    selectExpressionChoice: jest.fn(() => null),
    computeTotalBias: jest.fn(() => 'OK'),
    buildMarketPayload: jest.fn(() => ({})),
    determineTier: jest.fn(() => 'B'),
    buildMarketCallCard: jest.fn(() => null),
    getModel: jest.fn(),
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
  }));

  jest.doMock('../utils/decision-publisher', () => ({
    publishDecisionForCard: publishDecisionForCardMock,
    applyUiActionFields: jest.fn(),
    finalizeDecisionFields: jest.fn((p) => p),
    capturePublishedDecisionState: jest.fn(() => null),
    assertNoDecisionMutation: jest.fn(() => []),
  }));

  const moduleUnderTest = require('../jobs/run_nba_model');

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
      computeNBADriverCardsMock,
      generateCardMock,
      publishDecisionForCardMock,
    },
  };
}

describe('runNBAModel', () => {
  let consoleLogSpy;
  let consoleErrorSpy;

  beforeEach(() => {
    delete process.env.ENABLE_WITHOUT_ODDS_MODE;
    delete process.env.ENABLE_WELCOME_HOME;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
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
    const { runNBAModel, mocks } = loadRunNBAModel({ oddsSnapshots: [] });

    const result = await runNBAModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
    });
    expect(mocks.computeNBADriverCardsMock).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('runs inference on a single game and writes driver cards to DB', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel();

    const result = await runNBAModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 1,
      cardsFailed: 0,
      errors: [],
    });
    expect(mocks.computeNBADriverCardsMock).toHaveBeenCalledTimes(1);
    expect(mocks.generateCardMock).toHaveBeenCalledTimes(1);
    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(1);

    const insertedCard = mocks.insertCardPayload.mock.calls[0][0];
    expect(insertedCard.cardType).toBe('nba-base-projection');
    expect(insertedCard.payloadData.run_id).toBe(result.jobRunId);

    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      result.jobRunId,
      expect.objectContaining({ cardsGenerated: 1 }),
    );
    expect(mocks.setCurrentRunId).toHaveBeenCalledWith(result.jobRunId, 'nba');
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('dedupes snapshots by latest captured_at and runs inference once per game', async () => {
    const olderSnapshot = buildOddsSnapshot({
      id: 'odds-old',
      game_id: 'game-dedup',
      captured_at: '2026-04-09T10:00:00.000Z',
      h2h_home: -120,
    });
    const newerSnapshot = buildOddsSnapshot({
      id: 'odds-new',
      game_id: 'game-dedup',
      captured_at: '2026-04-09T18:00:00.000Z',
      h2h_home: -150,
    });

    const { runNBAModel, mocks } = loadRunNBAModel({
      oddsSnapshots: [olderSnapshot, newerSnapshot],
    });

    const result = await runNBAModel();

    expect(result).toMatchObject({ success: true, cardsGenerated: 1 });
    // Deduped: two snapshots → one game → one call to driver inference
    expect(mocks.computeNBADriverCardsMock).toHaveBeenCalledTimes(1);
    const [gameIdArg, snapshotArg] =
      mocks.computeNBADriverCardsMock.mock.calls[0];
    expect(gameIdArg).toBe('game-dedup');
    // Enriched snapshot carries the newer row's id
    expect(snapshotArg.id).toBe('odds-new');
  });

  test('honors dryRun without recording a job or writing cards', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel();

    const result = await runNBAModel({ dryRun: true });

    expect(result).toEqual({
      success: true,
      jobRunId: null,
      dryRun: true,
      jobKey: null,
    });
    expect(mocks.insertJobRun).not.toHaveBeenCalled();
    expect(mocks.getOddsWithUpcomingGames).not.toHaveBeenCalled();
    expect(mocks.computeNBADriverCardsMock).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).not.toHaveBeenCalled();
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('skips execution when jobKey is already claimed', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel({ shouldRunJobKey: false });

    const result = await runNBAModel({ jobKey: 'nba:2026-04-10T00' });

    expect(result).toEqual({
      success: true,
      jobRunId: null,
      skipped: true,
      jobKey: 'nba:2026-04-10T00',
    });
    expect(mocks.shouldRunJobKeyMock).toHaveBeenCalledWith('nba:2026-04-10T00');
    expect(mocks.insertJobRun).not.toHaveBeenCalled();
    expect(mocks.getOddsWithUpcomingGames).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
  });

  test('skips game and writes no cards when driver produces no signals', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel({ driverCards: [] });

    const result = await runNBAModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
      cardsFailed: 0,
    });
    expect(mocks.generateCardMock).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      result.jobRunId,
      expect.any(Object),
    );
  });

  test('skips game when projection inputs are incomplete', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel({
      projectionComplete: false,
    });

    const result = await runNBAModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
    });
    // Projection gate fires before driver inference
    expect(mocks.computeNBADriverCardsMock).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      result.jobRunId,
      expect.any(Object),
    );
  });

  test('fails the job when card payload validation returns errors', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel({
      validationResult: {
        success: false,
        errors: ['payloadData.confidence must be a number'],
      },
    });

    const result = await runNBAModel();

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid card payload');
    expect(result.error).toContain('payloadData.confidence must be a number');
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunFailure).toHaveBeenCalledWith(
      result.jobRunId,
      expect.stringContaining('Invalid card payload'),
    );
    expect(mocks.markJobRunSuccess).not.toHaveBeenCalled();
    expect(mocks.setCurrentRunId).not.toHaveBeenCalled();
  });

  test('accumulates per-game errors without failing the whole job', async () => {
    const failingSnapshot = buildOddsSnapshot({
      id: 'odds-fail',
      game_id: 'game-fail',
      captured_at: '2026-04-09T10:00:00.000Z',
    });
    const passingSnapshot = buildOddsSnapshot({
      id: 'odds-pass',
      game_id: 'game-pass',
      captured_at: '2026-04-09T18:00:00.000Z',
    });

    const { runNBAModel, mocks } = loadRunNBAModel({
      oddsSnapshots: [failingSnapshot, passingSnapshot],
      enrichImpl: async (snap) => {
        if (snap.game_id === 'game-fail')
          throw new Error('ESPN enrichment timeout');
        return snap;
      },
    });

    const result = await runNBAModel();

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 1,
      cardsFailed: 1,
    });
    expect(result.errors).toEqual(
      expect.arrayContaining(['game-fail: ESPN enrichment timeout']),
    );
    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(1);
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      result.jobRunId,
      expect.any(Object),
    );
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('withoutOddsMode: uses synthetic snapshots when no regular odds available', async () => {
    const syntheticSnap = buildOddsSnapshot({
      id: 'synth-001',
      game_id: 'nba-synth-game',
    });

    const { runNBAModel, mocks } = loadRunNBAModel({
      oddsSnapshots: [],
      syntheticSnapshots: [syntheticSnap],
      withoutOddsMode: true,
    });

    const result = await runNBAModel({ withoutOddsMode: true });

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 1,
    });
    expect(mocks.getUpcomingGamesAsSyntheticSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(1);
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      result.jobRunId,
      expect.any(Object),
    );
  });

  test('withoutOddsMode: exits cleanly when no synthetic snapshots found either', async () => {
    const { runNBAModel, mocks } = loadRunNBAModel({
      oddsSnapshots: [],
      syntheticSnapshots: [],
      withoutOddsMode: true,
    });

    const result = await runNBAModel({ withoutOddsMode: true });

    expect(result).toMatchObject({
      success: true,
      cardsGenerated: 0,
    });
    expect(mocks.getUpcomingGamesAsSyntheticSnapshots).toHaveBeenCalledTimes(1);
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
  });
});

// WI-0646: Playoff mode detection tests
describe('playoff mode detection', () => {
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
      game_id: 'nba-playoff-001',
      raw_data: { season: { type: 3 } },
    });

    const { runNBAModel, mocks } = loadRunNBAModel({
      oddsSnapshots: [playoffSnapshot],
    });

    await runNBAModel();

    // Should log [PLAYOFF_MODE]
    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0]);
    expect(logCalls.some((msg) => /\[PLAYOFF_MODE\]/.test(String(msg)))).toBe(true);

    // publishDecisionForCard should be called with inflated sigma (spread * 1.2, total * 1.2)
    // computeSigmaFromHistory mock returns { total: 12, spread: 4.5 }
    // After PLAYOFF_SIGMA_MULTIPLIER=1.2: spread=5.4, total=14.4
    expect(mocks.publishDecisionForCardMock).toHaveBeenCalled();
    const calls = mocks.publishDecisionForCardMock.mock.calls;
    const sigmaArgs = calls.map((c) => c[0].options?.sigmaOverride).filter(Boolean);
    expect(sigmaArgs.length).toBeGreaterThan(0);
    sigmaArgs.forEach((sigma) => {
      // Playoff sigma should be larger than baseline values (4.5 and 12)
      if (Number.isFinite(sigma.spread)) {
        expect(sigma.spread).toBeGreaterThan(4.5);
      }
      if (Number.isFinite(sigma.total)) {
        expect(sigma.total).toBeGreaterThan(12);
      }
    });
  });

  test('does not apply PLAYOFF_MODE for regular-season game', async () => {
    const regularSnapshot = buildOddsSnapshot({
      game_id: 'nba-regular-001',
      raw_data: { season: { type: 2 } },
    });

    const { runNBAModel, mocks } = loadRunNBAModel({
      oddsSnapshots: [regularSnapshot],
    });

    await runNBAModel();

    // Should NOT log [PLAYOFF_MODE]
    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0]);
    expect(logCalls.some((msg) => /\[PLAYOFF_MODE\]/.test(String(msg)))).toBe(false);

    // publishDecisionForCard should be called with unmodified sigma (spread=4.5, total=12)
    expect(mocks.publishDecisionForCardMock).toHaveBeenCalled();
    const calls = mocks.publishDecisionForCardMock.mock.calls;
    const sigmaArgs = calls.map((c) => c[0].options?.sigmaOverride).filter(Boolean);
    expect(sigmaArgs.length).toBeGreaterThan(0);
    sigmaArgs.forEach((sigma) => {
      // Regular-season sigma should match baseline values exactly
      if (Number.isFinite(sigma.spread)) {
        expect(sigma.spread).toBe(4.5);
      }
      if (Number.isFinite(sigma.total)) {
        expect(sigma.total).toBe(12);
      }
    });
  });
});
