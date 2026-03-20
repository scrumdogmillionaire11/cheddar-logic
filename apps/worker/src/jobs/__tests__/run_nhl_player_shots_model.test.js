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
    recordProjectionEntry: jest.fn(),
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
    projectSogV2: jest.fn(() => ({
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
    })),
    projectBlkV1: jest.fn(() => ({
      blk_mu: 0,
      blk_sigma: 0,
      flags: [],
    })),
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
    // Provide a real odds-backed prop line so the no-real-line guard does NOT
    // fire, giving us a genuine FIRE card we can assert against.
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    // Real prop line (over/under prices present → usingRealLine=true → FIRE allowed).
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });

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
    // Odds-backed card must NOT have SYNTHETIC_LINE or anomaly flags.
    expect(card.payloadData.decision.v2.flags).not.toContain('SYNTHETIC_LINE');
  });

  test('uses opponent team profile from team_metrics_cache for matchup scoring', async () => {
    const { mod, data, shots } = loadFreshModule();

    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    const teamMetricsGet = jest.fn(() => ({
      opponent_shots_against_pg: 31.8,
      league_avg_shots_against_pg: 28.5,
      team_pace_proxy: 1.06,
      opponent_pace_proxy: 1.04,
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

    expect(teamMetricsGet).toHaveBeenCalledWith(
      'Toronto Maple Leafs',
      'Edmonton Oilers',
      'Toronto Maple Leafs',
    );
    expect(shots.calcMu).toHaveBeenCalledWith(
      expect.objectContaining({
        opponentFactor: expect.any(Number),
        paceFactor: expect.any(Number),
      }),
    );
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.matchup_score).toBeGreaterThan(0.6);
    expect(card.payloadData.drivers.opponent_factor).toBeGreaterThan(1.0);
    expect(card.payloadData.drivers.pace_factor).toBeGreaterThan(1.0);
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

  test('adds decision_basis_meta and records projection telemetry when flagged and no real line', async () => {
    process.env.ENABLE_DECISION_BASIS_TAGS = 'true';
    process.env.ENABLE_PROJECTION_PERF_LEDGER = 'true';

    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'projection-ledger-01' })],
      players: [buildPlayer({ player_id: 9191, player_name: 'Projection Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const insertedCard = data.insertCardPayload.mock.calls[0][0];
    expect(insertedCard.payloadData.decision_basis_meta).toEqual(
      expect.objectContaining({
        decision_basis: 'PROJECTION_ONLY',
        execution_eligible: false,
        market_line_source: 'synthetic_fallback',
      }),
    );
    expect(insertedCard.payloadData.decision.market_line_source).toBe(
      'synthetic_fallback',
    );

    expect(data.recordProjectionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        cardId: insertedCard.id,
        gameId: insertedCard.gameId,
        sport: 'NHL',
        decisionBasis: 'PROJECTION_ONLY',
      }),
    );

    delete process.env.ENABLE_DECISION_BASIS_TAGS;
    delete process.env.ENABLE_PROJECTION_PERF_LEDGER;
  });

  test('Guard 1: HOT projection-only card (no real line) is downgraded FIRE→HOLD, card still emitted', async () => {
    // No real prop line → usingRealLine=false → FIRE must be blocked.
    // Card should still be created (HOLD is not PASS), but action must be 'HOLD'.
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.0 });
    // getPlayerPropLine returns null (default) — no real line.

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'guard1-no-line-01' })],
      players: [buildPlayer({ player_id: 8811, player_name: 'No Line Player' })],
      playerLogs: buildGames(5),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    // Must be HOLD (downgraded), not FIRE.
    expect(card.payloadData.play.action).toBe('HOLD');
    expect(card.payloadData.play.status).toBe('WATCH');
    // SYNTHETIC_LINE flag must be set in v2 flags.
    expect(card.payloadData.decision.v2.flags).toContain('SYNTHETIC_LINE');
  });

  test('Guard 2: PROJECTION_ANOMALY (weighted mu < 60% of L5 mean) blocks FIRE and flags payload', async () => {
    // l5Sog = [2,2,2,2,2] → arithmetic mean = 2.0
    // calcMu mocked to return 1.0 → anomaly: 1.0 < 0.6*2.0=1.2 ✓
    // All 5 shots (2) are <= 2.5 line → UNDER hitRate=1.0 → consistency=1.0 → FIRE (before guard)
    // Guard 2 must then downgrade FIRE → HOLD and add PROJECTION_ANOMALY flag.
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'UNDER', edge: -1.5 });
    // mu=1.0 → anomaly detected (1.0 < 0.6*2.0=1.2)
    shots.calcMu.mockReturnValue(1.0);
    shots.calcMu1p.mockReturnValue(0.32);
    // Real prop line supplied (usingRealLine=true) so Guard 1 does not interfere.
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'guard2-anomaly-01' })],
      players: [buildPlayer({ player_id: 7722, player_name: 'Anomaly Player' })],
      // shots [2,2,2,2,2] → l5_arith_mean=2.0; calcMu=1.0 < 0.6*2.0=1.2 → anomaly
      playerLogs: buildGamesFromShots([2, 2, 2, 2, 2]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    // Action must be HOLD (anomaly guard blocked FIRE).
    expect(card.payloadData.play.action).toBe('HOLD');
    expect(card.payloadData.play.status).toBe('WATCH');
    // PROJECTION_ANOMALY flag must appear in v2 flags.
    expect(card.payloadData.decision.v2.flags).toContain('PROJECTION_ANOMALY');
  });

  // --- WI-0527: v2 anomaly flag, pricing nullification, extended drivers ---

  test('Test A: v2 PROJECTION_ANOMALY flag appears in decision.v2.flags when sog_mu < 0.6 * l5_avg', async () => {
    // sog_mu=1.4, l5Sog=[3,3,3,3,3] → l5_avg=3.0 → 1.4 < 0.6*3.0=1.8 → v2AnomalyDetected=true
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'UNDER', edge: -1.5 });
    shots.calcMu.mockReturnValue(3.0); // V1 mu — no V1 anomaly, only V2 anomaly
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    // V2 projection returns sog_mu well below 60% of l5_avg=3.0
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.08,
      edge_under_pp: -0.08,
      ev_over: 0.06,
      ev_under: -0.06,
      opportunity_score: 0.72,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'v2-anomaly-flag-01' })],
      players: [buildPlayer({ player_id: 5001, player_name: 'V2 Anomaly Player A' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.flags).toContain('PROJECTION_ANOMALY');
  });

  test('Test B: edge_over_pp, ev_over, opportunity_score are null when v2 anomaly detected', async () => {
    // Same anomaly scenario — pricing fields must be null even though v2 mock returns non-null values
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'UNDER', edge: -1.5 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 1.4,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 4.2,
      shot_rate_pp_per60: 0,
      shot_env_factor: 0.9,
      role_stability: 'HIGH',
      trend_score: -0.1,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.12,   // non-null — must be nullified by guard
      edge_under_pp: -0.12,
      ev_over: 0.09,        // non-null — must be nullified
      ev_under: -0.09,
      opportunity_score: 0.85, // non-null — must be nullified
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'v2-anomaly-null-01' })],
      players: [buildPlayer({ player_id: 5002, player_name: 'V2 Anomaly Player B' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    expect(card.payloadData.decision.v2.edge_over_pp).toBeNull();
    expect(card.payloadData.decision.v2.ev_over).toBeNull();
    expect(card.payloadData.decision.v2.opportunity_score).toBeNull();
  });

  test('Test C: edge_over_pp is NOT nullified when sog_mu >= 0.6 * l5_avg (no anomaly)', async () => {
    // sog_mu=3.0, l5=[3,3,3,3,3] → l5_avg=3.0 → 3.0 >= 1.8 → no anomaly
    const { mod, data, shots } = loadFreshModule();
    shots.classifyEdge.mockReturnValue({ tier: 'HOT', direction: 'OVER', edge: 1.5 });
    shots.calcMu.mockReturnValue(3.0);
    data.getPlayerPropLine.mockReturnValue({ line: 2.5, over_price: -115, under_price: -105 });
    shots.projectSogV2.mockReturnValue({
      sog_mu: 3.0,
      sog_sigma: 1.2,
      toi_proj: 20,
      shot_rate_ev_per60: 9.0,
      shot_rate_pp_per60: 0,
      shot_env_factor: 1.0,
      role_stability: 'HIGH',
      trend_score: 0.05,
      fair_over_prob_by_line: {},
      fair_under_prob_by_line: {},
      fair_price_over_by_line: {},
      fair_price_under_by_line: {},
      market_line: 2.5,
      market_price_over: -115,
      market_price_under: -105,
      edge_over_pp: 0.10,
      edge_under_pp: -0.10,
      ev_over: 0.08,
      ev_under: -0.08,
      opportunity_score: 0.78,
      flags: [],
    });

    data.getDatabase.mockReturnValue(buildMockDb({
      games: [buildFutureGame({ game_id: 'v2-no-anomaly-01' })],
      players: [buildPlayer({ player_id: 5003, player_name: 'V2 No Anomaly Player C' })],
      playerLogs: buildGamesFromShots([3, 3, 3, 3, 3]),
      availabilityRow: { status: 'ACTIVE', checked_at: new Date().toISOString() },
    }));

    await mod.runNHLPlayerShotsModel();

    expect(data.insertCardPayload).toHaveBeenCalled();
    const card = data.insertCardPayload.mock.calls[0][0];
    // No anomaly — edge_over_pp should come through (non-null)
    expect(card.payloadData.decision.v2.edge_over_pp).not.toBeNull();
    expect(card.payloadData.decision.v2.flags).not.toContain('PROJECTION_ANOMALY');
  });
});
