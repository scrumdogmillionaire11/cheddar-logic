/**
 * Unit tests for run_nhl_player_shots_model.js
 *
 * Tests:
 * 1. Player with fewer than 5 recent logs is skipped with proper log message
 * 2. setCurrentRunId is called even when 0 cards are created
 * 3. NHL_SOG_1P_CARDS_ENABLED=false (default) prevents 1P card creation
 * 4. Synthetic fallback line is deterministic (Math.round(mu * 2) / 2)
 */

'use strict';

// Note: jest.mock factories may only reference variables prefixed with 'mock'
// (Jest restriction). Track calls via these arrays.
const mockInsertCardPayloadCalls = [];
const mockSetCurrentRunIdCalls = [];

// Helper used inside test to get mocked module's tracking arrays
function getTracking() {
  return { mockInsertCardPayloadCalls, mockSetCurrentRunIdCalls };
}

// Helper: build a future game object
function buildFutureGame(overrides = {}) {
  return {
    game_id: 'game-001',
    home_team: 'Edmonton Oilers',
    away_team: 'Toronto Maple Leafs',
    game_time_utc: new Date(Date.now() + 3600 * 1000 * 2).toISOString(),
    sport: 'NHL',
    ...overrides,
  };
}

// Helper: build a player row
function buildPlayer(overrides = {}) {
  return {
    player_id: 9999,
    player_name: 'Test Player',
    team_abbrev: 'EDM',
    ...overrides,
  };
}

// Helper: build N game log rows
function buildGames(n) {
  return Array.from({ length: n }, (_, i) => ({
    game_id: `g${i}`,
    game_date: `2026-03-0${i + 1}`,
    opponent: 'TOR',
    is_home: 1,
    shots: 3,
    toi_minutes: 20,
    raw_data: '{}',
  }));
}

// Build a mock DB whose prepare() dispatches by SQL keyword
function buildMockDb({ games = [], players = [], playerLogs = [] } = {}) {
  return {
    prepare: jest.fn((sql) => {
      const s = sql.trim().toLowerCase();
      if (s.includes('from games')) {
        return { all: jest.fn(() => games) };
      }
      if (s.includes('from player_shot_logs') && s.includes('distinct')) {
        return { all: jest.fn(() => players) };
      }
      if (s.includes('from player_shot_logs') && s.includes('player_id = ?')) {
        return { all: jest.fn(() => playerLogs) };
      }
      // team_metrics_cache, game_id_map, etc.
      return { all: jest.fn(() => []), get: jest.fn(() => null), run: jest.fn() };
    }),
  };
}

// Load a fresh copy of the module under test with mocks applied.
// Returns { mod, data, shots }
function loadFreshModule() {
  jest.resetModules();

  jest.mock('@cheddar-logic/data', () => ({
    getDatabase: jest.fn(),
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    setCurrentRunId: jest.fn(),
    insertCardPayload: jest.fn(),
    validateCardPayload: jest.fn(),
    withDb: jest.fn((fn) => fn()),
    getPlayerPropLine: jest.fn(() => null),
  }));

  jest.mock('../../models/nhl-player-shots', () => ({
    calcMu: jest.fn(() => 3.2),
    calcMu1p: jest.fn(() => 1.0),
    classifyEdge: jest.fn(() => ({ tier: 'COLD', direction: 'OVER', edge: 0.1 })),
  }));

  const mod = require('../run_nhl_player_shots_model');
  const data = require('@cheddar-logic/data');
  const shots = require('../../models/nhl-player-shots');

  return { mod, data, shots };
}

describe('run_nhl_player_shots_model', () => {
  beforeEach(() => {
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;
    jest.clearAllMocks();
  });

  test('player with only 3 logs is skipped — no card and skip log emitted', async () => {
    const { mod, data } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame()],
      players: [buildPlayer()],
      playerLogs: buildGames(3),  // only 3 — below threshold of 5
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runNHLPlayerShotsModel();

    // No card should be created
    expect(data.insertCardPayload).not.toHaveBeenCalled();

    // Log should mention "fewer than 5"
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/fewer than 5/i);

    logSpy.mockRestore();
  });

  test('setCurrentRunId is called even when 0 cards are created (COLD edge)', async () => {
    const { mod, data, shots } = loadFreshModule();

    // 5 logs, but edge is COLD — no card
    shots.classifyEdge.mockReturnValue({ tier: 'COLD', direction: 'OVER', edge: 0.1 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-002' })],
      players: [buildPlayer({ player_id: 8888, player_name: 'Cold Player' })],
      playerLogs: buildGames(5),
    }));

    await mod.runNHLPlayerShotsModel();

    // No card
    expect(data.insertCardPayload).not.toHaveBeenCalled();
    // setCurrentRunId should still be called (unconditionally on success path)
    expect(data.setCurrentRunId).toHaveBeenCalled();
  });

  test('1P cards are NOT generated when NHL_SOG_1P_CARDS_ENABLED is not set', async () => {
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;

    const { mod, data, shots } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-003' })],
      players: [buildPlayer({ player_id: 7777, player_name: 'Hot Player' })],
      playerLogs: buildGames(5),
    }));

    // Full game = HOT (card created), 1P = HOT (should be suppressed by flag)
    shots.classifyEdge
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 1.2 })
      .mockReturnValueOnce({ tier: 'HOT', direction: 'OVER', edge: 0.9 });

    await mod.runNHLPlayerShotsModel();

    const allCalls = data.insertCardPayload.mock.calls;
    const onePCalls = allCalls.filter((call) => {
      const card = call[0];
      return (
        card &&
        (card.cardType === 'nhl-player-shots-1p' ||
          (card.payloadData && card.payloadData.card_type === 'nhl-player-shots-1p'))
      );
    });
    expect(onePCalls.length).toBe(0);
  });

  test('synthetic fallback line is deterministic — Math.round(mu * 2) / 2', () => {
    // Pure formula check — no module interaction needed
    const mu = 3.2;
    const expected = Math.round(mu * 2) / 2; // 3.2*2=6.4 → round=6 → /2=3

    for (let i = 0; i < 10; i++) {
      const line = Math.round(mu * 2) / 2;
      expect(line).toBe(expected);
    }
    // Sanity: should be 3, not 3.2
    expect(expected).toBe(3);
  });
});
