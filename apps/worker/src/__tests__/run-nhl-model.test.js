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

function loadRunNHLModel({
  oddsSnapshots = [buildOddsSnapshot()],
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
  const runPerGameWriteTransaction = jest.fn((fn) => fn());
  const validateCardPayloadMock = jest.fn(() => validationResult);
  const shouldRunJobKeyMock = jest.fn(() => shouldRunJobKey);
  const withDb = jest.fn(async (fn) => fn());
  const enrichOddsSnapshotWithEspnMetrics = jest.fn(enrichImpl);
  const updateOddsSnapshotRawData = jest.fn();
  const getDatabase = jest.fn(() => ({
    prepare: jest.fn(() => ({ all: jest.fn(() => []), get: jest.fn(() => ({ cnt: 0 })) })),
  }));
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
  }));

  jest.doMock('../moneypuck', () => ({
    enrichOddsSnapshotWithMoneyPuck: jest.fn(async (snap) => snap),
    fetchMoneyPuckSnapshot: jest.fn(async () => null),
  }));

  jest.doMock('../models', () => ({
    computeNHLDriverCards: jest.fn(() => []),
    generateCard: jest.fn(),
    computeNHLMarketDecisions: jest.fn(() => ({})),
    selectExpressionChoice: jest.fn(() => null),
    buildMarketPayload: jest.fn(() => ({})),
    determineTier: jest.fn(() => 'BEST'),
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
      getSigmaDefaults: jest.fn(() => ({ total: 8, spread: 3.0 })),
    },
    generateCard: jest.fn(),
    buildMarketCallCard: jest.fn(),
  }));

  jest.doMock('../utils/decision-publisher', () => ({
    publishDecisionForCard: jest.fn(() => ({
      gated: false,
      allow: true,
      reasonCode: null,
    })),
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
    expect(mocks.getOddsWithUpcomingGames).toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(result.jobRunId);
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
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

  test('recognizes playoff game when raw_data.season.type is 3', async () => {
    const playoffSnapshot = buildOddsSnapshot({
      game_id: 'nhl-playoff-001',
      raw_data: { season: { type: 3 } },
    });

    const { runNHLModel } = loadRunNHLModel({
      oddsSnapshots: [playoffSnapshot],
    });

    await runNHLModel();

    // Should log [PLAYOFF_MODE]
    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0]);
    expect(logCalls.some((msg) => /\[PLAYOFF_MODE\]/.test(String(msg)))).toBe(true);
  });

  test('does not log PLAYOFF_MODE for regular-season game', async () => {
    const regularSnapshot = buildOddsSnapshot({
      game_id: 'nhl-regular-001',
      raw_data: { season: { type: 2 } },
    });

    const { runNHLModel } = loadRunNHLModel({
      oddsSnapshots: [regularSnapshot],
    });

    await runNHLModel();

    // Should NOT log [PLAYOFF_MODE]
    const logCalls = consoleLogSpy.mock.calls.map((args) => args[0]);
    expect(logCalls.some((msg) => /\[PLAYOFF_MODE\]/.test(String(msg)))).toBe(false);
  });
});
