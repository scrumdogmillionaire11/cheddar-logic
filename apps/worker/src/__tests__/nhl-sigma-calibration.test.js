'use strict';

/**
 * WI-0773: Unit tests for NHL sigma calibration via computeSigmaFromHistory
 *
 * Tests that run_nhl_model.js calls computeSigmaFromHistory at job start,
 * branches correctly on sigma_source ('computed' vs 'fallback'),
 * and annotates card payloads with raw_data.sigma_source.
 *
 * Pattern: mirrors run-nhl-model.test.js loadRunNHLModel helper,
 * controlling edgeCalculator.computeSigmaFromHistory return value.
 */

function buildOddsSnapshot(overrides = {}) {
  return {
    id: 'odds-row-nhl-sigma-001',
    game_id: 'nhl-sigma-game-001',
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

const MINIMAL_PACE_RESULT = {
  homeExpected: 3.0,
  awayExpected: 2.8,
  expectedTotal: 5.8,
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
  homeGoalieCertainty: 'CONFIRMED',
  awayGoalieCertainty: 'CONFIRMED',
  homeAdjustmentTrust: 'FULL',
  awayAdjustmentTrust: 'FULL',
  official_eligible: true,
  first_period_model: { classification: 'PASS', reason_codes: [] },
};

function buildFakeDriverCard(gameId = 'nhl-sigma-game-001', descriptor = {}) {
  return {
    cardType: descriptor.cardType || 'nhl-pace-totals',
    gameId,
    sport: 'NHL',
    cardTitle: descriptor.cardTitle || 'NHL Pace Total: OVER',
    modelOutputIds: null,
    runId: null,
    // Include auditContext.paceResult so attachNhlSnapshotAuditFields does not throw
    // (in test mode, emitNhlSnapshotInvariant throws when paceResult is missing)
    auditContext: {
      paceResult: MINIMAL_PACE_RESULT,
    },
    payloadData: {
      game_id: gameId,
      sport: 'NHL',
      model_version: 'nhl-drivers-v1',
      prediction: descriptor.prediction || 'OVER',
      confidence: descriptor.confidence ?? 0.62,
      confidence_pct: Math.round((descriptor.confidence ?? 0.62) * 100),
      tier: descriptor.tier || 'B',
      market_type: descriptor.market_type || 'TOTAL',
      consistency: descriptor.consistency || {
        pace_tier: 'MID',
        event_env: 'INDOOR',
        total_bias: 'OK',
      },
      line: descriptor.line ?? 5.5,
      price: descriptor.price ?? -110,
      pipeline_state: null,
      run_id: null,
      decision_v2: {
        sharp_price_status: 'PRICED',
        official_status: 'PLAY',
      },
      raw_data: descriptor.raw_data || {},
    },
  };
}

/**
 * Build and require the NHL model with controlled computeSigmaFromHistory return value.
 *
 * @param {object} sigmaResult - Value computeSigmaFromHistory returns
 * @param {object} [opts]
 */
function loadRunNHLModel({
  sigmaResult = { margin: 2.1, total: 5.4, sigma_source: 'computed', games_sampled: 45 },
  oddsSnapshots = [buildOddsSnapshot()],
  driverCards = null,
} = {}) {
  jest.resetModules();

  delete process.env.ENABLE_WITHOUT_ODDS_MODE;
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
  const validateCardPayloadMock = jest.fn(() => ({ success: true, errors: [] }));
  const shouldRunJobKeyMock = jest.fn(() => true);
  const withDb = jest.fn(async (fn) => fn());
  const enrichOddsSnapshotWithEspnMetrics = jest.fn(async (snap) => snap);
  const updateOddsSnapshotRawData = jest.fn();
  const getDatabase = jest.fn(() => ({
    prepare: jest.fn(() => ({ all: jest.fn(() => []) })),
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

  const resolvedDriverCards = driverCards || [buildFakeDriverCard()];
  const computeNHLDriverCardsMock = jest.fn(() => resolvedDriverCards);

  jest.doMock('../models', () => ({
    computeNHLDriverCards: computeNHLDriverCardsMock,
    generateCard: jest.fn((opts) => buildFakeDriverCard(opts.gameId, opts.descriptor)),
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
      projection_inputs_complete: true,
      missing_inputs: [],
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

  const computeSigmaFromHistoryMock = jest.fn(() => sigmaResult);
  const getSigmaDefaultsMock = jest.fn(() => ({ margin: 2.4, total: 5.8 }));

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
      computeSigmaFromHistory: computeSigmaFromHistoryMock,
      computeConfidence: jest.fn((opts) => opts.baseConfidence),
      getSigmaDefaults: getSigmaDefaultsMock,
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
      payload.execution_status = payload.decision_v2?.sharp_price_status === 'UNPRICED'
        ? 'BLOCKED'
        : 'EXECUTABLE';
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
      computeSigmaFromHistoryMock,
      getSigmaDefaultsMock,
    },
  };
}

describe('NHL sigma calibration — WI-0773', () => {
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

  describe('Test A: sufficient history (sigma_source = computed)', () => {
    const sufficientSigma = {
      margin: 2.1,
      total: 5.4,
      sigma_source: 'computed',
      games_sampled: 45,
    };

    it('calls computeSigmaFromHistory with { sport: "NHL", db: expect.anything() }', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({ sigmaResult: sufficientSigma });
      await runNHLModel();
      expect(mocks.computeSigmaFromHistoryMock).toHaveBeenCalledWith(
        expect.objectContaining({ sport: 'NHL', db: expect.anything() }),
      );
    });

    it('does NOT call getSigmaDefaults for the primary sigma path when history is sufficient', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({ sigmaResult: sufficientSigma });
      await runNHLModel();
      // getSigmaDefaults should not be called on the primary (non-fallback) path
      expect(mocks.getSigmaDefaultsMock).not.toHaveBeenCalledWith('NHL');
    });

    it('logs "[NHL] sigma calibrated from 45 samples" when sigma_source is computed', async () => {
      const { runNHLModel } = loadRunNHLModel({ sigmaResult: sufficientSigma });
      await runNHLModel();
      const logCalls = consoleLogSpy.mock.calls.flat().join('\n');
      expect(logCalls).toMatch(/\[NHL\] sigma calibrated from 45 samples/);
    });

    it('card payloads include raw_data.sigma_source = "calibrated" when computed', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({ sigmaResult: sufficientSigma });
      await runNHLModel();
      const cardCalls = mocks.insertCardPayload.mock.calls;
      expect(cardCalls.length).toBeGreaterThan(0);
      for (const [card] of cardCalls) {
        expect(card.payloadData.raw_data.sigma_source).toBe('calibrated');
      }
    });
  });

  describe('Test B: insufficient history (sigma_source = fallback)', () => {
    const fallbackSigma = {
      margin: 2.4,
      total: 5.8,
      sigma_source: 'fallback',
    };

    it('calls computeSigmaFromHistory with { sport: "NHL", db: expect.anything() }', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({ sigmaResult: fallbackSigma });
      await runNHLModel();
      expect(mocks.computeSigmaFromHistoryMock).toHaveBeenCalledWith(
        expect.objectContaining({ sport: 'NHL', db: expect.anything() }),
      );
    });

    it('calls getSigmaDefaults("NHL") on the fallback path', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({ sigmaResult: fallbackSigma });
      await runNHLModel();
      expect(mocks.getSigmaDefaultsMock).toHaveBeenCalledWith('NHL');
    });

    it('logs "[NHL] insufficient history for sigma calibration — using defaults" when fallback', async () => {
      const { runNHLModel } = loadRunNHLModel({ sigmaResult: fallbackSigma });
      await runNHLModel();
      const logCalls = consoleLogSpy.mock.calls.flat().join('\n');
      expect(logCalls).toMatch(/\[NHL\] insufficient history for sigma calibration — using defaults/);
    });

    it('card payloads include raw_data.sigma_source = "default" when fallback', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({ sigmaResult: fallbackSigma });
      await runNHLModel();
      const cardCalls = mocks.insertCardPayload.mock.calls;
      expect(cardCalls.length).toBeGreaterThan(0);
      for (const [card] of cardCalls) {
        expect(card.payloadData.raw_data.sigma_source).toBe('default');
      }
    });
  });

  describe('Test C: sigma_source annotation on card payloads', () => {
    it('computed sigma → raw_data.sigma_source = "calibrated"', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({
        sigmaResult: { margin: 2.0, total: 5.3, sigma_source: 'computed', games_sampled: 30 },
      });
      await runNHLModel();
      const [card] = mocks.insertCardPayload.mock.calls[0];
      expect(card.payloadData.raw_data).toBeDefined();
      expect(card.payloadData.raw_data.sigma_source).toBe('calibrated');
    });

    it('fallback sigma → raw_data.sigma_source = "default"', async () => {
      const { runNHLModel, mocks } = loadRunNHLModel({
        sigmaResult: { margin: 2.4, total: 5.8, sigma_source: 'fallback' },
      });
      await runNHLModel();
      const [card] = mocks.insertCardPayload.mock.calls[0];
      expect(card.payloadData.raw_data).toBeDefined();
      expect(card.payloadData.raw_data.sigma_source).toBe('default');
    });
  });
});
