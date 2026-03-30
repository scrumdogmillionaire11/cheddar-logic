const { validateCardPayload } = require('@cheddar-logic/data');
const {
  computeMLBDriverCards,
  selectMlbGameMarket,
} = require('../models/mlb-model');
const {
  buildMlbMarketAvailability,
  buildMlbF5OddsContext,
  MLB_PIPELINE_REASON_CODES,
  MIN_MLB_GAMES_FOR_RECAL,
} = require('../jobs/run_mlb_model');

function buildF5Snapshot(overrides = {}) {
  return {
    game_id: 'mlb-game-001',
    id: 'odds-row-001',
    home_team: 'Yankees',
    away_team: 'Red Sox',
    game_time_utc: '2026-03-28T23:05:00.000Z',
    captured_at: '2026-03-27T18:00:00.000Z',
    total: 8.5,
    total_price_over: -110,
    total_price_under: -110,
    total_f5: 4.5,
    total_price_over_f5: -112,
    total_price_under_f5: -108,
    raw_data: {
      mlb: {
        f5_line: 4.5,
        strikeout_lines: {
          home: 6.5,
          away: 6.5,
        },
        home_pitcher: {
          era: 3.1,
          whip: 1.08,
          k_per_9: 9.8,
          recent_k_per_9: 10.1,
          recent_ip: 6.2,
        },
        away_pitcher: {
          era: 3.4,
          whip: 1.11,
          k_per_9: 9.2,
          recent_k_per_9: 8.9,
          recent_ip: 6.0,
        },
      },
    },
    ...overrides,
  };
}

function buildPitcherStatsRow(team) {
  return {
    team,
    updated_at: '2026-03-27T12:00:00.000Z',
    era: 3.2,
    whip: 1.09,
    recent_ip: 6.0,
    k_per_9: 9.7,
    recent_k_per_9: 9.9,
    season_starts: 5,
    handedness: 'R',
    days_since_last_start: 5,
    season_k_pct: 0.28,
    k_pct_last_4_starts: 0.29,
    k_pct_prior_4_starts: 0.27,
    role: 'starter',
  };
}

function buildSigmaGameRows(count) {
  return Array.from({ length: count }, (_, i) => ({
    final_score_home: 4 + (i % 3),
    final_score_away: 3 + (i % 4),
  }));
}

function loadRunMlbModel({
  mode,
  gameDriverCards,
  pitcherKDriverCards,
  selection,
  snapshotOverrides = {},
  sigmaGameRows = null,
}) {
  jest.resetModules();

  if (mode) process.env.PITCHER_KS_MODEL_MODE = mode;
  else delete process.env.PITCHER_KS_MODEL_MODE;

  const insertCardPayload = jest.fn();
  const insertModelOutput = jest.fn();
  const prepareModelAndCardWrite = jest.fn();
  const validateCardPayloadMock = jest.fn(() => ({ success: true, errors: [] }));
  const computeMLBDriverCardsMock = jest.fn(() => gameDriverCards);
  const computePitcherKDriverCardsMock = jest.fn(() => pitcherKDriverCards);
  const selectMlbGameMarketMock = jest.fn(() => selection);
  const getDatabase = jest.fn(() => ({
    prepare: jest.fn((sql) => ({
      get: (...args) => {
        if (sql.includes('mlb_pitcher_stats')) {
          return args[0] === 'Yankees'
            ? buildPitcherStatsRow('Yankees')
            : buildPitcherStatsRow('Red Sox');
        }
        return null;
      },
      all: jest.fn(() => {
        if (sql.includes('game_results')) {
          return sigmaGameRows ?? [];
        }
        return [];
      }),
      run: jest.fn(),
    })),
  }));

  jest.doMock('@cheddar-logic/data', () => ({
    getDatabase,
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    setCurrentRunId: jest.fn(),
    getOddsSnapshots: jest.fn(),
    getOddsWithUpcomingGames: jest.fn(() => [buildF5Snapshot(snapshotOverrides)]),
    getLatestOdds: jest.fn(),
    insertModelOutput,
    insertCardPayload,
    prepareModelAndCardWrite,
    validateCardPayload: validateCardPayloadMock,
    shouldRunJobKey: jest.fn(() => true),
    withDb: jest.fn(async (fn) => fn()),
    getPlayerPropLinesForGame: jest.fn(() => []),
  }));

  jest.doMock('../models', () => ({
    getModel: jest.fn(() => ({})),
    computeMLBDriverCards: computeMLBDriverCardsMock,
    computePitcherKDriverCards: computePitcherKDriverCardsMock,
  }));

  jest.doMock('../models/mlb-model', () => ({
    selectMlbGameMarket: selectMlbGameMarketMock,
  }));

  const moduleUnderTest = require('../jobs/run_mlb_model');
  return {
    ...moduleUnderTest,
    mocks: {
      insertCardPayload,
      insertModelOutput,
      prepareModelAndCardWrite,
      validateCardPayloadMock,
      computeMLBDriverCardsMock,
      computePitcherKDriverCardsMock,
      selectMlbGameMarketMock,
    },
  };
}

describe('mlb dual-run helpers', () => {
  afterEach(() => {
    delete process.env.PITCHER_KS_MODEL_MODE;
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('computeMLBDriverCards only returns F5 game candidates and selector chooses F5', () => {
    const snapshot = buildF5Snapshot();

    const cards = computeMLBDriverCards(snapshot.game_id, snapshot);

    expect(cards).toHaveLength(1);
    expect(cards[0].market).toBe('f5_total');

    const selection = selectMlbGameMarket(snapshot.game_id, snapshot, cards);
    expect(selection.chosen_market).toBe('F5_TOTAL');
    expect(selection.why_this_market).toBe(
      'Rule 1: only configured MLB game market',
    );
    expect(selection.markets).toHaveLength(1);
    expect(selection.markets[0]).toMatchObject({
      market: 'F5_TOTAL',
    });
  });

  test('selector emits NO_F5_LINE rejection when no F5 game candidate exists', () => {
    const snapshot = buildF5Snapshot({
      raw_data: {
        mlb: {
          home_pitcher: buildF5Snapshot().raw_data.mlb.home_pitcher,
          away_pitcher: buildF5Snapshot().raw_data.mlb.away_pitcher,
        },
      },
    });

    const selection = selectMlbGameMarket(snapshot.game_id, snapshot, []);

    expect(selection.chosen_market).toBe('F5_TOTAL');
    expect(selection.rejected).toEqual({ F5_TOTAL: 'NO_F5_LINE' });
    expect(selection.markets).toEqual([]);
  });

  test('mlb-f5 payload contract validates with recommended_bet_type and odds_context', () => {
    const snapshot = buildF5Snapshot();
    const payload = {
      game_id: snapshot.game_id,
      sport: 'MLB',
      model_version: 'mlb-model-v1',
      home_team: snapshot.home_team,
      away_team: snapshot.away_team,
      matchup: `${snapshot.away_team} @ ${snapshot.home_team}`,
      start_time_utc: snapshot.game_time_utc,
      market_type: 'FIRST_PERIOD',
      prediction: 'OVER',
      selection: { side: 'OVER' },
      line: 4.5,
      confidence: 0.8,
      tier: 'BEST',
      ev_passed: true,
      reasoning: 'F5 projected 5.1 vs line 4.5',
      disclaimer: 'Analysis provided for educational purposes. Not a recommendation.',
      generated_at: '2026-03-27T18:00:00.000Z',
      projection: { projected_total: 5.1 },
      recommended_bet_type: 'total',
      odds_context: buildMlbF5OddsContext(snapshot),
      primary_game_market: true,
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
    };

    expect(validateCardPayload('mlb-f5', payload)).toEqual({
      success: true,
      errors: [],
    });
  });

  test('market availability resolves from current snapshot fields without F5 ML expectation', () => {
    const availability = buildMlbMarketAvailability(buildF5Snapshot());

    expect(availability).toMatchObject({
      f5_line_ok: true,
      f5_ml_ok: false,
      full_game_total_ok: true,
      expect_f5_total: true,
      expect_f5_ml: false,
    });
    expect(availability.blocking_reason_codes).toEqual([]);
  });

  test('market availability falls back to raw_data when F5 values are not promoted to top-level fields', () => {
    const availability = buildMlbMarketAvailability(
      buildF5Snapshot({
        total_f5: null,
        total_price_over_f5: null,
        total_price_under_f5: null,
        raw_data: {
          totals: [{ line: 8.5, over: -110, under: -110 }],
          totals_f5: [{ line: 4.5, over: -112, under: -108 }],
          mlb: {
            home_pitcher: buildF5Snapshot().raw_data.mlb.home_pitcher,
            away_pitcher: buildF5Snapshot().raw_data.mlb.away_pitcher,
          },
        },
      }),
    );

    expect(availability.f5_line_ok).toBe(true);
    expect(availability.full_game_total_ok).toBe(true);
    expect(availability.blocking_reason_codes).toEqual([]);
  });

  test('market availability emits F5_ML_UNAVAILABLE only when F5 ML expectation is active', () => {
    const availability = buildMlbMarketAvailability(buildF5Snapshot(), {
      expectF5Ml: true,
    });

    expect(availability.expect_f5_ml).toBe(true);
    expect(availability.f5_ml_ok).toBe(false);
    expect(availability.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE,
    );
    expect(availability.blocking_reason_codes).not.toContain(
      MLB_PIPELINE_REASON_CODES.F5_TOTAL_UNAVAILABLE,
    );
  });
});

describe('runMLBModel dual-run orchestration', () => {
  const gameDriver = {
    market: 'f5_total',
    prediction: 'OVER',
    confidence: 0.9,
    ev_threshold_passed: true,
    reasoning: 'F5 edge',
    drivers: [{ type: 'mlb-f5', edge: 0.8, projected: 5.3 }],
  };

  const pitcherKHome = {
    market: 'pitcher_k_home',
    prediction: 'OVER',
    confidence: 0.84,
    ev_threshold_passed: true,
    emit_card: true,
    reasoning: 'Home SP edge',
    drivers: [{ type: 'pitcher-k', projection: 7.1 }],
    basis: 'PROJECTION_ONLY',
  };

  const pitcherKAway = {
    market: 'pitcher_k_away',
    prediction: 'OVER',
    confidence: 0.81,
    ev_threshold_passed: true,
    emit_card: true,
    reasoning: 'Away SP edge',
    drivers: [{ type: 'pitcher-k', projection: 6.8 }],
    basis: 'PROJECTION_ONLY',
  };

  afterEach(() => {
    delete process.env.PITCHER_KS_MODEL_MODE;
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('writes one mlb-f5 and additive mlb-pitcher-k cards, never mlb-strikeout, and logs dual-run', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [
        {
          market: 'F5_TOTAL',
          status: 'FIRE',
          prediction: 'OVER',
          score: 0.9,
          edge: 0.8,
          projected: 5.3,
        },
      ],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [pitcherKHome, pitcherKAway],
      selection,
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    expect(mocks.computePitcherKDriverCardsMock).toHaveBeenCalledWith(
      'mlb-game-001',
      expect.any(Object),
      { mode: 'PROJECTION_ONLY' },
    );
    expect(
      mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType),
    ).toEqual(['mlb-f5', 'mlb-pitcher-k', 'mlb-pitcher-k']);
    expect(
      mocks.insertCardPayload.mock.calls.some(
        ([card]) => card.cardType === 'mlb-strikeout',
      ),
    ).toBe(false);
    expect(mocks.prepareModelAndCardWrite).toHaveBeenCalledWith(
      'mlb-game-001',
      'mlb-model-v1',
      'mlb-strikeout',
      expect.any(Object),
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('[MLB_DUAL_RUN]'),
    );

    const f5Payload = mocks.insertCardPayload.mock.calls[0][0].payloadData;
    expect(f5Payload.primary_game_market).toBe(true);
    expect(f5Payload.chosen_market).toBe('F5_TOTAL');
    expect(f5Payload.recommended_bet_type).toBe('total');
    expect(f5Payload.odds_context).toBeDefined();
    expect(f5Payload.pipeline_state).toMatchObject({
      f5_line_ok: true,
      f5_ml_ok: false,
      full_game_total_ok: true,
    });
    expect(f5Payload.pipeline_state.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE,
    );
  });

  test('missing F5 line logs NO_F5_LINE, emits F5_TOTAL_UNAVAILABLE, and still writes mlb-pitcher-k in ODDS_BACKED mode', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [],
      rejected: { F5_TOTAL: 'NO_F5_LINE' },
      selected_driver: null,
    };
    const oddsBackedProp = {
      ...pitcherKHome,
      basis: 'ODDS_BACKED',
      line_source: 'DraftKings',
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'ODDS_BACKED',
      gameDriverCards: [],
      pitcherKDriverCards: [oddsBackedProp],
      selection,
      snapshotOverrides: {
        total_f5: null,
        total_price_over_f5: null,
        total_price_under_f5: null,
        raw_data: {
          mlb: {
            strikeout_lines: {
              home: 6.5,
              away: 6.5,
            },
            home_pitcher: buildF5Snapshot().raw_data.mlb.home_pitcher,
            away_pitcher: buildF5Snapshot().raw_data.mlb.away_pitcher,
          },
        },
      },
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    expect(mocks.computePitcherKDriverCardsMock).toHaveBeenCalledWith(
      'mlb-game-001',
      expect.any(Object),
      { mode: 'ODDS_BACKED' },
    );
    expect(
      mocks.insertCardPayload.mock.calls.map(([card]) => card.cardType),
    ).toEqual(['mlb-pitcher-k']);
    const payload = mocks.insertCardPayload.mock.calls[0][0].payloadData;
    expect(payload.pipeline_state.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_TOTAL_UNAVAILABLE,
    );
    expect(payload.pipeline_state.blocking_reason_codes).not.toContain(
      'WATCHDOG_MARKET_UNAVAILABLE',
    );
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"NO_F5_LINE"'),
    );
  });

  test('active F5 ML expectation emits F5_ML_UNAVAILABLE in pipeline state', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [
        {
          market: 'F5_TOTAL',
          status: 'FIRE',
          prediction: 'OVER',
          score: 0.9,
          edge: 0.8,
          projected: 5.3,
        },
      ],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel, mocks } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [pitcherKHome],
      selection,
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel({ expectF5Ml: true });

    expect(result.success).toBe(true);
    const payload = mocks.insertCardPayload.mock.calls[0][0].payloadData;
    expect(payload.pipeline_state.blocking_reason_codes).toContain(
      MLB_PIPELINE_REASON_CODES.F5_ML_UNAVAILABLE,
    );
  });

  // ── WI-0648: MLB empirical sigma recalibration gate ───────────────────────

  test('sigma gate: emits MLB_SIGMA_PRESEASON_DEFAULT when game_results < threshold', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [{ market: 'F5_TOTAL', status: 'FIRE', prediction: 'OVER', score: 0.9, edge: 0.8, projected: 5.3 }],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [],
      selection,
      sigmaGameRows: buildSigmaGameRows(MIN_MLB_GAMES_FOR_RECAL - 1), // 19 rows — below threshold
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    const sigmaLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_PRESEASON_DEFAULT]'),
    );
    expect(sigmaLog).toBeDefined();
    expect(sigmaLog[0]).toContain(`threshold=${MIN_MLB_GAMES_FOR_RECAL}`);
    // Empirical log must NOT appear
    const empiricalLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_EMPIRICAL]'),
    );
    expect(empiricalLog).toBeUndefined();
  });

  test('sigma gate: emits MLB_SIGMA_EMPIRICAL when game_results >= threshold', async () => {
    const selection = {
      chosen_market: 'F5_TOTAL',
      why_this_market: 'Rule 1: only configured MLB game market',
      markets: [{ market: 'F5_TOTAL', status: 'FIRE', prediction: 'OVER', score: 0.9, edge: 0.8, projected: 5.3 }],
      rejected: {},
      selected_driver: gameDriver,
    };

    const { runMLBModel } = loadRunMlbModel({
      mode: 'PROJECTION_ONLY',
      gameDriverCards: [gameDriver],
      pitcherKDriverCards: [],
      selection,
      sigmaGameRows: buildSigmaGameRows(MIN_MLB_GAMES_FOR_RECAL), // exactly 20 rows — at threshold
    });
    const consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await runMLBModel();

    expect(result.success).toBe(true);
    const empiricalLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_EMPIRICAL]'),
    );
    expect(empiricalLog).toBeDefined();
    expect(empiricalLog[0]).toContain('games_sampled=20');
    // Preseason default log must NOT appear
    const preseasonLog = consoleLog.mock.calls.find((args) =>
      args[0]?.includes('[MLB_SIGMA_PRESEASON_DEFAULT]'),
    );
    expect(preseasonLog).toBeUndefined();
  });
});
