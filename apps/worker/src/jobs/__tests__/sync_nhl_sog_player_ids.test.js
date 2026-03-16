'use strict';

const { DateTime } = require('luxon');

function buildSkaterRow(overrides = {}) {
  return {
    playerId: 1,
    skaterFullName: 'Test Skater',
    teamAbbrevs: 'EDM',
    shots: 120,
    gamesPlayed: 40,
    seasonId: 20252026,
    ...overrides,
  };
}

function loadSyncModule({ shouldRun = true } = {}) {
  jest.resetModules();

  const mockData = {
    insertJobRun: jest.fn(),
    markJobRunSuccess: jest.fn(),
    markJobRunFailure: jest.fn(),
    shouldRunJobKey: jest.fn(() => shouldRun),
    withDb: jest.fn((fn) => fn()),
    upsertTrackedPlayer: jest.fn(),
    deactivateTrackedPlayersNotInSet: jest.fn(() => 0),
  };

  jest.doMock('@cheddar-logic/data', () => mockData);
  const mod = require('../sync_nhl_sog_player_ids');
  return { mod, mockData };
}

function loadSchedulerModule() {
  jest.resetModules();

  jest.doMock('@cheddar-logic/data', () => ({
    initDb: jest.fn(),
    getUpcomingGames: jest.fn(() => []),
    shouldRunJobKey: jest.fn(() => true),
    hasRunningJobRun: jest.fn(() => false),
    wasJobRecentlySuccessful: jest.fn(() => false),
  }));

  jest.doMock('../pull_odds_hourly', () => ({ pullOddsHourly: jest.fn() }));
  jest.doMock('../refresh_stale_odds', () => ({ refreshStaleOdds: jest.fn() }));
  jest.doMock('../run_nhl_model', () => ({ runNHLModel: jest.fn() }));
  jest.doMock('../run_nba_model', () => ({ runNBAModel: jest.fn() }));
  jest.doMock('../run_fpl_model', () => ({ runFPLModel: jest.fn() }));
  jest.doMock('../run_nfl_model', () => ({ runNFLModel: jest.fn() }));
  jest.doMock('../run_mlb_model', () => ({ runMLBModel: jest.fn() }));
  jest.doMock('../run_soccer_model', () => ({ runSoccerModel: jest.fn() }));
  jest.doMock('../run_ncaam_model', () => ({ runNCAAMModel: jest.fn() }));
  jest.doMock('../refresh_ncaam_ft_csv', () => ({ runRefreshNcaamFtCsv: jest.fn() }));
  jest.doMock('../settle_game_results', () => ({ settleGameResults: jest.fn() }));
  jest.doMock('../settle_pending_cards', () => ({ settlePendingCards: jest.fn() }));
  jest.doMock('../backfill_card_results', () => ({ backfillCardResults: jest.fn() }));
  jest.doMock('../check_pipeline_health', () => ({ checkPipelineHealth: jest.fn() }));
  jest.doMock('../refresh_team_metrics_daily', () => ({ run: jest.fn() }));
  jest.doMock('../sync_nhl_sog_player_ids', () => ({ syncNhlSogPlayerIds: jest.fn() }));

  return require('../../schedulers/main');
}

describe('sync_nhl_sog_player_ids', () => {
  beforeEach(() => {
    delete process.env.NHL_SOG_SEASON_ID;
    delete process.env.NHL_SOG_TOP_SHOOTERS_COUNT;
    delete process.env.NHL_SOG_MIN_GAMES_PLAYED;
    delete process.env.NHL_SOG_SYNC_FETCH_LIMIT;
    global.fetch = jest.fn();
    jest.clearAllMocks();
  });

  test('parseTopShooters filters by gamesPlayed and sorts by shots per game', () => {
    const { mod } = loadSyncModule();
    const payload = {
      data: [
        buildSkaterRow({ playerId: 11, shots: 210, gamesPlayed: 70 }), // 3.000
        buildSkaterRow({ playerId: 22, shots: 180, gamesPlayed: 40 }), // 4.500
        buildSkaterRow({ playerId: 33, shots: 100, gamesPlayed: 15 }), // filtered
      ],
    };

    const top = mod.parseTopShooters(payload, { topCount: 2, minGamesPlayed: 20 });
    expect(top.map((row) => row.playerId)).toEqual([22, 11]);
    expect(top[0].shotsPerGame).toBe(4.5);
  });

  test('sync job upserts top shooters and deactivates stale rows', async () => {
    const { mod, mockData } = loadSyncModule();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          buildSkaterRow({ playerId: 11, skaterFullName: 'A', teamAbbrevs: 'EDM', shots: 220, gamesPlayed: 55 }),
          buildSkaterRow({ playerId: 22, skaterFullName: 'B', teamAbbrevs: 'TOR', shots: 180, gamesPlayed: 45 }),
          buildSkaterRow({ playerId: 33, skaterFullName: 'C', teamAbbrevs: 'BOS', shots: 120, gamesPlayed: 18 }), // filtered
        ],
      }),
    });

    const result = await mod.syncNhlSogPlayerIds({
      jobKey: 'sync_nhl_sog_player_ids|2026-03-16|0400',
      topCount: 2,
      minGamesPlayed: 20,
      fetchLimit: 10,
    });

    expect(result.success).toBe(true);
    expect(result.selected).toBe(2);
    expect(mockData.insertJobRun).toHaveBeenCalledTimes(1);
    expect(mockData.upsertTrackedPlayer).toHaveBeenCalledTimes(2);
    expect(mockData.upsertTrackedPlayer.mock.calls[0][0]).toMatchObject({
      playerId: 11,
      sport: 'NHL',
      market: 'shots_on_goal',
      isActive: true,
    });
    expect(mockData.deactivateTrackedPlayersNotInSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sport: 'NHL',
        market: 'shots_on_goal',
        activePlayerIds: [11, 22],
      }),
    );
    expect(mockData.markJobRunSuccess).toHaveBeenCalledTimes(1);
  });

  test('dry-run returns selected IDs without DB writes', async () => {
    const { mod, mockData } = loadSyncModule();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          buildSkaterRow({ playerId: 99, shots: 150, gamesPlayed: 30 }),
        ],
      }),
    });

    const result = await mod.syncNhlSogPlayerIds({
      dryRun: true,
      topCount: 1,
      minGamesPlayed: 20,
    });

    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.playerIds).toEqual([99]);
    expect(mockData.insertJobRun).not.toHaveBeenCalled();
    expect(mockData.upsertTrackedPlayer).not.toHaveBeenCalled();
    expect(mockData.deactivateTrackedPlayersNotInSet).not.toHaveBeenCalled();
  });

  test('jobKey idempotency skip prevents API call', async () => {
    const { mod, mockData } = loadSyncModule({ shouldRun: false });
    const result = await mod.syncNhlSogPlayerIds({
      jobKey: 'sync_nhl_sog_player_ids|2026-03-16|0400',
    });

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockData.insertJobRun).not.toHaveBeenCalled();
  });
});

describe('scheduler NHL SOG sync window', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ENABLE_NHL_SOG_PLAYER_SYNC = 'true';
    process.env.ENABLE_ODDS_PULL = 'false';
    process.env.ENABLE_SETTLEMENT = 'false';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('computeDueJobs queues sync_nhl_sog_player_ids at 04:00 ET with deterministic key', () => {
    const scheduler = loadSchedulerModule();
    const nowEt = DateTime.fromISO('2026-03-16T04:00:00', {
      zone: 'America/New_York',
    });
    const nowUtc = nowEt.toUTC();

    const due = scheduler.computeDueJobs({
      nowEt,
      nowUtc,
      games: [],
      dryRun: false,
    });

    const syncJob = due.find((job) => job.jobName === 'sync_nhl_sog_player_ids');
    expect(syncJob).toBeTruthy();
    expect(syncJob.jobKey).toBe('sync_nhl_sog_player_ids|2026-03-16|0400');
    expect(syncJob.args.jobKey).toBe(syncJob.jobKey);
  });
});
