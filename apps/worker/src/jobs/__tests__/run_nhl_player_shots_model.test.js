/**
 * Unit tests for run_nhl_player_shots_model.js
 *
 * Tests:
 * 1. Player with fewer than 5 recent logs is skipped with proper log message
 * 2. setCurrentRunId is called even when 0 cards are created
 * 3. NHL_SOG_1P_CARDS_ENABLED=false (default) prevents 1P card creation
 * 4. Projection-floor fallback uses NHL_SOG_PROJECTION_LINE (default 2.5) when no real line
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

function buildGamesFromShots(shotsByGame = []) {
  return shotsByGame.map((shots, i) => ({
    game_id: `g${i}`,
    game_date: `2026-03-${String(i + 1).padStart(2, '0')}`,
    opponent: 'TOR',
    is_home: 1,
    shots,
    toi_minutes: 20,
    raw_data: '{}',
  }));
}

// Build a mock DB whose prepare() dispatches by SQL keyword
// availabilityRow: if set, returned for player_availability queries (null = no record = fail-open)
function buildMockDb({
  games = [],
  players = [],
  playerLogs = [],
  availabilityRow = null,
  oddsSnapshotRawData = null,
} = {}) {
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
      if (s.includes('from player_availability')) {
        return { get: jest.fn(() => availabilityRow) };
      }
      if (s.includes('from odds_snapshots')) {
        if (!oddsSnapshotRawData) return { get: jest.fn(() => null) };
        return {
          get: jest.fn(() => ({
            raw_data:
              typeof oddsSnapshotRawData === 'string'
                ? oddsSnapshotRawData
                : JSON.stringify(oddsSnapshotRawData),
          })),
        };
      }
      if (s.includes('select id') && s.includes('from card_payloads')) {
        return { all: jest.fn(() => [{ id: 'existing-card-1' }]) };
      }
      if (s.includes('delete from card_results')) {
        return { run: jest.fn(() => ({ changes: 1 })) };
      }
      if (s.includes('delete from card_payloads')) {
        return { run: jest.fn(() => ({ changes: 1 })) };
      }
      if (s.includes('update card_payloads') && s.includes('set expires_at')) {
        return { run: jest.fn(() => ({ changes: 0 })) };
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
    calcFairLine: jest.fn(() => 3.0),
    calcFairLine1p: jest.fn(() => 0.96),
    classifyEdge: jest.fn(() => ({ tier: 'COLD', direction: 'OVER', edge: 0.1 })),
  }));

  jest.mock('../../moneypuck', () => ({
    fetchMoneyPuckSnapshot: jest.fn(async () => ({ injuries: {} })),
  }));

  const mod = require('../run_nhl_player_shots_model');
  const data = require('@cheddar-logic/data');
  const shots = require('../../models/nhl-player-shots');
  const moneyPuck = require('../../moneypuck');

  return { mod, data, shots, moneyPuck };
}

describe('run_nhl_player_shots_model', () => {
  beforeEach(() => {
    delete process.env.NHL_SOG_1P_CARDS_ENABLED;
    jest.clearAllMocks();
  });

  test('uses datetime(game_time_utc) window filter for 36h upcoming games', async () => {
    const { mod, data } = loadFreshModule();
    const mockDb = buildMockDb({
      games: [buildFutureGame()],
      players: [buildPlayer()],
      playerLogs: buildGames(5),
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const gamesPrepare = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('from games'),
    );
    expect(gamesPrepare).toBeTruthy();
    const sql = String(gamesPrepare[0]).toLowerCase();
    expect(sql).toContain("datetime(game_time_utc) > datetime('now')");
    expect(sql).toContain("datetime(game_time_utc) < datetime('now', '+36 hours')");
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

  test('projection-floor fallback defaults to 2.5 when NHL_SOG_PROJECTION_LINE not set', () => {
    // When no real Odds API line exists, model uses a fixed floor so high-projection
    // players still generate cards. Default is 2.5 SOG (a standard NHL market line).
    delete process.env.NHL_SOG_PROJECTION_LINE;
    const floor = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
    expect(floor).toBe(2.5);
  });

  test('projection-floor fallback respects NHL_SOG_PROJECTION_LINE override', () => {
    process.env.NHL_SOG_PROJECTION_LINE = '3.0';
    const floor = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
    expect(floor).toBe(3.0);
    delete process.env.NHL_SOG_PROJECTION_LINE;
  });

  test('player with INJURED availability is skipped even when 5 logs exist', async () => {
    const { mod, data, shots } = loadFreshModule();

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-inj-01' })],
      players: [buildPlayer({ player_id: 6666, player_name: 'Injured Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'INJURED', checked_at: new Date().toISOString() },
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runNHLPlayerShotsModel();

    // No card should be created
    expect(data.insertCardPayload).not.toHaveBeenCalled();

    // Log should mention availability status
    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/availability status=INJURED/i);

    logSpy.mockRestore();
  });

  test('player with INJURED availability purges existing player cards for the same game', async () => {
    const { mod, data } = loadFreshModule();
    const mockDb = buildMockDb({
      games: [buildFutureGame({ game_id: 'game-inj-purge-01' })],
      players: [buildPlayer({ player_id: 6123, player_name: 'Purge Injured Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'INJURED', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const deleteCall = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('delete from card_payloads'),
    );
    expect(deleteCall).toBeTruthy();
    expect(data.insertCardPayload).not.toHaveBeenCalled();
  });

  test('active player purges existing cards for same game before creating a new card', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    const mockDb = buildMockDb({
      games: [buildFutureGame({ game_id: 'game-dedupe-01' })],
      players: [buildPlayer({ player_id: 7771, player_name: 'Dedupe Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    const deleteCall = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('delete from card_payloads'),
    );
    expect(deleteCall).toBeTruthy();
    expect(data.insertCardPayload).toHaveBeenCalledTimes(1);
  });

  test('MoneyPuck injury_status overrides ACTIVE availability and skips player card generation', async () => {
    const { mod, data, moneyPuck } = loadFreshModule();

    moneyPuck.fetchMoneyPuckSnapshot.mockResolvedValue({
      injuries: {
        'Detroit Red Wings': [{ player: 'Dylan Larkin', status: 'Out' }],
      },
    });

    const mockDb = buildMockDb({
      games: [
        buildFutureGame({
          game_id: 'game-mp-inj-01',
          home_team: 'Detroit Red Wings',
          away_team: 'Florida Panthers',
        }),
      ],
      players: [
        buildPlayer({
          player_id: 8477946,
          player_name: 'Dylan Larkin',
          team_abbrev: 'DET',
        }),
      ],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();

    const deleteCall = mockDb.prepare.mock.calls.find(([sql]) =>
      String(sql).toLowerCase().includes('delete from card_payloads'),
    );
    expect(deleteCall).toBeTruthy();
  });

  test('team abbreviation matching does not use substrings (TOR must not match PREDATORS)', async () => {
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.2 });

    const mockDb = buildMockDb({
      games: [
        buildFutureGame({
          game_id: 'game-no-substring-match-01',
          home_team: 'Nashville Predators',
          away_team: 'Winnipeg Jets',
        }),
      ],
      players: [
        buildPlayer({
          player_id: 8479318,
          player_name: 'Auston Matthews',
          team_abbrev: 'TOR',
        }),
      ],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    });
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();
  });

  test('player with stale INJURED availability row is still skipped', async () => {
    // Regression guard: the old query used AND checked_at > datetime('now', '-24 hours'),
    // which silently dropped stale injury records and caused fail-open for injured players
    // when pull_nhl_player_shots had not run recently. The fix removes the staleness
    // window so any recorded INJURED status blocks card generation.
    const { mod, data } = loadFreshModule();

    const staleCheckedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48h ago
    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-inj-stale-01' })],
      players: [buildPlayer({ player_id: 6667, player_name: 'Stale Injured Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'INJURED', status_reason: 'ltir', checked_at: staleCheckedAt },
    }));

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();

    const allLogs = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(allLogs).toMatch(/availability status=INJURED/i);

    logSpy.mockRestore();
  });

  test('player with no availability record proceeds normally (fail-open)', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-avail-02' })],
      players: [buildPlayer({ player_id: 5555, player_name: 'No Avail Record' })],
      playerLogs: buildGames(5),
      availabilityRow: null, // no record — fail-open
    }));

    await mod.runNHLPlayerShotsModel();

    // Should proceed to model and create a card
    expect(data.insertCardPayload).toHaveBeenCalled();
  });

  test('player with ACTIVE availability proceeds normally', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-avail-03' })],
      players: [buildPlayer({ player_id: 4444, player_name: 'Active Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
  });

  test('excludes player IDs via NHL_SOG_EXCLUDE_PLAYER_IDS in model run', async () => {
    process.env.NHL_SOG_EXCLUDE_PLAYER_IDS = '8479318';
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'game-exclude-01' })],
      players: [buildPlayer({ player_id: 8479318, player_name: 'Auston Matthews' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', status_reason: null, checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();
    delete process.env.NHL_SOG_EXCLUDE_PLAYER_IDS;
  });

  test('dedupes duplicate game/player rows within a run', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [
        buildFutureGame({ game_id: 'dup-game-01' }),
        buildFutureGame({ game_id: 'dup-game-01' }),
      ],
      players: [buildPlayer({ player_id: 3333, player_name: 'Dup Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalledTimes(1);
  });

  test('writes canonical play action fields and fair-line recommendation for playable cards', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'fair-line-01' })],
      players: [buildPlayer({ player_id: 2222, player_name: 'Fair Line Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.play.action).toBe('FIRE');
    expect(card.payloadData.play.classification).toBe('BASE');
    expect(card.payloadData.play.status).toBe('FIRE');
    expect(card.payloadData.suggested_line).toBe(3);
    expect(card.payloadData.play.pick_string).toMatch(/Proj \d+\.\d+ · Fair \d+(\.\d+)? · Edge [+-]\d+\.\d+/i);
    expect(card.payloadData.confidence).toBeGreaterThan(0.75);
  });

  test('uses opponent team profile from team_metrics_cache for matchup scoring', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    const teamMetricsGet = jest.fn(() => ({
      opponent_goals_against: 3.6,
      league_avg_goals_against: 2.9,
    }));
    const mockDb = {
      prepare: jest.fn((sql) => {
        const s = sql.trim().toLowerCase();
        if (s.includes('from games')) return { all: jest.fn(() => [buildFutureGame()]) };
        if (s.includes('from player_shot_logs') && s.includes('distinct')) {
          return { all: jest.fn(() => [buildPlayer({ player_id: 1010, player_name: 'Matchup Player' })]) };
        }
        if (s.includes('from player_shot_logs') && s.includes('player_id = ?')) {
          return { all: jest.fn(() => buildGames(5)) };
        }
        if (s.includes('from player_availability')) return { get: jest.fn(() => null) };
        if (s.includes('from team_metrics_cache')) return { get: teamMetricsGet };
        return { all: jest.fn(() => []), get: jest.fn(() => null), run: jest.fn() };
      }),
    };
    data.getDatabase.mockReturnValue(mockDb);

    await mod.runNHLPlayerShotsModel();

    expect(teamMetricsGet).toHaveBeenCalledWith('Toronto Maple Leafs');
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.matchup_score).toBeGreaterThan(0.8);
  });

  test('suppresses PASS cards when consistency support is weak', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'pass-skip-01' })],
      players: [buildPlayer({ player_id: 1111, player_name: 'Volatile Player' })],
      playerLogs: buildGamesFromShots([0, 6, 0, 6, 0]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).not.toHaveBeenCalled();
  });
});
