'use strict';

function buildSkaterRow(overrides = {}) {
  return {
    playerId: 1,
    skaterFullName: 'Test Blocker',
    teamAbbrevs: 'CAR',
    blockedShots: 120,
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
  const mod = require('../sync_nhl_blk_player_ids');
  return { mod, mockData };
}

describe('sync_nhl_blk_player_ids', () => {
  beforeEach(() => {
    delete process.env.NHL_BLK_SEASON_ID;
    delete process.env.NHL_BLK_TOP_BLOCKERS_COUNT;
    delete process.env.NHL_BLK_MIN_GAMES_PLAYED;
    delete process.env.NHL_BLK_SYNC_FETCH_LIMIT;
    global.fetch = jest.fn();
    jest.clearAllMocks();
  });

  test('parseTopBlockers filters by games played and sorts by blocks per game', () => {
    const { mod } = loadSyncModule();
    const payload = {
      data: [
        buildSkaterRow({ playerId: 11, blockedShots: 210, gamesPlayed: 70 }), // 3.0
        buildSkaterRow({ playerId: 22, blockedShots: 180, gamesPlayed: 40 }), // 4.5
        buildSkaterRow({ playerId: 33, blockedShots: 100, gamesPlayed: 15 }), // filtered
      ],
    };

    const top = mod.parseTopBlockers(payload, { topCount: 2, minGamesPlayed: 20 });
    expect(top.map((row) => row.playerId)).toEqual([22, 11]);
    expect(top[0].blocksPerGame).toBe(4.5);
  });

  test('sync job upserts top blockers into tracked_players market=blocked_shots', async () => {
    const { mod, mockData } = loadSyncModule();
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          buildSkaterRow({ playerId: 11, skaterFullName: 'A', blockedShots: 220, gamesPlayed: 55 }),
          buildSkaterRow({ playerId: 22, skaterFullName: 'B', blockedShots: 180, gamesPlayed: 45 }),
        ],
      }),
    });

    const result = await mod.syncNhlBlkPlayerIds({
      jobKey: 'sync_nhl_blk_player_ids|2026-03-28|0400',
      topCount: 2,
      minGamesPlayed: 20,
      fetchLimit: 10,
    });

    expect(result.success).toBe(true);
    expect(result.selected).toBe(2);
    expect(mockData.upsertTrackedPlayer).toHaveBeenCalledTimes(2);
    expect(mockData.upsertTrackedPlayer.mock.calls[0][0]).toMatchObject({
      playerId: 11,
      sport: 'NHL',
      market: 'blocked_shots',
      isActive: true,
    });
    expect(mockData.deactivateTrackedPlayersNotInSet).toHaveBeenCalledWith(
      expect.objectContaining({
        sport: 'NHL',
        market: 'blocked_shots',
        activePlayerIds: [11, 22],
      }),
    );
  });
});
