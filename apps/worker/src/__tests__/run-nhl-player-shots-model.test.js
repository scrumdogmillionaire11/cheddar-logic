/**
 * Thin runner-contract suite for run_nhl_player_shots_model.js.
 *
 * Covers:
 * - no-games guard
 * - single mocked run
 * - dual-run mode (full-game + 1P)
 * - cardsCreated accounting
 * - top-level error propagation
 */

function buildFutureGame(overrides = {}) {
  return {
    game_id: 'game-001',
    home_team: 'Edmonton Oilers',
    away_team: 'Toronto Maple Leafs',
    game_time_utc: '2026-03-30T23:00:00.000Z',
    sport: 'NHL',
    ...overrides,
  };
}

function buildPlayer(overrides = {}) {
  return {
    player_id: 9999,
    player_name: 'Test Player',
    team_abbrev: 'EDM',
    ...overrides,
  };
}

function buildShotLogs(count = 5, rawDataOverrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    game_id: `g${index}`,
    game_date: `2026-03-${String(index + 1).padStart(2, '0')}`,
    opponent: 'TOR',
    is_home: 1,
    shots: 3,
    toi_minutes: 20,
    raw_data:
      index === 0
        ? JSON.stringify({
            shotsPer60: 8.2,
            projToi: 18,
            ppToi: 2.0,
            ppRatePer60: 3.1,
            ppRateL10Per60: 3.0,
            ppRateL5Per60: 3.2,
            ...rawDataOverrides,
          })
        : '{}',
  }));
}

function buildMockDb({
  games = [],
  players = [],
  playerLogs = [],
  playerBlkLogs = [],
  playerPropLines = [],
  availabilityRow = null,
} = {}) {
  return {
    prepare: jest.fn((sql) => {
      const normalized = String(sql).trim().toLowerCase();

      if (normalized.includes('from games')) {
        return { all: jest.fn(() => games) };
      }
      if (
        normalized.includes('from player_shot_logs') &&
        normalized.includes('distinct')
      ) {
        return { all: jest.fn(() => players) };
      }
      if (
        normalized.includes('from player_shot_logs') &&
        normalized.includes('player_id = ?')
      ) {
        return { all: jest.fn(() => playerLogs) };
      }
      if (
        normalized.includes('from player_blk_logs') &&
        normalized.includes('distinct')
      ) {
        return { all: jest.fn(() => playerBlkLogs) };
      }
      if (
        normalized.includes('from player_blk_logs') &&
        normalized.includes('player_id = ?')
      ) {
        return { all: jest.fn(() => playerBlkLogs) };
      }
      if (normalized.includes('from player_availability')) {
        return { get: jest.fn(() => availabilityRow) };
      }
      if (normalized.includes('from player_prop_lines')) {
        return { all: jest.fn(() => playerPropLines) };
      }
      if (normalized.includes('from player_blk_rates')) {
        return { get: jest.fn(() => null) };
      }
      if (
        normalized.includes('select id') &&
        normalized.includes('from card_payloads')
      ) {
        return { all: jest.fn(() => []) };
      }
      if (normalized.includes('delete from card_results')) {
        return { run: jest.fn(() => ({ changes: 0 })) };
      }
      if (normalized.includes('delete from card_payloads')) {
        return { run: jest.fn(() => ({ changes: 0 })) };
      }
      if (
        normalized.includes('update card_payloads') &&
        normalized.includes('set expires_at')
      ) {
        return { run: jest.fn(() => ({ changes: 0 })) };
      }

      return {
        all: jest.fn(() => []),
        get: jest.fn(() => null),
        run: jest.fn(() => ({ changes: 0 })),
      };
    }),
  };
}

function loadRunNHLPlayerShotsModel({
  games = [],
  players = [],
  playerLogs = [],
  playerBlkLogs = [],
  playerPropLines = [],
  availabilityRow = null,
  insertJobRunImpl = jest.fn(),
} = {}) {
  jest.resetModules();

  delete process.env.NHL_SOG_1P_CARDS_ENABLED;
  delete process.env.NHL_BLK_CARDS_ENABLED;

  const insertJobRun = jest.fn(insertJobRunImpl);
  const markJobRunSuccess = jest.fn();
  const markJobRunFailure = jest.fn();
  const setCurrentRunId = jest.fn();
  const insertCardPayload = jest.fn();
  const recordProjectionEntry = jest.fn();
  const validateCardPayload = jest.fn();
  const withDb = jest.fn(async (fn) => fn());
  const getPlayerPropLine = jest.fn(() => null);
  const getDatabase = jest.fn(() =>
    buildMockDb({
      games,
      players,
      playerLogs,
      playerBlkLogs,
      playerPropLines,
      availabilityRow,
    }),
  );

  jest.doMock('@cheddar-logic/data', () => ({
    getDatabase,
    insertJobRun,
    markJobRunSuccess,
    markJobRunFailure,
    setCurrentRunId,
    insertCardPayload,
    recordProjectionEntry,
    validateCardPayload,
    withDb,
    getPlayerPropLine,
  }));

  const calcMu = jest.fn(() => 3.2);
  const calcMu1p = jest.fn(() => 1.0);
  const calcFairLine = jest.fn(() => 3.0);
  const calcFairLine1p = jest.fn(() => 1.0);
  const classifyEdge = jest.fn(() => ({
    tier: 'HOT',
    direction: 'OVER',
    edge: 1.0,
  }));
  const projectSogV2 = jest.fn(() => ({
    sog_mu: 3.2,
    sog_sigma: 1.79,
    toi_proj: 20,
    shot_rate_ev_per60: 9.6,
    shot_rate_pp_per60: 0,
    shot_env_factor: 1.0,
    role_stability: 'HIGH',
    trend_score: 0.05,
    fair_over_prob_by_line: {},
    fair_under_prob_by_line: {},
    fair_price_over_by_line: {},
    fair_price_under_by_line: {},
    market_line: 2.5,
    market_price_over: null,
    market_price_under: null,
    edge_over_pp: null,
    edge_under_pp: null,
    ev_over: null,
    ev_under: null,
    opportunity_score: null,
    flags: [],
  }));

  jest.doMock('../models/nhl-player-shots', () => ({
    calcMu,
    calcMu1p,
    classifyEdge,
    calcFairLine,
    calcFairLine1p,
    projectSogV2,
    projectBlkV1: jest.fn(() => ({
      blk_mu: 0,
      blk_sigma: 0,
      flags: [],
    })),
  }));

  const fetchMoneyPuckSnapshot = jest.fn(async () => ({ injuries: {} }));
  jest.doMock('../moneypuck', () => ({
    fetchMoneyPuckSnapshot,
  }));

  const applyNhlDecisionBasisMeta = jest.fn();
  const recordNhlProjectionTelemetry = jest.fn();
  jest.doMock('../utils/nhl-shots-patch', () => ({
    applyNhlDecisionBasisMeta,
    recordNhlProjectionTelemetry,
  }));

  const moduleUnderTest = require('../jobs/run_nhl_player_shots_model');

  return {
    ...moduleUnderTest,
    mocks: {
      insertJobRun,
      markJobRunSuccess,
      markJobRunFailure,
      setCurrentRunId,
      insertCardPayload,
      recordProjectionEntry,
      validateCardPayload,
      withDb,
      getPlayerPropLine,
      getDatabase,
      calcMu,
      calcMu1p,
      classifyEdge,
      calcFairLine,
      calcFairLine1p,
      projectSogV2,
      fetchMoneyPuckSnapshot,
      applyNhlDecisionBasisMeta,
      recordNhlProjectionTelemetry,
    },
  };
}

describe('runNHLPlayerShotsModel', () => {
  let consoleLogSpy;
  let consoleErrorSpy;
  let consoleWarnSpy;
  let consoleDebugSpy;

  beforeEach(() => {
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;
    delete process.env.NHL_BLK_CARDS_ENABLED;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    consoleDebugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleDebugSpy.mockRestore();
    jest.restoreAllMocks();
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;
    delete process.env.NHL_BLK_CARDS_ENABLED;
  });

  test('returns success with zero cards when no upcoming NHL games exist', async () => {
    const { runNHLPlayerShotsModel, mocks } = loadRunNHLPlayerShotsModel();

    const result = await runNHLPlayerShotsModel();

    expect(result).toEqual({
      success: true,
      gamesProcessed: 0,
      cardsCreated: 0,
    });
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
    expect(mocks.markJobRunSuccess).toHaveBeenCalledWith(
      expect.any(String),
      { gamesProcessed: 0, cardsCreated: 0 },
    );
    expect(mocks.setCurrentRunId).toHaveBeenCalledWith(
      mocks.markJobRunSuccess.mock.calls[0][0],
      'nhl_props',
    );
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('runs a single mocked game and inserts one full-game SOG card', async () => {
    const { runNHLPlayerShotsModel, mocks } = loadRunNHLPlayerShotsModel({
      games: [buildFutureGame()],
      players: [buildPlayer()],
      playerLogs: buildShotLogs(5),
    });

    const result = await runNHLPlayerShotsModel();

    expect(result).toEqual({
      success: true,
      gamesProcessed: 1,
      cardsCreated: 1,
    });
    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(1);
    expect(result.cardsCreated).toBe(mocks.insertCardPayload.mock.calls.length);

    const card = mocks.insertCardPayload.mock.calls[0][0];
    expect(card.cardType).toBe('nhl-player-shots');
    expect(card.payloadData.card_type).toBe('nhl-player-shots');
    expect(card.payloadData.run_id).toBe(
      mocks.markJobRunSuccess.mock.calls[0][0],
    );
    expect(mocks.setCurrentRunId).toHaveBeenCalledWith(
      mocks.markJobRunSuccess.mock.calls[0][0],
      'nhl_props',
    );
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('dual-run mode writes one full-game SOG card and one 1P SOG card', async () => {
    const { runNHLPlayerShotsModel, mocks } = loadRunNHLPlayerShotsModel({
      games: [buildFutureGame({ game_id: 'game-dual-001' })],
      players: [buildPlayer({ player_id: 1111, player_name: 'Dual Run Player' })],
      playerLogs: buildShotLogs(5),
    });
    process.env.NHL_SOG_1P_CARDS_ENABLED = 'true';

    const result = await runNHLPlayerShotsModel();

    expect(result).toEqual({
      success: true,
      gamesProcessed: 1,
      cardsCreated: 2,
    });
    expect(mocks.insertCardPayload).toHaveBeenCalledTimes(2);
    expect(result.cardsCreated).toBe(mocks.insertCardPayload.mock.calls.length);

    const cardTypes = mocks.insertCardPayload.mock.calls.map(
      ([card]) => card.payloadData.card_type,
    );
    expect(cardTypes).toEqual(
      expect.arrayContaining(['nhl-player-shots', 'nhl-player-shots-1p']),
    );
    expect(mocks.setCurrentRunId).toHaveBeenCalledWith(
      mocks.markJobRunSuccess.mock.calls[0][0],
      'nhl_props',
    );
    expect(mocks.markJobRunFailure).not.toHaveBeenCalled();
  });

  test('propagates early top-level failures and marks the job as failed', async () => {
    const { runNHLPlayerShotsModel, mocks } = loadRunNHLPlayerShotsModel({
      insertJobRunImpl: () => {
        throw new Error('job run insert failed');
      },
    });

    const result = await runNHLPlayerShotsModel();

    expect(result).toEqual({
      success: false,
      error: 'job run insert failed',
    });
    expect(mocks.markJobRunFailure).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: 'job run insert failed' }),
    );
    expect(mocks.markJobRunSuccess).not.toHaveBeenCalled();
    expect(mocks.insertCardPayload).not.toHaveBeenCalled();
  });
});
